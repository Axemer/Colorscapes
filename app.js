/* =========================================================
   Entry point
   Boots the app: restore state from the hash, bail out early if
   WebGL is missing, then wire the UI and the stage.
   ========================================================= */

(function (GS) {
  'use strict';

  function hasWebGL() {
    try {
      const probe = document.createElement('canvas');
      return !!(probe.getContext('webgl') || probe.getContext('experimental-webgl'));
    } catch {
      return false;
    }
  }

  function showFatal(message) {
    GS.byId('stage').replaceChildren();
    const note = document.createElement('div');
    note.className = 'stage-note';
    note.textContent = message;
    GS.byId('stage').appendChild(note);
  }

  function init() {
    const fromHash = GS.share.read();
    GS.applyState(fromHash || GS.DEFAULT_STATE);

    if (!hasWebGL()) {
      showFatal('WebGL not available in this browser.');
      return;
    }

    GS.ui.init();
    GS.preview.observeStage();

    window.addEventListener('hashchange', () => {
      const next = GS.share.read();
      if (!next) return;
      GS.applyState(next);
      GS.ui.rebuildAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.GS);
