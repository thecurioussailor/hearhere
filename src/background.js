// HearHere — background service worker (v0.2).
// Owns the single reading session and routes it to an engine:
//   system → chrome.tts (OS voices, free)
//   cloud  → offscreen player using the user's own OpenAI / ElevenLabs key

const DEFAULTS = {
  rate: 1,
  hoverMode: false,
  voiceName: '',                 // system voice
  provider: 'system',            // system | openai | elevenlabs
  openaiModel: 'gpt-4o-mini-tts',
  openaiVoice: 'marin',
  openaiInstructions: '',
  elevenModel: 'eleven_flash_v2_5',
  elevenVoiceId: '',
  elevenVoiceName: '',
  dailyCharLimit: 20000,         // cloud characters per day, 0 = no limit
  confirmOverChars: 3000,        // ask before reading more than this with a cloud voice
  hoverMaxChars: 1500,           // Hover Read skips longer blocks with a cloud voice
  hoverDwellCloudMs: 1000        // how long to rest the cursor before Hover Read fires (cloud)
};
const LOCAL_DEFAULTS = { openaiKey: '', elevenKey: '' };
const PROVIDER_LABEL = { system: 'System voice', openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
const SYSTEM_CHUNK = 220;
const CLOUD_CHUNK = 400;

/**
 * session: { sid, tabId, reqId, chunks[], index, status: 'playing'|'paused', buffering,
 *            rate, voiceName, engine: 'system'|'cloud', cfg, needsRestart }
 */
let session = null;
let seq = 0;

// ---------- text ----------
function cleanText(text) {
  return String(text || '')
    .replace(/\[(?:\d+(?:\s*[,–-]\s*\d+)*|citation needed|edit|note \d+)\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkText(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?…。！？]["'”’)\]]*)\s+/);
  const chunks = [];
  let cur = '';
  const flush = () => { const t = cur.trim(); if (t) chunks.push(t); cur = ''; };
  for (let s of sentences) {
    while (s.length > max) {
      let cut = s.lastIndexOf(', ', max);
      if (cut < max * 0.5) cut = s.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      flush();
      chunks.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (!s) continue;
    if (cur && (cur.length + 1 + s.length) > max) flush();
    cur = cur ? `${cur} ${s}` : s;
  }
  flush();
  return chunks;
}

// ---------- state broadcast ----------
function stateOf(s, statusOverride) {
  const status = statusOverride || (s ? s.status : 'idle');
  return {
    type: 'hh-state',
    status,
    tabId: s ? s.tabId : null,
    reqId: s ? s.reqId : null,
    rate: s ? s.rate : undefined,
    buffering: !!(s && s.buffering && status === 'playing'),
    provider: s ? (s.engine === 'cloud' ? s.cfg.provider : 'system') : null,
    chunkIndex: s ? s.index : 0,
    chunkCount: s ? s.chunks.length : 0
  };
}

function notifyTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function toastTab(tabId, text) {
  notifyTab(tabId, { type: 'hh-toast', text });
}

function broadcast(s = session, statusOverride) {
  const msg = stateOf(s, statusOverride);
  if (s) notifyTab(s.tabId, msg);
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup / settings, if open
}

// ---------- usage tracking (cloud characters) ----------
let usageLock = Promise.resolve();
const dayKey = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

function normUsage(u) {
  u = u && typeof u === 'object' ? { ...u } : {};
  const day = dayKey();
  const month = day.slice(0, 7);
  if (u.day !== day) { u.day = day; u.dayChars = 0; u.dayByProvider = {}; }
  if (u.month !== month) { u.month = month; u.monthChars = 0; u.monthByProvider = {}; }
  return u;
}

function addUsage(chars, provider) {
  usageLock = usageLock.then(async () => {
    const { usage } = await chrome.storage.local.get({ usage: null });
    const u = normUsage(usage);
    u.dayChars += chars;
    u.monthChars += chars;
    u.dayByProvider[provider] = (u.dayByProvider[provider] || 0) + chars;
    u.monthByProvider[provider] = (u.monthByProvider[provider] || 0) + chars;
    await chrome.storage.local.set({ usage: u });
  }).catch(() => {});
  return usageLock;
}

/** -1 = unlimited, otherwise characters left today. */
async function remainingBudget() {
  await usageLock;
  const [{ dailyCharLimit }, { usage }] = await Promise.all([
    chrome.storage.sync.get({ dailyCharLimit: DEFAULTS.dailyCharLimit }),
    chrome.storage.local.get({ usage: null })
  ]);
  const limit = Number(dailyCharLimit) || 0;
  if (limit <= 0) return -1;
  return Math.max(0, limit - normUsage(usage).dayChars);
}

// ---------- settings ----------
async function validVoice(voiceName) {
  if (!voiceName) return '';
  try {
    const voices = await chrome.tts.getVoices();
    return voices.some(v => v.voiceName === voiceName) ? voiceName : '';
  } catch (_) {
    return '';
  }
}

function cloudConfig(settings, local) {
  if (settings.provider === 'openai') {
    if (!local.openaiKey) return { error: 'No OpenAI API key set' };
    return {
      cfg: {
        provider: 'openai', apiKey: local.openaiKey, model: settings.openaiModel,
        voice: settings.openaiVoice, instructions: settings.openaiInstructions || ''
      }
    };
  }
  if (settings.provider === 'elevenlabs') {
    if (!local.elevenKey) return { error: 'No ElevenLabs API key set' };
    if (!settings.elevenVoiceId) return { error: 'No ElevenLabs voice selected' };
    return {
      cfg: {
        provider: 'elevenlabs', apiKey: local.elevenKey, model: settings.elevenModel,
        voice: settings.elevenVoiceId, instructions: ''
      }
    };
  }
  return { error: 'Unknown voice provider' };
}

// ---------- offscreen document ----------
const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Plays text-to-speech audio from the voice provider the user selected.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function sendOffscreen(msg, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
      if (res !== undefined) return res;
    } catch (_) {}
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 120));
  }
  return undefined;
}

async function stopOffscreen() {
  try { if (await hasOffscreen()) await sendOffscreen({ type: 'cloud-stop' }, 1); } catch (_) {}
}

// ---------- engines ----------
function systemSpeakFrom(index) {
  const s = session;
  if (!s) return;
  s.sid = ++seq;
  s.index = index;
  s.status = 'playing';
  s.buffering = false;
  s.needsRestart = false;
  const sid = s.sid;
  const last = s.chunks.length - 1;

  chrome.tts.stop();
  chrome.tts.resume(); // make sure the engine isn't left paused

  for (let i = index; i <= last; i++) {
    const opts = {
      rate: s.rate,
      enqueue: i !== index,
      onEvent: (ev) => onTtsEvent(sid, i, last, ev)
    };
    if (s.voiceName) opts.voiceName = s.voiceName;
    chrome.tts.speak(s.chunks[i], opts).catch((err) => {
      console.warn('[HearHere] speak failed', err);
      if (session && session.sid === sid && i === last) finish();
    });
  }
}

function onTtsEvent(sid, i, last, ev) {
  if (!session || session.engine !== 'system' || session.sid !== sid) return;
  switch (ev.type) {
    case 'start':
      session.index = i;
      break;
    case 'end':
      if (i === last) finish();
      break;
    case 'error':
      console.warn('[HearHere] tts error', ev.errorMessage);
      if (i === last) finish();
      break;
  }
}

async function cloudPlayFrom(index) {
  const s = session;
  if (!s) return;
  s.sid = ++seq;
  s.index = index;
  s.status = 'playing';
  s.buffering = true;
  s.needsRestart = false;
  const sid = s.sid;
  const stale = () => session !== s || s.sid !== sid;

  const budget = await remainingBudget();
  if (stale()) return;
  if (budget === 0) {
    fallbackToSystem(index, 'Daily character limit reached. Reading with the system voice (change the limit in HearHere settings).');
    return;
  }
  try {
    await ensureOffscreen();
  } catch (err) {
    console.warn('[HearHere] offscreen failed', err);
    if (!stale()) fallbackToSystem(index, 'Could not start the audio player. Using the system voice.');
    return;
  }
  if (stale()) return;
  const res = await sendOffscreen({
    type: 'cloud-play', sid, chunks: s.chunks, startIndex: index, rate: s.rate, cfg: s.cfg, budget
  });
  if (!res && !stale()) fallbackToSystem(index, 'The audio player did not respond. Using the system voice.');
}

function startFrom(index) {
  if (!session) return;
  if (session.engine === 'cloud') return cloudPlayFrom(index);
  systemSpeakFrom(index);
}

function fallbackToSystem(index, message) {
  const s = session;
  if (!s) return;
  if (s.engine === 'cloud') stopOffscreen();
  s.engine = 'system';
  s.cfg = null;
  if (message) toastTab(s.tabId, message);
  systemSpeakFrom(index);
  broadcast();
}

function onCloudEvent(msg) {
  if (msg.event === 'usage') addUsage(msg.chars || 0, msg.provider || 'unknown'); // spent either way
  const s = session;
  if (!s || s.engine !== 'cloud' || msg.sid !== s.sid) return;
  switch (msg.event) {
    case 'buffering':
      s.index = msg.index;
      s.buffering = true;
      broadcast();
      break;
    case 'start':
      s.index = msg.index;
      s.buffering = false;
      broadcast();
      break;
    case 'done':
      finish();
      break;
    case 'limit':
      fallbackToSystem(msg.index, 'Daily character limit reached. Continuing with the system voice (change the limit in HearHere settings).');
      break;
    case 'error': {
      const label = PROVIDER_LABEL[s.cfg.provider] || 'Voice provider';
      const reason = (msg.error && msg.error.message) || 'Something went wrong.';
      fallbackToSystem(msg.index, `${label}: ${reason} Continuing with the system voice.`);
      break;
    }
  }
}

// ---------- session control ----------
async function speak(text, tabId, reqId = null) {
  const clean = cleanText(text);
  if (!clean) return;
  const [settings, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS)
  ]);

  let engine = 'system';
  let cfg = null;
  if (settings.provider !== 'system') {
    const r = cloudConfig(settings, local);
    if (r.cfg) { engine = 'cloud'; cfg = r.cfg; }
    else toastTab(tabId, `${r.error}. Using the system voice; open HearHere settings to fix.`);
  }

  const chunks = chunkText(clean, engine === 'cloud' ? CLOUD_CHUNK : SYSTEM_CHUNK);
  if (!chunks.length) return;
  const voiceName = await validVoice(settings.voiceName);

  const prev = session;
  session = {
    sid: 0, tabId, reqId, chunks, index: 0, status: 'playing', buffering: engine === 'cloud',
    rate: Number(settings.rate) || 1, voiceName, engine, cfg, needsRestart: false
  };
  if (prev) {
    if (prev.engine === 'cloud' && engine !== 'cloud') stopOffscreen();
    if (prev.engine === 'system' && engine !== 'system') { chrome.tts.stop(); chrome.tts.resume(); }
    if (prev.tabId !== tabId) broadcast(prev, 'idle');
  }
  broadcast();
  await startFrom(0);
}

