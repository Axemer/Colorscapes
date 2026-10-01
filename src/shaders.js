/* =========================================================
   Shaders
   Single-shape pass. Renders one superellipse with a 1D
   gradient modulated along its own axis, outputs premultiplied
   alpha so the renderer can composite shapes with blendFunc.
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
uniform float u_opacity;

uniform sampler2D u_gradTex;
uniform float u_gradAngle;
uniform float u_gradExtent;

float rand(vec2 co){
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(){
  float aspect = u_resolution.x / u_resolution.y;
  vec2 uv = v_uv;

  /* ---------- Superellipse in aspect-corrected space ---------- */
  vec2 p = (uv - u_center) * vec2(aspect, 1.0);

  float ca = cos(u_shapeAngle);
  float sa = sin(u_shapeAngle);
  vec2 rp = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);

  vec2 half_size = max(u_size * 0.5 * vec2(aspect, 1.0), vec2(1e-6));
  vec2 d = abs(rp) / half_size;

  float r  = max(u_roundness, 1.001);
  float dx = max(d.x, 1e-6);
  float dy = max(d.y, 1e-6);
  float dist = pow(pow(dx, r) + pow(dy, r), 1.0 / r);

  /* Local |grad dist| in image space. Normalising the softness
     by it makes the falloff width direction-independent, so
     elongated shapes get the same visual edge softness on every
     side instead of a wide flat falloff on the long axis. */
  float inner   = pow(dx, r) + pow(dy, r);
  float inner_p = pow(max(inner, 1e-6), 1.0 / r - 1.0);
  vec2 grad = vec2(
    inner_p * pow(dx, r - 1.0) * sign(rp.x) / half_size.x,
    inner_p * pow(dy, r - 1.0) * sign(rp.y) / half_size.y
  );
  float gradMag = max(length(grad), 1e-6);

  float minHalf   = max(0.5 * min(u_size.x * aspect, u_size.y), 0.01);
  float softImage = max(u_softness, 0.001) * minHalf;
  float softLoc   = clamp(softImage * gradMag, 0.005, 3.0);

  /* Quintic smootherstep: gentler in/out than the cubic smoothstep,
     removes the faint corner it leaves in the alpha ramp. */
  float tt = clamp((dist - (1.0 - softLoc)) / (2.0 * softLoc), 0.0, 1.0);
  float st = tt * tt * tt * (tt * (tt * 6.0 - 15.0) + 10.0);
  float mask = 1.0 - st;

  /* ---------- Gradient along the shape's own axis ---------- */
  vec2 gDir = vec2(cos(u_gradAngle), sin(u_gradAngle));
  float tRaw = dot(uv - u_center, gDir);
  float gpos = clamp(tRaw / max(u_gradExtent, 1e-6) * 0.5 + 0.5, 0.0, 1.0);
  vec3 color = texture2D(u_gradTex, vec2(gpos, 0.5)).rgb * u_glow;

  color += (rand(gl_FragCoord.xy) - 0.5) / 255.0;

  float alpha = mask * u_opacity;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

  GS.shaders = { VERT_SRC, FRAG_SRC };
})(window.GS);