/* =========================================================
   Storage
   User presets in localStorage. Reads never throw (private mode,
   disabled storage, corrupted JSON) — they just look empty.
   ========================================================= */

(function (GS) {
  'use strict';

  const LS_KEY = 'gradient-studio-presets-v1';

  function loadUserPresets() {
    try {
      const list = JSON.parse(localStorage.getItem(LS_KEY));
      return Array.isArray(list) ? list.filter(p => p && p.name && p.state) : [];
    } catch {
      return [];
    }
  }

  function saveUserPresets(list) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(list));
    } catch {
      GS.toast('Could not save presets');
    }
  }

  GS.storage = { loadUserPresets, saveUserPresets };
})(window.GS);
