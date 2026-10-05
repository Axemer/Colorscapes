/* =========================================================
   Export
   Renders on an offscreen canvas with preserveDrawingBuffer so it
   can be read back. The context is created once and reused —
   making a new one per export would leak WebGL contexts.
   ========================================================= */

(function (GS) {
  'use strict';

  let session = null;

  function getSession() {
    if (!session) {
      const canvas = document.createElement('canvas');
      session = { canvas, renderer: new GS.Renderer(canvas, true) };
    }
    return session;
  }

  function canvasToBlob(canvas) {
    /* toBlob is the async form and the only one that does not need a
       data URL round-trip, which would blow the argument limit on a
       5120px frame. */
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportPNG() {
    const width = Math.floor(GS.state.exportW);
    const height = Math.floor(GS.state.exportH);
    if (!(width > 0 && height > 0)) {
      GS.toast('Invalid size');
      return;
    }

    GS.toast(`Rendering ${width}×${height}…`);
    await new Promise(r => setTimeout(r, 40));

    try {
      const { canvas, renderer } = getSession();
      renderer.render(GS.state, width, height);

      const blob = await canvasToBlob(canvas);
      if (!blob) throw new Error('toBlob returned null');

      download(blob, `gradient_${width}x${height}_${Date.now()}.png`);
      GS.toast(`Exported ${width}×${height}`);
    } catch (e) {
      console.error(e);
      GS.toast('Export failed: ' + e.message);
    }
  }

  GS.exportPNG = exportPNG;
})(window.GS);
