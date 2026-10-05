/* =========================================================
   Color
   Hex <-> RGB conversions and HSL generation for the
   randomisers. Gradient interpolation lives in gradient.js,
   which keeps its own OkLab copy so the sampling hot path has
   no cross-module calls; nothing here needs to know about it.
   ========================================================= */

(function (GS) {
  'use strict';

  const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  const color = {};

  color.isHex = function (value) {
    return typeof value === 'string' && HEX_RE.test(value);
  };

  color.hexToRgb255 = function (hex) {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  color.hexToRgb01 = function (hex) {
    return color.hexToRgb255(hex).map(v => v / 255);
  };

  color.hslToHex = function (h, s, l) {
    h = ((h % 360) + 360) % 360;
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  };

  GS.color = color;
})(window.GS);
