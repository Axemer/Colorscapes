'use strict';

/* =========================================================
   Shaders
   ========================================================= */

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  // y-flip so v_uv.y = 0 is top of the image
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision highp float;

varying vec2 v_uv;

uniform vec2  u_resolution;
uniform vec2  u_center;
uniform vec2  u_size;
uniform float u_shapeAngle;
uniform float u_roundness;
uniform float u_softness;
uniform float u_glow;
uniform vec3  u_bg;

uniform sampler2D u_mainTex;
uniform sampler2D u_horizTex;
uniform float u_mainAngle;
uniform float u_horizAngle;
uniform float u_mainExtent;
uniform float u_horizExtent;
uniform float u_mix;

float rand(vec2 co){
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(){
  float aspect = u_resolution.x / u_resolution.y;
  vec2 uv = v_uv;

  /* ---------- Shape mask (superellipse) ---------- */
  vec2 p = (uv - u_center) * vec2(aspect, 1.0);

  float ca = cos(u_shapeAngle);
  float sa = sin(u_shapeAngle);
  vec2 rp = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);

  vec2 half_size = max(u_size * 0.5 * vec2(aspect, 1.0), vec2(1e-6));
  vec2 d = abs(rp) / half_size;

  float r = max(u_roundness, 1.001);
  float dist = pow(pow(d.x, r) + pow(d.y, r), 1.0 / r);

  float soft = max(u_softness, 0.001);
  float mask = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, dist);
  mask = clamp(mask, 0.0, 1.0);

  /* ---------- Main gradient ---------- */
  vec2 mainDir = vec2(cos(u_mainAngle), sin(u_mainAngle));
  float tMainRaw = dot(uv - u_center, mainDir);
  float tMain = clamp(tMainRaw / max(u_mainExtent, 1e-6) * 0.5 + 0.5, 0.0, 1.0);
  vec3 cMain = texture2D(u_mainTex, vec2(tMain, 0.5)).rgb;

  /* ---------- Overlay gradient ---------- */
  vec2 hDir = vec2(cos(u_horizAngle), sin(u_horizAngle));
  float tHorizRaw = dot(uv - u_center, hDir);
  float tHoriz = clamp(tHorizRaw / max(u_horizExtent, 1e-6) * 0.5 + 0.5, 0.0, 1.0);
  vec3 cHoriz = texture2D(u_horizTex, vec2(tHoriz, 0.5)).rgb;

  vec3 color = mix(cMain, cHoriz, u_mix) * u_glow;

  /* ---------- Composite ---------- */
  vec3 outColor = mix(u_bg, color, mask);

  /* Dithering against banding */
  float n = rand(gl_FragCoord.xy) - 0.5;
  outColor += n / 255.0;

  gl_FragColor = vec4(outColor, 1.0);
}
`;

/* =========================================================
   Utilities
   ========================================================= */

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function hexToRgb255(hex){
  let h = hex.replace('#','');
  if (h.length === 3) h = h.split('').map(c=>c+c).join('');
  const n = parseInt(h, 16);
  if (isNaN(n)) return [0,0,0];
  return [(n>>16)&255, (n>>8)&255, n&255];
}
function hexToRgb01(hex){
  const [r,g,b] = hexToRgb255(hex);
  return [r/255, g/255, b/255];
}
function hslToHex(h, s, l){
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1-l);
  const f = n => {
    const k = (n + h/30) % 12;
    const c = l - a * Math.max(-1, Math.min(k-3, 9-k, 1));
    return Math.round(255*c).toString(16).padStart(2,'0');
  };
  return '#' + f(0) + f(8) + f(4);
}
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }
function b64enc(s){ return btoa(unescape(encodeURIComponent(s))); }
function b64dec(s){ return decodeURIComponent(escape(atob(s))); }

/* =========================================================
   Gradient sampling (CPU, for texture generation)
   ========================================================= */

function sampleStops(sorted, t){
  if (!sorted.length) return [0,0,0];
  if (sorted.length === 1) return hexToRgb255(sorted[0].color);
  if (t <= sorted[0].pos) return hexToRgb255(sorted[0].color);
  if (t >= sorted[sorted.length-1].pos) return hexToRgb255(sorted[sorted.length-1].color);
  for (let i=0;i<sorted.length-1;i++){
    const a = sorted[i], b = sorted[i+1];
    if (t >= a.pos && t <= b.pos){
      const denom = (b.pos - a.pos) || 1e-6;
      const u = (t - a.pos) / denom;
      const ca = hexToRgb255(a.color), cb = hexToRgb255(b.color);
      return [
        Math.round(ca[0] + (cb[0]-ca[0])*u),
        Math.round(ca[1] + (cb[1]-ca[1])*u),
        Math.round(ca[2] + (cb[2]-ca[2])*u),
      ];
    }
  }
  return hexToRgb255(sorted[sorted.length-1].color);
}

/* =========================================================
   Shape extent along gradient axis
   ========================================================= */

function computeExtent(aspect, shape, gradAngleDeg){
  const a = gradAngleDeg * Math.PI / 180;
  const dx = Math.cos(a), dy = Math.sin(a);

  // Half-extents of shape in aspect-normalised space (y = 1 unit = image height)
  const hw = shape.width  * 0.5 * aspect;
  const hh = shape.height * 0.5;

  const theta = shape.angle * Math.PI / 180;
  const ct = Math.abs(Math.cos(theta));
  const st = Math.abs(Math.sin(theta));

  // Rotated bbox half-extents (aspect-space)
  const rx = hw * ct + hh * st;
  const ry = hw * st + hh * ct;

  // Convert x back to UV-fraction-of-width
  const ux = rx / aspect;
  const uy = ry;

  return ux * Math.abs(dx) + uy * Math.abs(dy);
}

/* =========================================================
   WebGL Renderer
   ========================================================= */

function compileShader(gl, type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    console.error(gl.getShaderInfoLog(s));
    throw new Error('Shader compile error');
  }
  return s;
}

function createProgram(gl){
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)){
    console.error(gl.getProgramInfoLog(p));
    throw new Error('Program link error');
  }
  gl.deleteShader(vs); gl.deleteShader(fs);
  return p;
}

class Renderer {
  constructor(canvas, preserve){
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {
      preserveDrawingBuffer: !!preserve,
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    }) || canvas.getContext('experimental-webgl');
    if (!this.gl) throw new Error('WebGL not supported');

    const gl = this.gl;
    this.program = createProgram(gl);
    gl.useProgram(this.program);

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1,  -1,1,
      -1, 1,  1,-1,   1,1,
    ]), gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    ['u_resolution','u_center','u_size','u_shapeAngle','u_roundness','u_softness',
     'u_glow','u_bg','u_mainTex','u_horizTex','u_mainAngle','u_horizAngle',
     'u_mainExtent','u_horizExtent','u_mix'].forEach(n => {
      this.u[n] = gl.getUniformLocation(this.program, n);
    });

    this.mainTex  = this._makeTex();
    this.horizTex = this._makeTex();
    this._texW = 1024;
  }

  _makeTex(){
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  _uploadGrad(tex, stops){
    const gl = this.gl;
    const W = this._texW;
    const data = new Uint8Array(W * 4);
    const sorted = [...stops].map(s => ({pos: clamp(s.pos,0,1), color: s.color}))
                             .sort((a,b)=>a.pos-b.pos);
    for (let i=0;i<W;i++){
      const t = i / (W-1);
      const c = sampleStops(sorted, t);
      data[i*4]   = c[0];
      data[i*4+1] = c[1];
      data[i*4+2] = c[2];
      data[i*4+3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  render(state, width, height){
    const gl = this.gl;
    width  = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));

    if (this.canvas.width !== width || this.canvas.height !== height){
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);

    const aspect = width / height;

    this._uploadGrad(this.mainTex,  state.main.stops);
    this._uploadGrad(this.horizTex, state.horiz.stops);

    const mainExtent  = computeExtent(aspect, state.shape, state.main.angle);
    const horizExtent = computeExtent(aspect, state.shape, state.horiz.angle);

    gl.uniform2f(this.u.u_resolution, width, height);
    gl.uniform2f(this.u.u_center, state.shape.centerX, state.shape.centerY);
    gl.uniform2f(this.u.u_size,   state.shape.width,   state.shape.height);
    gl.uniform1f(this.u.u_shapeAngle, state.shape.angle * Math.PI / 180);
    gl.uniform1f(this.u.u_roundness,  state.shape.roundness);
    gl.uniform1f(this.u.u_softness,   state.shape.softness);
    gl.uniform1f(this.u.u_glow,       state.shape.glow);

    const bg = hexToRgb01(state.background);
    gl.uniform3f(this.u.u_bg, bg[0], bg[1], bg[2]);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mainTex);
    gl.uniform1i(this.u.u_mainTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.horizTex);
    gl.uniform1i(this.u.u_horizTex, 1);

    gl.uniform1f(this.u.u_mainAngle,   state.main.angle  * Math.PI / 180);
    gl.uniform1f(this.u.u_horizAngle,  state.horiz.angle * Math.PI / 180);
    gl.uniform1f(this.u.u_mainExtent,  mainExtent);
    gl.uniform1f(this.u.u_horizExtent, horizExtent);
    gl.uniform1f(this.u.u_mix,         state.mix);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

/* =========================================================
   Default state + presets
   ========================================================= */

const DEFAULT_STATE = {
  shape: {
    width: 0.62, height: 0.30,
    centerX: 0.5, centerY: 0.5,
    angle: 0,
    roundness: 2.2,
    softness: 0.65,
    glow: 1.0,
  },
  main: {
    angle: 90,
    stops: [
      { pos: 0.00, color: '#0b1e4f' },
      { pos: 0.22, color: '#1e6bb8' },
      { pos: 0.46, color: '#6ad4c8' },
      { pos: 0.68, color: '#c8e88a' },
      { pos: 0.85, color: '#f0d060' },
      { pos: 1.00, color: '#f0a050' },
    ],
  },
  horiz: {
    angle: 0,
    stops: [
      { pos: 0.0, color: '#ffffff' },
      { pos: 1.0, color: '#000000' },
    ],
  },
  mix: 0.0,
  background: '#000000',
  exportW: 1920,
  exportH: 1080,
};

const BUILTIN_PRESETS = [
  {
    name: 'Cold Aurora',
    state: {
      shape: { width: 0.66, height: 0.34, centerX: 0.5, centerY: 0.5, angle: 0, roundness: 2.4, softness: 0.7, glow: 1.05 },
      main: {
        angle: 90,
        stops: [
          { pos: 0.00, color: '#0a1a4a' },
          { pos: 0.22, color: '#2a6bb5' },
          { pos: 0.45, color: '#8ce0d4' },
          { pos: 0.66, color: '#c8e8a0' },
          { pos: 0.86, color: '#e8e070' },
          { pos: 1.00, color: '#f0a860' },
        ],
      },
      horiz: { angle: 0, stops: [ { pos:0, color:'#ffffff' }, { pos:1, color:'#000000' } ] },
      mix: 0.0,
      background: '#000000',
      exportW: 1920, exportH: 1080,
    },
  },
  {
    name: 'Warm Bloom',
    state: {
      shape: { width: 0.66, height: 0.34, centerX: 0.5, centerY: 0.5, angle: 0, roundness: 2.4, softness: 0.7, glow: 1.05 },
      main: {
        angle: 90,
        stops: [
          { pos: 0.00, color: '#ff8c1a' },
          { pos: 0.25, color: '#ff4f2e' },
          { pos: 0.50, color: '#ff2d8a' },
          { pos: 0.76, color: '#7a2ad4' },
          { pos: 1.00, color: '#0a1050' },
        ],
      },
      horiz: { angle: 0, stops: [ { pos:0, color:'#ffffff' }, { pos:1, color:'#000000' } ] },
      mix: 0.0,
      background: '#000000',
      exportW: 1920, exportH: 1080,
    },
  },
];

/* =========================================================
   App state
   ========================================================= */

let state = deepClone(DEFAULT_STATE);
let previewRenderer = null;
let exportRenderer = null;
let renderQueued = false;

/* =========================================================
   UI construction
   ========================================================= */

function makeControl(parent, opts){
  const { label, min, max, step, value, onChange } = opts;
  const row = document.createElement('div');
  row.className = 'ctrl';

  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);

  const range = document.createElement('input');
  range.type = 'range';
  range.min = min; range.max = max; range.step = step; range.value = value;
  row.appendChild(range);

  const num = document.createElement('input');
  num.type = 'number';
  num.min = min; num.max = max; num.step = step; num.value = value;
  row.appendChild(num);

  let last = value;
  function apply(v, fire){
    last = v;
    range.value = v;
    num.value = v;
    if (fire) onChange(v);
  }

  range.addEventListener('input', () => {
    const v = parseFloat(range.value);
    last = v; num.value = v;
    onChange(v);
  });
  num.addEventListener('input', () => {
    const v = parseFloat(num.value);
    if (!isNaN(v)){
      last = v; range.value = v; onChange(v);
    }
  });
  num.addEventListener('blur', () => {
    const v = clamp(parseFloat(num.value) || last, parseFloat(min), parseFloat(max));
    apply(v, true);
  });

  parent.appendChild(row);
  return { set: v => apply(v, false) };
}

function renderStops(container, stops, onChange){
  container.innerHTML = '';
  stops.forEach((stop, i) => {
    const row = document.createElement('div');
    row.className = 'stop';

    const color = document.createElement('input');
    color.type = 'color';
    color.value = stop.color;
    row.appendChild(color);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = 0; range.max = 1; range.step = 0.001;
    range.value = stop.pos;
    row.appendChild(range);

    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = Math.round(stop.pos * 100) + '%';
    row.appendChild(pos);

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '×';
    del.disabled = stops.length <= 2;
    del.title = 'Remove stop';
    row.appendChild(del);

    color.addEventListener('input', () => { stop.color = color.value; onChange(); });
    range.addEventListener('input', () => {
      stop.pos = parseFloat(range.value);
      pos.textContent = Math.round(stop.pos * 100) + '%';
      onChange();
    });
    del.addEventListener('click', () => {
      const idx = stops.indexOf(stop);
      if (idx >= 0 && stops.length > 2){
        stops.splice(idx, 1);
        renderStops(container, stops, onChange);
        onChange();
      }
    });

    container.appendChild(row);
  });
}

function buildShapeUI(){
  const body = document.getElementById('shape-body');
  const s = state.shape;
  const f = () => scheduleRender();

  makeControl(body, { label:'Width',    min:0.01, max:3,    step:0.005, value:s.width,   onChange:v=>{s.width=v; f();} });
  makeControl(body, { label:'Height',   min:0.01, max:3,    step:0.005, value:s.height,  onChange:v=>{s.height=v; f();} });
  makeControl(body, { label:'Center X', min:-1,   max:2,    step:0.005, value:s.centerX, onChange:v=>{s.centerX=v; f();} });
  makeControl(body, { label:'Center Y', min:-1,   max:2,    step:0.005, value:s.centerY, onChange:v=>{s.centerY=v; f();} });
  makeControl(body, { label:'Rotation', min:-180, max:180,  step:0.5,   value:s.angle,   onChange:v=>{s.angle=v; f();} });
  makeControl(body, { label:'Roundness',min:1.2,  max:20,   step:0.05,  value:s.roundness,onChange:v=>{s.roundness=v; f();} });
  makeControl(body, { label:'Softness', min:0.001,max:2,    step:0.005, value:s.softness,onChange:v=>{s.softness=v; f();} });
  makeControl(body, { label:'Glow',     min:0.1,  max:2,    step:0.01,  value:s.glow,    onChange:v=>{s.glow=v; f();} });
}

function buildGradientUI(){
  // Main
  makeControl(document.getElementById('main-angle'), {
    label:'Angle', min:0, max:360, step:0.5, value:state.main.angle,
    onChange:v => { state.main.angle = v; scheduleRender(); }
  });
  renderStops(document.getElementById('main-stops'), state.main.stops, scheduleRender);

  // Overlay
  makeControl(document.getElementById('horiz-angle'), {
    label:'Angle', min:0, max:360, step:0.5, value:state.horiz.angle,
    onChange:v => { state.horiz.angle = v; scheduleRender(); }
  });
  renderStops(document.getElementById('horiz-stops'), state.horiz.stops, scheduleRender);

  makeControl(document.getElementById('mix-ctrl'), {
    label:'Mix', min:0, max:1, step:0.005, value:state.mix,
    onChange:v => { state.mix = v; scheduleRender(); }
  });

  document.querySelectorAll('.add-stop').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.grad;
      const stops = state[key].stops;
      const sorted = [...stops].sort((a,b)=>a.pos-b.pos);
      let pos;
      if (sorted.length === 0) pos = 0.5;
      else {
        // find widest gap
        let bestGap = -1, bestPos = 0.5;
        for (let i=0;i<sorted.length-1;i++){
          const g = sorted[i+1].pos - sorted[i].pos;
          if (g > bestGap){ bestGap = g; bestPos = (sorted[i].pos + sorted[i+1].pos) / 2; }
        }
        pos = bestPos;
      }
      const color = sampleStopsColor(sorted, pos);
      stops.push({ pos, color });
      const container = document.getElementById(key === 'main' ? 'main-stops' : 'horiz-stops');
      renderStops(container, stops, scheduleRender);
      scheduleRender();
    });
  });
}

function sampleStopsColor(sorted, t){
  const c = sampleStops(sorted, t);
  return '#' + c.map(v => v.toString(16).padStart(2,'0')).join('');
}

function buildBackgroundUI(){
  const body = document.getElementById('bg-body');
  const row = document.createElement('div');
  row.className = 'ctrl';
  row.style.gridTemplateColumns = '78px 1fr';

  const lab = document.createElement('label');
  lab.textContent = 'Color';
  row.appendChild(lab);

  const color = document.createElement('input');
  color.type = 'color';
  color.value = state.background;
  color.style.justifySelf = 'end';
  color.style.width = '44px';
  color.style.height = '28px';
  color.style.padding = '0';
  color.style.border = '1px solid rgba(255,255,255,0.16)';
  color.style.borderRadius = '7px';
  color.style.background = 'none';
  color.style.cursor = 'pointer';
  color.addEventListener('input', () => { state.background = color.value; scheduleRender(); });
  row.appendChild(color);

  body.appendChild(row);
}

function buildExportUI(){
  const body = document.getElementById('export-body');

  const size = document.createElement('div');
  size.className = 'export-size';
  body.appendChild(size);

  const wWrap = document.createElement('div');
  wWrap.innerHTML = '<div class="lbl" style="margin-bottom:4px">Width</div>';
  const wIn = document.createElement('input');
  wIn.type = 'number'; wIn.min = 1; wIn.step = 1; wIn.value = state.exportW;
  wIn.style.textAlign = 'left';
  wWrap.appendChild(wIn);
  size.appendChild(wWrap);

  const hWrap = document.createElement('div');
  hWrap.innerHTML = '<div class="lbl" style="margin-bottom:4px">Height</div>';
  const hIn = document.createElement('input');
  hIn.type = 'number'; hIn.min = 1; hIn.step = 1; hIn.value = state.exportH;
  hIn.style.textAlign = 'left';
  hWrap.appendChild(hIn);
  size.appendChild(hWrap);

  wIn.addEventListener('input', () => {
    const v = parseInt(wIn.value, 10);
    if (!isNaN(v) && v > 0){ state.exportW = v; layoutPreview(); }
  });
  hIn.addEventListener('input', () => {
    const v = parseInt(hIn.value, 10);
    if (!isNaN(v) && v > 0){ state.exportH = v; layoutPreview(); }
  });

  const presets = document.createElement('div');
  presets.className = 'preset-grid';
  const sizes = [
    [1920,1080],[2560,1440],[3840,2160],
    [1080,1920],[1440,2560],[5120,2880],
    [3840,3840],[800,800],[1080,1080],
  ];
  sizes.forEach(([w,h]) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.textContent = `${w}×${h}`;
    b.addEventListener('click', () => {
      state.exportW = w; state.exportH = h;
      wIn.value = w; hIn.value = h;
      layoutPreview();
    });
    presets.appendChild(b);
  });
  body.appendChild(presets);

  const expBtn = document.createElement('button');
  expBtn.className = 'btn primary';
  expBtn.type = 'button';
  expBtn.textContent = 'Export PNG';
  expBtn.style.marginTop = '4px';
  expBtn.addEventListener('click', doExport);
  body.appendChild(expBtn);

  const shareRow = document.createElement('div');
  shareRow.className = 'btn-row';
  const shareBtn = document.createElement('button');
  shareBtn.className = 'btn'; shareBtn.type = 'button'; shareBtn.textContent = 'Copy link';
  shareBtn.addEventListener('click', () => {
    const hash = '#' + b64enc(JSON.stringify(state));
    const url = location.origin + location.pathname + hash;
    navigator.clipboard.writeText(url).then(
      () => toast('Link copied'),
      () => toast('Copy failed')
    );
  });
  const randBtn = document.createElement('button');
  randBtn.className = 'btn'; randBtn.type = 'button'; randBtn.textContent = 'Random';
  randBtn.addEventListener('click', () => {
    applyState(randomState());
    rebuildAll();
    toast('Randomized');
  });
  shareRow.appendChild(shareBtn);
  shareRow.appendChild(randBtn);
  body.appendChild(shareRow);
}

/* =========================================================
   Presets
   ========================================================= */

const LS_KEY = 'gradient-studio-presets-v1';

function loadUserPresets(){
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { return []; }
}
function saveUserPresets(list){
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
  catch {}
}

function buildPresetsUI(){
  const body = document.getElementById('presets-body');
  body.innerHTML = '';

  const builtinLabel = document.createElement('div');
  builtinLabel.style.fontSize = '11px';
  builtinLabel.style.color = 'var(--text-dim)';
  builtinLabel.textContent = 'Built-in';
  body.appendChild(builtinLabel);

  const list1 = document.createElement('div');
  list1.className = 'preset-list';
  BUILTIN_PRESETS.forEach(p => {
    const item = makePresetItem(p.name, p.state, null);
    list1.appendChild(item);
  });
  body.appendChild(list1);

  const userPresets = loadUserPresets();

  const userLabel = document.createElement('div');
  userLabel.style.fontSize = '11px';
  userLabel.style.color = 'var(--text-dim)';
  userLabel.style.marginTop = '8px';
  userLabel.textContent = 'My presets';
  body.appendChild(userLabel);

  const list2 = document.createElement('div');
  list2.className = 'preset-list';
  if (userPresets.length === 0){
    const empty = document.createElement('div');
    empty.style.fontSize = '11px';
    empty.style.color = 'var(--text-dim)';
    empty.style.padding = '4px 2px';
    empty.textContent = 'No saved presets yet';
    list2.appendChild(empty);
  } else {
    userPresets.forEach((p, i) => {
      const item = makePresetItem(p.name, p.state, () => {
        const list = loadUserPresets();
        list.splice(i, 1);
        saveUserPresets(list);
        buildPresetsUI();
      });
      list2.appendChild(item);
    });
  }
  body.appendChild(list2);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn';
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save current as preset';
  saveBtn.style.marginTop = '6px';
  saveBtn.addEventListener('click', () => {
    const name = prompt('Preset name:', 'Preset ' + (loadUserPresets().length + 1));
    if (!name) return;
    const list = loadUserPresets();
    list.push({ name, state: deepClone(state) });
    saveUserPresets(list);
    buildPresetsUI();
    toast('Saved');
  });
  body.appendChild(saveBtn);
}

function makePresetItem(name, st, onRemove){
  const item = document.createElement('div');
  item.className = 'preset-item';

  const sw = document.createElement('div');
  sw.className = 'swatch';
  // build a small preview of the main gradient
  const sorted = [...st.main.stops].sort((a,b)=>a.pos-b.pos);
  const mid = sampleStopsColor(sorted, 0.5);
  const top = sampleStopsColor(sorted, 0.15);
  const bot = sampleStopsColor(sorted, 0.85);
  sw.style.background = `linear-gradient(180deg, ${top}, ${mid}, ${bot})`;
  item.appendChild(sw);

  const nm = document.createElement('div');
  nm.className = 'name';
  nm.textContent = name;
  item.appendChild(nm);

  if (onRemove){
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = 'Delete preset';
    rm.addEventListener('click', e => { e.stopPropagation(); onRemove(); });
    item.appendChild(rm);
  }

  item.addEventListener('click', () => {
    applyState(deepClone(st));
    rebuildAll();
    toast('Loaded "' + name + '"');
  });

  return item;
}

/* =========================================================
   Random preset
   ========================================================= */

function randomState(){
  const baseHue = Math.random() * 360;
  const hueSpread = 60 + Math.random() * 180;
  const n = 4 + Math.floor(Math.random() * 3);

  const stops = [];
  for (let i=0;i<n;i++){
    const t = i / (n - 1);
    const hue = baseHue + hueSpread * t;
    const sat = 55 + Math.random() * 35;
    const light = 22 + 45 * Math.sin(t * Math.PI); // bright in middle
    stops.push({ pos: t, color: hslToHex(hue, sat, light) });
  }

  const s = deepClone(DEFAULT_STATE);
  s.main.stops = stops;
  s.main.angle = 90;
  s.shape.width  = 0.5 + Math.random() * 0.3;
  s.shape.height = 0.2 + Math.random() * 0.25;
  s.shape.roundness = 2 + Math.random() * 2.5;
  s.shape.softness  = 0.45 + Math.random() * 0.5;
  s.shape.angle = (Math.random() - 0.5) * 30;
  s.mix = Math.random() < 0.3 ? Math.random() * 0.25 : 0;
  if (s.mix > 0){
    const h2 = baseHue + 180;
    s.horiz.stops = [
      { pos: 0, color: hslToHex(h2, 60, 75) },
      { pos: 1, color: hslToHex(h2, 70, 25) },
    ];
  }
  return s;
}

/* =========================================================
   Apply / rebuild state
   ========================================================= */

function applyState(next){
  state = deepClone(next);
  // Ensure export size fields have values
  if (!state.exportW) state.exportW = 1920;
  if (!state.exportH) state.exportH = 1080;
  if (typeof state.mix !== 'number') state.mix = 0;
  // Ensure at least 2 stops
  ['main','horiz'].forEach(k => {
    if (!state[k] || !Array.isArray(state[k].stops) || state[k].stops.length < 2){
      state[k] = state[k] || {};
      state[k].stops = state[k].stops || deepClone(DEFAULT_STATE[k].stops);
      if (state[k].stops.length < 2) state[k].stops = deepClone(DEFAULT_STATE[k].stops);
    }
    if (typeof state[k].angle !== 'number') state[k].angle = DEFAULT_STATE[k].angle;
  });
}

function rebuildAll(){
  document.getElementById('shape-body').innerHTML = '';
  document.getElementById('main-angle').innerHTML = '';
  document.getElementById('main-stops').innerHTML = '';
  document.getElementById('horiz-angle').innerHTML = '';
  document.getElementById('horiz-stops').innerHTML = '';
  document.getElementById('mix-ctrl').innerHTML = '';
  document.getElementById('bg-body').innerHTML = '';
  document.getElementById('export-body').innerHTML = '';

  buildShapeUI();
  buildGradientUI();
  buildBackgroundUI();
  buildExportUI();
  buildPresetsUI();

  layoutPreview();
  updateHash();
}

/* =========================================================
   Preview layout & render
   ========================================================= */

function layoutPreview(){
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('preview');
  const rect = stage.getBoundingClientRect();

  const pad = 48;
  const availW = Math.max(80, rect.width  - pad);
  const availH = Math.max(80, rect.height - pad);

  const aspect = state.exportW / state.exportH;
  let cssW, cssH;
  if (availW / availH > aspect){
    cssH = availH; cssW = cssH * aspect;
  } else {
    cssW = availW; cssH = cssW / aspect;
  }

  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Cap preview resolution for perf; aspect stays identical
  const maxDim = 2048;
  let pw = Math.round(cssW * dpr);
  let ph = Math.round(cssH * dpr);
  const biggest = Math.max(pw, ph);
  if (biggest > maxDim){
    const k = maxDim / biggest;
    pw = Math.round(pw * k);
    ph = Math.round(ph * k);
  }

  if (!previewRenderer){
    previewRenderer = new Renderer(canvas, false);
  }
  previewRenderer.render(state, pw, ph);
}

function scheduleRender(){
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    layoutPreview();
    updateHash();
  });
}

/* =========================================================
   Export
   ========================================================= */

async function doExport(){
  const w = Math.floor(state.exportW);
  const h = Math.floor(state.exportH);
  if (!(w > 0 && h > 0)){ toast('Invalid size'); return; }

  toast(`Rendering ${w}×${h}…`);

  // Let the toast paint
  await new Promise(r => setTimeout(r, 60));

  try {
    const c = document.createElement('canvas');
    const r = new Renderer(c, true);
    r.render(state, w, h);

    const blob = await new Promise(res => {
      if (c.toBlob) c.toBlob(b => res(b), 'image/png');
      else {
        const data = c.toDataURL('image/png');
        const b = dataURLtoBlob(data);
        res(b);
      }
    });
    if (!blob) throw new Error('toBlob returned null');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gradient_${w}x${h}_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    toast(`Exported ${w}×${h}`);
  } catch (e){
    console.error(e);
    toast('Export failed: ' + e.message);
  }
}

function dataURLtoBlob(dataURL){
  const [meta, b64] = dataURL.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* =========================================================
   Toast
   ========================================================= */

let toastTimer = null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* =========================================================
   Hash sharing
   ========================================================= */

let hashTimer = null;
function updateHash(){
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    try {
      const hash = '#' + b64enc(JSON.stringify(state));
      history.replaceState(null, '', hash);
    } catch {}
  }, 300);
}

function readHash(){
  const raw = location.hash.slice(1);
  if (!raw) return null;
  try { return JSON.parse(b64dec(raw)); }
  catch { return null; }
}

/* =========================================================
   Init
   ========================================================= */

function init(){
  // Initial state
  const fromHash = readHash();
  if (fromHash){
    applyState(fromHash);
  } else {
    state = deepClone(DEFAULT_STATE);
  }

  // Check WebGL
  try {
    const test = document.createElement('canvas');
    if (!(test.getContext('webgl') || test.getContext('experimental-webgl'))){
      document.getElementById('stage').innerHTML =
        '<div style="color:#9a9aa1;font-size:13px">WebGL not available in this browser.</div>';
      return;
    }
  } catch {}

  rebuildAll();

  window.addEventListener('resize', () => layoutPreview());
  window.addEventListener('hashchange', () => {
    const s = readHash();
    if (s){
      applyState(s);
      rebuildAll();
    }
  });
}

init();