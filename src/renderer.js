/* =========================================================
   WebGL Renderer
   One context, one program, one fullscreen quad, two 1D gradient
   textures. Gradients are baked on the CPU and uploaded as 1024x1.
   Note: GL objects belong to their context, so a second Renderer
   (used for export) needs its own context, buffer and textures.
   ========================================================= */

(function (GS) {
  'use strict';

  const { clamp, deg2rad } = GS.utils;
  const { hexToRgb01 } = GS.color;
  const { sortStops, sampleStops, computeExtent } = GS.gradient;

  const GRAD_TEX_WIDTH = 1024;
  const UNIFORMS = [
    'u_resolution', 'u_center', 'u_size', 'u_shapeAngle', 'u_roundness', 'u_softness',
    'u_glow', 'u_bg', 'u_mainTex', 'u_horizTex', 'u_mainAngle', 'u_horizAngle',
    'u_mainExtent', 'u_horizExtent', 'u_mix',
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
      this.mainTex = this._createTexture();
      this.horizTex = this._createTexture();
      this._gradData = new Uint8Array(GRAD_TEX_WIDTH * 4);
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

    /* Bakes stops into the shared scratch buffer, then uploads it. */
    _uploadGradient(tex, stops) {
      const gl = this.gl;
      const data = this._gradData;
      const sorted = sortStops(stops);
      for (let i = 0; i < GRAD_TEX_WIDTH; i++) {
        const c = sampleStops(sorted, i / (GRAD_TEX_WIDTH - 1));
        data[i * 4] = Math.round(c[0]);
        data[i * 4 + 1] = Math.round(c[1]);
        data[i * 4 + 2] = Math.round(c[2]);
        data[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GRAD_TEX_WIDTH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    _uploadShape(state) {
      const gl = this.gl;
      const s = state.shape;
      const u = this.u;

      gl.uniform2f(u.u_center, s.centerX, s.centerY);
      gl.uniform2f(u.u_size, s.width, s.height);
      gl.uniform1f(u.u_shapeAngle, deg2rad(s.angle));
      gl.uniform1f(u.u_roundness, s.roundness);
      gl.uniform1f(u.u_softness, s.softness);
      gl.uniform1f(u.u_glow, s.glow);
    }

    _uploadGradients(state, aspect) {
      const gl = this.gl;
      const u = this.u;
      const { main, horiz, mix } = state;

      this._uploadGradient(this.mainTex, main.stops);
      this._uploadGradient(this.horizTex, horiz.stops);

      gl.uniform1f(u.u_mainAngle, deg2rad(main.angle));
      gl.uniform1f(u.u_horizAngle, deg2rad(horiz.angle));
      gl.uniform1f(u.u_mainExtent, computeExtent(aspect, state.shape, main.angle));
      gl.uniform1f(u.u_horizExtent, computeExtent(aspect, state.shape, horiz.angle));
      gl.uniform1f(u.u_mix, clamp(mix, 0, 1));
    }

    _bindTexture(unit, tex, uniform) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.u[uniform], unit);
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

      const aspect = width / height;
      this._uploadShape(state);
      this._uploadGradients(state, aspect);

      const bg = hexToRgb01(state.background);
      gl.uniform3f(this.u.u_bg, bg[0], bg[1], bg[2]);

      this._bindTexture(0, this.mainTex, 'u_mainTex');
      this._bindTexture(1, this.horizTex, 'u_horizTex');

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  GS.Renderer = Renderer;
})(window.GS);
