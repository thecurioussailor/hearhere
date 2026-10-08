// HearHere — cloud voice providers (shared by the offscreen player and the settings page).
// Each provider: synthesize({ apiKey, model, voice, instructions, text, prevText, nextText, signal }) -> Blob
(() => {
  'use strict';

  class ProviderError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = 'ProviderError';
      this.code = code;       // auth | quota | rate | bad-request | server | network
      this.status = status || 0;
    }
  }

  const FATAL = new Set(['auth', 'quota', 'bad-request']);
  const isFatal = (err) => !!err && FATAL.has(err.code);

  async function safeJson(res) {
    try { return await res.json(); } catch (_) { return null; }
  }

  async function doFetch(url, init) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new ProviderError('Network error. Check your connection.', 'network');
    }
  }

  // ---------------- OpenAI ----------------
  const OPENAI_ALL_VOICES = [
    'marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'
  ];
  const OPENAI_CLASSIC_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

  const openai = {
    id: 'openai',
    label: 'OpenAI',
    keyHint: 'Starts with sk-…  Get one at platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts: most natural, accepts a speaking style' },
      { id: 'tts-1', label: 'tts-1: fastest, cheapest' },
      { id: 'tts-1-hd', label: 'tts-1-hd: higher fidelity' }
    ],
    defaultModel: 'gpt-4o-mini-tts',
    defaultVoice: 'marin',
    supportsInstructions: (model) => /^gpt-4o/.test(model || ''),
    voicesFor(model) {
      const ids = /^tts-1/.test(model || '') ? OPENAI_CLASSIC_VOICES : OPENAI_ALL_VOICES;
      return ids.map(id => ({
        id,
        name: id[0].toUpperCase() + id.slice(1) + (id === 'marin' || id === 'cedar' ? ' (recommended)' : '')
      }));
    },
    async synthesize({ apiKey, model, voice, instructions, text, signal }) {
      const body = { model: model || 'gpt-4o-mini-tts', voice: voice || 'marin', input: text, response_format: 'mp3' };
      if (instructions && openai.supportsInstructions(body.model)) body.instructions = instructions;
      const res = await doFetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) throw await openaiError(res);
      return res.blob();
    }
  };

  async function openaiError(res) {
    const b = await safeJson(res);
    const msg = (b && b.error && b.error.message) || res.statusText || 'Unknown error';
    const code = b && b.error && b.error.code;
    if (res.status === 401) return new ProviderError('Invalid API key.', 'auth', 401);
    if (res.status === 403) return new ProviderError(`Access denied: ${msg}`, 'auth', 403);
    if (res.status === 429) {
      return code === 'insufficient_quota'
        ? new ProviderError('Your OpenAI account is out of credits.', 'quota', 429)
        : new ProviderError('Rate limit hit. Slow down a little.', 'rate', 429);
    }
    if (res.status === 400 || res.status === 404) return new ProviderError(msg, 'bad-request', res.status);
    return new ProviderError(`Server error (${res.status}).`, 'server', res.status);
  }

  // ---------------- ElevenLabs ----------------
  const elevenlabs = {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    keyHint: 'From elevenlabs.io → Developers → API keys (needs Text to Speech + Voices read access)',
    models: [
      { id: 'eleven_flash_v2_5', label: 'Flash v2.5: fast, half the credits' },
      { id: 'eleven_multilingual_v2', label: 'Multilingual v2: richest, most stable' },
      { id: 'eleven_v3', label: 'Eleven v3: most expressive' }
    ],
    defaultModel: 'eleven_flash_v2_5',
    supportsInstructions: () => false,
    async listVoices(apiKey) {
      const out = [];
      let token = null;
      for (let page = 0; page < 5; page++) {
        const url = new URL('https://api.elevenlabs.io/v2/voices');
        url.searchParams.set('page_size', '100');
        url.searchParams.set('include_total_count', 'false');
        if (token) url.searchParams.set('next_page_token', token);
        const res = await doFetch(url, { headers: { 'xi-api-key': apiKey } });
        if (!res.ok) throw await elevenError(res);
        const data = await res.json();
        for (const v of data.voices || []) {
          out.push({
            id: v.voice_id,
            name: v.name,
            category: v.category || '',
            previewUrl: v.preview_url || '',
            labels: v.labels || {}
          });
        }
        if (!data.has_more || !data.next_page_token) break;
        token = data.next_page_token;
      }
      return out;
    },
    async synthesize({ apiKey, model, voice, text, prevText, nextText, signal }) {
      if (!voice) throw new ProviderError('No voice selected.', 'bad-request');
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
      const body = { text, model_id: model || 'eleven_flash_v2_5' };
      // Neighbouring text keeps intonation continuous across chunks.
      if (body.model_id !== 'eleven_v3') {
        if (prevText) body.previous_text = prevText.slice(-300);
        if (nextText) body.next_text = nextText.slice(0, 300);
      }
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) throw await elevenError(res);
      return res.blob();
    }
  };

  async function elevenError(res) {
    const b = await safeJson(res);
    let detail = b && b.detail;
    let status = '';
    let msg = '';
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      status = detail.status || detail.code || '';
      msg = detail.message || '';
    } else if (typeof detail === 'string') {
      msg = detail;
    } else if (Array.isArray(detail) && detail[0]) {
      msg = detail[0].msg || '';
    }
    if (/quota|credit/i.test(status + ' ' + msg)) {
      return new ProviderError('Your ElevenLabs account is out of credits.', 'quota', res.status);
    }
    if (res.status === 401) {
      return new ProviderError(msg && /permission/i.test(msg) ? `Key is missing a permission: ${msg}` : 'Invalid API key.', 'auth', 401);
    }
    if (res.status === 403) return new ProviderError(msg || 'Access denied.', 'auth', 403);
    if (res.status === 429) return new ProviderError('Too many requests at once. Slow down a little.', 'rate', 429);
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      return new ProviderError(msg || 'The request was rejected (check the voice and model).', 'bad-request', res.status);
    }
    return new ProviderError(`Server error (${res.status}).`, 'server', res.status);
  }

  globalThis.HHProviders = {
    openai,
    elevenlabs,
    get: (id) => (id === 'openai' ? openai : id === 'elevenlabs' ? elevenlabs : null),
    ProviderError,
    isFatal
  };
})();