function finish() {
  const s = session;
  session = null;
  if (s) broadcast(s, 'idle');
}

function pause() {
  const s = session;
  if (!s || s.status !== 'playing') return;
  if (s.engine === 'cloud') sendOffscreen({ type: 'cloud-pause', sid: s.sid }, 1);
  else chrome.tts.pause();
  s.status = 'paused';
  broadcast();
}

async function resume() {
  const s = session;
  if (!s || s.status !== 'paused') return;
  if (s.engine === 'system') {
    if (s.needsRestart) systemSpeakFrom(s.index);
    else { chrome.tts.resume(); s.status = 'playing'; }
    broadcast();
    return;
  }
  s.status = 'playing';
  broadcast();
  // The offscreen player may have been closed by Chrome during a long pause;
  // if so, restart the current chunk (it's cached, so this costs nothing).
  const alive = await hasOffscreen().catch(() => false);
  const res = alive ? await sendOffscreen({ type: 'cloud-resume', sid: s.sid }, 1) : null;
  if ((!res || !res.ok) && session === s && s.status === 'playing') await cloudPlayFrom(s.index);
}

function toggle() {
  if (!session) return false;
  if (session.status === 'playing') pause();
  else resume();
  return true;
}

function stop() {
  const s = session;
  session = null;
  if (s && s.engine === 'cloud') stopOffscreen();
  else { chrome.tts.stop(); chrome.tts.resume(); }
  if (s) broadcast(s, 'idle');
}

