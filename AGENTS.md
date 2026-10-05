# Colorscapes / Gradient Studio

Single-page WebGL gradient generator. **Zero dependencies, zero tooling** — no `package.json`, no
bundler, no tests, no lint, no CI, and do not add them. Open `index.html` over `file://`: that is the
whole dev loop *and* the whole verification step. WebGL is hard-required (`app.js` probes for it and
renders a fatal note if absent).

Every module is an IIFE attaching its public API to `window.GS`. **The `<script>` order in
`index.html` is the dependency graph** — there is no module loader, so a file reading `GS.utils` at
IIFE-evaluation time throws if tagged too early. Only top-level `const { x } = GS.y` makes order
matter; calls inside handlers do not.

`namespace`/`utils`/`color`/`geom` — `GS`/`byId`, helpers, hex↔OkLab, **all shape geometry**.
`gradient`/`shaders`/`renderer` — stop sampling, `sortStops`, three GLSL programs + `BLUR_PAIRS`,
`Renderer` (context, programs, FBOs, kernel). `state`/`storage` — `GS.state`, `SHAPE_SCHEMA`,
normalisation, presets, randomisers (`localStorage` key `gradient-studio-presets-v1`).
`ui`/`preview`/`layout` — every panel + toast/modal; canvas sizing, rAF loop, hit-test; 2D editor
canvas. `share`/`exporter`/`app.js` — state ⇄ URL hash; offscreen PNG; boot: hash → `applyState` →
WebGL check → `ui.init()`.

## State

`GS.state` is **one live mutable object** and `applyState(raw)` normalises into it *in place*, so
external references stay valid. Never reassign `GS.state` — mutate fields. `GS.selection = { id }`
is UI-only and deliberately not serialised. State must stay plain-JSON serialisable and compact: it
round-trips through the URL hash as base64. Schema is v2 (`shapes[]`); `migrateLegacy` keeps v1
share links alive — never delete it, keep migrations additive. `stop.color` must stay `#rrggbb`;
`isHex` rejects anything else during normalisation.

Every value arriving from a hash, preset or `randomState()` must pass `normaliseShape`, which is
**generated from `SHAPE_SCHEMA`** (`state.js`) — one table line per numeric field, and the panel and
normaliser follow. A field not in that table is silently dropped or defaulted; that is the most
likely bug when extending the schema.

## Render discipline

**Mutate state, then `GS.preview.schedule()`** — rAF-coalesced, and it also redraws the layout canvas
and syncs the hash. Never call `renderer.render()` from UI code. Structural change →
`GS.ui.refreshSelection()` / `rebuildAll()`; export-size change → `GS.preview.layout()` **plus**
`GS.layout.resize()`, since the preview aspect follows `exportW/exportH`.

Panel listeners are **delegated on containers and bound once in `ui.init()`** precisely so rebuilds
cannot leak — never bind to a row you build. Rows are matched by `data-key`, never by position, so
schema rows may be reordered or interleaved freely. `visible === false` and `opacity <= 0` are
draw-time skips in `_drawShapes`, not UI-level. `share.sync()` is debounced 300 ms with
`replaceState`, so the back button stays clean.

All geometry is normalised 0..1 UV against the export aspect (x aspect-scaled); `rot` is degrees,
`roundness` the superellipse exponent. Shapes paint in array order — last on top, hit-tests iterate
backwards. Stops are shown in **position** order, so reordering them swaps *colours* between fixed
positions and region width is edited by moving positions themselves; the shapes list instead moves
whole objects, because there array order *is* the Z-order. `Delete`/`Backspace` and `Ctrl/Cmd+D`
are suppressed while focus is in an input/select/textarea.

## WebGL

`shapes → scene FBO → blur X → blur Y → composite`. **Blur runs after the shapes have merged** — that
is the point: overlaps cross-fade into a real third colour, then the single image is smeared. Don't
move it into the shape pass. Everything is premultiplied; `GL_LINEAR` on premultiplied RGBA is what
makes it correct, so keep new blend modes premultiplied-source. Blur runs on a buffer downscaled by
`MIN_BLUR_SCALE`; tap offsets are texels of the *destination*, not the source.

`state.blur` is a **fraction of frame width, never pixels**, so preview and 4K export smear alike.
`measureSigma` exists because folding integer taps into half-texel linear taps widens the kernel:
sigma is measured through the same taps the GPU uses — do not substitute the analytic value. The
gradient is baked CPU-side in OkLab into a pooled 1024×1 texture; the shader only samples.

The preview never renders above `MAX_DIM` (2048). Export size is unbounded and uses a **separate,
long-lived offscreen `Renderer` with `preserveDrawingBuffer`** (`exporter.js`). One context per
canvas, ever — a fresh one per export leaks contexts.

## Change both sides

| If you change | Also update |
|---|---|
| `BLEND_MODES` | `applyBlend` in `renderer.js` |
| `MAX_BLUR` | `BLUR_PAIRS` in `shaders.js` — the kernel runs out of pairs |
| `SHAPE_SCHEMA` `min` | `shapeMask` in `shaders.js` — same floors (`roundness ≥ 0.01`, `softness ≥ 0.001`) |
| `geom.js` rotation | the shader rotates **world → local**; `geom.toWorld` is its inverse |
| OkLab math | duplicated by hand in `gradient.js` *and* `color.js` — no build step shares a header |

The `roundness` floor is an epsilon, not a shape limit: `r = 1` is a rhombus, `r < 1` a concave
4-point star, and the `1/r` in both shader and editor goes infinite at exactly 0.

`geom.js` is the only copy of the hit-test, resize and handle maths. It was duplicated near-verbatim
in `preview.js` and `layout.js` and the copies disagreed: one ignored rotation, the other rotated
the wrong way, so every rotated outline was mirrored against the render. Add new geometric
predicates there; do not reopen a copy. `GRAIN_CELLS` reaches the shader as `u_grainScale` in
**cells across the frame**, so grain is a fraction of the frame, not a pixel count; `hash21` must
keep its small multiplier or the lattice dies at 5120 px and the whole frame holds ~13k values.

**Never render the gradient strip with a CSS gradient** — `stripBackground` and the layout swatches
pre-sample OkLab, because browsers interpolate CSS gradients in sRGB and show a harsher ramp than
the preview.

## Style

2-space indent, single quotes, semicolons, trailing commas in multi-line literals. Each file opens
with a `/* ==== Title ==== */` banner explaining its role; inner sections use
`/* ---------- name ---------- */`. Comments explain **why** a non-obvious choice was made (sigma
measurement, blur ordering, OkLab, why UI ranges differ from schema clamps) — match that density,
don't narrate the obvious. Commit messages are in **Russian** and describe the architecture, not
just the diff.