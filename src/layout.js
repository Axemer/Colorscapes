/* =========================================================
   Layout editor
   Small 2D canvas that mirrors the export frame and shows every
   shape as a superellipse outline. Pointer drags move the shape,
   double-click on empty space adds a new one, right-click removes.
   The canvas is created once and just redrawn on state changes.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, deg2rad } = GS.utils;
  const { sortStops, sampleStopsColor } = GS.gradient;

  const SIDE_PADDING = 12;
  const MAX_HEIGHT = 240;
  const GRID_DIV = 4;
  const SUPER_STEPS = 96;

  let canvas = null;
  let ctx = null;
  let drag = null;

  /* ---------- geometry ---------- */

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

  /* The hit-test above rotates world -> local, and the shader does the
     same; drawing has to walk the other way, and the inverse of a
     rotation matrix is its transpose — the sine swaps sign. Using the
     forward matrix here mirrors every rotated outline against the WebGL
     render (and against its own hit-test), which reads as the shape
     being flipped. */
  function superellipsePath(ctx, cx, cy, rx, ry, n, rot) {
    const cr = Math.cos(rot), sr = -Math.sin(rot);
    ctx.beginPath();
    for (let i = 0; i <= SUPER_STEPS; i++) {
      const t = (i / SUPER_STEPS) * Math.PI * 2;
      const ct = Math.cos(t), st = Math.sin(t);
      const ex = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n) * rx;
      const ey = Math.sign(st) * Math.pow(Math.abs(st), 2 / n) * ry;
      const px = cx + (ex * cr - ey * sr);
      const py = cy + (ex * sr + ey * cr);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /* ---------- drawing ---------- */

  function draw() {
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = GS.state.background || '#000';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID_DIV; i++) {
      const t = i / GRID_DIV;
      ctx.beginPath(); ctx.moveTo(t * w, 0); ctx.lineTo(t * w, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, t * h); ctx.lineTo(w, t * h); ctx.stroke();
    }

    // Centre crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    for (const shape of GS.state.shapes) drawShape(shape, w, h);
  }

  function drawShape(shape, w, h) {
    const cx = shape.x * w;
    const cy = shape.y * h;
    const rx = shape.w * 0.5 * w;
    const ry = shape.h * 0.5 * h;
    const rot = deg2rad(shape.rot);
    const selected = GS.selection.id === shape.id;

    ctx.save();
    ctx.globalAlpha = shape.visible ? 1 : 0.22;

    superellipsePath(ctx, cx, cy, rx, ry, shape.roundness, rot);

    if (shape.visible) {
      const sorted = sortStops(shape.gradient.stops);
      const angleRad = deg2rad(shape.gradient.angle);
      const dx = Math.cos(angleRad), dy = Math.sin(angleRad);
      const g = ctx.createLinearGradient(
        cx - dx * rx, cy - dy * ry,
        cx + dx * rx, cy + dy * ry,
      );
      g.addColorStop(0, sampleStopsColor(sorted, 0.1));
      g.addColorStop(0.5, sampleStopsColor(sorted, 0.5));
      g.addColorStop(1, sampleStopsColor(sorted, 0.9));

      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * clamp(shape.opacity, 0.08, 1) * 0.85;
      ctx.fillStyle = g;
      ctx.fill();
      ctx.globalAlpha = prevAlpha;
    }

    ctx.strokeStyle = selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = selected ? 1.8 : 1;
    ctx.stroke();

    // Center handle
    ctx.beginPath();
    ctx.arc(cx, cy, selected ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = selected ? '#fff' : 'rgba(255,255,255,0.55)';
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.restore();
  }

  /* ---------- sizing ---------- */

  function resize() {
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const availW = Math.max(40, rect.width - SIDE_PADDING * 2);
    const aspect = GS.state.exportW / GS.state.exportH;

    let w = availW;
    let h = w / aspect;
    if (h > MAX_HEIGHT) { h = MAX_HEIGHT; w = h * aspect; }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    draw();
  }

  /* ---------- pointer ---------- */

  function toUV(e) {
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
    if (!drag) return;
    const { u, v } = toUV(e);
    drag.shape.x = u + drag.offX;
    drag.shape.y = v + drag.offY;
    draw();
    GS.preview.schedule();
    GS.ui.syncShapeInputs();
  }

  function onPointerUp(e) {
    if (!drag) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
  }

  function onDblClick(e) {
    const { u, v } = toUV(e);
    if (hitTest(u, v)) return;
    GS.ui.addShapeAt(u, v);
  }

  function onContextMenu(e) {
    const { u, v } = toUV(e);
    const shape = hitTest(u, v);
    if (shape) {
      e.preventDefault();
      GS.ui.deleteShape(shape.id);
    }
  }

  /* ---------- public ---------- */

  function init() {
    canvas = GS.byId('layout-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);

    if (typeof ResizeObserver === 'function') {
      let lastW = 0;
      new ResizeObserver(entries => {
        const w = Math.round(entries[0].contentRect.width);
        if (w === lastW) return;
        lastW = w;
        resize();
      }).observe(canvas.parentElement);
    }
    window.addEventListener('resize', resize);

    resize();
  }

  GS.layout = { init, draw, resize };
})(window.GS);