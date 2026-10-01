/* =========================================================
   Color
   Hex <-> RGB conversions, HSL generation for random presets
   and OKLab mixing for gradient interpolation.
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

  color.rgbToHex = function (rgb) {
    return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
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

  /* ---------- OKLab ----------
     Gradient stops are mixed here instead of in sRGB: a straight
     sRGB lerp between two saturated colours dips through a muddy
     grey and reads as a hard band. OKLab is perceptually uniform,
     so the same lerp stays bright and the ramp has no visible
     crease where the two hues meet. */

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(c) {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  /* [r, g, b] in 0..255 → OKLab. */
  color.rgb255ToOklab = function (rgb) {
    const r = srgbToLinear(rgb[0] / 255);
    const g = srgbToLinear(rgb[1] / 255);
    const b = srgbToLinear(rgb[2] / 255);

    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  };

  /* OKLab → [r, g, b] in 0..255, gamut-clipped per channel. */
  color.oklabToRgb255 = function (lab) {
    const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    const s_ = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2];

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

    const out = [r, g, b];
    for (let i = 0; i < 3; i++) {
      const v = Math.round(Math.max(0, Math.min(1, linearToSrgb(out[i]))) * 255);
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return out;
  };

  GS.color = color;
})(window.GS);
