/* =========================================================
   Geometry
   The single place that knows what a shape's numbers mean.

   Shape geometry is normalised UV against the export aspect:
   x/y are fractions of the frame, w/h are fractions of width and
   height, rot is degrees. Nothing here is in pixels.

   Every measurement — both hit-tests, both resize gestures, the
   layout outlines, the handle positions — goes through this file.
   That is deliberate: two hand-written copies of the superellipse
   predicate is how the preview's resize grips ended up somewhere
   other than the shape they belonged to.

   ---------- local space ----------

   "Local" is the shape's own frame: rotated by rot, with x scaled by
   the aspect ratio. All distances are measured there, which is the
   same frame the shader's shapeMask works in, and matching it is
   why a hit-test agrees with the pixels. Aspect-corrected units
   also make a resize a straight division instead of a tuned
   constant: see applyResize.

   shapeMask in shaders.js is the hand-written mirror of
   superellipseDist below — same rotation direction, same clamps.
   Change one, change the other.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, deg2rad } = GS.utils;

  /* ---------- constants ---------- */

  /* The eight resize grips, as signed offsets from the centre in the
     shape's own axes. One array: it used to exist four times over,
     and the preview's copy had quietly lost the rotation. */
  const HANDLE_DIRS = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];

  /* Grip hit radius, in CSS pixels — the pointer's unit, not the
     canvas backing store's, so a HiDPI screen does not halve it.
     Both surfaces measure in CSS pixels for exactly this reason. */
  const HANDLE_HIT = 10;

  /* Drawn grip radius, also CSS pixels. */
  const HANDLE_SIZE = 5;

  /* Resize speed, in frames of width per CSS pixel of drag. 1 makes a
     grip track the pointer exactly, which is the only value that
     feels the same in a 300px panel and a 1600px one — the old
     ladder tuned itself against canvas pixels and therefore against
     panel width and devicePixelRatio. Raise it to make dragging
     feel heavier, not to fix a bug. */
  const RESIZE_GAIN = 1;

  const MIN_SIZE = 0.001;
  const MAX_SIZE = 10;

  /* The roundness floor is an epsilon, not a shape limit: r = 1 is a
     rhombus and r < 1 a concave four-point star, but 1/r goes
     infinite at exactly 0. shapeMask in the shader uses 0.01 too. */
  const MIN_ROUNDNESS = 0.01;
  const MIN_HALF = 1e-6;

  /* ---------- frames ---------- */

  function aspect() {
    return GS.state.exportW / GS.state.exportH;
  }

  /* world -> local. Rotation by +rot after the aspect scaling. */
  function toLocal(shape, u, v, ar) {
    const t = deg2rad(shape.rot);
    const px = (u - shape.x) * ar;
    const py = v - shape.y;
    const ca = Math.cos(t), sa = Math.sin(t);
    return [px * ca - py * sa, px * sa + py * ca];
  }

  /* local -> world. The transpose of the above, so the sine changes
     sign; using the forward matrix here mirrors anything rotated. */
  function toWorld(shape, lx, ly, ar) {
    const t = deg2rad(shape.rot);
    const ca = Math.cos(t), sa = Math.sin(t);
    return [
      shape.x + (lx * ca + ly * sa) / ar,
      shape.y - lx * sa + ly * ca,
    ];
  }

  /* ---------- superellipse ---------- */

  /* 1.0 exactly on the outline, less inside, more outside. This is
     the CPU half of the contract with shapeMask. */
  function superellipseDist(shape, u, v, ar) {
    const [lx, ly] = toLocal(shape, u, v, ar);
    const hw = Math.max(shape.w * 0.5 * ar, MIN_HALF);
    const hh = Math.max(shape.h * 0.5, MIN_HALF);
    const r = Math.max(shape.roundness, MIN_ROUNDNESS);
    const dx = Math.abs(lx) / hw;
    const dy = Math.abs(ly) / hh;
    return Math.pow(Math.pow(dx, r) + Math.pow(dy, r), 1 / r);
  }

  function shapeContains(shape, u, v, ar) {
    return superellipseDist(shape, u, v, ar) <= 1;
  }

  /* Topmost first: shapes paint in array order, so the last one drawn
     is the one under the pointer. Invisible shapes are not hit — the
     same rule the renderer applies when it skips them. */
  function hitTest(u, v) {
    const ar = aspect();
    for (let i = GS.state.shapes.length - 1; i >= 0; i--) {
      const s = GS.state.shapes[i];
      if (s.visible && shapeContains(s, u, v, ar)) return s;
    }
    return null;
  }

  /* ---------- handles ---------- */

  /* Grip centres in UV, rotated with the shape. rectW/rectH are CSS
     pixels and only used for hit-testing: a UV distance is anisotropic
     on a non-square canvas, so it cannot be compared against a pixel
     radius directly. */
  function handlePoints(shape, ar) {
    const hw = shape.w * 0.5;
    const hh = shape.h * 0.5;
    const pts = [];
    for (let i = 0; i < HANDLE_DIRS.length; i++) {
      const dx = HANDLE_DIRS[i][0], dy = HANDLE_DIRS[i][1];
      const [u, v] = toWorld(shape, dx * hw * ar, dy * hh, ar);
      pts.push({ u, v, dx, dy, index: i });
    }
    return pts;
  }

  function hitHandle(shape, u, v, rectW, rectH, ar) {
    const pts = handlePoints(shape, ar);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const dpx = Math.hypot((u - p.u) * rectW, (v - p.v) * rectH);
      if (dpx <= HANDLE_HIT) return p;
    }
    return null;
  }

  /* ---------- resize ---------- */

  /* Freeze everything the gesture needs, so applyResize never reads
     the shape back: mutating a shape mid-drag would make the deltas
     drift. */
  function startResize(shape, grip, u, v, ar) {
    const [lx, ly] = toLocal(shape, u, v, ar);
    return {
      shape,
      grip,
      ar,
      dirX: grip.dx,
      dirY: grip.dy,
      startLx: lx,
      startLy: ly,
      startW: shape.w,
      startH: shape.h,
      startX: shape.x,
      startY: shape.y,
    };
  }

  /* Pure: reads the gesture and the pointer, returns the new pose.
     mods.ratio locks the aspect ratio, mods.fromCenter pins the
     opposite edge (alt). Returns everything the caller has to write,
     including x/y, because from-center moves the shape as well. */

  /* The width follows the dragged edge one-to-one: local units are
     aspect-corrected, so a drag of dlx is dlx/ar in width units and a
     half-extent change of that is a width change of twice it. No
     canvas size appears in that, which is the whole point. */
  function applyResize(rd, u, v, mods) {
    const shape = rd.shape;
    const [lx, ly] = toLocal(shape, u, v, rd.ar);

    /* The gesture works in the same clamped size domain as the
       normaliser, so a shape stored at w = 0 has a finite starting
       ratio instead of 0/0 and the lock below cannot produce NaN. */
    const startW = clamp(rd.startW, MIN_SIZE, MAX_SIZE);
    const startH = clamp(rd.startH, MIN_SIZE, MAX_SIZE);

    let w = startW;
    let h = startH;

    if (rd.dirX !== 0) {
      w += 2 * rd.dirX * (lx - rd.startLx) / rd.ar * RESIZE_GAIN;
    }
    if (rd.dirY !== 0) {
      h += 2 * rd.dirY * (ly - rd.startLy) * RESIZE_GAIN;
    }

    if (mods.ratio && rd.dirX !== 0 && rd.dirY !== 0) {
      const ratio = startW / startH;
      if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
    }

    w = clamp(w, MIN_SIZE, MAX_SIZE);
    h = clamp(h, MIN_SIZE, MAX_SIZE);

    let x = rd.startX;
    let y = rd.startY;

    if (mods.fromCenter && (rd.dirX !== 0 || rd.dirY !== 0)) {
      /* Keep the grabbed edge where it is and move the centre to the
         other side of it, in local units — that is what makes the
         shape grow out of its middle rather than its far edge. */
      const [cu, cv] = toWorld(
        shape,
        rd.dirX * (startW * 0.5 * rd.ar - w * 0.5 * rd.ar),
        rd.dirY * (startH * 0.5 - h * 0.5),
        rd.ar,
      );
      x = cu;
      y = cv;
    }

    return { w, h, x, y };
  }

  GS.geom = {
    aspect,
    toLocal,
    toWorld,
    superellipseDist,
    shapeContains,
    hitTest,
    handlePoints,
    hitHandle,
    startResize,
    applyResize,
    HANDLE_DIRS,
    HANDLE_HIT,
    HANDLE_SIZE,
    RESIZE_GAIN,
  };
})(window.GS);
