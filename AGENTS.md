# Colorscapes / Gradient Studio

Single-page WebGL gradient generator. **16 files, zero dependencies, zero tooling.**
No `package.json`, no bundler, no tests, no lint, no CI — this is deliberate. Do not add them.

## Run it

Open `index.html` directly (`file://` works — plain `<script>` tags, no modules, no `fetch`).
That is the entire dev loop and the entire verification step: there is nothing to run, build, or lint.

WebGL is hard-required. `app.js:10` probes for it and renders a fatal note if absent.

## Architecture

Every module is an IIFE that attaches its public API to `window.GS`:

```js
(function (GS) {
  'use strict';
  ...
})(window.GS);
```

**The `<script>` order in `index.html:83-96` is the dependency graph** — there is no module
loader, so a file that reads `GS.utils` or `GS.gradient` at IIFE-evaluation time will throw if
tagged too early. Adding a module means adding a tag *and* placing it after its dependencies
(`namespace` → `utils`/`color` → `gradient`/`shaders` → `renderer` → `state` → …).
Cross-module calls made *inside* handlers are order-independent; only top-level
`const { x } = GS.y` destructuring is not.

| File | Owns |
|---|---|
| `src/namespace.js` | `window.GS`, `GS.byId` |
| `src/utils.js` | `clamp`, `deg2rad`, `clone`, `debounce`, base64, `dataURLtoBlob` |
| `src/color.js` | hex↔RGB, `hslToHex`, public OkLab conversions |
| `src/gradient.js` | OkLab stop sampling, `sortStops`, `widestGapMidpoint`, `computeExtent` |
| `src/shaders.js` | three GLSL programs + `BLUR_PAIRS` (no WebGL calls) |
| `src/renderer.js` | `Renderer` class — context, programs, FBOs, blur kernel |
| `src/state.js` | `GS.state`, `applyState`, normalisation, randomisers, presets |
| `src/storage.js` | user presets in `localStorage` |
| `src/ui.js` | every panel, controls, toast, modal — the largest file |
| `src/preview.js` | preview canvas sizing, rAF loop, pointer hit-test on the render |
| `src/layout.js` | 2D editor canvas (drag / dbl-click add / right-click delete) |
| `src/share.js` | state ⇄ URL hash, copy-link |
| `src/exporter.js` | offscreen `Renderer` → PNG download |
| `app.js` | boot: read hash → `applyState` → WebGL check → `ui.init()` |

## State model

`GS.state` is **one live mutable object**, and `applyState(raw)` normalises into it *in place*
(`src/state.js:259`) so external references stay valid.

- **Never reassign `GS.state`.** Mutate fields, or go through `GS.applyState()`.
- Every value that arrives from the hash, a preset, or `randomState()` must pass
  `normaliseShape`/`normaliseGradient` (`src/state.js:186-220`). **A new shape field that is not
  added there is silently dropped or defaulted** — this is the single most likely bug when
  extending the schema.
- Schema is v2 (`shapes[]`). `migrateLegacy` (`src/state.js:223`) keeps v1 share links working —
  don't delete it, and keep migrations additive.
- `GS.selection = { id }` is UI-only and deliberately not serialised.
- State round-trips through the URL hash as base64 JSON, so it must stay plain-JSON
  serialisable and compact (`clone` uses `structuredClone`).

## Render discipline

**Mutate state, then call `GS.preview.schedule()`** — it is rAF-coalesced and also redraws the
layout canvas and syncs the hash. Never call `renderer.render()` from UI code.

- Selection / structural change (`addShape`, `deleteShape`, `refreshSelection`, preset load) →
  `GS.ui.refreshSelection()` or `GS.ui.rebuildAll()`; these clear and re-`build*` panels.
- Export-size change → `GS.preview.layout()` **plus** `GS.layout.resize()` (both synchronous;
  the preview aspect depends on `exportW/exportH`).
- Panel listeners are **delegated on container elements and bound once in `ui.init()`**
  (`src/ui.js:965`) precisely so `rebuildAll()` doesn't leak handlers. Keep it that way: add a
  listener to the container, not to rows you build.

## WebGL pipeline (`renderer.js`, `shaders.js`)

One context, one fullscreen triangle-pair quad, three programs, three FBOs. Four stages:

```
shapes   -> scene FBO   transparent, per-shape glBlendFunc
blur X   -> blur FBO A
blur Y   -> blur FBO B
composite-> canvas      scene over the background colour
```

