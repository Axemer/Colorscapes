/* =========================================================
   State
   GS.state is the single live, mutable app state. Schema v2:
   an ordered list of shapes, each carrying its own gradient,
   transform and blend mode. applyState() normalises any
   untrusted object (hash, preset, random) into it in place,
   including migrating v1 single-shape states transparently.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, clone } = GS.utils;
  const { isHex, hslToHex } = GS.color;

  const BLEND_MODES = ['normal', 'add', 'screen', 'multiply'];

  /* Ceiling for the scene blur, as a fraction of frame width. Past
     this the kernel runs out of pairs and the radius stops growing,
     so the slider is capped to match what the GPU can deliver. */
  const MAX_BLUR = 0.04;

  const DEFAULT_GRADIENT = {
    angle: 90,
    stops: [
      { pos: 0.00, color: '#0b1e4f' },
      { pos: 0.22, color: '#1e6bb8' },
      { pos: 0.46, color: '#6ad4c8' },
      { pos: 0.68, color: '#c8e88a' },
      { pos: 0.85, color: '#f0d060' },
      { pos: 1.00, color: '#f0a050' },
    ],
  };

  const DEFAULT_SHAPE = {
    x: 0.5, y: 0.5,
    w: 0.62, h: 0.30,
    rot: 0,
    roundness: 2.2,
    softness: 0.28,
    glow: 1.0,
    opacity: 1.0,
    grain: 0.0,
    visible: true,
    blend: 'normal',
    gradient: DEFAULT_GRADIENT,
  };

  /* The numeric shape schema, in one table, shared by the normaliser
     and the shape panel. Two limits live here on purpose and are not
     the same numbers: `ui` is the range the slider offers, while
     `min`/`max` is the hard clamp that keeps a hostile hash from
     producing zero-area geometry or a 1/0 in the shader. `shapeMask`
     in shaders.js mirrors the min columns.

     The panel order is the schema order; nothing else may depend on
     it (syncShapeInputs matches rows by data-key). */
  const SHAPE_SCHEMA = [
    { key: 'x', label: 'X', step: 0.005, ui: [-1, 2] },
    { key: 'y', label: 'Y', step: 0.005, ui: [-1, 2] },
    { key: 'w', label: 'Width', step: 0.005, ui: [0.01, 3], min: 0.001 },
    { key: 'h', label: 'Height', step: 0.005, ui: [0.01, 3], min: 0.001 },
    { key: 'rot', label: 'Rotation', step: 0.5, ui: [-180, 180] },
    { key: 'roundness', label: 'Roundness', step: 0.05, ui: [0.01, 20], min: 0.01 },
    { key: 'softness', label: 'Softness', step: 0.005, ui: [0.001, 2], min: 0.001 },
    { key: 'glow', label: 'Glow', step: 0.01, ui: [0.1, 2] },
    { key: 'opacity', label: 'Opacity', step: 0.01, ui: [0, 1], min: 0, max: 1 },
    { key: 'grain', label: 'Grain', step: 0.001, ui: [0, 0.15], min: 0, max: 1 },
  ];

  const DEFAULT_STATE = {
    shapes: [clone(DEFAULT_SHAPE)],
    background: '#000000',
    /* Scene-wide Gaussian, as a fraction of the frame width so a
       preview and a 4K export smear by the same amount. */
    blur: 0.012,
    exportW: 1920,
    exportH: 1080,
  };

  /* Built-in presets are stored in the modern shape-list format.
     Migration below also accepts the old shape/main/horiz/mix
     schema, so external hashes from before the upgrade keep working. */
  const BUILTIN_PRESETS = [
    {
      name: 'Neon Sunset',
      state: {
        shapes: [{
          id: 'neon-sunset',
          x: 0.5, y: 0.5,
          w: 0.86, h: 0.94,
          rot: 0,
          roundness: 3.2,
          softness: 0.24,
          glow: 1.0,
          opacity: 1.0,
          grain: 0.028,
          visible: true,
          blend: 'normal',
          gradient: {
            angle: 90,
            stops: [
              { pos: 0.00, color: '#dc2814' },
              { pos: 0.15, color: '#e64514' },
              { pos: 0.35, color: '#f58520' },
              { pos: 0.47, color: '#ffb860' },
              { pos: 0.53, color: '#f0c8b8' },
              { pos: 0.57, color: '#a0c4f0' },
              { pos: 0.65, color: '#4888ee' },
              { pos: 0.80, color: '#3a58d4' },
              { pos: 1.00, color: '#321ea0' },
            ],
          },
        }],
        background: '#000000',
        exportW: 1920,
        exportH: 1080,
      },
    },
    {
      name: 'Cold Aurora',
      state: {
        shapes: [{
          x: 0.5, y: 0.5, w: 0.66, h: 0.34, rot: 0,
          roundness: 2.4, softness: 0.7, glow: 1.05,
          opacity: 1.0, visible: true, blend: 'normal',
          gradient: {
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
        }],
        background: '#000000',
        exportW: 1920, exportH: 1080,
      },
    },
    {
      name: 'Warm Bloom',
      state: {
        shapes: [{
          x: 0.5, y: 0.5, w: 0.66, h: 0.34, rot: 0,
          roundness: 2.4, softness: 0.7, glow: 1.05,
          opacity: 1.0, visible: true, blend: 'normal',
          gradient: {
            angle: 90,
            stops: [
              { pos: 0.00, color: '#ff8c1a' },
              { pos: 0.25, color: '#ff4f2e' },
              { pos: 0.50, color: '#ff2d8a' },
              { pos: 0.76, color: '#7a2ad4' },
              { pos: 1.00, color: '#0a1050' },
            ],
          },
        }],
        background: '#000000',
        exportW: 1920, exportH: 1080,
      },
    },
  ];

  /* ---------- helpers ---------- */

  function num(v, fb) { return typeof v === 'number' && isFinite(v) ? v : fb; }

  function blankState() {
    return { shapes: [], background: '', blur: 0, exportW: 0, exportH: 0 };
  }

  function makeId() {
    return 's' + Math.random().toString(36).slice(2, 9);
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

  /* Every numeric field comes from the schema table, so adding one is
     a single line above and cannot be silently dropped here. */
  function normaliseShape(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {
      id: typeof src.id === 'string' && src.id ? src.id : makeId(),
      visible: src.visible !== false,
      blend: BLEND_MODES.includes(src.blend) ? src.blend : DEFAULT_SHAPE.blend,
      gradient: normaliseGradient(src.gradient, DEFAULT_GRADIENT),
    };
    for (const f of SHAPE_SCHEMA) {
      let v = num(src[f.key], DEFAULT_SHAPE[f.key]);
      if (f.min !== undefined) v = Math.max(f.min, v);
      if (f.max !== undefined) v = Math.min(f.max, v);
      out[f.key] = v;
    }
    return out;
  }

  /* v1 (shape/main/horiz/mix) → v2 (shapes[]). */
  function migrateLegacy(src) {
    if (!src || typeof src !== 'object') return null;
    if (Array.isArray(src.shapes)) return src;
    if (!src.shape || !src.main) return null;

    const legacy = src.shape;
    const base = {
      x: num(legacy.centerX, 0.5),
      y: num(legacy.centerY, 0.5),
      w: num(legacy.width, 0.62),
      h: num(legacy.height, 0.30),
      rot: num(legacy.angle, 0),
      roundness: num(legacy.roundness, 2.2),
      softness: num(legacy.softness, 0.65),
      glow: num(legacy.glow, 1.0),
      opacity: 1.0,
      visible: true,
      blend: 'normal',
      gradient: src.main,
    };

    const shapes = [base];
    const mix = clamp(num(src.mix, 0), 0, 1);
    if (mix > 0.0001 && src.horiz) {
      shapes.push({ ...base, gradient: src.horiz, opacity: mix });
    }

    return {
      shapes,
      background: src.background,
      blur: num(src.blur, DEFAULT_STATE.blur),
      exportW: src.exportW,
      exportH: src.exportH,
    };
  }

  function normaliseInto(target, raw) {
    const migrated = migrateLegacy(raw) || (raw && typeof raw === 'object' ? raw : {});
    const src = migrated;

    const list = Array.isArray(src.shapes) && src.shapes.length > 0
      ? src.shapes.map(normaliseShape)
      : [normaliseShape({})];

    target.shapes = list;
    target.background = isHex(src.background) ? src.background : DEFAULT_STATE.background;
    target.blur = clamp(num(src.blur, DEFAULT_STATE.blur), 0, MAX_BLUR);
    target.exportW = Math.max(1, Math.round(num(src.exportW, DEFAULT_STATE.exportW)));
    target.exportH = Math.max(1, Math.round(num(src.exportH, DEFAULT_STATE.exportH)));
    return target;
  }

  function applyState(raw) {
    return normaliseInto(GS.state, raw);
  }

  /* Hue-ramped gradient, brighter in the middle, reusable for
     freshly-added shapes so they don't clone the selected one. */
  function randomGradient() {
    const baseHue = Math.random() * 360;
    const hueSpread = 60 + Math.random() * 180;
    const count = 4 + Math.floor(Math.random() * 3);
    const stops = [];
    for (let j = 0; j < count; j++) {
      const t = j / (count - 1);
      stops.push({
        pos: t,
        color: hslToHex(
          baseHue + hueSpread * t,
          55 + Math.random() * 35,
          22 + 45 * Math.sin(t * Math.PI),
        ),
      });
    }
    return { angle: Math.floor(Math.random() * 360), stops };
  }

  /* A brand-new shape: geometry and gradient are both generated,
     so "+ Add shape" never looks like "Duplicate". `at` pins the
     centre (layout-canvas double click), otherwise it is random. */
  function randomShape(at) {
    const s = clone(DEFAULT_SHAPE);
    s.id = makeId();
    s.x = at ? clamp(at.u, -0.3, 1.3) : 0.2 + Math.random() * 0.6;
    s.y = at ? clamp(at.v, -0.3, 1.3) : 0.22 + Math.random() * 0.56;
    s.w = 0.24 + Math.random() * 0.46;
    s.h = 0.14 + Math.random() * 0.28;
    s.rot = (Math.random() - 0.5) * 36;
    s.roundness = 1.6 + Math.random() * 3.2;
    s.softness = 0.4 + Math.random() * 0.6;
    s.opacity = 1;
    s.blend = 'normal';
    s.gradient = randomGradient();
    return normaliseShape(s);
  }

  /* 1–3 shapes, each with its own hue-ramped gradient. */
  function randomState() {
    const count = 1 + Math.floor(Math.random() * 3);
    const shapes = [];

    for (let i = 0; i < count; i++) {
      const s = randomShape();
      if (i > 0) s.blend = Math.random() < 0.5 ? 'screen' : 'add';
      shapes.push(s);
    }

    return normaliseInto(blankState(), {
      shapes,
      background: '#000000',
      blur: DEFAULT_STATE.blur,
      exportW: 1920,
      exportH: 1080,
    });
  }

  /* ---------- selection (UI state, not persisted) ---------- */

  GS.selection = { id: null };

  GS.getSelectedShape = function () {
    if (!GS.selection.id) return null;
    return GS.state.shapes.find(s => s.id === GS.selection.id) || null;
  };

  GS.ensureSelection = function () {
    if (!GS.state.shapes.length) { GS.selection.id = null; return; }
    if (!GS.state.shapes.some(s => s.id === GS.selection.id)) {
      GS.selection.id = GS.state.shapes[0].id;
    }
  };

  GS.state = normaliseInto(blankState(), DEFAULT_STATE);
  GS.applyState = applyState;
  GS.randomState = randomState;
  GS.randomShape = randomShape;
  GS.DEFAULT_STATE = DEFAULT_STATE;
  GS.DEFAULT_GRADIENT = DEFAULT_GRADIENT;
  GS.DEFAULT_SHAPE = DEFAULT_SHAPE;
  GS.BUILTIN_PRESETS = BUILTIN_PRESETS;
  GS.BLEND_MODES = BLEND_MODES;
  GS.SHAPE_SCHEMA = SHAPE_SCHEMA;
  GS.MAX_BLUR = MAX_BLUR;
  GS.makeShapeId = makeId;
})(window.GS);