/* =========================================================
   Shaders
   Fullscreen-quad pass: superellipse mask, two gradient textures
   mixed and composited over a flat background, dithered.
   ========================================================= */

(function (GS) {
  'use strict';

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

  GS.shaders = { VERT_SRC, FRAG_SRC };
})(window.GS);
