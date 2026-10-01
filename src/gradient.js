/* =========================================================
   Gradient utilities
   Stops are interpolated in OkLab (Björn Ottosson), which is
   perceptually uniform — 3–5 stops give a smooth "expensive"
   ramp instead of the muddy midtones sRGB produces.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp } = GS.utils;
  const { hexToRgb255 } = GS.color;

  /* ---------- sRGB <-> linear ---------- */

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(1, s));
  }

  /* ---------- linear RGB <-> OkLab ---------- */

  function linearToOklab(r, g, b) {
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return [
      0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    ];
  }
  function oklabToLinear(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return [
      +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }

  /* ---------- colour helpers ---------- */

  function hexToOklab(hex) {
    const [r, g, b] = hexToRgb255(hex);
    return linearToOklab(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255));
  }
  function oklabToRgb255(lab) {
    const [lr, lg, lb] = oklabToLinear(lab[0], lab[1], lab[2]);
    return [
      Math.round(linearToSrgb(lr) * 255),
      Math.round(linearToSrgb(lg) * 255),
      Math.round(linearToSrgb(lb) * 255),
    ];
  }

  /* Cache: stop objects are stable between edits. */
  const labCache = new WeakMap();
  function stopLab(stop) {
    let lab = labCache.get(stop);
    if (!lab || lab._hex !== stop.color) {
      lab = hexToOklab(stop.color);
      lab._hex = stop.color;
      labCache.set(stop, lab);
    }
    return lab;
  }

  /* ---------- public ---------- */

  function sortStops(stops) {
    return [...stops].sort((a, b) => a.pos - b.pos);
  }

  function sampleStops(sorted, t) {
    if (!sorted.length) return [0, 0, 0];
    if (sorted.length === 1) return hexToRgb255(sorted[0].color);
    if (t <= sorted[0].pos) return hexToRgb255(sorted[0].color);
    const last = sorted[sorted.length - 1];
    if (t >= last.pos) return hexToRgb255(last.color);

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (t >= a.pos && t <= b.pos) {
        const span = (b.pos - a.pos) || 1e-6;
        const u = (t - a.pos) / span;
        const la = stopLab(a), lb = stopLab(b);
        return oklabToRgb255([
          la[0] + (lb[0] - la[0]) * u,
          la[1] + (lb[1] - la[1]) * u,
          la[2] + (lb[2] - la[2]) * u,
        ]);
      }
    }
    return hexToRgb255(last.color);
  }

  function sampleStopsColor(sorted, t) {
    const c = sampleStops(sorted, t);
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function widestGapMidpoint(sorted) {
    if (sorted.length < 2) return 0.5;
    let best = -1, pos = 0.5;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1].pos - sorted[i].pos;
      if (gap > best) { best = gap; pos = (sorted[i].pos + sorted[i + 1].pos) / 2; }
    }
    return pos;
  }

  function computeExtent(aspect, shape, gradAngleDeg) {
    const a = gradAngleDeg * Math.PI / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const hw = shape.width * 0.5 * aspect;
    const hh = shape.height * 0.5;
    const theta = shape.angle * Math.PI / 180;
    const ct = Math.abs(Math.cos(theta)), st = Math.abs(Math.sin(theta));
    const rx = hw * ct + hh * st;
    const ry = hw * st + hh * ct;
    return (rx / aspect) * Math.abs(dx) + ry * Math.abs(dy);
  }

  GS.gradient = { sortStops, sampleStops, sampleStopsColor, widestGapMidpoint, computeExtent };
})(window.GS);