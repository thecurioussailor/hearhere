// HearHere — settings page.
const DEFAULTS = {
  provider: 'system',
  openaiModel: 'gpt-4o-mini-tts', openaiVoice: 'marin', openaiInstructions: '',
  elevenModel: 'eleven_flash_v2_5', elevenVoiceId: '', elevenVoiceName: '',
  dailyCharLimit: 20000, confirmOverChars: 3000, hoverMaxChars: 1500, hoverDwellCloudMs: 1000
};
const LOCAL_DEFAULTS = { openaiKey: '', elevenKey: '', elevenVoices: [], usage: null };
const SAMPLE = "Hi! This is how HearHere sounds with this voice. Select any text on a page, and I'll read it to you.";

const $ = (id) => document.getElementById(id);
const { openai, elevenlabs } = HHProviders;
let sync = { ...DEFAULTS };
let local = { ...LOCAL_DEFAULTS };
let sampleAudio = null;

// ---------- helpers ----------
let savedTimer = 0;
function flashSaved() {
  const el = $('saved');
  el.textContent = 'Saved';
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

async function saveSync(patch) {
  Object.assign(sync, patch);
  await chrome.storage.sync.set(patch);
  flashSaved();
}

async function saveLocal(patch) {
  Object.assign(local, patch);
  await chrome.storage.local.set(patch);
  flashSaved();
}

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
}

function fillSelect(sel, items, value) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.label || it.name;
    sel.appendChild(o);
  }
  if (items.some(i => i.id === value)) sel.value = value;
}

function playBlob(blob) {
  stopSample();
  sampleAudio = new Audio(URL.createObjectURL(blob));
  return sampleAudio.play();
}

function stopSample() {
  if (sampleAudio) { sampleAudio.pause(); URL.revokeObjectURL(sampleAudio.src); sampleAudio = null; }
}

const fmt = (n) => Number(n || 0).toLocaleString();
const fmtBytes = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

// ---------- engine ----------
function renderProvider() {
  document.querySelectorAll('input[name="provider"]').forEach(r => { r.checked = r.value === sync.provider; });
  document.querySelectorAll('.provider').forEach(c => c.classList.toggle('active', c.dataset.provider === sync.provider));
}

document.querySelectorAll('input[name="provider"]').forEach(r => {
  r.addEventListener('change', () => { saveSync({ provider: r.value }); renderProvider(); });
});

// ---------- key fields ----------
document.querySelectorAll('[data-toggle]').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.toggle);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
  });
});

$('openaiKey').addEventListener('change', async (e) => {
  await saveLocal({ openaiKey: e.target.value.trim() });
  e.target.value = local.openaiKey;
  setStatus('openaiStatus', local.openaiKey ? 'Key saved. Press "Play sample" to check it.' : '');
});

$('elevenKey').addEventListener('change', async (e) => {
  await saveLocal({ elevenKey: e.target.value.trim() });
  e.target.value = local.elevenKey;
  if (local.elevenKey) loadElevenVoices();
  else fillElevenVoices([]);
});

// ---------- OpenAI ----------
function renderOpenAI() {
  fillSelect($('openaiModel'), openai.models, sync.openaiModel);
  const voices = openai.voicesFor(sync.openaiModel);
  if (!voices.some(v => v.id === sync.openaiVoice)) {
    sync.openaiVoice = voices[0].id;
    chrome.storage.sync.set({ openaiVoice: sync.openaiVoice });
  }
  fillSelect($('openaiVoice'), voices, sync.openaiVoice);
  $('openaiInstructions').value = sync.openaiInstructions;
  $('openaiInstructionsWrap').hidden = !openai.supportsInstructions(sync.openaiModel);
}

$('openaiModel').addEventListener('change', async (e) => { await saveSync({ openaiModel: e.target.value }); renderOpenAI(); });
$('openaiVoice').addEventListener('change', (e) => saveSync({ openaiVoice: e.target.value }));
$('openaiInstructions').addEventListener('change', (e) => saveSync({ openaiInstructions: e.target.value.trim() }));

$('openaiTest').addEventListener('click', () => runSample('openai', {
  apiKey: local.openaiKey, model: sync.openaiModel, voice: sync.openaiVoice, instructions: sync.openaiInstructions
}, 'openaiStatus', 'openaiTest'));

