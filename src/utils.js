/* =========================================================
   Utilities
   Small dependency-free helpers: numbers, cloning, base64
   for the URL hash.
   ========================================================= */

(function (GS) {
  'use strict';

  const utils = {};

  utils.clamp = function (v, a, b) {
    return Math.max(a, Math.min(b, v));
  };

  utils.deg2rad = function (deg) {
    return deg * Math.PI / 180;
  };

  utils.clone = function (value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  };

  utils.debounce = function (fn, ms) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  /* Unicode-safe base64 (state is serialised into the URL hash). */
  utils.b64enc = function (str) {
    const bytes = new TextEncoder().encode(str);
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  };

  utils.b64dec = function (b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  GS.utils = utils;
})(window.GS);
