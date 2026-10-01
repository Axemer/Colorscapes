/* =========================================================
   WebGL Renderer
   One context, one fullscreen quad, three programs, three
   render targets. A frame is four stages:

     shapes    -> scene FBO   transparent, per-shape blend modes
     blur X    -> blur FBO A
     blur Y    -> blur FBO B
     composite -> canvas      scene over the background colour

   Blurring after the shapes have merged is the whole point: two
   overlapping figures cross-fade into a real third colour and
   then that single image is smeared, instead of each shape being
   smeared on its own and stacked afterwards. The two blur passes
   are skipped entirely when the radius is zero.

   Gradient textures are pooled and reused across draws.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, deg2rad } = GS.utils;
  const { hexToRgb01 } = GS.color;
  const { sortStops, sampleStops, computeExtent } = GS.gradient;

  const GRAD_TEX_WIDTH = 1024;
  const MAX_PAIRS = GS.shaders.BLUR_PAIRS;

  /* Below this the blur is switched off rather than snapped up to
     the kernel's own resolution, so a 0 slider really means 0. */
  const MIN_BLUR_RADIUS = 0.2;

  /* The blur chain may run on a smaller buffer: a wide Gaussian
     hides the resolution it is sampled at, and this is what keeps
     the cost flat as the radius grows instead of quadratic. */
  const MIN_BLUR_SCALE = 0.03;

  const SHAPE_UNIFORMS = [
    'u_resolution', 'u_center', 'u_size', 'u_shapeAngle', 'u_roundness',
    'u_softness', 'u_glow', 'u_opacity', 'u_grain', 'u_gradTex',
    'u_gradAngle', 'u_gradExtent',
  ];
  const BLUR_UNIFORMS = ['u_src', 'u_texel', 'u_offsets[0]', 'u_weights[0]'];
  const COMPOSITE_UNIFORMS = ['u_scene', 'u_bg'];

  function getContext(canvas, preserveDrawingBuffer) {
    return canvas.getContext('webgl', {
      preserveDrawingBuffer: !!preserveDrawingBuffer,
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    }) || canvas.getContext('experimental-webgl');
  }

  function compileShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile error: ' + log);
    }
    return shader;
  }

  function createProgram(gl, fragSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, GS.shaders.VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('Program link error: ' + log);
    }
    return program;
  }

  function mapUniforms(gl, program, names) {
    const out = {};
    names.forEach(name => {
      out[name] = gl.getUniformLocation(program, name);
    });
    return out;
  }

  /* Approximations of the four blend modes we expose. All four
     consume premultiplied source, and the scene target is cleared
     to transparent black, so 'normal' is a true over-operator. */
  function applyBlend(gl, mode) {
    switch (mode) {
      case 'add':
        gl.blendFunc(gl.ONE, gl.ONE);
        break;
      case 'screen':
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
        break;
      case 'multiply':
        gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
        break;
      default:
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  /* ---------- separable Gaussian kernel ---------- */

  const kernelOffsets = new Float32Array(MAX_PAIRS);
  const kernelWeights = new Float32Array(MAX_PAIRS + 1);

  /* Integer taps 1..2N per side, folded into N mirrored pairs at
     half-texel offsets (1.5, 3.5, 5.5 …) where GL_LINEAR returns the
     exact average of the two texels. sigmaU puts the outermost tap
     at ~3 sigma, the usual truncation point. */
  function buildKernel(pairs) {
    const sigmaU = (2 * pairs) / 3;
    const denom = 2 * sigmaU * sigmaU;

    let total = 1;
    for (let i = 0; i < pairs; i++) {
      const a = 2 * i + 1, b = 2 * i + 2;
      const w = Math.exp(-(a * a) / denom) + Math.exp(-(b * b) / denom);
      kernelOffsets[i] = a + 0.5;
      kernelWeights[i + 1] = w;
      total += 2 * w;
    }
    for (let i = pairs; i < MAX_PAIRS; i++) {
      kernelOffsets[i] = 0;
      kernelWeights[i + 1] = 0;
    }

    kernelWeights[0] = 1 / total;
    for (let i = 0; i < pairs; i++) {
      kernelWeights[i + 1] /= total;
    }

    return measureSigma(pairs);
  }

  /* Folding integer taps into linear ones widens the kernel by 1-5%,
     because a pair straddling the curve no longer samples it exactly.
     Rather than carry a fudge factor, push a delta through the same
     half-texel taps the GPU uses and read the sigma off the result:
     whatever this reports is what actually gets rendered. */
  function measureSigma(pairs) {
    const N = 64, mid = 40;
    const delta = new Float64Array(N);
    delta[mid] = 1;

    const at = i => delta[i < 0 ? 0 : i > N - 1 ? N - 1 : i];
    const linear = x => {
      const i = Math.floor(x), f = x - i;
      return at(i) * (1 - f) + at(i + 1) * f;
    };

    const out = new Float64Array(N);
    let mass = 0, mean = 0;
    for (let y = 0; y < N; y++) {
      let v = delta[y] * kernelWeights[0];
      for (let i = 0; i < pairs; i++) {
        const o = kernelOffsets[i], w = kernelWeights[i + 1];
        v += linear(y + o) * w;
        v += linear(y - o) * w;
      }
      out[y] = v;
      mass += v;
      mean += v * y;
    }
    mean /= mass;

    let m2 = 0;
    for (let y = 0; y < N; y++) {
      const d = y - mean;
      m2 += out[y] * d * d;
    }
    return Math.sqrt(m2 / mass);
  }

  function blurPlan(radiusPx) {
    const pairs = clamp(Math.ceil(radiusPx / 3), 1, MAX_PAIRS);
    const sigma = buildKernel(pairs);
    return {
      pairs,
      /* Sampling the source at 1/scale of its size turns sigma texels
         of kernel into sigma/scale pixels of actual blur. */
      scale: clamp(sigma / radiusPx, MIN_BLUR_SCALE, 1),
    };
  }

  /* ---------- render target ---------- */

  class RenderTarget {
    constructor(gl) {
      this.gl = gl;
      this.width = 0;
      this.height = 0;

      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      /* LINEAR: a blur pass must interpolate, and interpolating
         premultiplied RGBA is the correct filter for it. */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      this.framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    resize(width, height) {
      if (width === this.width && height === this.height) return;
      this.width = width;
      this.height = height;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null,
      );
    }

    bind() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.viewport(0, 0, this.width, this.height);
    }
  }

  /* ---------- renderer ---------- */

  class Renderer {
    constructor(canvas, preserveDrawingBuffer) {
      this.canvas = canvas;
      this.gl = getContext(canvas, preserveDrawingBuffer);
      if (!this.gl) throw new Error('WebGL not supported');

      const gl = this.gl;
      const shaders = GS.shaders;

      this.shapeProg = createProgram(gl, shaders.SHAPE_FRAG_SRC);
      this.blurProg = createProgram(gl, shaders.BLUR_FRAG_SRC);
      this.compProg = createProgram(gl, shaders.COMPOSITE_FRAG_SRC);

      this.shapeU = mapUniforms(gl, this.shapeProg, SHAPE_UNIFORMS);
      this.blurU = mapUniforms(gl, this.blurProg, BLUR_UNIFORMS);
      this.compU = mapUniforms(gl, this.compProg, COMPOSITE_UNIFORMS);

      this.scene = new RenderTarget(gl);
      this.blurA = new RenderTarget(gl);
      this.blurB = new RenderTarget(gl);

      this._attachQuad();

      this._texPool = [];
      this._texCursor = 0;
      this._gradData = new Uint8Array(GRAD_TEX_WIDTH * 4);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
    }

    _attachQuad() {
      const gl = this.gl;
      this._vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]), gl.STATIC_DRAW);

      this._aPos = {
        shape: gl.getAttribLocation(this.shapeProg, 'a_pos'),
        blur: gl.getAttribLocation(this.blurProg, 'a_pos'),
        composite: gl.getAttribLocation(this.compProg, 'a_pos'),
      };
    }

    _useQuad(kind) {
      const gl = this.gl;
      const loc = this._aPos[kind];
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    _createTexture() {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return tex;
    }

    _nextTexture() {
      const idx = this._texCursor++;
      if (!this._texPool[idx]) this._texPool[idx] = this._createTexture();
      return this._texPool[idx];
    }

    _uploadGradient(tex, stops) {
      const gl = this.gl;
      const data = this._gradData;
      const sorted = sortStops(stops);
      for (let i = 0; i < GRAD_TEX_WIDTH; i++) {
        const c = sampleStops(sorted, i / (GRAD_TEX_WIDTH - 1));
        data[i * 4]     = Math.round(c[0]);
        data[i * 4 + 1] = Math.round(c[1]);
        data[i * 4 + 2] = Math.round(c[2]);
        data[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GRAD_TEX_WIDTH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    _drawShape(shape, aspect) {
      const gl = this.gl;
      const u = this.shapeU;

      applyBlend(gl, shape.blend);

      gl.uniform2f(u.u_center, shape.x, shape.y);
      gl.uniform2f(u.u_size, shape.w, shape.h);
      gl.uniform1f(u.u_shapeAngle, deg2rad(shape.rot));
      gl.uniform1f(u.u_roundness, shape.roundness);
      gl.uniform1f(u.u_softness, shape.softness);
      gl.uniform1f(u.u_glow, shape.glow);
      gl.uniform1f(u.u_opacity, clamp(shape.opacity, 0, 1));
      gl.uniform1f(u.u_grain, Math.max(0, shape.grain || 0));

      const grad = shape.gradient;
      const tex = this._nextTexture();

      this._uploadGradient(tex, grad.stops);

      const extentShape = {
        width: shape.w,
        height: shape.h,
        angle: shape.rot
      };

      const extent = computeExtent(
        aspect,
        extentShape,
        grad.angle
      );

      gl.uniform1f(u.u_gradAngle, deg2rad(grad.angle));
      gl.uniform1f(u.u_gradExtent, extent);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u.u_gradTex, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    /* stage 1 — every shape, blended into one transparent image */
    _drawShapes(state, width, height) {
      const gl = this.gl;
      const u = this.shapeU;

      this.scene.resize(width, height);
      this.scene.bind();

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this.shapeProg);
      this._useQuad('shape');
      gl.enable(gl.BLEND);
      gl.uniform2f(u.u_resolution, width, height);

      const aspect = width / height;
      this._texCursor = 0;

      for (const shape of state.shapes) {
        if (!shape.visible) continue;
        if (shape.opacity <= 0) continue;
        this._drawShape(shape, aspect);
      }
    }

    /* stages 2 and 3 — separable Gaussian over the merged scene */
    _blurScene(radiusPx, width, height) {
      const gl = this.gl;
      const u = this.blurU;

      const plan = blurPlan(radiusPx);
      const bw = Math.max(1, Math.round(width * plan.scale));
      const bh = Math.max(1, Math.round(height * plan.scale));

      this.blurA.resize(bw, bh);
      this.blurB.resize(bw, bh);

      gl.useProgram(this.blurProg);
      this._useQuad('blur');
      gl.disable(gl.BLEND);
      gl.uniform1i(u.u_src, 0);
      gl.uniform1fv(u['u_offsets[0]'], kernelOffsets);
      gl.uniform1fv(u['u_weights[0]'], kernelWeights);
      gl.activeTexture(gl.TEXTURE0);

      /* horizontal: scene -> A. The offsets are in texels of the buffer
         being written, not of the scene being read: that is what makes
         sigma texels here come out as sigma/scale pixels of blur. */
      this.blurA.bind();
      gl.bindTexture(gl.TEXTURE_2D, this.scene.texture);
      gl.uniform2f(u.u_texel, 1 / bw, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      /* vertical: A -> B, same grid, same kernel */
      this.blurB.bind();
      gl.bindTexture(gl.TEXTURE_2D, this.blurA.texture);
      gl.uniform2f(u.u_texel, 0, 1 / bh);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      return this.blurB;
    }

    /* stage 4 — the only place the background colour appears */
    _composite(state, source) {
      const gl = this.gl;
      const u = this.compU;
      const bg = hexToRgb01(state.background);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.compProg);
      this._useQuad('composite');
      gl.disable(gl.BLEND);
      gl.uniform3f(u.u_bg, bg[0], bg[1], bg[2]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform1i(u.u_scene, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    render(state, width, height) {
      width = Math.max(1, Math.floor(width));
      height = Math.max(1, Math.floor(height));

      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;

      this._drawShapes(state, width, height);

      /* state.blur is a fraction of the frame width, so the preview
         and a 4K export get the same blur, not the same pixel count. */
      const radiusPx = Math.max(0, state.blur || 0) * width;
      const source = radiusPx >= MIN_BLUR_RADIUS
        ? this._blurScene(radiusPx, width, height)
        : this.scene;

      this._composite(state, source);
    }
  }

  GS.Renderer = Renderer;
})(window.GS);
