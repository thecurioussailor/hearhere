const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const DEFAULTS = { rate: 1, voiceName: '', hoverMode: false };
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

const $ = (id) => document.getElementById(id);
let state = { status: 'idle' };

function fmtRate(r) { return `${Number(r)}×`; }

function renderState() {
  const s = state.status;
  $('play').innerHTML = s === 'playing' ? ICON_PAUSE : ICON_PLAY;
  $('play').title = s === 'playing' ? 'Pause' : s === 'paused' ? 'Resume' : 'Read selection';
  $('stop').disabled = s === 'idle';
  const status = $('status');
  status.textContent = s === 'playing' ? 'Reading…' : s === 'paused' ? 'Paused' : 'Ready';
  status.classList.toggle('live', s !== 'idle');
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
    b.addEventListener('click', () => {
      chrome.storage.sync.set({ rate: r });
      renderRates(r);
    });
    wrap.appendChild(b);
  }
  $('rateLabel').textContent = fmtRate(current);
}

function hint(text, warn = false) {
  const h = $('hint');
  h.textContent = text;
  h.classList.toggle('warn', warn);
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
    if (!c.description) continue; // skip _execute_action
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
  const s = await chrome.storage.sync.get(DEFAULTS);
  renderRates(Number(s.rate) || 1);
  $('hover').checked = !!s.hoverMode;
  loadVoices(s.voiceName);
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

$('editShortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'hh-state') {
    state = msg;
    renderState();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.rate) renderRates(Number(changes.rate.newValue) || 1);
  if (changes.hoverMode) $('hover').checked = !!changes.hoverMode.newValue;
});

init();
