/* =========================================================
   UI
   Builds and owns every panel. All dynamic content is rendered
   with delegated listeners bound once, so rebuildAll() is cheap
   and safe to call after any state change.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, clone } = GS.utils;
  const gradient = GS.gradient;

  /* Containers cleared on every rebuild. */
  const PANEL_TARGETS = [
    'shape-body', 'main-angle', 'main-stops',
    'horiz-angle', 'horiz-stops', 'mix-ctrl',
    'bg-body', 'export-body', 'presets-body',
  ];

  const STOP_HOSTS = { main: 'main-stops', horiz: 'horiz-stops' };
  const GRADIENT_KEYS = ['main', 'horiz'];

  const SHAPE_FIELDS = [
    ['width', 'Width', 0.01, 3, 0.005],
    ['height', 'Height', 0.01, 3, 0.005],
    ['centerX', 'Center X', -1, 2, 0.005],
    ['centerY', 'Center Y', -1, 2, 0.005],
    ['angle', 'Rotation', -180, 180, 0.5],
    ['roundness', 'Roundness', 1.2, 20, 0.05],
    ['softness', 'Softness', 0.001, 2, 0.005],
    ['glow', 'Glow', 0.1, 2, 0.01],
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

  function percent(pos) {
    return Math.round(pos * 100) + '%';
  }

  /* ---------- Generic controls ---------- */

  /* Range + number pair kept in sync. Returns a programmatic setter. */
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
    return { set: v => set(v, false) };
  }

  /* ---------- Gradient stops ---------- */

  function renderStops(container, stops) {
    const rows = stops.map((stop, i) => {
      const row = el('div', 'stop');
      row.dataset.index = i;

      const color = el('input');
      color.type = 'color';
      color.value = stop.color;
      color.title = 'Stop colour';

      const range = el('input');
      range.type = 'range';
      range.min = 0;
      range.max = 1;
      range.step = 0.001;
      range.value = stop.pos;

      const del = el('button', 'del', '×');
      del.type = 'button';
      del.title = 'Remove stop';
      del.disabled = stops.length <= 2;

      row.append(color, range, el('span', 'pos', percent(stop.pos)), del);
      return row;
    });
    container.replaceChildren(...rows);
  }

  function bindStopEditor(container) {
    const key = container.dataset.grad;

    container.addEventListener('input', e => {
      const row = e.target.closest('.stop');
      if (!row) return;
      const stop = GS.state[key].stops[+row.dataset.index];
      if (!stop) return;

      if (e.target.type === 'color') {
        stop.color = e.target.value;
      } else if (e.target.type === 'range') {
        stop.pos = parseFloat(e.target.value);
        row.querySelector('.pos').textContent = percent(stop.pos);
      } else {
        return;
      }
      GS.preview.schedule();
    });

    container.addEventListener('click', e => {
      if (!e.target.closest('.del')) return;
      const stops = GS.state[key].stops;
      if (stops.length <= 2) return;
      stops.splice(+e.target.closest('.stop').dataset.index, 1);
      renderStops(container, stops);
      GS.preview.schedule();
    });
  }

  function addStop(key) {
    const stops = GS.state[key].stops;
    const sorted = gradient.sortStops(stops);
    const pos = gradient.widestGapMidpoint(sorted);
    const after = sorted.findIndex(s => s.pos > pos);
    stops.splice(after === -1 ? stops.length : after, 0, {
      pos,
      color: gradient.sampleStopsColor(sorted, pos),
    });
    renderStops(GS.byId(STOP_HOSTS[key]), stops);
    GS.preview.schedule();
  }

  /* ---------- Panels ---------- */

  function buildShapeUI() {
    const body = GS.byId('shape-body');
    SHAPE_FIELDS.forEach(([key, label, min, max, step]) => {
      makeControl(body, {
        label, min, max, step,
        value: GS.state.shape[key],
        onChange: v => {
          GS.state.shape[key] = v;
          GS.preview.schedule();
        },
      });
    });
  }

  function buildGradientUI() {
    GRADIENT_KEYS.forEach(key => {
      makeControl(GS.byId(key + '-angle'), {
        label: 'Angle', min: 0, max: 360, step: 0.5,
        value: GS.state[key].angle,
        onChange: v => {
          GS.state[key].angle = v;
          GS.preview.schedule();
        },
      });
      renderStops(GS.byId(STOP_HOSTS[key]), GS.state[key].stops);
    });

    makeControl(GS.byId('mix-ctrl'), {
      label: 'Mix', min: 0, max: 1, step: 0.005,
      value: GS.state.mix,
      onChange: v => {
        GS.state.mix = v;
        GS.preview.schedule();
      },
    });
  }

  function buildBackgroundUI() {
    const row = el('div', 'ctrl ctrl-color');
    row.appendChild(el('label', null, 'Colour'));

    const color = el('input');
    color.type = 'color';
    color.value = GS.state.background;
    color.addEventListener('input', () => {
      GS.state.background = color.value;
      GS.preview.schedule();
    });

    row.appendChild(color);
    GS.byId('bg-body').appendChild(row);
  }

  function sizeField(label, value, onChange) {
    const wrap = el('div', 'size-field');
    wrap.appendChild(el('div', 'lbl', label));

    const input = el('input');
    input.type = 'number';
    input.min = 1;
    input.step = 1;
    input.value = value;
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
      GS.preview.layout();
    });
    const height = sizeField('Height', GS.state.exportH, v => {
      GS.state.exportH = v;
      GS.preview.layout();
    });
    size.append(width.wrap, height.wrap);

    const presets = el('div', 'preset-grid');
    SIZE_PRESETS.forEach(([w, h]) => {
      presets.appendChild(button('btn', `${w}×${h}`, () => {
        GS.state.exportW = w;
        GS.state.exportH = h;
        width.input.value = w;
        height.input.value = h;
        GS.preview.layout();
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

  function presetItem(preset, kind, index) {
    const item = el('div', 'preset-item');
    item.dataset.kind = kind;
    item.dataset.index = index;

    const swatch = el('div', 'swatch');
    const stops = gradient.sortStops(preset.state.main.stops);
    swatch.style.background = `linear-gradient(180deg, ${gradient.sampleStopsColor(stops, 0.15)}, ${gradient.sampleStopsColor(stops, 0.5)}, ${gradient.sampleStopsColor(stops, 0.85)})`;

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
    GS.BUILTIN_PRESETS.forEach((preset, i) => builtin.appendChild(presetItem(preset, 'builtin', i)));
    body.appendChild(builtin);

    const user = GS.storage.loadUserPresets();
    body.appendChild(el('div', 'section-label section-label-spaced', 'My presets'));
    const userList = el('div', 'preset-list');
    if (user.length === 0) {
      userList.appendChild(el('div', 'preset-empty', 'No saved presets yet'));
    } else {
      user.forEach((preset, i) => userList.appendChild(presetItem(preset, 'user', i)));
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

  /* One click handler covers the static "+ Add stop" buttons. */
  function bindAddStop() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('.add-stop');
      if (btn) addStop(btn.dataset.grad);
    });
  }

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

  function rebuildAll() {
    PANEL_TARGETS.forEach(id => GS.byId(id).replaceChildren());
    buildShapeUI();
    buildGradientUI();
    buildBackgroundUI();
    buildExportUI();
    buildPresetsUI();
    GS.preview.layout();
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
    if (message === undefined) {
      toastTimer = null;
      return;
    }
    node.textContent = message;
    node.classList.add('show');
    toastTimer = setTimeout(() => {
      node.classList.remove('show');
      toastTimer = setTimeout(runToastQueue, 260);
    }, 2200);
  }

  /* ---------- Modal prompt (replaces window.prompt) ---------- */

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

      function submit() {
        close(input.value.trim() || null);
      }

      function onKey(e) {
        if (e.key === 'Escape') close(null);
        else if (e.key === 'Enter') submit();
      }

      document.addEventListener('keydown', onKey);
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) close(null);
      });
      cancel.addEventListener('click', () => close(null));
      ok.addEventListener('click', submit);
    });
  }

  function init() {
    GRADIENT_KEYS.forEach(key => bindStopEditor(GS.byId(STOP_HOSTS[key])));
    bindAddStop();
    bindPresets();
    rebuildAll();
  }

  GS.ui = { init, rebuildAll };
  GS.toast = toast;
  GS.askText = askText;
})(window.GS);
