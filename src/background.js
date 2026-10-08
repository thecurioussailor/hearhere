// HearHere — background service worker.
// Owns the speech engine (chrome.tts) and the single active reading session.

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const DEFAULTS = { rate: 1, voiceName: '', hoverMode: false };
const CHUNK_MAX = 220;

/**
 * session: {
 *   id, tabId, reqId, chunks[], index, status: 'playing'|'paused',
 *   rate, voiceName, needsRestart
 * }
 */
let session = null;
let seq = 0;

// ---------- text chunking ----------
// Short chunks keep chrome.tts responsive (pause/stop, speed changes) and
// avoid the cut-off some voices have on very long utterances.
function chunkText(text, max = CHUNK_MAX) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?…。！？]["'”’)\]]*)\s+/);
  const chunks = [];
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = '';
  };
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
function stateOf(s) {
  return {
    type: 'hh-state',
    status: s ? s.status : 'idle',
    tabId: s ? s.tabId : null,
    reqId: s ? s.reqId : null,
    rate: s ? s.rate : undefined,
    chunkIndex: s ? s.index : 0,
    chunkCount: s ? s.chunks.length : 0
  };
}

function notifyTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function broadcast(s = session, overrideStatus) {
  const msg = stateOf(s);
  if (overrideStatus) msg.status = overrideStatus;
  if (s) notifyTab(s.tabId, msg);
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup, if open
}

// ---------- speech ----------
async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function validVoice(voiceName) {
  if (!voiceName) return '';
  try {
    const voices = await chrome.tts.getVoices();
    return voices.some(v => v.voiceName === voiceName) ? voiceName : '';
  } catch (_) {
    return '';
  }
}

async function speak(text, tabId, reqId = null) {
  const chunks = chunkText(text);
  if (!chunks.length) return;
  const settings = await getSettings();
  const voiceName = await validVoice(settings.voiceName);

  const prev = session;
  session = {
    id: 0, tabId, reqId, chunks, index: 0, status: 'playing',
    rate: Number(settings.rate) || 1, voiceName, needsRestart: false
  };
  // Tell the previous tab it's done (same tab gets the new state instead).
  if (prev && prev.tabId !== tabId) broadcast(prev, 'idle');
  speakFrom(0);
  broadcast();
}

function speakFrom(index) {
  const s = session;
  if (!s) return;
  s.id = ++seq;
  s.index = index;
  s.status = 'playing';
  s.needsRestart = false;
  const id = s.id;
  const last = s.chunks.length - 1;

  // Clear anything queued and make sure the engine isn't left paused.
  chrome.tts.stop();
  chrome.tts.resume();

  for (let i = index; i <= last; i++) {
    const opts = {
      rate: s.rate,
      enqueue: i !== index,
      onEvent: (ev) => onTtsEvent(id, i, last, ev)
    };
    if (s.voiceName) opts.voiceName = s.voiceName;
    chrome.tts.speak(s.chunks[i], opts).catch((err) => {
      console.warn('[HearHere] speak failed', err);
      if (session && session.id === id && i === last) finish();
    });
  }
}

function onTtsEvent(id, i, last, ev) {
  if (!session || session.id !== id) return; // event from a replaced/stopped run
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
    default:
      break; // interrupted / cancelled / word / sentence / pause / resume
  }
}

function finish() {
  const s = session;
  session = null;
  if (s) broadcast(s, 'idle');
}

function pause() {
  if (!session || session.status !== 'playing') return;
  chrome.tts.pause();
  session.status = 'paused';
  broadcast();
}

function resume() {
  if (!session || session.status !== 'paused') return;
  if (session.needsRestart) {
    speakFrom(session.index); // speed/voice changed while paused
  } else {
    chrome.tts.resume();
    session.status = 'playing';
  }
  broadcast();
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
  chrome.tts.stop();
  chrome.tts.resume(); // un-stick the engine if it was paused
  if (s) broadcast(s, 'idle');
}

// ---------- talking to tabs ----------
async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch (_) {
    // Content script missing (tab opened before install/reload) — inject and retry.
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
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set(current);

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'hearhere-read',
      title: 'Read aloud with HearHere',
      contexts: ['selection']
    });
  });

  // Make HearHere work in tabs that were already open.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ['src/content.css'] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/content.js'] }).catch(() => {});
  }
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
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'speak':
      speak(msg.text, sender.tab ? sender.tab.id : msg.tabId, msg.reqId || null);
      break;
    case 'pause': pause(); break;
    case 'resume': resume(); break;
    case 'toggle': toggle(); break;
    case 'stop': stop(); break;
    case 'keepalive': break; // keeps the worker (and session state) alive while reading
    case 'getState': {
      // Content scripts only care about sessions in their own tab.
      if (sender.tab && (!session || session.tabId !== sender.tab.id)) {
        sendResponse(stateOf(null));
      } else {
        sendResponse(stateOf(session));
      }
      return;
    }
    case 'readActiveTab':
      activeTab().then(readInTab).then(ok => sendResponse({ ok }));
      return true; // async response
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !session) return;
  let changed = false;
  if (changes.rate) {
    session.rate = Number(changes.rate.newValue) || 1;
    changed = true;
  }
  if (changes.voiceName) {
    session.voiceName = changes.voiceName.newValue || '';
    changed = true;
  }
  if (!changed) return;
  if (session.status === 'playing') speakFrom(session.index); // restart current sentence at new speed
  else session.needsRestart = true;
  broadcast();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session && session.tabId === tabId) stop();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (session && session.tabId === tabId && changeInfo.status === 'loading' && changeInfo.url) stop();
});

// exported for tests
self.__hearhere = { chunkText, RATES };
