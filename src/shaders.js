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
uniform vec2  u_grainScale;

uniform sampler2D u_gradTex;
uniform float u_gradAngle;
uniform float u_gradExtent;


/* ---------------------------------------------------------
   Hash
   --------------------------------------------------------- */

/* Precision-safe float hash, Hoskins-style. The usual
   fract(p * bigConst) shape collapses at export sizes: at
   5120px across the product reaches ~630k, where a float32 step
   is already 1/16, so the input lattice falls to a couple of
   hundred states and the field tiles visibly. Scaling by a small
   constant keeps every product under 1024 and leaves the whole
   mantissa to the mixing. */
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}


/* ---------------------------------------------------------
   Grain
   --------------------------------------------------------- */

/* Value noise: one hash per lattice corner, smoothstepped
   between them. Interpolating is what lets a cell be a fraction
   of the frame instead of a single pixel, so a 4K export carries
   the same grain the preview showed rather than the same one
   pixel four thousand times. */
float valueNoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);

  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/* Two terms: the value-noise field sets how big the grain is, the
   per-pixel hash keeps the sparkle real film grain has. The lattice
   is turned off-axis by ~31.7°, otherwise the interpolation grid
   lines up with the pixel rows and shows through as a mesh.

   The 1.6 puts the sum back at the standard deviation of the old
   per-pixel field, so the slider keeps meaning the same amount of
   noise; the two terms are decorrelated enough that half and half
   reads the same roughness at 800px and at 5K. */
float grainField(vec2 uv){
  vec2 q = uv * u_grainScale;
  q = vec2(
    q.x * 0.85065 - q.y * 0.52573,
    q.x * 0.52573 + q.y * 0.85065
  );

  float structured = valueNoise(q) - 0.5;
  float crisp = hash21(floor(uv * u_resolution)) - 0.5;

  return (structured + crisp) * 0.5 * 1.6;
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

  float r = max(u_roundness, 0.01);

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

  /* Grain belongs to the field, so the blur smears it too, and the
     same field is sampled by every shape: overlapping figures share
     one grain instead of each carrying its own copy. */
  if (u_grain > 0.0) {
    color += vec3(grainField(uv) * u_grain);
  }

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
