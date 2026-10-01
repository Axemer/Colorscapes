/* =========================================================
   Shaders
   Three independent programs, one per stage of the pipeline:

     shape      one superellipse with its own gradient and grain,
                outputs PREMULTIPLIED alpha. Knows nothing about
                blur — the radius used to live here, smearing every
                shape on its own.
     blur       separable Gaussian, one axis per pass. Convolves
                whatever it is given, so it blurs a whole merged
                scene instead of a single shape.
     composite  premultiplied scene over the background colour.

   The vertex shader is shared: the y-flip puts v_uv.y = 0 at the
   top of the image, and every stage uses the same mapping, so no
   pass ever has to think about texture orientation.
   ========================================================= */

(function (GS) {
  'use strict';

  /* Integer taps per side are folded into pairs: a GL_LINEAR sample
     at offset k+0.5 returns the average of texels k and k+1, so one
     fetch replaces two. Pair count is fixed and the unused weights
     are zero, which keeps the loop bound a compile-time constant —
     the one thing GLSL ES 1.00 insists on. */
  const BLUR_PAIRS = 6;

  const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  /* Plain clip space -> texture space, y up. Every pass that samples
     a render target then agrees with the GPU about which row is row
     0; a pass that thinks in image space (y down) flips it itself. */
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

  const SHAPE_FRAG_SRC = `
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
uniform float u_grain;

uniform sampler2D u_gradTex;
uniform float u_gradAngle;
uniform float u_gradExtent;


/* ---------------------------------------------------------
   Hash
   --------------------------------------------------------- */

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}


/* ---------------------------------------------------------
   Shape mask
   --------------------------------------------------------- */

float shapeMask(vec2 uv){
  float aspect = u_resolution.x / u_resolution.y;

  vec2 p = (uv - u_center) * vec2(aspect, 1.0);

  float ca = cos(u_shapeAngle);
  float sa = sin(u_shapeAngle);

  vec2 rp = vec2(
    p.x * ca - p.y * sa,
    p.x * sa + p.y * ca
  );

  vec2 half_size =
    max(u_size * 0.5 * vec2(aspect, 1.0), vec2(1e-6));

  vec2 d = abs(rp) / half_size;

  float r = max(u_roundness, 1.001);

  float dist = pow(
    pow(max(d.x, 1e-6), r) +
    pow(max(d.y, 1e-6), r),
    1.0 / r
  );

  float soft = max(u_softness, 0.001);

  float t = clamp(
    (dist - (1.0 - soft)) / (2.0 * soft),
    0.0,
    1.0
  );

  float st =
    t * t * t *
    (t * (t * 6.0 - 15.0) + 10.0);

  return 1.0 - st;
}


/* ---------------------------------------------------------
   Gradient
   --------------------------------------------------------- */

vec3 gradientColor(vec2 uv){
  vec2 gDir = vec2(
    cos(u_gradAngle),
    sin(u_gradAngle)
  );

  float tRaw = dot(
    uv - u_center,
    gDir
  );

  float gpos = clamp(
    tRaw / max(u_gradExtent, 1e-6) * 0.5 + 0.5,
    0.0,
    1.0
  );

  return texture2D(
    u_gradTex,
    vec2(gpos, 0.5)
  ).rgb * u_glow;
}


/* ---------------------------------------------------------
   Main
   --------------------------------------------------------- */

void main(){

  /* Shape geometry, gradient angle and grain are all authored in
     image space (y down, origin top-left), so flip once here. */
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);

  float mask = shapeMask(uv);

  vec3 color = gradientColor(uv);

  /* Grain belongs to the field, so the blur smears it too. */
  float g = hash21(uv * u_resolution) - 0.5;
  color += vec3(g * u_grain);

  float alpha = mask * u_opacity;

  /*
   * Premultiplied output. This is what makes the blur correct:
   * the separable pass convolves (R*A, G*A, B*A, A) as one vector,
   * and GL_LINEAR then interpolates already-multiplied colour, so a
   * fading edge carries its own hue instead of bleeding the
   * background through it.
   */
  gl_FragColor = vec4(
    color * alpha,
    alpha
  );
}
`;

  const BLUR_FRAG_SRC = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_src;

/* One texel along the blur axis: (1/w, 0) for X, (0, 1/h) for Y. */
uniform vec2  u_texel;

/* u_weights[0] is the centre tap, u_weights[i + 1] the weight of
   the pair at u_offsets[i] texels, applied mirrored. */
uniform float u_offsets[${BLUR_PAIRS}];
uniform float u_weights[${BLUR_PAIRS + 1}];

void main(){
  vec4 sum = texture2D(u_src, v_uv) * u_weights[0];

  for (int i = 0; i < ${BLUR_PAIRS}; i++) {
    vec2 o = u_texel * u_offsets[i];
    float w = u_weights[i + 1];
    sum += texture2D(u_src, v_uv + o) * w;
    sum += texture2D(u_src, v_uv - o) * w;
  }

  gl_FragColor = sum;
}
`;

  const COMPOSITE_FRAG_SRC = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_scene;
uniform vec3 u_bg;

void main(){
  /* Premultiplied "over": the scene keeps its alpha so its blurred
     edges can fade into the background instead of cutting against
     it. The framebuffer itself stays opaque. */
  vec4 scene = texture2D(u_scene, v_uv);
  gl_FragColor = vec4(
    scene.rgb + u_bg * (1.0 - scene.a),
    1.0
  );
}
`;

  GS.shaders = {
    VERT_SRC,
    SHAPE_FRAG_SRC,
    BLUR_FRAG_SRC,
    COMPOSITE_FRAG_SRC,
    BLUR_PAIRS,
  };})(window.GS);
