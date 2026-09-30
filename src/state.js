/* =========================================================
   State
   GS.state is the single live, mutable app state. applyState()
   normalises any untrusted object (hash, preset, random) into it,
   in place, so every reference stays valid.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, clone } = GS.utils;
  const { isHex, hslToHex } = GS.color;

  const DEFAULT_STATE = {
    shape: {
      width: 0.62, height: 0.30,
      centerX: 0.5, centerY: 0.5,
      angle: 0,
      roundness: 2.2,
      softness: 0.65,
      glow: 1.0,
    },
    main: {
      angle: 90,
      stops: [
        { pos: 0.00, color: '#0b1e4f' },
        { pos: 0.22, color: '#1e6bb8' },
        { pos: 0.46, color: '#6ad4c8' },
        { pos: 0.68, color: '#c8e88a' },
        { pos: 0.85, color: '#f0d060' },
        { pos: 1.00, color: '#f0a050' },
      ],
    },
    horiz: {
      angle: 0,
      stops: [
        { pos: 0.0, color: '#ffffff' },
        { pos: 1.0, color: '#000000' },
      ],
    },
    mix: 0.0,
    background: '#000000',
    exportW: 1920,
    exportH: 1080,
  };

  const WHITE_TO_BLACK = [
    { pos: 0, color: '#ffffff' },
    { pos: 1, color: '#000000' },
  ];

  const BUILTIN_PRESETS = [
    {
      name: 'Cold Aurora',
      state: {
        shape: { width: 0.66, height: 0.34, centerX: 0.5, centerY: 0.5, angle: 0, roundness: 2.4, softness: 0.7, glow: 1.05 },
        main: {
          angle: 90,
          stops: [
            { pos: 0.00, color: '#0a1a4a' },
            { pos: 0.22, color: '#2a6bb5' },
            { pos: 0.45, color: '#8ce0d4' },
            { pos: 0.66, color: '#c8e8a0' },
            { pos: 0.86, color: '#e8e070' },
            { pos: 1.00, color: '#f0a860' },
          ],
        },
        horiz: { angle: 0, stops: WHITE_TO_BLACK },
        mix: 0.0,
        background: '#000000',
        exportW: 1920, exportH: 1080,
      },
    },
    {
      name: 'Warm Bloom',
      state: {
        shape: { width: 0.66, height: 0.34, centerX: 0.5, centerY: 0.5, angle: 0, roundness: 2.4, softness: 0.7, glow: 1.05 },
        main: {
          angle: 90,
          stops: [
            { pos: 0.00, color: '#ff8c1a' },
            { pos: 0.25, color: '#ff4f2e' },
            { pos: 0.50, color: '#ff2d8a' },
            { pos: 0.76, color: '#7a2ad4' },
            { pos: 1.00, color: '#0a1050' },
          ],
        },
        horiz: { angle: 0, stops: WHITE_TO_BLACK },
        mix: 0.0,
        background: '#000000',
        exportW: 1920, exportH: 1080,
      },
    },
  ];

  function blankState() {
    return { shape: {}, main: {}, horiz: {}, mix: 0, background: '', exportW: 0, exportH: 0 };
  }

  function num(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function normaliseStops(stops, fallback) {
    if (!Array.isArray(stops)) return clone(fallback);
    const clean = stops
      .filter(s => s && typeof s.pos === 'number' && isFinite(s.pos) && isHex(s.color))
      .map(s => ({ pos: clamp(s.pos, 0, 1), color: s.color }));
    return clean.length >= 2 ? clean : clone(fallback);
  }

  function normaliseGradient(raw, fallback) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      angle: num(src.angle, fallback.angle),
      stops: normaliseStops(src.stops, fallback.stops),
    };
  }

  /* Merges an arbitrary object into target, filling gaps from the defaults. */
  function normaliseInto(target, raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const shape = src.shape && typeof src.shape === 'object' ? src.shape : {};

    Object.keys(DEFAULT_STATE.shape).forEach(key => {
      target.shape[key] = num(shape[key], DEFAULT_STATE.shape[key]);
    });

    target.main = normaliseGradient(src.main, DEFAULT_STATE.main);
    target.horiz = normaliseGradient(src.horiz, DEFAULT_STATE.horiz);
    target.mix = clamp(num(src.mix, DEFAULT_STATE.mix), 0, 1);
    target.background = isHex(src.background) ? src.background : DEFAULT_STATE.background;
    target.exportW = Math.max(1, Math.round(num(src.exportW, DEFAULT_STATE.exportW)));
    target.exportH = Math.max(1, Math.round(num(src.exportH, DEFAULT_STATE.exportH)));

    return target;
  }

  function applyState(raw) {
    return normaliseInto(GS.state, raw);
  }

  /* Hue-ramped gradient, brighter in the middle, plus a wild shape. */
  function randomState() {
    const baseHue = Math.random() * 360;
    const hueSpread = 60 + Math.random() * 180;
    const count = 4 + Math.floor(Math.random() * 3);

    const stops = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      stops.push({
        pos: t,
        color: hslToHex(baseHue + hueSpread * t, 55 + Math.random() * 35, 22 + 45 * Math.sin(t * Math.PI)),
      });
    }

    const next = clone(DEFAULT_STATE);
    next.main = { angle: 90, stops };
    next.shape.width = 0.5 + Math.random() * 0.3;
    next.shape.height = 0.2 + Math.random() * 0.25;
    next.shape.roundness = 2 + Math.random() * 2.5;
    next.shape.softness = 0.45 + Math.random() * 0.5;
    next.shape.angle = (Math.random() - 0.5) * 30;
    next.mix = Math.random() < 0.3 ? Math.random() * 0.25 : 0;
    if (next.mix > 0) {
      const hue = baseHue + 180;
      next.horiz = {
        angle: 0,
        stops: [
          { pos: 0, color: hslToHex(hue, 60, 75) },
          { pos: 1, color: hslToHex(hue, 70, 25) },
        ],
      };
    }

    return normaliseInto(blankState(), next);
  }

  GS.state = normaliseInto(blankState(), DEFAULT_STATE);
  GS.applyState = applyState;
  GS.randomState = randomState;
  GS.DEFAULT_STATE = DEFAULT_STATE;
  GS.BUILTIN_PRESETS = BUILTIN_PRESETS;
})(window.GS);
