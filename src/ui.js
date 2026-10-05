/* =========================================================
   UI
   Builds and owns every panel. Delegated listeners bound once,
   so rebuildAll() and refreshSelection() stay cheap. The
   gradient editor is a draggable strip plus a numeric stop list,
   kept in sync; stops are always displayed in position order.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, clone } = GS.utils;
  const gradient = GS.gradient;

  const PANEL_TARGETS = [
    'shapes-list', 'shape-body', 'grad-angle', 'grad-stops',
    'bg-body', 'blur-body', 'export-body', 'presets-body',
  ];

  /* The blur lives on the scene, not on a shape, and is stored as a
     fraction of the frame width. The slider speaks percent, and the
     hint underneath translates it into the pixels the current export
     size will actually get. */
  const BLUR_STEP_PCT = 0.05;

  const SHAPE_FIELDS = [
    ['x', 'X', -1, 2, 0.005],
    ['y', 'Y', -1, 2, 0.005],
    ['w', 'Width', 0.01, 3, 0.005],
    ['h', 'Height', 0.01, 3, 0.005],
    ['rot', 'Rotation', -180, 180, 0.5],
    ['roundness', 'Roundness', 1.2, 20, 0.05],
    ['softness', 'Softness', 0.001, 2, 0.005],
    ['glow', 'Glow', 0.1, 2, 0.01],
    ['opacity', 'Opacity', 0, 1, 0.01],
    ['grain', 'Grain', 0, 0.15, 0.001],
  ];

  const SIZE_PRESETS = [
    [1920, 1080], [2560, 1440], [3840, 2160],
    [1080, 1920], [1440, 2560], [5120, 2880],
    [3840, 3840], [800, 800], [1080, 1080],
  ];

  /* ---------- DOM helpers ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    const node = el('button', className, text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function percent(pos) { return Math.round(pos * 100) + '%'; }

  function sortedStops(stops) {
    return [...stops].sort((a, b) => a.pos - b.pos);
  }

  /* ---------- Generic range+number ---------- */

  const inputBinders = new WeakMap();

  function makeControl(parent, opts) {
    const { label, min, max, step, value, onChange } = opts;
    const row = el('div', 'ctrl');
    row.appendChild(el('label', null, label));

    const range = el('input');
    range.type = 'range';
    Object.assign(range, { min, max, step, value });

    const num = el('input');
    num.type = 'number';
    Object.assign(num, { min, max, step, value });

    row.append(range, num);

    function set(v, fire) {
      range.value = v;
      num.value = v;
      if (fire) onChange(v);
    }

    range.addEventListener('input', () => {
      const v = parseFloat(range.value);
      num.value = v;
      onChange(v);
    });
    num.addEventListener('input', () => {
      const v = parseFloat(num.value);
      if (isNaN(v)) return;
      range.value = v;
      onChange(v);
    });
    num.addEventListener('blur', () => {
      const v = parseFloat(num.value);
      set(isNaN(v) ? value : clamp(v, parseFloat(min), parseFloat(max)), true);
    });

    parent.appendChild(row);
    const api = { set: v => set(v, false) };
    inputBinders.set(row, api);
    return api;
  }

  function syncShapeInputs() {
    const body = GS.byId('shape-body');
    const shape = GS.getSelectedShape();
    if (!body || !shape) return;
    SHAPE_FIELDS.forEach(([key], i) => {
      const row = body.querySelectorAll('.ctrl')[i];
      if (!row) return;
      const api = inputBinders.get(row);
      if (api) api.set(shape[key]);
    });
  }

  /* ---------- Gradient strip (drag editor) ---------- */

  let stripDrag = null;
  const STRIP_SAMPLES = 24;

  /* The strip mirrors the renderer, so it is sampled through the
     same OKLab mix instead of a CSS gradient — browsers interpolate
     those in sRGB and would show a harsher ramp than the preview. */
  function stripBackground(stops) {
    const list = sortedStops(stops);
    if (!list.length) return 'none';
    if (list.length === 1) return list[0].color;
    const parts = [];
    for (let i = 0; i < STRIP_SAMPLES; i++) {
      const t = i / (STRIP_SAMPLES - 1);
      parts.push(`${gradient.sampleStopsColor(list, t)} ${(t * 100).toFixed(2)}%`);
    }
    return 'linear-gradient(90deg, ' + parts.join(', ') + ')';
  }

  function renderStrip() {
    const strip = GS.byId('grad-strip');
    const handles = GS.byId('grad-handles');
    if (!strip || !handles) return;

    const shape = GS.getSelectedShape();
    if (!shape) {
      strip.style.background = 'none';
      handles.replaceChildren();
      return;
    }

    const list = sortedStops(shape.gradient.stops);
    strip.style.background = stripBackground(list);

    handles.replaceChildren(...list.map(stop => {
      const h = el('div', 'stop-handle');
      h.style.left = (stop.pos * 100) + '%';
      h.style.backgroundColor = stop.color;
      h.title = percent(stop.pos);
      h._stop = stop;
      return h;
    }));
  }

  function bindStrip() {
    const strip = GS.byId('grad-strip');
    const handles = GS.byId('grad-handles');
    if (!strip || !handles) return;

    strip.addEventListener('pointerdown', e => {
      const shape = GS.getSelectedShape();
      if (!shape) return;
      const rect = strip.getBoundingClientRect();
      const pos = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const list = sortedStops(shape.gradient.stops);
      shape.gradient.stops.push({
        pos,
        color: gradient.sampleStopsColor(list, pos),
      });
      renderStrip();
      renderStops(GS.byId('grad-stops'), shape.gradient.stops);
      GS.preview.schedule();
      if (GS.layout) GS.layout.draw();
    });

    handles.addEventListener('pointerdown', e => {
      const h = e.target.closest('.stop-handle');
      if (!h || !h._stop) return;
      stripDrag = { stop: h._stop, handle: h };
      try { h.setPointerCapture(e.pointerId); } catch (_) {}
      h.classList.add('active');
      e.preventDefault();
    });

    handles.addEventListener('pointermove', e => {
      if (!stripDrag) return;
      const { stop, handle } = stripDrag;
      const shape = GS.getSelectedShape();
      if (!shape) return;
      const rect = strip.getBoundingClientRect();
      const pos = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      stop.pos = pos;
      handle.style.left = (pos * 100) + '%';
      handle.title = percent(pos);

      // live re-tint of the strip background
      strip.style.background = stripBackground(shape.gradient.stops);

      GS.preview.schedule();
      if (GS.layout) GS.layout.draw();
    });

    handles.addEventListener('pointerup', e => {
      if (!stripDrag) return;
      try { stripDrag.handle.releasePointerCapture(e.pointerId); } catch (_) {}
      stripDrag = null;
      const shape = GS.getSelectedShape();
      if (!shape) return;
      renderStrip();
      renderStops(GS.byId('grad-stops'), shape.gradient.stops);
    });
    handles.addEventListener('pointercancel', () => {
      if (!stripDrag) return;
      stripDrag.handle.classList.remove('active');
      stripDrag = null;
    });
  }

  /* ---------- Stops editor (numeric rows) ---------- */

  function renderStops(container, stops) {
    const list = sortedStops(stops);
    container.replaceChildren(...list.map(stop => {
      const row = el('div', 'stop');
      row._stop = stop;

      const grip = el('div', 'grip');
      grip.title = 'Drag to reorder stops';

      const color = el('input', 'stop-color');
      color.type = 'color';
      color.value = stop.color;
      color.title = 'Stop colour';

      const posRange = el('input', 'pos-range');
      posRange.type = 'range';
      posRange.min = 0; posRange.max = 1; posRange.step = 0.001;
      posRange.value = stop.pos;
      posRange.title = 'Position along the gradient';

      const del = el('button', 'del', '×');
      del.type = 'button';
      del.title = 'Remove stop';
      del.disabled = stops.length <= 2;

      row.append(
        grip, color,
        posRange, el('span', 'pos', percent(stop.pos)),
        del,
      );
      return row;
    }));
  }

  /* Colour order is position order, so "reorder" means giving the
     dragged stop the slot of the row it landed on: the positions
     stay put and the colours swap places between them. */
  function reorderStops(stops, from, to) {
    const list = sortedStops(stops);
    const positions = list.map(s => s.pos);
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    list.forEach((s, i) => { s.pos = positions[i]; });
    stops.length = 0;
    stops.push(...list);
  }

  function bindStopEditor(container) {
    container.addEventListener('input', e => {
      const shape = GS.getSelectedShape();
      if (!shape) return;
      const row = e.target.closest('.stop');
      if (!row || !row._stop) return;
      const stop = row._stop;
      const target = e.target;

      if (target === row.querySelector('.stop-color')) {
        stop.color = target.value;
      } else if (target.classList.contains('pos-range')) {
        stop.pos = clamp(parseFloat(target.value), 0, 1);
        row.querySelector('.pos').textContent = percent(stop.pos);
      } else {
        return;
      }

      renderStrip();
      GS.preview.schedule();
    });

    /* Rows are shown in position order, so anything that can move a
       stop past its neighbour is re-sorted once the gesture ends. */
    container.addEventListener('change', () => {
      const shape = GS.getSelectedShape();
      if (!shape) return;
      renderStops(container, shape.gradient.stops);
      renderStrip();
    });

    container.addEventListener('click', e => {
      if (!e.target.closest('.del')) return;
      const shape = GS.getSelectedShape();
      if (!shape) return;
      const stops = shape.gradient.stops;
      if (stops.length <= 2) return;
      const row = e.target.closest('.stop');
      if (!row || !row._stop) return;
      const idx = stops.indexOf(row._stop);
      if (idx >= 0) stops.splice(idx, 1);
      renderStops(container, stops);
      renderStrip();
      GS.preview.schedule();
    });

    bindStopReorder(container);
  }

  /* Pointer-driven drag & drop. Native HTML5 DnD would fight the
     range inputs, so rows are picked up by their grip, a drop
     marker shows which slot is targeted and the swap happens on
     release. */
  let stopDrag = null;

  function clearDropMarks(container) {
    container.querySelectorAll('.drop-before, .drop-after')
      .forEach(r => r.classList.remove('drop-before', 'drop-after'));
  }

  function bindStopReorder(container) {
    container.addEventListener('pointerdown', e => {
      const grip = e.target.closest('.grip');
      if (!grip) return;
      const row = grip.closest('.stop');
      const shape = GS.getSelectedShape();
      if (!row || !row._stop || !shape) return;

      const from = sortedStops(shape.gradient.stops).indexOf(row._stop);
      if (from < 0) return;

      stopDrag = { stop: row._stop, row, grip, from, to: from };
      row.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    container.addEventListener('pointermove', e => {
      if (!stopDrag) return;
      const rows = [...container.children];
      let to = stopDrag.from;
      let best = Infinity;
      rows.forEach((r, i) => {
        if (r === stopDrag.row) return;
        const rect = r.getBoundingClientRect();
        const d = Math.abs(e.clientY - (rect.top + rect.height / 2));
        if (d < best) { best = d; to = i; }
      });
      if (to === stopDrag.to) return;

      stopDrag.to = to;
      clearDropMarks(container);
      const target = rows[to];
      if (target) target.classList.add(to > stopDrag.from ? 'drop-after' : 'drop-before');
    });

    const finish = e => {
      if (!stopDrag) return;
      const { from, to, row, grip } = stopDrag;
      stopDrag = null;
      try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
      clearDropMarks(container);
      row.classList.remove('dragging');

      if (from === to) return;
      const shape = GS.getSelectedShape();
      if (!shape) return;
      const stops = shape.gradient.stops;
      reorderStops(stops, from, to);
      renderStops(container, stops);
      renderStrip();
      GS.preview.schedule();
    };

    container.addEventListener('pointerup', finish);
    container.addEventListener('pointercancel', finish);
  }

  function addStop() {
    const shape = GS.getSelectedShape();
    if (!shape) return;
    const stops = shape.gradient.stops;
    const sorted = gradient.sortStops(stops);
    const pos = gradient.widestGapMidpoint(sorted);
    stops.push({ pos, color: gradient.sampleStopsColor(sorted, pos) });
    renderStops(GS.byId('grad-stops'), stops);
    renderStrip();
    GS.preview.schedule();
  }

  /* ---------- Shapes list ---------- */

  function swatchBackground(stops) {
    const sorted = gradient.sortStops(stops);
    return `linear-gradient(180deg, ${gradient.sampleStopsColor(sorted, 0.15)}, ${gradient.sampleStopsColor(sorted, 0.5)}, ${gradient.sampleStopsColor(sorted, 0.85)})`;
  }

  function buildShapesList() {
    const list = GS.byId('shapes-list');
    const items = GS.state.shapes.map((shape, i) => {
      const item = el('div', 'shape-item' + (shape.id === GS.selection.id ? ' selected' : ''));
      item.dataset.id = shape.id;

      const grip = el('div', 'grip');
      grip.title = 'Drag to change Z-order';

      const sw = el('div', 'swatch-mini');
      sw.style.background = swatchBackground(shape.gradient.stops);

      item.append(grip, sw);

      item.appendChild(el('div', 'name', `Shape ${i + 1}`));

      const vis = el('button', 'icon-btn' + (shape.visible ? '' : ' off'), shape.visible ? '◉' : '○');
      vis.type = 'button';
      vis.title = shape.visible ? 'Hide' : 'Show';
      vis.dataset.action = 'toggle-vis';
      item.appendChild(vis);

      const rm = el('button', 'icon-btn', '×');
      rm.type = 'button';
      rm.title = 'Delete shape';
      rm.dataset.action = 'delete';
      item.appendChild(rm);

      return item;
    });
    list.replaceChildren(...items);
  }

  function bindShapesList() {
    const list = GS.byId('shapes-list');
    list.addEventListener('click', e => {
      const item = e.target.closest('.shape-item');
      if (!item) return;
      /* The grip owns its own gesture (pick up on pointerdown, drop
         on release); letting the synthetic click through as well
         would just re-select and rebuild the same panels twice. */
      if (e.target.closest('.grip')) return;
      const shape = GS.state.shapes.find(s => s.id === item.dataset.id);
      if (!shape) return;

      const action = e.target.dataset.action;
      if (action === 'toggle-vis') {
        shape.visible = !shape.visible;
        buildShapesList();
        GS.preview.schedule();
        return;
      }
      if (action === 'delete') {
        deleteShape(shape.id);
        return;
      }
      GS.selection.id = shape.id;
      refreshSelection();
    });

    bindShapeReorder(list);
  }

  /* Shapes paint in array order, so the list order *is* the Z-order:
     the first row is the bottom-most layer. Rows are picked up by
     their grip, a marker shows the target slot and the array is
     respliced on release. Reordering swaps whole shape objects
     rather than colours-in-fixed-positions (that trick is only
     correct for gradient stops, whose positions are the schema). */
  let shapeDrag = null;

  function moveShape(from, to) {
    if (from === to) return;
    const shapes = GS.state.shapes;
    const [moved] = shapes.splice(from, 1);
    shapes.splice(to, 0, moved);
  }

  function bindShapeReorder(list) {
    list.addEventListener('pointerdown', e => {
      const grip = e.target.closest('.grip');
      if (!grip) return;
      const row = grip.closest('.shape-item');
      if (!row) return;
      const from = GS.state.shapes.findIndex(s => s.id === row.dataset.id);
      if (from < 0) return;

      shapeDrag = { row, grip, from, to: from };
      row.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();

      /* Grabbing a row picks it, like every other layer panel. The
         list itself must not be rebuilt here — it would replace the
         row under the pointer mid-gesture — so the highlight is
         toggled in place and only the sibling panels are refreshed. */
      if (GS.selection.id !== row.dataset.id) {
        GS.selection.id = row.dataset.id;
        list.querySelectorAll('.shape-item').forEach(r => {
          r.classList.toggle('selected', r === row);
        });
        refreshShapePanel();
        refreshGradientPanel();
      }
    });

    list.addEventListener('pointermove', e => {
      if (!shapeDrag) return;
      const rows = [...list.children];
      let to = shapeDrag.from;
      let best = Infinity;
      rows.forEach((r, i) => {
        if (r === shapeDrag.row) return;
        const rect = r.getBoundingClientRect();
        const d = Math.abs(e.clientY - (rect.top + rect.height / 2));
        if (d < best) { best = d; to = i; }
      });
      if (to === shapeDrag.to) return;

      shapeDrag.to = to;
      clearDropMarks(list);
      const target = rows[to];
      if (target) target.classList.add(to > shapeDrag.from ? 'drop-after' : 'drop-before');
    });

    const finish = e => {
      if (!shapeDrag) return;
      const { from, to, row, grip } = shapeDrag;
      shapeDrag = null;
      try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
      clearDropMarks(list);
      row.classList.remove('dragging');

      if (from === to) return;
      moveShape(from, to);
      buildShapesList();
      GS.preview.schedule();
    };

    /* A cancel means the browser took the gesture away (touch
       scroll, a context menu); committing there would silently
       reshuffle the layers the user never finished dropping. */
    const cancel = e => {
      if (!shapeDrag) return;
      try { shapeDrag.grip.releasePointerCapture(e.pointerId); } catch (_) {}
      clearDropMarks(list);
      shapeDrag.row.classList.remove('dragging');
      shapeDrag = null;
    };

    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', cancel);
  }

  /* ---------- Shape ops ---------- */

  function addShape() {
    const next = GS.randomShape();
    GS.state.shapes.push(next);
    GS.selection.id = next.id;
    refreshSelection();
    GS.preview.schedule();
    GS.toast('New random shape');
  }

  function duplicateShape() {
    const sel = GS.getSelectedShape();
    if (!sel) return;
    const dup = {
      ...clone(sel),
      id: GS.makeShapeId(),
      x: sel.x + 0.06,
      y: sel.y + 0.06,
    };
    const i = GS.state.shapes.indexOf(sel);
    GS.state.shapes.splice(i + 1, 0, dup);
    GS.selection.id = dup.id;
    refreshSelection();
    GS.preview.schedule();
    GS.toast('Duplicated');
  }

  function addShapeAt(u, v) {
    const next = GS.randomShape({ u, v });
    GS.state.shapes.push(next);
    GS.selection.id = next.id;
    refreshSelection();
    GS.preview.schedule();
  }

  function deleteShape(id) {
    const i = GS.state.shapes.findIndex(s => s.id === id);
    if (i < 0) return;
    if (GS.state.shapes.length <= 1) {
      GS.toast('Cannot delete the last shape');
      return;
    }
    GS.state.shapes.splice(i, 1);
    if (GS.selection.id === id) {
      const pick = GS.state.shapes[Math.min(i, GS.state.shapes.length - 1)];
      GS.selection.id = pick ? pick.id : null;
    }
    refreshSelection();
    GS.preview.schedule();
  }

  /* ---------- Selected-shape panel ---------- */

  function buildShapePanel() {
    const body = GS.byId('shape-body');
    const shape = GS.getSelectedShape();
    if (!shape) {
      body.appendChild(el('div', 'preset-empty', 'No shape selected'));
      return;
    }

    SHAPE_FIELDS.forEach(([key, label, min, max, step]) => {
      makeControl(body, {
        label, min, max, step,
        value: shape[key],
        onChange: v => {
          shape[key] = v;
          GS.preview.schedule();
          if (GS.layout) GS.layout.draw();
        },
      });
    });

    const row = el('div', 'ctrl');
    row.style.gridTemplateColumns = '78px 1fr';
    row.appendChild(el('label', null, 'Blend'));

    const sel = el('select', 'blend-select');
    GS.BLEND_MODES.forEach(mode => {
      const opt = el('option', null, mode.charAt(0).toUpperCase() + mode.slice(1));
      opt.value = mode;
      if (shape.blend === mode) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      shape.blend = sel.value;
      GS.preview.schedule();
    });
    row.appendChild(sel);
    body.appendChild(row);
  }

  /* ---------- Gradient panel (selected shape) ---------- */

  function buildGradientPanel() {
    const shape = GS.getSelectedShape();
    const angleHost = GS.byId('grad-angle');
    const stopsHost = GS.byId('grad-stops');

    if (!shape) {
      angleHost.replaceChildren();
      stopsHost.replaceChildren();
      renderStrip();
      return;
    }

    makeControl(angleHost, {
      label: 'Angle', min: 0, max: 360, step: 0.5,
      value: shape.gradient.angle,
      onChange: v => {
        shape.gradient.angle = v;
        GS.preview.schedule();
        if (GS.layout) GS.layout.draw();
      },
    });
    renderStops(stopsHost, shape.gradient.stops);
    renderStrip();
  }

  /* ---------- Background ---------- */

  function buildBackgroundUI() {
    const row = el('div', 'ctrl ctrl-color');
    row.appendChild(el('label', null, 'Colour'));

    const color = el('input');
    color.type = 'color';
    color.value = GS.state.background;
    color.addEventListener('input', () => {
      GS.state.background = color.value;
      GS.preview.schedule();
      if (GS.layout) GS.layout.draw();
    });

    row.appendChild(color);
    GS.byId('bg-body').appendChild(row);
  }

  /* ---------- Blur ---------- */

  function blurPixels() {
    return Math.round((GS.state.blur || 0) * GS.state.exportW);
  }

  function syncBlurHint() {
    const hint = GS.byId('blur-hint');
    if (!hint) return;
    const px = blurPixels();
    hint.textContent = px > 0
      ? `Gaussian σ ≈ ${px} px at ${GS.state.exportW}×${GS.state.exportH}`
      : 'No blur — shapes composite straight to the canvas';
  }

  function buildBlurUI() {
    const body = GS.byId('blur-body');

    makeControl(body, {
      label: 'Radius', min: 0, max: GS.MAX_BLUR * 100, step: BLUR_STEP_PCT,
      value: (GS.state.blur || 0) * 100,
      onChange: v => {
        GS.state.blur = clamp(v / 100, 0, GS.MAX_BLUR);
        syncBlurHint();
        GS.preview.schedule();
      },
    });

    const hint = el('div', 'hint');
    hint.id = 'blur-hint';
    body.appendChild(hint);
    syncBlurHint();
  }

  /* ---------- Export ---------- */

  function sizeField(label, value, onChange) {
    const wrap = el('div', 'size-field');
    wrap.appendChild(el('div', 'lbl', label));
    const input = el('input');
    input.type = 'number';
    input.min = 1; input.step = 1; input.value = value;
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      if (!isNaN(v) && v > 0) onChange(v);
    });
    wrap.appendChild(input);
    return { wrap, input };
  }

  function buildExportUI() {
    const body = GS.byId('export-body');

    const size = el('div', 'export-size');
    const width = sizeField('Width', GS.state.exportW, v => {
      GS.state.exportW = v;
      syncBlurHint();
      GS.preview.layout();
      if (GS.layout) GS.layout.resize();
    });
    const height = sizeField('Height', GS.state.exportH, v => {
      GS.state.exportH = v;
      syncBlurHint();
      GS.preview.layout();
      if (GS.layout) GS.layout.resize();
    });
    size.append(width.wrap, height.wrap);

    const presets = el('div', 'preset-grid');
    SIZE_PRESETS.forEach(([w, h]) => {
      presets.appendChild(button('btn', `${w}×${h}`, () => {
        GS.state.exportW = w;
        GS.state.exportH = h;
        width.input.value = w;
        height.input.value = h;
        syncBlurHint();
        GS.preview.layout();
        if (GS.layout) GS.layout.resize();
      }));
    });

    const actions = el('div', 'btn-row');
    actions.append(
      button('btn', 'Copy link', () => GS.share.copyLink()),
      button('btn', 'Random', () => {
        GS.applyState(GS.randomState());
        rebuildAll();
        GS.toast('Randomised');
      }),
    );

    body.append(size, presets, button('btn primary', 'Export PNG', () => GS.exportPNG()), actions);
  }

  /* ---------- Presets ---------- */

  function presetItem(preset, kind, index) {
    const item = el('div', 'preset-item');
    item.dataset.kind = kind;
    item.dataset.index = index;

    const swatch = el('div', 'swatch');
    const first = preset.state.shapes && preset.state.shapes[0];
    if (first) swatch.style.background = swatchBackground(first.gradient.stops);
    item.append(swatch, el('div', 'name', preset.name));

    if (kind === 'user') {
      const rm = button('rm', '×', () => removeUserPreset(index));
      rm.title = 'Delete preset';
      item.appendChild(rm);
    }
    return item;
  }

  function buildPresetsUI() {
    const body = GS.byId('presets-body');
    body.replaceChildren();

    body.appendChild(el('div', 'section-label', 'Built-in'));
    const builtin = el('div', 'preset-list');
    GS.BUILTIN_PRESETS.forEach((p, i) => builtin.appendChild(presetItem(p, 'builtin', i)));
    body.appendChild(builtin);

    const user = GS.storage.loadUserPresets();
    body.appendChild(el('div', 'section-label section-label-spaced', 'My presets'));
    const userList = el('div', 'preset-list');
    if (user.length === 0) {
      userList.appendChild(el('div', 'preset-empty', 'No saved presets yet'));
    } else {
      user.forEach((p, i) => userList.appendChild(presetItem(p, 'user', i)));
    }
    body.appendChild(userList);

    body.appendChild(button('btn', 'Save current as preset', saveCurrentAsPreset));
  }

  function removeUserPreset(index) {
    const list = GS.storage.loadUserPresets();
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    GS.storage.saveUserPresets(list);
    buildPresetsUI();
    GS.toast('Preset deleted');
  }

  async function saveCurrentAsPreset() {
    const list = GS.storage.loadUserPresets();
    const name = await GS.askText({ title: 'Preset name', value: `Preset ${list.length + 1}` });
    if (!name) return;
    list.push({ name, state: clone(GS.state) });
    GS.storage.saveUserPresets(list);
    buildPresetsUI();
    GS.toast(`Saved "${name}"`);
  }

  /* ---------- Delegated binders ---------- */

  function bindPresets() {
    GS.byId('presets-body').addEventListener('click', e => {
      const item = e.target.closest('.preset-item');
      if (!item) return;
      const index = +item.dataset.index;
      if (e.target.closest('.rm')) return removeUserPreset(index);
      const list = item.dataset.kind === 'builtin' ? GS.BUILTIN_PRESETS : GS.storage.loadUserPresets();
      const preset = list[index];
      if (!preset) return;
      GS.applyState(preset.state);
      rebuildAll();
      GS.toast(`Loaded "${preset.name}"`);
    });
  }

  function bindGlobalKeys() {
    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!GS.selection.id) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteShape(GS.selection.id);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateShape();
      }
    });
  }

  function bindShapeActions() {
    GS.byId('add-shape-btn').addEventListener('click', addShape);
    GS.byId('duplicate-shape-btn').addEventListener('click', duplicateShape);
    GS.byId('add-stop-btn').addEventListener('click', addStop);
  }

  /* ---------- Refresh ---------- */

  function refreshShapesList() { buildShapesList(); }

  function refreshShapePanel() {
    GS.byId('shape-body').replaceChildren();
    buildShapePanel();
  }

  function refreshGradientPanel() {
    GS.byId('grad-angle').replaceChildren();
    GS.byId('grad-stops').replaceChildren();
    buildGradientPanel();
  }

  function refreshSelection() {
    GS.ensureSelection();
    refreshShapesList();
    refreshShapePanel();
    refreshGradientPanel();
    if (GS.layout) GS.layout.draw();
  }

  function rebuildAll() {
    PANEL_TARGETS.forEach(id => GS.byId(id).replaceChildren());
    GS.ensureSelection();
    buildShapesList();
    buildShapePanel();
    buildGradientPanel();
    buildBackgroundUI();
    buildBlurUI();
    buildExportUI();
    buildPresetsUI();
    GS.preview.layout();
    if (GS.layout) GS.layout.resize();
    GS.share.sync();
  }

  /* ---------- Toast ---------- */

  const toastQueue = [];
  let toastTimer = null;

  function toast(message) {
    toastQueue.push(String(message));
    if (!toastTimer) runToastQueue();
  }

  function runToastQueue() {
    const node = GS.byId('toast');
    const message = toastQueue.shift();
    if (message === undefined) { toastTimer = null; return; }
    node.textContent = message;
    node.classList.add('show');
    toastTimer = setTimeout(() => {
      node.classList.remove('show');
      toastTimer = setTimeout(runToastQueue, 260);
    }, 2200);
  }

  /* ---------- Modal ---------- */

  function askText(opts) {
    const { title = 'Enter a value', value = '', okLabel = 'Save' } = opts;
    return new Promise(resolve => {
      const backdrop = el('div', 'modal-backdrop');
      const box = el('div', 'modal');
      box.appendChild(el('div', 'modal-title', title));

      const field = el('div', 'modal-field');
      const input = el('input');
      input.type = 'text';
      input.value = value;
      field.appendChild(input);

      const actions = el('div', 'btn-row');
      const cancel = button('btn', 'Cancel');
      const ok = button('btn primary', okLabel);
      actions.append(cancel, ok);

      box.append(field, actions);
      backdrop.appendChild(box);
      document.body.appendChild(backdrop);

      requestAnimationFrame(() => {
        backdrop.classList.add('show');
        input.focus();
        input.select();
      });

      function close(result) {
        document.removeEventListener('keydown', onKey);
        backdrop.classList.remove('show');
        setTimeout(() => backdrop.remove(), 180);
        resolve(result);
      }
      function submit() { close(input.value.trim() || null); }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        else if (e.key === 'Enter') submit();
      }
      document.addEventListener('keydown', onKey);
      backdrop.addEventListener('click', e => { if (e.target === backdrop) close(null); });
      cancel.addEventListener('click', () => close(null));
      ok.addEventListener('click', submit);
    });
  }

  /* ---------- Init ---------- */

  function init() {
    bindStopEditor(GS.byId('grad-stops'));
    bindStrip();
    bindShapesList();
    bindPresets();
    bindShapeActions();
    bindGlobalKeys();
    if (GS.layout) GS.layout.init();
    rebuildAll();
  }

  GS.ui = {
    init, rebuildAll, refreshSelection,
    syncShapeInputs,
    addShape, addShapeAt, duplicateShape, deleteShape,
  };
  GS.toast = toast;
  GS.askText = askText;
})(window.GS);
