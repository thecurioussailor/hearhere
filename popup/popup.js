const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const DEFAULTS = {
  rate: 1, voiceName: '', hoverMode: false, provider: 'system',
  openaiModel: 'gpt-4o-mini-tts', openaiVoice: 'marin', elevenModel: 'eleven_flash_v2_5',
  elevenVoiceId: '', elevenVoiceName: '', dailyCharLimit: 20000
};
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

const ELEVEN_MODEL_NAMES = { eleven_flash_v2_5: 'Flash v2.5', eleven_multilingual_v2: 'Multilingual v2', eleven_v3: 'Eleven v3' };
const $ = (id) => document.getElementById(id);
let state = { status: 'idle' };
let settings = { ...DEFAULTS };
let keys = { openaiKey: '', elevenKey: '' };

const fmtRate = (r) => `${Number(r)}×`;
const fmt = (n) => Number(n || 0).toLocaleString();

function renderState() {
  const s = state.status;
  $('playIcon').innerHTML = s === 'playing' ? ICON_PAUSE : ICON_PLAY;
  $('play').title = s === 'playing' ? 'Pause' : s === 'paused' ? 'Resume' : 'Read selection';
  const busy = !!state.buffering && s === 'playing';
  $('play').classList.toggle('busy', busy);
  $('play').classList.toggle('playing', s === 'playing' && !busy);
  $('stop').disabled = s === 'idle';
  const status = $('status');
  status.textContent = s === 'playing' ? (state.buffering ? 'Getting the voice ready' : 'Reading') : s === 'paused' ? 'Paused' : 'Ready';
  if (s !== 'idle') hint(s === 'paused' ? 'Press play to continue.' : 'Esc on the page stops reading.');
  else if (!$('hint').classList.contains('warn')) hint('Select text on the page, then press play.');
}

function renderRates(current) {
  const wrap = $('rates');
  wrap.innerHTML = '';
  for (const r of RATES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(Math.abs(r - current) < 0.01));
    b.textContent = fmtRate(r);
    b.addEventListener('click', () => { chrome.storage.sync.set({ rate: r }); renderRates(r); });
    wrap.appendChild(b);
  }
  $('rateLabel').textContent = fmtRate(current);
}

function hint(text, warn = false) {
  const h = $('hint');
  h.textContent = text;
  h.classList.toggle('warn', warn);
}

async function renderVoice() {
  const p = settings.provider;
  document.querySelectorAll('#providers button').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.provider === p));
  });
  $('systemVoiceWrap').hidden = p !== 'system';
  $('cloudInfo').hidden = p === 'system';
  const warn = $('cloudWarn');
  warn.hidden = true;
  if (p === 'system') return;

  if (p === 'openai') {
    $('cloudVoice').textContent = cap(settings.openaiVoice);
    $('cloudModel').textContent = settings.openaiModel;
    if (!keys.openaiKey) showWarn('Add your OpenAI API key');
  } else {
    $('cloudVoice').textContent = settings.elevenVoiceName || 'No voice picked';
    $('cloudModel').textContent = ELEVEN_MODEL_NAMES[settings.elevenModel] || settings.elevenModel;
    if (!keys.elevenKey) showWarn('Add your ElevenLabs API key');
    else if (!settings.elevenVoiceId) showWarn('Pick an ElevenLabs voice');
  }
  const { usage } = await chrome.storage.local.get({ usage: null });
  const day = new Date().toLocaleDateString('en-CA');
  const used = usage && usage.day === day ? usage.dayChars || 0 : 0;
  const limit = Number(settings.dailyCharLimit) || 0;
  $('usage').textContent = limit
    ? `${fmt(used)} of ${fmt(limit)} characters used today`
    : `${fmt(used)} characters used today (no daily limit)`;
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  $('meterFill').style.width = `${pct}%`;
  $('meterFill').parentElement.classList.toggle('full', pct >= 100);
  $('meterFill').parentElement.hidden = !limit;
}

function showWarn(text) {
  const warn = $('cloudWarn');
  warn.innerHTML = '';
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = `${text} in voice settings`;
  a.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
  warn.appendChild(a);
  warn.hidden = false;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

function openSettings() {
  const hash = settings.provider === 'system' ? '' : `#${settings.provider}`;
  chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html${hash}`) });
}

async function loadVoices(selected) {
  const sel = $('voice');
  let voices = [];
  try { voices = await chrome.tts.getVoices(); } catch (_) {}
  const uiLang = (navigator.language || 'en').split('-')[0];
  voices.sort((a, b) => {
    const am = (a.lang || '').startsWith(uiLang) ? 0 : 1;
    const bm = (b.lang || '').startsWith(uiLang) ? 0 : 1;
    return am - bm || (a.lang || '').localeCompare(b.lang || '') || a.voiceName.localeCompare(b.voiceName);
  });
  const seen = new Set();
  for (const v of voices) {
    if (!v.voiceName || seen.has(v.voiceName)) continue;
    seen.add(v.voiceName);
    const o = document.createElement('option');
    o.value = v.voiceName;
    o.textContent = v.lang ? `${v.voiceName} (${v.lang})` : v.voiceName;
    sel.appendChild(o);
  }
  sel.value = seen.has(selected) ? selected : '';
}

async function loadShortcuts() {
  const list = $('shortcuts');
  const cmds = await chrome.commands.getAll();
  for (const c of cmds) {
    if (!c.description) continue;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = c.description;
    const k = document.createElement('kbd');
    k.textContent = c.shortcut || 'Not set';
    li.append(name, k);
    list.appendChild(li);
  }
}

async function init() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  keys = await chrome.storage.local.get({ openaiKey: '', elevenKey: '' });
  renderRates(Number(settings.rate) || 1);
  $('hover').checked = !!settings.hoverMode;
  loadVoices(settings.voiceName);
  renderVoice();
  loadShortcuts();
  const st = await chrome.runtime.sendMessage({ type: 'getState' }).catch(() => null);
  if (st) state = st;
  renderState();
}

$('play').addEventListener('click', async () => {
  if (state.status === 'playing') return chrome.runtime.sendMessage({ type: 'pause' });
  if (state.status === 'paused') return chrome.runtime.sendMessage({ type: 'resume' });
  const res = await chrome.runtime.sendMessage({ type: 'readActiveTab' }).catch(() => null);
  if (!res || !res.ok) hint("HearHere can't run on this page (browser pages, Web Store, built-in PDF viewer).", true);
});

$('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop' }));
$('hover').addEventListener('change', (e) => chrome.storage.sync.set({ hoverMode: e.target.checked }));
$('voice').addEventListener('change', (e) => chrome.storage.sync.set({ voiceName: e.target.value }));
document.querySelectorAll('#providers button').forEach(b => {
  b.addEventListener('click', () => chrome.storage.sync.set({ provider: b.dataset.provider }));
});
$('openSettings').addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
$('editShortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'hh-state') { state = msg; renderState(); }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    if (changes.rate) renderRates(Number(changes.rate.newValue) || 1);
    if (changes.hoverMode) $('hover').checked = !!changes.hoverMode.newValue;
  }
  if (area === 'local') {
    for (const k of ['openaiKey', 'elevenKey']) if (changes[k]) keys[k] = changes[k].newValue;
  }
  renderVoice();
});

HHBloom.hydrate();
init();
