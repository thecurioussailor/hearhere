// HearHere — bloom shapes (logo, engine marks, play button). Shared by popup and settings.
(() => {
  'use strict';
  // petals → distance from centre, petal radius, core radius (viewBox 0..100)
  const SHAPES = {
    4: { d: 22, r: 25, c: 22 },
    5: { d: 25, r: 22, c: 24 },
    6: { d: 26, r: 21, c: 24 },
    8: { d: 29, r: 17, c: 28 },
    12: { d: 37, r: 12.5, c: 39 }
  };

  function svg(petals, color = 'currentColor', center = '', cls = '') {
    const s = SHAPES[petals] || SHAPES[6];
    let out = `<svg class="bloom ${cls}" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g class="petals" style="fill:${color}">`;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * 2 * Math.PI - Math.PI / 2;
      out += `<circle cx="${(50 + s.d * Math.cos(a)).toFixed(2)}" cy="${(50 + s.d * Math.sin(a)).toFixed(2)}" r="${s.r}"/>`;
    }
    out += `<circle cx="50" cy="50" r="${s.c}"/></g>`;
    if (center) out += `<circle cx="50" cy="50" r="9" style="fill:${center}"/>`;
    return `${out}</svg>`;
  }

  // <i data-bloom="6" data-color="var(--coral)" data-center="#fff"></i>
  function hydrate(root = document) {
    root.querySelectorAll('[data-bloom]').forEach((el) => {
      el.innerHTML = svg(Number(el.dataset.bloom), el.dataset.color, el.dataset.center, el.dataset.cls || '');
    });
  }

  globalThis.HHBloom = { svg, hydrate, SHAPES };
})();
