/* =========================================================
   Sharing
   The whole state travels in the URL hash as base64 JSON, so
   there is no backend. Writes are debounced and replaceState
   keeps the back button clean.
   ========================================================= */

(function (GS) {
  'use strict';

  const { b64enc, b64dec, debounce } = GS.utils;

  function encode(state) {
    try {
      return '#' + b64enc(JSON.stringify(state));
    } catch {
      return '';
    }
  }

  function sync() {
    writeHash();
  }

  const writeHash = debounce(() => {
    const hash = encode(GS.state);
    if (hash) history.replaceState(null, '', hash);
  }, 300);

  function read() {
    const raw = location.hash.slice(1);
    if (!raw) return null;
    try {
      return JSON.parse(b64dec(raw));
    } catch {
      return null;
    }
  }

  function shareUrl() {
    const hash = encode(GS.state);
    return hash ? location.origin + location.pathname + hash : '';
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  async function copyLink() {
    const url = shareUrl();
    if (!url) return GS.toast('Copy failed');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else if (!fallbackCopy(url)) {
        throw new Error('clipboard unavailable');
      }
      GS.toast('Link copied');
    } catch {
      GS.toast('Copy failed');
    }
  }

  GS.share = { sync, read, shareUrl, copyLink };
})(window.GS);
