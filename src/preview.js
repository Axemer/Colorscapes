/* =========================================================
   Preview
   Sizes the canvas to the stage and keeps the WebGL preview in
   sync with the export aspect ratio. Renders are coalesced into
   one animation frame.
   ========================================================= */

(function (GS) {
  'use strict';

  const STAGE_PADDING = 48;
  const MAX_DPR = 2;
  const MAX_DIM = 2048;

  let renderer = null;
  let frame = 0;

  function fitInside(availW, availH, aspect) {
    if (availW / availH > aspect) {
      const h = availH;
      return { w: h * aspect, h };
    }
    const w = availW;
    return { w, h: w / aspect };
  }

  function pixelSize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let w = Math.round(cssW * dpr);
    let h = Math.round(cssH * dpr);
    const biggest = Math.max(w, h);
    if (biggest > MAX_DIM) {
      const k = MAX_DIM / biggest;
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    return { w, h };
  }

  function layout() {
    const stage = GS.byId('stage');
    const canvas = GS.byId('preview');
    const rect = stage.getBoundingClientRect();

    const availW = Math.max(80, rect.width - STAGE_PADDING);
    const availH = Math.max(80, rect.height - STAGE_PADDING);
    const css = fitInside(availW, availH, GS.state.exportW / GS.state.exportH);

    canvas.style.width = css.w + 'px';
    canvas.style.height = css.h + 'px';

    if (!renderer) renderer = new GS.Renderer(canvas, false);
    const px = pixelSize(css.w, css.h);
    renderer.render(GS.state, px.w, px.h);
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
      GS.share.sync();
    });
  }

  /* The stage also changes size when the window moves between monitors
     (devicePixelRatio), so keep a plain resize listener as well. */
  function observeStage() {
    if (typeof ResizeObserver === 'function') {
      let lastW = 0, lastH = 0;
      new ResizeObserver(entries => {
        const rect = entries[0].contentRect;
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        schedule();
      }).observe(GS.byId('stage'));
    }
    window.addEventListener('resize', schedule);
  }

  GS.preview = { layout, schedule, observeStage };
})(window.GS);
