// HearHere — content script.
// Select → Read button, Hover Read, highlight, on-page player bar.
(() => {
  'use strict';

  // If an older copy is running (extension reloaded / re-injected), retire it.
  const previous = window.__hearhere;
  if (previous && typeof previous.teardown === 'function') {
    try { previous.teardown(); } catch (_) {}
  }

  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
  const HOVER_DWELL_MS = 450;        // system voice
  const PROVIDER_LABEL = { openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
  const SETTINGS_DEFAULTS = {
    rate: 1, hoverMode: false, provider: 'system',
    confirmOverChars: 3000, hoverMaxChars: 1500, hoverDwellCloudMs: 1000
  };
  const MAX_CHARS = 20000;
  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
    'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'SUMMARY', 'LEGEND'
  ]);
  const BLOCKISH = new Set(['block', 'list-item', 'table-cell', 'flex', 'grid', 'flow-root', 'table-caption']);
  const IGNORE_SELECTOR =
    'input, textarea, select, button, [contenteditable=""], [contenteditable="true"], script, style, noscript, svg';

  const ac = new AbortController();
  const on = (target, type, fn, opts = {}) =>
    target.addEventListener(type, fn, { ...opts, signal: ac.signal });

  let alive = true;
  let status = 'idle';          // idle | playing | paused
  let rate = 1;
  let hoverMode = false;
  let buffering = false;
  const settings = { ...SETTINGS_DEFAULTS };
  let confirmAction = null;
  let lastSkipToastEl = null;
  let currentReq = null;        // id of the reading this tab asked for
  let reqSeq = 0;
  let readingEl = null;         // block being read (highlighted)
  let previewEl = null;         // block under cursor waiting for dwell
  let lastHoverTarget = null;
  let lastHoverBlock = null;
  let dwellTimer = 0;
  let moveRaf = 0;
  let scrollRaf = 0;
  let keepAliveTimer = 0;
  let toastTimer = 0;
  let pendingSelectionText = '';
  const mouse = { x: -1, y: -1 };

  // ---------- messaging ----------
  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function send(msg) {
    if (!contextAlive()) { teardown(); return Promise.resolve(undefined); }
    try {
      return chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch (_) {
      teardown();
      return Promise.resolve(undefined);
    }
  }

  // ---------- UI (shadow DOM so page CSS can't touch it) ----------
  function bloomSvg(petals, color, center, cls = '') {
    const g = { 6: [26, 21, 24], 12: [37, 12.5, 39] }[petals];
    let out = `<svg class="bloom ${cls}" viewBox="0 0 100 100" aria-hidden="true"><g class="petals" fill="${color}">`;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * 2 * Math.PI - Math.PI / 2;
      out += `<circle cx="${(50 + g[0] * Math.cos(a)).toFixed(2)}" cy="${(50 + g[0] * Math.sin(a)).toFixed(2)}" r="${g[1]}"/>`;
    }
    out += `<circle cx="50" cy="50" r="${g[2]}"/></g>`;
    if (center) out += `<circle cx="50" cy="50" r="10" fill="${center}"/>`;
    return `${out}</svg>`;
  }

  const ICON = {
    speaker: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15.5 8.2a5 5 0 0 1 0 7.6l-1.3-1.5a3 3 0 0 0 0-4.6z"/><path d="M17.9 5.4a9 9 0 0 1 0 13.2l-1.3-1.5a7 7 0 0 0 0-10.2z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
  };

  const host = document.createElement('hearhere-ui');
  host.setAttribute('style',
    'all:initial !important;position:fixed !important;top:0 !important;left:0 !important;' +
    'width:0 !important;height:0 !important;z-index:2147483647 !important;');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      [hidden] { display: none !important; }
      button { all: unset; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: inherit; }
      button:focus-visible { outline: 2px solid #8c9dff; outline-offset: 2px; }
      svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
      .read {
        position: fixed; height: 32px; padding: 0 14px 0 8px; gap: 7px; border-radius: 999px;
        background: #24204a; color: #fff8fc; font-size: 13px; font-weight: 600;
        box-shadow: 0 8px 24px rgba(36,32,74,.28);
        animation: pop .16s ease-out;
      }
      .read .bloom { width: 20px; height: 20px; transition: transform .3s ease; }
      .read:hover .bloom { transform: rotate(30deg); }
      .bar {
        position: fixed; right: 20px; bottom: 20px; display: flex; align-items: center; gap: 2px;
        padding: 5px 8px 5px 5px; border-radius: 999px; background: #24204a; color: #fff8fc;
        box-shadow: 0 12px 32px rgba(36,32,74,.32);
        animation: pop .18s ease-out;
      }
      .bar button { width: 34px; height: 34px; border-radius: 999px; }
      .bar button:hover { background: rgba(255,248,252,.12); }
      .bar button.main { position: relative; width: 44px; height: 44px; color: #24204a; }
      .bar button.main:hover { background: none; }
      .bar button.main .bloom { position: absolute; inset: 0; width: 44px; height: 44px; transform-origin: 50% 50%; transition: transform .2s ease; }
      .bar button.main:hover .bloom { transform: scale(1.06); }
      .bar button.main .glyph { position: relative; display: inline-flex; }
      .bar.playing button.main .bloom { animation: spin 14s linear infinite; }
      .bar button.main.busy .bloom { animation: breathe 1.1s ease-in-out infinite; }
      .bar button.step { font-size: 18px; font-weight: 500; line-height: 1; }
      .bar button[disabled] { opacity: .35; pointer-events: none; }
      .rate { min-width: 44px; text-align: center; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .sep { width: 1px; height: 18px; background: rgba(255,248,252,.2); margin: 0 4px; }
      .toast {
        position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%);
        padding: 9px 16px; border-radius: 14px; background: #24204a; color: #fff8fc;
        font-size: 13px; max-width: min(520px, calc(100vw - 32px)); text-align: center;
        box-shadow: 0 10px 28px rgba(36,32,74,.28); animation: fade .16s ease-out;
      }
      .confirm {
        position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%); width: min(360px, calc(100vw - 32px));
        padding: 16px; border-radius: 20px; background: #24204a; color: #fff8fc;
        box-shadow: 0 14px 36px rgba(36,32,74,.34); animation: fade .16s ease-out; font-size: 13px; line-height: 1.45;
      }
      .confirm p { margin: 0 0 12px; }
      .confirm .msg { font-size: 14px; font-weight: 600; }
      .confirm .sub { color: rgba(255,248,252,.65); font-size: 12px; margin-top: -8px; }
      .confirm .actions { display: flex; justify-content: flex-end; gap: 8px; }
      .confirm button { height: 32px; padding: 0 16px; border-radius: 999px; font-size: 13px; font-weight: 600; }
      .confirm .cancel { background: rgba(255,248,252,.12); }
      .confirm .cancel:hover { background: rgba(255,248,252,.2); }
      .confirm .ok { background: #f27268; color: #24204a; }
      .confirm .ok:hover { background: #f58a81; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes breathe { 50% { transform: scale(.88) rotate(15deg); } }
      @keyframes pop { from { transform: scale(.9); opacity: 0; } }
      @keyframes fade { from { opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
    </style>
    <button class="read" type="button" title="Read aloud (Alt+Shift+R)" hidden>${bloomSvg(6, '#f27268', '#24204a')}<span>Read</span></button>
    <div class="bar" role="toolbar" aria-label="HearHere controls" hidden>
      <button class="main" data-act="toggle" type="button" title="Pause (Alt+Shift+Space)">${bloomSvg(12, '#f27268')}<span class="glyph"></span></button>
      <button data-act="stop" type="button" title="Stop (Esc)">${ICON.stop}</button>
      <span class="sep"></span>
      <button class="step" data-act="slower" type="button" title="Slower">−</button>
      <span class="rate">1×</span>
      <button class="step" data-act="faster" type="button" title="Faster">+</button>
    </div>
    <div class="toast" role="status" hidden></div>
    <div class="confirm" role="dialog" aria-modal="false" hidden>
      <p class="msg"></p>
      <p class="sub">This uses your API credits.</p>
      <div class="actions">
        <button class="cancel" type="button">Cancel</button>
        <button class="ok" type="button">Read</button>
      </div>
    </div>
  `;
  const readBtn = root.querySelector('.read');
  const bar = root.querySelector('.bar');
  const toggleBtn = bar.querySelector('[data-act="toggle"]');
  const toggleGlyph = toggleBtn.querySelector('.glyph');
  const slowerBtn = bar.querySelector('[data-act="slower"]');
  const fasterBtn = bar.querySelector('[data-act="faster"]');
  const rateLabel = bar.querySelector('.rate');
  const toastEl = root.querySelector('.toast');
  const confirmEl = root.querySelector('.confirm');
  const confirmMsg = confirmEl.querySelector('.msg');
  document.documentElement.appendChild(host);

  const fmtRate = (r) => `${Number(r).toString()}×`;

  function renderBar() {
    bar.hidden = status === 'idle';
    const paused = status === 'paused';
    toggleGlyph.innerHTML = paused ? ICON.play : ICON.pause;
    bar.classList.toggle('playing', status === 'playing' && !buffering);
    toggleBtn.title = paused ? 'Resume (Alt+Shift+Space)' : 'Pause (Alt+Shift+Space)';
    toggleBtn.classList.toggle('busy', buffering && status === 'playing');
    if (buffering && status === 'playing') toggleBtn.title = 'Getting the voice ready';
    rateLabel.textContent = fmtRate(rate);
    const idx = rateIndex(rate);
    slowerBtn.disabled = idx <= 0;
    fasterBtn.disabled = idx >= RATES.length - 1;
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, Math.min(6000, 2000 + text.length * 30));
  }

  // ---------- highlights ----------
  function setReadingEl(el) {
    if (readingEl === el) return;
    if (readingEl) readingEl.classList.remove('hearhere-reading');
    readingEl = el || null;
    if (readingEl) readingEl.classList.add('hearhere-reading');
  }

  function setPreviewEl(el) {
    if (previewEl === el) return;
    if (previewEl) previewEl.classList.remove('hearhere-preview');
    previewEl = el || null;
    if (previewEl) previewEl.classList.add('hearhere-preview');
  }

  // ---------- reading ----------
  function speakText(text, el) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
    currentReq = `${Date.now().toString(36)}-${++reqSeq}`;
    setReadingEl(el || null);
    send({ type: 'speak', text, reqId: currentReq });
  }

  const isCloud = () => settings.provider === 'openai' || settings.provider === 'elevenlabs';

  function showConfirm(text, onOk) {
    confirmMsg.textContent = text;
    confirmAction = onOk;
    confirmEl.hidden = false;
    confirmEl.querySelector('.ok').focus({ preventScroll: true });
  }

  function closeConfirm(run) {
    const action = confirmAction;
    confirmAction = null;
    confirmEl.hidden = true;
    if (run && action) action();
  }

  // Explicit reads (button, shortcut). Long reads with a paid voice ask first.
  function requestRead(text, el) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const limit = Number(settings.confirmOverChars) || 0;
    if (isCloud() && limit > 0 && clean.length > limit) {
      const n = Math.min(clean.length, MAX_CHARS).toLocaleString();
      showConfirm(`Read ${n} characters with ${PROVIDER_LABEL[settings.provider]}?`, () => speakText(clean, el));
      return;
    }
    speakText(clean, el);
  }

  function applyState(msg) {
    if (!msg) return;
    // Ignore "finished" notices from a reading we've already replaced.
    if (msg.status === 'idle' && msg.reqId !== currentReq && status === 'idle') return;
    if (msg.status === 'idle' && msg.reqId && msg.reqId !== currentReq) return;
    if (msg.status !== 'idle' && msg.reqId !== currentReq) {
      // Reading started elsewhere (context menu, or this page after re-injection).
      setReadingEl(null);
      currentReq = msg.reqId || null;
    }
    status = msg.status;
    buffering = !!msg.buffering;
    if (typeof msg.rate === 'number') rate = msg.rate;
    if (status === 'idle') {
      setReadingEl(null);
      currentReq = null;
    }
    renderBar();
    updateKeepAlive();
  }

  function updateKeepAlive() {
    if (status !== 'idle' && !keepAliveTimer) {
      keepAliveTimer = setInterval(() => send({ type: 'keepalive' }), 20000);
    } else if (status === 'idle' && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = 0;
    }
  }

  function rateIndex(r) {
    let best = 0;
    RATES.forEach((v, i) => { if (Math.abs(v - r) < Math.abs(RATES[best] - r)) best = i; });
    return best;
  }

  function stepRate(dir) {
    const idx = Math.min(RATES.length - 1, Math.max(0, rateIndex(rate) + dir));
    rate = RATES[idx];
    renderBar();
    try { chrome.storage.sync.set({ rate }); } catch (_) { teardown(); }
  }

  // ---------- selection ----------
  function getSelectionInfo() {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' ||
        (ae.tagName === 'INPUT' && /^(text|search|url|email|tel)$/i.test(ae.type || 'text')))) {
      try {
        const s = ae.selectionStart, e = ae.selectionEnd;
        if (s != null && e != null && e > s) {
          const text = ae.value.slice(s, e);
          if (text.trim()) return { text, rect: ae.getBoundingClientRect() };
        }
      } catch (_) {}
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    const range = sel.getRangeAt(sel.rangeCount - 1);
    const rects = Array.from(range.getClientRects()).filter(r => r.width || r.height);
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return { text, rect };
  }

  function showReadButton() {
    const info = getSelectionInfo();
    if (!info) return hideReadButton();
    pendingSelectionText = info.text;
    const r = info.rect;
    const bw = 84, bh = 32, pad = 8;
    const left = Math.min(Math.max(pad, r.right - bw / 2), window.innerWidth - bw - pad);
    let top = r.bottom + pad;
    if (top + bh > window.innerHeight - pad) top = Math.max(pad, r.top - bh - pad);
    readBtn.style.left = `${left}px`;
    readBtn.style.top = `${top}px`;
    readBtn.hidden = false;
  }

  function hideReadButton() {
    readBtn.hidden = true;
    pendingSelectionText = '';
  }

  // ---------- hover read ----------
  function hasDirectText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim().length > 1) return true;
    }
    return false;
  }

  // A "leaf" block: block-level box whose text lives in inline children, not nested blocks.
  function isTextLeafBlock(el) {
    if (!BLOCKISH.has(getComputedStyle(el).display)) return false;
    let hasText = hasDirectText(el);
    for (const c of el.children) {
      const d = getComputedStyle(c).display;
      if (d === 'none') continue;
      const txt = c.textContent.trim();
      if (!txt) continue;
      if (BLOCKISH.has(d) || BLOCK_TAGS.has(c.tagName)) return false;
      hasText = true;
    }
    return hasText;
  }

  function isReadable(el) {
    const t = (el.innerText || '').trim();
    return t.length >= 2 && t.length <= MAX_CHARS;
  }

  function findBlock(start) {
    if (!(start instanceof Element) || start === host) return null;
    if (start.closest(IGNORE_SELECTOR)) return null;
    for (let el = start, depth = 0; el && depth < 15; el = el.parentElement, depth++) {
      if (el === document.body || el === document.documentElement) return null;
      if (BLOCK_TAGS.has(el.tagName) || isTextLeafBlock(el)) {
        return isReadable(el) ? el : null;
      }
    }
    return null;
  }

  function handleHover(target) {
    if (!hoverMode || !target || target === host) return;
    if (target === lastHoverTarget) return;
    lastHoverTarget = target;
    const block = findBlock(target);
    if (block === lastHoverBlock) return;
    lastHoverBlock = block;
    clearTimeout(dwellTimer);
    setPreviewEl(block && block !== readingEl ? block : null);
    if (!block || block === readingEl) return;
    const cloud = isCloud();
    const dwell = cloud ? Math.max(300, Number(settings.hoverDwellCloudMs) || 1000) : HOVER_DWELL_MS;
    dwellTimer = setTimeout(() => {
      if (!hoverMode || lastHoverBlock !== block || !block.isConnected) return;
      const text = (block.innerText || '').replace(/\s+/g, ' ').trim();
      const cap = Number(settings.hoverMaxChars) || 0;
      if (cloud && cap > 0 && text.length > cap) {
        // Cost guard: don't spend credits on huge blocks just because the cursor passed by.
        if (lastSkipToastEl !== block) toast('Long block: select it or press Alt+Shift+R to read it');
        lastSkipToastEl = block;
        return;
      }
      setPreviewEl(null);
      speakText(text, block);
    }, dwell);
  }

  function setHoverMode(value, announce) {
    hoverMode = !!value;
    if (!hoverMode) {
      clearTimeout(dwellTimer);
      setPreviewEl(null);
      lastHoverBlock = null;
      lastHoverTarget = null;
    }
    if (announce && document.visibilityState === 'visible') {
      toast(hoverMode ? 'Hover Read is on. Rest your cursor on text to hear it.' : 'Hover Read is off.');
    }
  }

  function blockUnderCursor() {
    if (mouse.x < 0) return null;
    return findBlock(document.elementFromPoint(mouse.x, mouse.y));
  }

  // ---------- commands ----------
  function runCommand(command) {
    if (command === 'read-selection') {
      const info = getSelectionInfo();
      if (info) {
        hideReadButton();
        requestRead(info.text, null);
        return;
      }
      const el = blockUnderCursor();
      if (el) requestRead(el.innerText, el);
      else toast('Select some text (or point at a paragraph) first');
    }
  }

  // ---------- event wiring ----------
  const fromUI = (e) => e.composedPath().includes(host);

  on(readBtn, 'mousedown', (e) => e.preventDefault()); // keep the selection
  on(readBtn, 'click', (e) => {
    e.preventDefault();
    const text = pendingSelectionText;
    hideReadButton();
    requestRead(text, null);
  });

  on(confirmEl, 'mousedown', (e) => e.preventDefault());
  on(confirmEl.querySelector('.ok'), 'click', () => closeConfirm(true));
  on(confirmEl.querySelector('.cancel'), 'click', () => closeConfirm(false));

  on(bar, 'mousedown', (e) => e.preventDefault());
  on(bar, 'click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'toggle': send({ type: 'toggle' }); break;
      case 'stop': send({ type: 'stop' }); break;
      case 'slower': stepRate(-1); break;
      case 'faster': stepRate(1); break;
    }
  });

  on(document, 'mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (!hoverMode || e.buttons) return;
    const t = e.target;
    if (moveRaf) cancelAnimationFrame(moveRaf);
    moveRaf = requestAnimationFrame(() => { moveRaf = 0; handleHover(t); });
  }, { passive: true, capture: true });

  on(document, 'mousedown', (e) => {
    if (fromUI(e)) return;
    clearTimeout(dwellTimer);
    hideReadButton();
  }, { capture: true });

  on(document, 'mouseup', (e) => {
    if (fromUI(e)) return;
    setTimeout(showReadButton, 10);
  }, { capture: true });

  on(document, 'keyup', (e) => {
    if (e.key === 'Shift' || e.shiftKey || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a')) {
      setTimeout(showReadButton, 10);
    }
  }, { capture: true });

  on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && !confirmEl.hidden) { closeConfirm(false); return; }
    if (e.key === 'Escape' && status !== 'idle') send({ type: 'stop' });
  }, { capture: true });

  on(document, 'selectionchange', () => {
    if (!readBtn.hidden && !getSelectionInfo()) hideReadButton();
  });

  on(window, 'scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!readBtn.hidden) showReadButton();
      if (hoverMode && mouse.x >= 0) handleHover(document.elementFromPoint(mouse.x, mouse.y));
    });
  }, { passive: true, capture: true });

  function onMessage(msg) {
    if (!alive || !msg || typeof msg !== 'object') return;
    if (msg.type === 'hh-state') applyState(msg);
    else if (msg.type === 'hh-command') runCommand(msg.command);
    else if (msg.type === 'hh-toast' && msg.text) toast(msg.text);
  }

  function onStorage(changes, area) {
    if (!alive || area !== 'sync') return;
    if (changes.rate) { rate = Number(changes.rate.newValue) || 1; renderBar(); }
    for (const k of ['provider', 'confirmOverChars', 'hoverMaxChars', 'hoverDwellCloudMs']) {
      if (changes[k]) settings[k] = changes[k].newValue;
    }
    if (changes.hoverMode) setHoverMode(changes.hoverMode.newValue, true);
  }

  // ---------- lifecycle ----------
  function teardown() {
    if (!alive) return;
    alive = false;
    ac.abort();
    clearTimeout(dwellTimer);
    clearTimeout(toastTimer);
    clearInterval(keepAliveTimer);
    if (moveRaf) cancelAnimationFrame(moveRaf);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    setPreviewEl(null);
    setReadingEl(null);
    host.remove();
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (_) {}
    try { chrome.storage.onChanged.removeListener(onStorage); } catch (_) {}
    if (window.__hearhere === api) window.__hearhere = null;
  }

  const api = { teardown };
  window.__hearhere = api;

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  chrome.storage.sync.get(SETTINGS_DEFAULTS).then((s) => {
    Object.assign(settings, s);
    rate = Number(s.rate) || 1;
    hoverMode = !!s.hoverMode;
    renderBar();
  }).catch(() => {});
  send({ type: 'getState' }).then(applyState);
  renderBar();
})();
