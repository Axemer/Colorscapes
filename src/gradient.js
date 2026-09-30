/* =========================================================
   Gradient math (CPU side)
   Stops are baked into a 1D texture on the CPU, so we also need
   sampling here for swatches / newly added stops. computeExtent()
   tells the shader how far a gradient runs across the shape.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, deg2rad } = GS.utils;
  const { hexToRgb255, rgbToHex } = GS.color;
  const gradient = {};

  gradient.sortStops = function (stops) {
    return [...stops]
      .filter(s => s && typeof s.pos === 'number' && isFinite(s.pos))
      .map(s => ({ pos: clamp(s.pos, 0, 1), color: s.color }))
      .sort((a, b) => a.pos - b.pos);
  };

  /* Returns [r, g, b] in 0..255 for a position in 0..1. */
  gradient.sampleStops = function (sorted, t) {
    if (!sorted.length) return [0, 0, 0];
    if (sorted.length === 1) return hexToRgb255(sorted[0].color);
    if (t <= sorted[0].pos) return hexToRgb255(sorted[0].color);

    const last = sorted[sorted.length - 1];
    if (t >= last.pos) return hexToRgb255(last.color);

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (t >= a.pos && t <= b.pos) {
        const u = (t - a.pos) / ((b.pos - a.pos) || 1e-6);
        const ca = hexToRgb255(a.color), cb = hexToRgb255(b.color);
        return [
          ca[0] + (cb[0] - ca[0]) * u,
          ca[1] + (cb[1] - ca[1]) * u,
          ca[2] + (cb[2] - ca[2]) * u,
        ];
      }
    }
    return hexToRgb255(last.color);
  };

  gradient.sampleStopsColor = function (sorted, t) {
    return rgbToHex(gradient.sampleStops(sorted, t));
  };

  /* Midpoint of the widest gap — the least disruptive place for a new stop. */
  gradient.widestGapMidpoint = function (sorted) {
    if (sorted.length < 2) return 0.5;
    let bestGap = -1, bestPos = 0.5;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1].pos - sorted[i].pos;
      if (gap > bestGap) {
        bestGap = gap;
        bestPos = (sorted[i].pos + sorted[i + 1].pos) / 2;
      }
    }
    return bestPos;
  };

  /* How far the shape reaches along a gradient axis, in UV space.
     Half-extents are measured in aspect-normalised units (y = image height). */
  gradient.computeExtent = function (aspect, shape, gradAngleDeg) {
    const a = deg2rad(gradAngleDeg);
    const dx = Math.cos(a), dy = Math.sin(a);

    const hw = shape.width * 0.5 * aspect;
    const hh = shape.height * 0.5;

    const theta = deg2rad(shape.angle);
    const ct = Math.abs(Math.cos(theta));
    const st = Math.abs(Math.sin(theta));

    const rx = hw * ct + hh * st;
    const ry = hw * st + hh * ct;

    return (rx / aspect) * Math.abs(dx) + ry * Math.abs(dy);
  };

  GS.gradient = gradient;
})(window.GS);
