/* =========================================================
   WebGL Renderer
   One context, one program, one fullscreen quad. Shapes are
   drawn back-to-front with per-shape blend modes into an
   opaque framebuffer; the background is a clear colour.
   Gradient textures are pooled and reused across draws.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, deg2rad } = GS.utils;
  const { hexToRgb01 } = GS.color;
  const { sortStops, sampleStops, computeExtent } = GS.gradient;

  const GRAD_TEX_WIDTH = 1024;
  const UNIFORMS = [
    'u_resolution', 'u_center', 'u_size', 'u_shapeAngle', 'u_roundness',
    'u_softness', 'u_glow', 'u_opacity', 'u_gradTex', 'u_gradAngle', 'u_gradExtent',
  ];

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

  function createProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, GS.shaders.VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, GS.shaders.FRAG_SRC);
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

  /* Approximations of the four blend modes we expose. */
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

  class Renderer {
    constructor(canvas, preserveDrawingBuffer) {
      this.canvas = canvas;
      this.gl = getContext(canvas, preserveDrawingBuffer);
      if (!this.gl) throw new Error('WebGL not supported');

      const gl = this.gl;
      this.program = createProgram(gl);

      this.u = {};
      UNIFORMS.forEach(name => {
        this.u[name] = gl.getUniformLocation(this.program, name);
      });

      this._attachQuad();

      this._texPool = [];
      this._texCursor = 0;
      this._gradData = new Uint8Array(GRAD_TEX_WIDTH * 4);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
    }

    _attachQuad() {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]), gl.STATIC_DRAW);

      const loc = gl.getAttribLocation(this.program, 'a_pos');
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
      const u = this.u;

      applyBlend(gl, shape.blend);

      gl.uniform2f(u.u_center, shape.x, shape.y);
      gl.uniform2f(u.u_size, shape.w, shape.h);
      gl.uniform1f(u.u_shapeAngle, deg2rad(shape.rot));
      gl.uniform1f(u.u_roundness, shape.roundness);
      gl.uniform1f(u.u_softness, shape.softness);
      gl.uniform1f(u.u_glow, shape.glow);
      gl.uniform1f(u.u_opacity, clamp(shape.opacity, 0, 1));

      const grad = shape.gradient;
      const tex = this._nextTexture();
      this._uploadGradient(tex, grad.stops);

      const extentShape = { width: shape.w, height: shape.h, angle: shape.rot };
      const extent = computeExtent(aspect, extentShape, grad.angle);

      gl.uniform1f(u.u_gradAngle, deg2rad(grad.angle));
      gl.uniform1f(u.u_gradExtent, extent);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u.u_gradTex, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    render(state, width, height) {
      const gl = this.gl;
      width = Math.max(1, Math.floor(width));
      height = Math.max(1, Math.floor(height));

      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;

      gl.viewport(0, 0, width, height);
      gl.useProgram(this.program);
      gl.uniform2f(this.u.u_resolution, width, height);

      const bg = hexToRgb01(state.background);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const aspect = width / height;
      this._texCursor = 0;

      for (const shape of state.shapes) {
        if (!shape.visible) continue;
        if (shape.opacity <= 0) continue;
        this._drawShape(shape, aspect);
      }
    }
  }

  GS.Renderer = Renderer;
})(window.GS);