- **Blur runs after the shapes have merged** — that is the entire point (overlapping shapes
  cross-fade into a real third colour, then the single image is smeared). Don't move it into the
  shape pass.
- Everything is **premultiplied**; `GL_LINEAR` on premultiplied RGBA is what makes the blur
  correct. Keep new blend modes premultiplied-source.
- `state.blur` is a **fraction of frame width, not pixels** (`renderer.js:463`), so preview and
  4K export smear identically. Never store pixels.
- `measureSigma` (`renderer.js:152`) exists because folding integer taps into half-texel linear
  taps widens the kernel — the sigma is measured through the same taps the GPU uses. Don't
  substitute the analytic value.
- Blur passes run on a **downscaled** buffer (`MIN_BLUR_SCALE`, `renderer.js:37`); offsets are in
  texels of the *destination*, not the source.
- The gradient is baked **CPU-side in OkLab into a 1024×1 RGBA texture** (`GRAD_TEX_WIDTH`),
  pooled and reused across draws. Keep the shader cheap; it just samples.
- The preview never renders above 2048px (`MAX_DIM`, `preview.js:15`); export size is unbounded
  and uses a **separate, long-lived offscreen `Renderer` with `preserveDrawingBuffer: true`**
  (`exporter.js:15`). One context per canvas, ever — a new one per export leaks contexts.

## Cross-file coupling (change both sides)

| If you change | Also update |
|---|---|
| `BLEND_MODES` (`state.js:16`) | `applyBlend` switch (`renderer.js:97`) |
| `MAX_BLUR` (`state.js:21`) | `BLUR_PAIRS` (`shaders.js:27`) — MAX_BLUR exists because the kernel runs out of pairs |
| `SHAPE_FIELDS` (`ui.js:26`) | `syncShapeInputs` (`ui.js:118`) matches `.ctrl` rows **by index** — append new rows *after* the field rows, never before |
| OkLab math | duplicated in `gradient.js:26-62` *and* `color.js:53-98`; `gradient.js` has its own private copy |
| Superellipse hit-test | duplicated near-verbatim in `preview.js:78` and `layout.js:26` |
| `normaliseShape` clamps | `shapeMask` in `shaders.js:76` mirrors them (`roundness ≥ 1.001`, `softness ≥ 0.001`) |

## Coordinates

All shape geometry is **normalised 0..1 UV against the export aspect** (`exportW/exportH`), not
pixels. x is scaled by aspect in hit-tests; `rot` is degrees; `roundness` is the superellipse
exponent. Shapes render in array order — last is on top; hit-tests iterate backwards.

## Gotchas

- **The gradient strip must not use a CSS gradient.** `stripBackground` (`ui.js:138`) builds a
  24-stop `linear-gradient` string from OkLab samples on purpose: browsers interpolate those in
  sRGB and show a harsher ramp than the preview. Same reason `layout.js` pre-samples 3 stops.
- Stops are always displayed in **position** order; "reorder" in `reorderStops` swaps *colours*
  between fixed positions. `MIN_GAP` (`ui.js:47`) keeps regions from collapsing.
- `shape.visible === false` and `opacity <= 0` are both draw-time skips in `_drawShapes`, not
  UI-level.
- `share.sync()` is debounced 300ms and uses `replaceState`, so the back button stays clean —
  state is always in the URL, not in memory.
- localStorage key: `gradient-studio-presets-v1` (`storage.js:10`). Reads never throw by design.
- Keyboard: `Delete`/`Backspace` delete the selected shape, `Ctrl/Cmd+D` duplicates, but both are
  suppressed while focus is in an input/select/textarea (`ui.js:834`).
- `stop.color` inputs must stay `#rrggbb` — `isHex` rejects anything else during normalisation.

## Style

2-space indent, single quotes, semicolons, trailing commas in multi-line literals. Each file opens
with a `/* ==== Title ==== */` banner explaining the module's role; sections inside use
`/* ---------- name ---------- */`. Comments explain **why** a non-obvious choice was made (the
sigma measurement, the blur ordering, the OkLab choice) — match that density; don't narrate the
obvious.

Commit messages are in **Russian** and describe the architecture, not just the diff.

## Known defects

- `BUILTIN_PRESETS` (`state.js:62`) contains **two presets named "Neon Sunset"**
  (entries at lines 63-92 and 93-126) — almost certainly a bad paste, and the mangled
  indentation around them is a symptom. Fixing it is in scope for anyone touching presets.
- Stray indentation left in `state.js` at lines 35 and 63.