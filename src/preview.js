/* =========================================================
   Preview
   Sizes the canvas to the stage, keeps the WebGL preview in sync
   with the export aspect, and provides pointer selection/drag
   directly on the preview surface (UV hit-test, no readback).
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, deg2rad } = GS.utils;

  const STAGE_PADDING = 48;
  const MAX_DPR = 2;
  const MAX_DIM = 2048;

  let renderer = null;
  let frame = 0;
  let drag = null;

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

  function shapeContains(shape, u, v) {
    const aspect = GS.state.exportW / GS.state.exportH;
    const px = (u - shape.x) * aspect;
    const py = (v - shape.y);
    const theta = deg2rad(shape.rot);
    const ca = Math.cos(theta), sa = Math.sin(theta);
    const rpx = px * ca - py * sa;
    const rpy = px * sa + py * ca;
    const hw = Math.max(shape.w * 0.5 * aspect, 1e-6);
    const hh = Math.max(shape.h * 0.5, 1e-6);
    const dx = Math.abs(rpx) / hw;
    const dy = Math.abs(rpy) / hh;
    const r = Math.max(shape.roundness, 1.001);
    const dist = Math.pow(Math.pow(dx, r) + Math.pow(dy, r), 1 / r);
    return dist <= 1;
  }

  function hitTest(u, v) {
    for (let i = GS.state.shapes.length - 1; i >= 0; i--) {
      const s = GS.state.shapes[i];
      if (s.visible && shapeContains(s, u, v)) return s;
    }
    return null;
  }

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
    const shape = hitTest(u, v);
    if (!shape) {
      if (GS.selection.id) { GS.selection.id = null; GS.ui.refreshSelection(); }
      return;
    }
    GS.selection.id = shape.id;
    GS.ui.refreshSelection();
    drag = { shape, offX: shape.x - u, offY: shape.y - v };
    GS.byId('preview').setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const { u, v } = toUV(e);
    drag.shape.x = u + drag.offX;
    drag.shape.y = v + drag.offY;
    schedule();
    GS.ui.syncShapeInputs();
  }

  function onPointerUp(e) {
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