// ---------- talking to tabs ----------
async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch (_) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      await chrome.tabs.sendMessage(tabId, msg);
      return true;
    } catch (_) {
      return false; // chrome://, Web Store, PDF viewer, etc.
    }
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function readInTab(tab) {
  if (!tab || tab.id == null) return false;
  return sendToTab(tab.id, { type: 'hh-command', command: 'read-selection' });
}

// ---------- listeners ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set(current);

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'hearhere-read', title: 'Read aloud with HearHere', contexts: ['selection'] });
  });

  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ['src/content.css'] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/content.js'] }).catch(() => {});
  }
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'hearhere-read' && info.selectionText) {
    speak(info.selectionText, tab ? tab.id : null, null);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab = tab || await activeTab();
  switch (command) {
    case 'read-selection':
      readInTab(tab);
      break;
    case 'toggle-pause':
      if (!toggle()) readInTab(tab);
      break;
    case 'stop-reading':
      stop();
      break;
    case 'toggle-hover': {
      const { hoverMode } = await chrome.storage.sync.get(DEFAULTS);
      await chrome.storage.sync.set({ hoverMode: !hoverMode });
      break;
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target === 'offscreen') return;
  if (msg.target === 'bg' && msg.type === 'cloud-event') { onCloudEvent(msg); return; }
  switch (msg.type) {
    case 'speak':
      speak(msg.text, sender.tab ? sender.tab.id : msg.tabId, msg.reqId || null);
      break;
    case 'pause': pause(); break;
    case 'resume': resume(); break;
    case 'toggle': toggle(); break;
    case 'stop': stop(); break;
    case 'keepalive': break;
    case 'getState':
      if (sender.tab && (!session || session.tabId !== sender.tab.id)) sendResponse(stateOf(null));
      else sendResponse(stateOf(session));
      return;
    case 'readActiveTab':
      activeTab().then(readInTab).then(ok => sendResponse({ ok }));
      return true;
    case 'addUsage': // settings page voice samples
      addUsage(msg.chars || 0, msg.provider || 'unknown');
      break;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !session) return;
  const s = session;
  if (changes.rate) {
    s.rate = Number(changes.rate.newValue) || 1;
    if (s.engine === 'cloud') {
      sendOffscreen({ type: 'cloud-rate', rate: s.rate }, 1); // instant, no new request
    } else if (s.status === 'playing') {
      systemSpeakFrom(s.index);
    } else {
      s.needsRestart = true;
    }
    broadcast();
  }
  if (changes.voiceName && s.engine === 'system') {
    s.voiceName = changes.voiceName.newValue || '';
    if (s.status === 'playing') systemSpeakFrom(s.index);
    else s.needsRestart = true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session && session.tabId === tabId) stop();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (session && session.tabId === tabId && changeInfo.status === 'loading' && changeInfo.url) stop();
});