// ---------- ElevenLabs ----------
function fillElevenVoices(voices) {
  const sel = $('elevenVoice');
  sel.innerHTML = '';
  if (!voices.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = local.elevenKey ? 'No voices found' : 'Add your key to load voices';
    sel.appendChild(o);
    return;
  }
  const mine = voices.filter(v => v.category && v.category !== 'premade');
  const premade = voices.filter(v => !v.category || v.category === 'premade');
  const addGroup = (label, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      const tags = [v.labels.accent, v.labels.gender, v.labels.description || v.labels.descriptive].filter(Boolean).join(', ');
      o.textContent = tags ? `${v.name} (${tags})` : v.name;
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  addGroup('Your voices', mine);
  addGroup('ElevenLabs voices', premade);
  if (!voices.some(v => v.id === sync.elevenVoiceId)) {
    const first = voices[0];
    saveSync({ elevenVoiceId: first.id, elevenVoiceName: first.name });
  }
  sel.value = sync.elevenVoiceId;
}

async function loadElevenVoices() {
  if (!local.elevenKey) return;
  setStatus('elevenStatus', 'Loading voices…');
  $('elevenReload').disabled = true;
  try {
    const voices = await elevenlabs.listVoices(local.elevenKey);
    await saveLocal({ elevenVoices: voices });
    fillElevenVoices(voices);
    setStatus('elevenStatus', `✓ Key works. ${voices.length} voices loaded.`, 'ok');
  } catch (err) {
    setStatus('elevenStatus', `✕ ${err.message}`, 'err');
  } finally {
    $('elevenReload').disabled = false;
  }
}

function renderEleven() {
  fillSelect($('elevenModel'), elevenlabs.models, sync.elevenModel);
  fillElevenVoices(local.elevenVoices || []);
}

$('elevenVoice').addEventListener('change', (e) => {
  const v = (local.elevenVoices || []).find(x => x.id === e.target.value);
  saveSync({ elevenVoiceId: e.target.value, elevenVoiceName: v ? v.name : '' });
});
$('elevenModel').addEventListener('change', (e) => saveSync({ elevenModel: e.target.value }));
$('elevenReload').addEventListener('click', loadElevenVoices);
$('elevenPreview').addEventListener('click', () => {
  const v = (local.elevenVoices || []).find(x => x.id === $('elevenVoice').value);
  if (!v || !v.previewUrl) return setStatus('elevenStatus', 'This voice has no free preview. Use Play sample instead.');
  stopSample();
  sampleAudio = new Audio(v.previewUrl);
  sampleAudio.play().catch(() => setStatus('elevenStatus', 'Could not play the preview.', 'err'));
  setStatus('elevenStatus', `Previewing ${v.name} (free, uses no credits)`);
});

$('elevenTest').addEventListener('click', () => runSample('elevenlabs', {
  apiKey: local.elevenKey, model: sync.elevenModel, voice: sync.elevenVoiceId
}, 'elevenStatus', 'elevenTest'));

// ---------- sample ----------
async function runSample(providerId, cfg, statusId, btnId) {
  if (!cfg.apiKey) return setStatus(statusId, 'Paste your API key first.', 'err');
  const provider = HHProviders.get(providerId);
  const btn = $(btnId);
  btn.disabled = true;
  setStatus(statusId, 'Generating…');
  try {
    const parts = [providerId, cfg.model, cfg.voice, cfg.instructions || '', SAMPLE];
    const k = await HHCache.key(parts);
    let blob = await HHCache.get(k);
    if (!blob) {
      blob = await provider.synthesize({ ...cfg, text: SAMPLE });
      HHCache.put(k, blob);
      chrome.runtime.sendMessage({ type: 'addUsage', chars: SAMPLE.length, provider: providerId }).catch(() => {});
    }
    await playBlob(blob);
    setStatus(statusId, '✓ Key works. Playing sample.', 'ok');
  } catch (err) {
    setStatus(statusId, `✕ ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    refreshStats();
  }
}

// ---------- guards ----------
const GUARDS = ['dailyCharLimit', 'confirmOverChars', 'hoverMaxChars', 'hoverDwellCloudMs'];
function renderGuards() { GUARDS.forEach(k => { $(k).value = sync[k]; }); }
GUARDS.forEach(k => {
  $(k).addEventListener('change', (e) => {
    let v = Math.max(0, Math.round(Number(e.target.value) || 0));
    if (k === 'hoverDwellCloudMs') v = Math.max(300, v || DEFAULTS.hoverDwellCloudMs);
    e.target.value = v;
    saveSync({ [k]: v });
  });
});

// ---------- usage & cache ----------
function normUsage(u) {
  const day = new Date().toLocaleDateString('en-CA');
  u = u || {};
  return {
    dayChars: u.day === day ? u.dayChars || 0 : 0,
    monthChars: u.month === day.slice(0, 7) ? u.monthChars || 0 : 0,
    monthByProvider: u.month === day.slice(0, 7) ? u.monthByProvider || {} : {}
  };
}

async function refreshStats() {
  const { usage } = await chrome.storage.local.get({ usage: null });
  const u = normUsage(usage);
  const limit = Number(sync.dailyCharLimit) || 0;
  $('usageToday').textContent = limit ? `${fmt(u.dayChars)} of ${fmt(limit)}` : fmt(u.dayChars);
  const pct = limit ? Math.min(100, (u.dayChars / limit) * 100) : 0;
  $('usageMeterFill').style.width = `${pct}%`;
  $('usageMeter').hidden = !limit;
  $('usageMeter').classList.toggle('full', pct >= 100);
  $('usageMonth').textContent = fmt(u.monthChars);
  const parts = Object.entries(u.monthByProvider).map(([p, n]) => `${p === 'openai' ? 'OpenAI' : p === 'elevenlabs' ? 'ElevenLabs' : p}: ${fmt(n)}`);
  $('usageBreakdown').textContent = parts.length ? `This month by provider: ${parts.join(', ')}.` : '';
  const c = await HHCache.stats();
  $('cacheCount').textContent = `${fmt(c.count)} ${c.count === 1 ? 'clip' : 'clips'}`;
  $('cacheSize').textContent = `Cached audio (${fmtBytes(c.bytes)})`;
}

$('cacheClear').addEventListener('click', async () => {
  await HHCache.clear();
  refreshStats();
  flashSaved();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.usage) refreshStats();
  if (area === 'sync' && changes.provider) { sync.provider = changes.provider.newValue; renderProvider(); }
});

// ---------- init ----------
HHBloom.hydrate();
(async () => {
  sync = await chrome.storage.sync.get(DEFAULTS);
  local = await chrome.storage.local.get(LOCAL_DEFAULTS);
  $('openaiKey').value = local.openaiKey;
  $('elevenKey').value = local.elevenKey;
  renderProvider();
  renderOpenAI();
  renderEleven();
  renderGuards();
  refreshStats();
  if (location.hash === '#elevenlabs' || location.hash === '#openai') {
    document.querySelector(`.provider[data-provider="${location.hash.slice(1)}"]`)?.scrollIntoView();
  }
})();
