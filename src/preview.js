/* =========================================================
   Preview
   Sizes the canvas to the stage, keeps the WebGL preview in sync
   with the export aspect, and provides pointer selection/drag
   directly on the preview surface (UV hit-test, no readback).
   ========================================================= */

(function (GS) {
  'use strict';

  const geom = GS.geom;

  const STAGE_PADDING = 48;
  const MAX_DPR = 2;
  const MAX_DIM = 2048;

  let renderer = null;
  let frame = 0;
  let drag = null;
  let resizeDrag = null;

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

    if (!renderer) {
      renderer = new GS.Renderer(canvas, false);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
    }
    const px = pixelSize(css.w, css.h);
    renderer.render(GS.state, px.w, px.h);
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
      if (GS.layout) GS.layout.draw();
      GS.share.sync();
    });
  }

  /* ---------- hit-test ---------- */

  /* The predicate, the grip positions and the resize maths all live in
     geom.js: this surface and the layout canvas have to agree about where
     a shape is, and two hand-written copies did not. */

  function toUV(e) {
    const canvas = GS.byId('preview');
    const rect = canvas.getBoundingClientRect();
    return {
      u: (e.clientX - rect.left) / rect.width,
      v: (e.clientY - rect.top) / rect.height,
    };
  }

  function onPointerDown(e) {
    const { u, v } = toUV(e);
    const canvas = GS.byId('preview');
    const rect = canvas.getBoundingClientRect();
    const selected = GS.selection.id
      ? GS.state.shapes.find(s => s.id === GS.selection.id)
      : null;

    if (selected) {
      const grip = geom.hitHandle(selected, u, v, rect.width, rect.height, geom.aspect());
      if (grip) {
        resizeDrag = geom.startResize(selected, grip, u, v, geom.aspect());
        GS.selection.id = selected.id;
        GS.ui.refreshSelection();
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
        return;
      }
    }

    const shape = geom.hitTest(u, v);
    if (!shape) {
      if (GS.selection.id) {
        GS.selection.id = null;
        GS.ui.refreshSelection();
      }
      return;
    }

    GS.selection.id = shape.id;
    GS.ui.refreshSelection();
    drag = { shape, offX: shape.x - u, offY: shape.y - v };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (resizeDrag) {
      const { u, v } = toUV(e);
      const shape = resizeDrag.shape;
      const pose = geom.applyResize(resizeDrag, u, v, {
        ratio: e.shiftKey,
        fromCenter: e.altKey || e.metaKey,
      });
      shape.w = pose.w;
      shape.h = pose.h;
      shape.x = pose.x;
      shape.y = pose.y;
      schedule();
      GS.ui.syncShapeInputs();
      return;
    }
    if (!drag) return;
    const { u, v } = toUV(e);
    drag.shape.x = u + drag.offX;
    drag.shape.y = v + drag.offY;
    schedule();
    GS.ui.syncShapeInputs();
  }

  function onPointerUp(e) {
    if (resizeDrag) {
      try { GS.byId('preview').releasePointerCapture(e.pointerId); } catch (_) {}
      resizeDrag = null;
      return;
    }
    if (!drag) return;
    try { GS.byId('preview').releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
  }

  /* ---------- observe ---------- */

  function observeStage() {
    if (typeof ResizeObserver === 'function') {
      let lastW = 0, lastH = 0;
      new ResizeObserver(entries => {
        const rect = entries[0].contentRect;
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w === lastW && h === lastH) return;
        lastW = w; lastH = h;
        schedule();
      }).observe(GS.byId('stage'));
    }
    window.addEventListener('resize', schedule);
  }

  GS.preview = { layout, schedule, observeStage };
})(window.GS);