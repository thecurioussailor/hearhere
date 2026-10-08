// HearHere — offscreen audio player for cloud voices.
// Generates audio one chunk ahead (never the whole text up front, so stopping early
// doesn't waste credits), plays it, and applies speed locally via playbackRate.
(() => {
  'use strict';

  const PREFETCH_AHEAD = 1;
  const audio = new Audio();
  audio.preservesPitch = true;

  /** @type {null | {
   *  sid:number, chunks:string[], cfg:object, rate:number, budget:number, index:number,
   *  paused:boolean, stopped:boolean, items:Map, ctrl:AbortController,
   *  resumeWaiter:Function|null, finishPlay:Function|null }} */
  let cur = null;

  function emit(run, event, extra = {}) {
    chrome.runtime.sendMessage({ target: 'bg', type: 'cloud-event', sid: run.sid, event, ...extra }).catch(() => {});
  }

  function setRate(rate) {
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function synthesizeWithRetry(run, provider, args) {
    try {
      return await provider.synthesize(args);
    } catch (err) {
      if (run.stopped || HHProviders.isFatal(err) || err.name === 'AbortError') throw err;
      await sleep(err.code === 'rate' ? 1500 : 700);
      if (run.stopped) throw err;
      return provider.synthesize(args); // one retry for network/server/rate errors
    }
  }

  function load(run, i) {
    if (i >= run.chunks.length) return null;
    if (run.items.has(i)) return run.items.get(i);
    const item = { ready: false, promise: null };
    item.promise = (async () => {
      const { cfg } = run;
      const text = run.chunks[i];
      const k = await HHCache.key([cfg.provider, cfg.model, cfg.voice, cfg.instructions || '', text]);
      const cached = await HHCache.get(k);
      if (cached) { item.ready = true; return cached; }
      if (run.stopped) throw Object.assign(new Error('stopped'), { name: 'AbortError' });

      if (run.budget >= 0) {
        if (text.length > run.budget) {
          throw Object.assign(new Error('Daily character limit reached.'), { code: 'limit' });
        }
        run.budget -= text.length;
      }
      const provider = HHProviders.get(cfg.provider);
      const blob = await synthesizeWithRetry(run, provider, {
        apiKey: cfg.apiKey, model: cfg.model, voice: cfg.voice, instructions: cfg.instructions,
        text, prevText: run.chunks[i - 1] || '', nextText: run.chunks[i + 1] || '',
        signal: run.ctrl.signal
      });
      emit(run, 'usage', { chars: text.length, provider: cfg.provider });
      HHCache.put(k, blob);
      item.ready = true;
      return blob;
    })();
    item.promise.catch(() => {}); // avoid unhandled-rejection noise for prefetched chunks
    run.items.set(i, item);
    return item;
  }

  function waitWhilePaused(run) {
    if (!run.paused || run.stopped) return Promise.resolve();
    return new Promise(resolve => { run.resumeWaiter = resolve; });
  }

  function playBlob(run, blob, i) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const cleanup = () => {
        audio.onended = null;
        audio.onerror = null;
        run.finishPlay = null;
        URL.revokeObjectURL(url);
      };
      audio.onended = () => { cleanup(); resolve(); };
      audio.onerror = () => {
        cleanup();
        reject(Object.assign(new Error('The audio could not be played.'), { code: 'playback' }));
      };
      run.finishPlay = () => { cleanup(); resolve(); };
      audio.src = url;
      setRate(run.rate);
      emit(run, 'start', { index: i });
      if (!run.paused) {
        audio.play().catch((err) => {
          if (run.stopped || run.paused) return;
          cleanup();
          reject(Object.assign(new Error(`Playback failed: ${err.message}`), { code: 'playback' }));
        });
      }
    });
  }

  async function play(msg) {
    stopAll();
    const run = {
      sid: msg.sid, chunks: msg.chunks, cfg: msg.cfg, rate: msg.rate || 1,
      budget: typeof msg.budget === 'number' ? msg.budget : -1,
      index: msg.startIndex || 0, paused: false, stopped: false,
      items: new Map(), ctrl: new AbortController(), resumeWaiter: null, finishPlay: null
    };
    cur = run;
    try {
      for (let i = run.index; i < run.chunks.length; i++) {
        if (run.stopped) return;
        run.index = i;
        const item = load(run, i);
        for (let j = 1; j <= PREFETCH_AHEAD; j++) load(run, i + j);
        if (!item.ready) emit(run, 'buffering', { index: i });
        const blob = await item.promise;
        if (run.stopped) return;
        await waitWhilePaused(run);
        if (run.stopped) return;
        await playBlob(run, blob, i);
        run.items.delete(i);
      }
      if (!run.stopped) emit(run, 'done');
    } catch (err) {
      if (run.stopped || (err && err.name === 'AbortError')) return;
      if (err && err.code === 'limit') emit(run, 'limit', { index: run.index });
      else emit(run, 'error', { index: run.index, error: { message: (err && err.message) || 'Unknown error', code: (err && err.code) || 'unknown' } });
    } finally {
      if (cur === run) cur = null;
    }
  }

  function stopAll() {
    const run = cur;
    cur = null;
    audio.pause();
    if (!run) return;
    run.stopped = true;
    run.ctrl.abort();
    if (run.finishPlay) run.finishPlay();
    if (run.resumeWaiter) { const w = run.resumeWaiter; run.resumeWaiter = null; w(); }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    const mine = !!cur && cur.sid === msg.sid;
    switch (msg.type) {
      case 'cloud-play':
        play(msg);
        sendResponse({ ok: true });
        break;
      case 'cloud-pause':
        if (mine) { cur.paused = true; audio.pause(); }
        sendResponse({ ok: mine });
        break;
      case 'cloud-resume':
        if (mine) {
          cur.paused = false;
          if (cur.resumeWaiter) { const w = cur.resumeWaiter; cur.resumeWaiter = null; w(); }
          else if (audio.src && audio.paused && cur.finishPlay) audio.play().catch(() => {});
        }
        sendResponse({ ok: mine });
        break;
      case 'cloud-rate':
        if (cur) { cur.rate = msg.rate; setRate(msg.rate); }
        sendResponse({ ok: true });
        break;
      case 'cloud-stop':
        stopAll();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false });
    }
  });
})();
