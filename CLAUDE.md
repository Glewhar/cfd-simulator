# CFD Muzzle Simulator — Project Brief

## What this is
A browser-based ballistic-gas fluid simulator. Gas is injected behind a
moving bullet inside a caliber-specific barrel, then vents through an optional
muzzle device (suppressor or brake) rendered as a 2D voxelized cross-section.
The underlying visualizer is Pavel Dobryakov's WebGL Navier-Stokes solver.

**Running locally:** PowerShell server via `.claude/launch.json` (config name
`ballistic-sim`, port 3000). Open `http://localhost:3000/index.html`.
A Node fallback lives in `server.js`.

## File map
| File | Purpose |
|------|---------|
| `index.html`   | UI shell: sim canvas, playback overlay, HUD panels, status bar |
| `style.css`    | Dark theme; CSS vars `--accent: #f97316`, `--danger: #dc2626` |
| `fluid-core.js`| Pavel's WebGL engine + obstacle-aware shaders. Exposes `window.FluidSim` |
| `ballistics.js`| `CALIBER_PRESETS`, `FIRE_PALETTE`, `FIRE_MODEL`, `deriveCaliberVisuals`, `FireSequencer`, `BALLISTIC_TIME`, `DEBUG_CONFIG` |
| `voxelizer.js` | `.obj` / `.stl` → 2D binary obstacle mask. `Voxelizer.voxelizeFromUrl()` |
| `scene.js`     | Obstacle texture rasterizer + canonical scene geometry. `Scene.computeGeometry` / `Scene.buildObstacleTexture` |
| `main.js`      | App glue: state, playback state machine, frame capture, drag-to-move device |
| `serve.ps1`    | PowerShell HTTP server (no Node/Python needed) |
| `*.stl`        | Built-in muzzle-device samples: `supressor_sample.stl`, `muzzle-break-sample.stl` |

## Architecture

### Fluid engine (`fluid-core.js`)
Pavel Dobryakov's 2D Navier–Stokes solver (WebGL ping-pong grid) with
additions for obstacle-aware physics:

- **Obstacle textures (two).** The fluid pipeline samples one obstacle
  texture; the overlay renderer samples another. This split lets the solver
  see thickened / sealed walls while the user still sees the uploaded
  geometry at its true voxelized width.
- **Obstacle-aware shaders.** Splat, advection, pressure projection, and
  bloom all respect obstacle cells. Splat and advection also ray-march their
  source-to-destination line so wide Gaussians / fast flows can't leap
  through thin walls (`uSplatLosGuard`, `uAdvBacktraceGuard`).
- **`preserveDrawingBuffer: true`** so `drawImage(canvas, …)` can read back
  the latest frame into a 2D offscreen canvas for scrub-playback capture.
- **No mouse interaction** — only `FireSequencer` and the device drag
  handler in `main.js` write into the sim.

Public API (`window.FluidSim`):
- `init(canvas)`
- `splat(x, y, dx, dy, color, radius)` — inject force + dye
- `uploadObstacleTexture(data, w, h)` — `Uint8Array` mask (0 = fluid, 255 = solid)
- `setConfig(key, value)` / `getConfig()`
- `setBeforeStepCallback(fn)` — called every frame with wall-clock `dt`
- `setSplatLosGuard(bool)` / `setBloomLosGuard(bool)`
- `getSimSize()` → `{width, height}` (aspect-ratio-corrected, NOT always 256×256)

### Caliber presets (`ballistics.js`)
**Presets hold physical facts only** — `MUZZLE_VELOCITY_FPS`,
`BARREL_LENGTH_INCHES`, `BULLET_LENGTH_INCHES`, `BORE_DIAMETER_INCHES`,
`BARREL_OD_INCHES`. No visual tuning knobs, no palette.

All visuals are **derived** from those physical values through two
module-level constants:

- **`FIRE_PALETTE`** — one shared palette for all calibers:
  `HOT_FLASH` (white-hot peak) → `MUZZLE_COLOR` → `COLOR` (in-bore start
  / smoke lerp source) → `SMOKE_COLOR`.
- **`FIRE_MODEL`** — global base values (`BLOOM_INTENSITY_BASE`,
  `SPLAT_RADIUS_BASE`, `CURL_BASE`, `VELOCITY_DISSIPATION`,
  `DENSITY_DISSIPATION`, `PRESSURE`, `PRESSURE_ITERATIONS`,
  `TARGET_IN_BORE_SPLATS`, reference velocity `V_REF_FPS`, reference bore
  `BORE_REF_INCHES`).

**`deriveCaliberVisuals(preset)`** returns the per-caliber triple
`{BLOOM_INTENSITY, SPLAT_RADIUS, CURL}` with:
- `BLOOM_INTENSITY = BASE × (v / V_REF)^1.3` — faster → brighter halo
- `SPLAT_RADIUS    = BASE × (bore / BORE_REF)` — bigger bore → wider plume
- `CURL            = BASE × (v / V_REF)` — faster → more turbulence

This makes caliber behavior **monotonic by construction**: adding a new
preset = adding 5 physical numbers, no visual hand-tuning.

Bullet kinematics + gas-injection force are also velocity-derived
(see Fire sequencer), so plume strength scales with muzzle velocity
automatically.

### Fire sequencer (`ballistics.js`)
Two-phase timeline driven by simulated milliseconds:

1. **`t ∈ (0, muzzleExitMs)` — in-bore gas push.** `N` splats per frame
   behind the bullet's tail, where
   `N = round(inBoreSplatRatePerSimMs × dtMs)` and
   `inBoreSplatRatePerSimMs = FIRE_MODEL.TARGET_IN_BORE_SPLATS / muzzleExitMs`
   (computed once in `fire()`). This compensates for fast calibers having
   short dwell time — total in-bore splat count is constant across
   calibers. Force = `v_bullet_field · gasSpeedRatio · GAS_FORCE_SCALE · gasForceMult`,
   ramped by `velFrac` (0 → 1 as the bullet accelerates). Color lerps
   `FIRE_PALETTE.COLOR → MUZZLE_COLOR → HOT_FLASH`.
2. **`t ∈ (muzzleExitMs, muzzleExitMs + smokeDurationMs)` — settling smoke.**
   In-bore injection has stopped; the accumulated bore gas vents through the
   unblocked muzzle under the solver alone (this produces the visible muzzle
   flash — there is no separate scripted exit-blast). Throttled smoke emission
   at `smokeRateHz` with live-tunable force / radius / duration.
3. **`t > muzzleExit + smokeDurationMs`** — IDLE.

`muzzleExitMs` = moment the bullet's TAIL clears the muzzle, derived from a
constant-acceleration textbook model using the real barrel length and
muzzle velocity.

API:
- `fire(preset, geom)` — start a sequence. Stores `geom`, caches
  `this.derived = deriveCaliberVisuals(preset)`, and precomputes
  `inBoreSplatRatePerSimMs` for the duration of the shot so mid-shot
  resizes can't shift timing.
- `update(dtWall)` — advance, returns `[{x,y,dx,dy,color,radius,phase}]`.
- `getBullet()` → `{xUV, yUV} | null` — position only. Length / half-height
  live on `geom` so drawing and physics agree by construction.
- `isActive` — true while not IDLE; drives auto-loop scheduling in main.js.

### Global time scale
`window.BALLISTIC_TIME.SIM_MS_PER_WALL_SEC` stretches sequencer time in
wall-clock. At `1.0`, one sim-ms takes one wall-second (1000× slow motion).
Applied only to `sequencer.simMs` — the fluid solver ticks on real wall-clock
dt, so its numerical stability is unaffected.

### Scene geometry (`scene.js`)
`Scene.computeGeometry(preset, simW, simH)` is the **single source of
truth**: a pure function that returns one geometry snapshot used by both
the obstacle painter and `FireSequencer.fire()`. This guarantees that the
DRAWN bullet and the PHYSICS bullet agree on length, position, and timing.

Returns barrel texels, `boreHalfH`, `barrelOdHalfH` (the barrel's outer-wall
bound), `bulletHalfH`, bullet length in texels and UV, muzzle-exit UV x,
`texelsPerInch` (the unified physical scale, shared by barrel / bullet /
mesh), and a legacy-fallback device fit-box (`deviceMaxW × deviceTargetH`)
for meshes without physical info. Barrel, bullet, and uploaded meshes all
scale off `SCENE_TEXELS_PER_INCH_OVER_REF`, so a 16" and 24" barrel render
at a true 2:3 ratio and a 200mm suppressor stays at its real size relative
to whichever preset is active.

**Vertical axis is one regime.** A single `VERTICAL_SCALE` factor multiplies
every Y-axis dimension derived from real inches — bore diameter, barrel OD,
bullet diameter, and the cross-axis of uploaded meshes. The real bore is
sub-pixel at this canvas resolution, so vertical is scaled up for
visibility; using one factor for every Y quantity keeps ratios physically
faithful. Horizontal dimensions (barrel length, bullet length, mesh long
axis) stay at true `texelsPerInch`.

`Scene.buildObstacleTexture(geom, deviceMask?, deviceW?, deviceH?,
deviceScaleMult?, offsetX?, offsetY?, bullet?)` rasterizes the obstacle map:

- Barrel walls: a tube bounded above and below by `barrelOdHalfH` (not
  wall-to-wall) for the first `barrelTexels` columns.
- Muzzle device (optional): majority-coverage downsample of the device mask.
  Horizontal scale is true-physical (`texelsPerInch`); vertical scale picks
  up `VERTICAL_SCALE`. Offset by drag.
- Bullet silhouette (optional): solid body at value 255 plus an optional
  invisible "skirt" at value 192. Gated by `DEBUG_CONFIG.bulletBorderEnabled`
  and scaled by `bulletBorderMult`.

Coordinate convention: `data[j * simW + i]`, `j=0` is the bottom row
(OpenGL UV `v = 0`).

### Voxelizer (`voxelizer.js`)
`Voxelizer.voxelizeFromUrl(url, axis, resolution, {mode})` fetches an `.obj`
or `.stl` and produces a 2D obstacle mask:

- **`mode: 'section'`** (default, best for hollow geometry with internal
  features like suppressor baffles): axial ray-cast inside-mesh test at
  the mesh centre. Odd-crossing = solid.
- **`mode: 'silhouette'`** (best for discrete solid parts): union of
  projected triangles via Canvas 2D `ctx.fill()`, one fill per triangle
  to avoid winding cancellation.
- **`axis`**: `'y'` (top view, default), `'z'` (front), `'x'` (side).

Returns `{ data: Uint8Array, width, height, solidPixels, totalPixels,
triangleCount }`. 255 = solid, 0 = fluid.

### Muzzle-device samples
`main.js` ships two built-in samples the user can select in the HUD:

- **Suppressor** → `supressor_sample.stl`
- **Muzzle brake** → `muzzle-break-sample.stl`
- **Bare muzzle** (no device)

Each sample entry in `MUZZLE_DEVICES` knows its own projection axis + mode.
Selecting a sample fetches the STL, voxelizes it, and uploads the mask
to the fluid sim. The device mask is draggable in sim space.

### Main app (`main.js`)
Key state:
- `selectedCaliberId`, `selectedDeviceId`, `deviceMask`, `deviceOffset`.
- `sceneGeometry` — refreshed every `rebuildObstacles()`.
- `fireSequencer`, `playbackState` (`'idle' | 'playing' | 'paused'`),
  `autoRepeatTimer`.
- Replay ring buffer: `replayFrames` (`REPLAY_MAX_FRAMES` = 360 offscreen
  canvases), `replayCount`, `replayWriteIdx`. Captured at `REPLAY_FPS = 30`,
  each frame downsampled to `REPLAY_W × REPLAY_H` for scrub-playback.

FIRE button state machine:
- **idle → FIRE** (red): start a fresh shot, enter `playing`.
- **playing → PAUSE** (orange): freeze sim, show scrub slider.
- **paused → PLAY** (green): unfreeze and continue.

Pause truly freezes everything: the solver (`FluidSim.setConfig('PAUSED',
true)`), the sequencer (the before-step callback early-returns when not
`'playing'`), and the replay capture (its own gate). The slider's `max` is
set to `replayCount - 1` on pause so the range matches captured frames
exactly.

Per-frame obstacle rebuild for the moving bullet:
- While `fireSequencer.isActive && getBullet() !== null`, `rebuildObstacles(bullet)`
  is called from the before-step hook every frame.
- Exactly one cleanup rebuild runs the frame after the bullet leaves so
  the phantom bullet clears out of the obstacle texture.

Drag-to-move device: `mousedown` on the sim canvas (with a device loaded)
captures screen px; `mousemove` converts to sim-space pixels (inverting Y)
and rebuilds.

## UI layout (bottom-docked HUD)
```
┌──────────────────────────────────────────────────────────────┐
│ status bar (top center, "Ready · Space to fire")            │
│                                                              │
│                   SIM CANVAS (100vw × 100vh)                 │
│                   — full viewport, draggable w/ device       │
│                                                              │
│  ┌─── HUD (bottom, horizontal flex row) ──────────────────┐  │
│  │ [CALIBER]   [DEVICE]   [FIRE]   [PLAYBACK when paused] │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```
Panels: `#caliber-panel`, `#device-panel`, `#fire-panel`, `#playback-panel`.
The HUD defaults to `pointer-events: none` and individual panels opt back in,
so the sim canvas stays draggable under empty HUD space.

## Gas behavior — tuning

The solver's advection shader decays per frame:
```glsl
float decay = 1.0 + dissipation * dt;
gl_FragColor = result / decay;
```
Higher dissipation → faster exponential decay.

### Force
Gas force is velocity-derived, no per-caliber hand tuning:
```
inBoreForce    = v_bullet_field × gasSpeedRatio × GAS_FORCE_SCALE × gasForceMult
v_bullet_field = physicalMuzzleVelUV × SIM_MS_PER_WALL_SEC × simWidth
```
`GAS_FORCE_SCALE = 80.0` constant; `gasForceMult` / `gasSpeedRatio` are
sliders. `v_bullet_field` uses the UNSCALED muzzle velocity so
`BULLET_VISUAL_SPEED_MULT = 1.0` (bullet kinematics only) doesn't
cross-contaminate gas dynamics.

### Visual knobs — global, not per-preset
All visual tuning lives in `FIRE_MODEL` and its derived values:

| Knob (global) | What it does |
|------|------|
| `VELOCITY_DISSIPATION` | Velocity field bulk-motion decay. × `velocityDissMult` slider. |
| `DENSITY_DISSIPATION`  | Dye (visible smoke) decay. × `densityDissMult` slider. |
| `SPLAT_RADIUS_BASE` × bore-ratio | Gaussian injection kernel width. × `splatRadiusMult` slider. |
| `CURL_BASE` × k_v      | Vorticity confinement — eddies, swirl. × `curlMult` slider. |
| `BLOOM_INTENSITY_BASE` × k_v^1.3 | Visible glow. × `bloomMult` slider. |
| `PRESSURE` / `PRESSURE_ITERATIONS` | Solver stability (no slider). |
| `TARGET_IN_BORE_SPLATS` | Total in-bore splat count target, held constant across calibers. |

Dissipation is set **once** on caliber change / slider drag — no mid-shot
phase swap. (The historical in-bore-vs-bloom phase split was removed; it
was invisible to users and made fast-caliber behavior non-monotonic.)

### Color progression
Shared palette, lerped over simulated time inside `update()`:
```
COLOR → MUZZLE_COLOR → HOT_FLASH      (in-bore, as velFrac ramps 0 → 1)
                       ↓
                  (muzzle exit)
                       ↓
COLOR → SMOKE_COLOR                    (settling, as t ramps 0 → smokeDurationMs)
```
The visible "flash goes out" effect comes from the high-magnitude palette
values decaying under `DENSITY_DISSIPATION` + the bloom threshold; there is
no second dye buffer.

### Scheduled bloom
`bloomOnsetOffsetMs` + `bloomFadeInMs` gate `BLOOM_INTENSITY` along sim-time
so the glow doesn't show during the in-bore push. Between shots (IDLE)
bloom is held at full so residual smoke still glows. The whole halo is
additionally gated by the `bloomEnabled` feature toggle.

### Debug panel — feature toggles vs. sliders
- **`*Enabled` booleans** — full on/off (`inboreEnabled`, `smokeEnabled`,
  `splatLosGuard`, `bloomLosGuard`, `bloomEnabled`, `curlEnabled`,
  `bulletBorderEnabled`).
- **`*Mult` sliders** — scale a derived / global value; 1.0× = unchanged.
  Ignored when the matching feature toggle is OFF. Every slider is one
  multiplier on one derived number — no hidden interactions.

Labels are firearms-first (e.g. "Powder charge" for `gasForceMult`, "Bore
seal" for `bulletBorderMult`); tooltips are the canonical explanation.

## Invariants to preserve

- **Caliber presets are physical-only.** No `BLOOM_INTENSITY`,
  `SPLAT_RADIUS`, `CURL`, palette, or dissipation on a preset. Visuals
  live in `FIRE_MODEL` + `FIRE_PALETTE`, derived via
  `deriveCaliberVisuals(preset)`. Faster caliber = brighter / bigger flash
  by construction.
- **One in-bore splat budget.** `TARGET_IN_BORE_SPLATS` splats per shot
  regardless of dwell time. Compensates for fast calibers having few
  frames in the barrel.
- **One geometry object.** Never compute barrel texels / bore half-height /
  bullet length outside `Scene.computeGeometry`.
- **Two obstacle buffers, one solver-facing, one visual-facing.** Morph
  ops ("seal this thin wall") go into the solver buffer only.
- **Pause freezes solver + sequencer + capture.** All three gate on
  `playbackState === 'playing'`. The slider's `max` must match the ring
  buffer.
- **Bullet is an obstacle, not a particle.** Painted at 255 like any wall.
  Repaint every frame it moves + one more time after it exits.
- **LOS guards stay ON by default.** The wide smoke Gaussian respects thin
  walls only because of the splat-shader ray-march; the fast advection
  backtrace respects them only because of the backtrace ray-march.
- **`UNPACK_ALIGNMENT = 1`** before any obstacle `texImage2D`.
- **Time base is split.** `sequencer.simMs` is stretched through
  `BALLISTIC_TIME.SIM_MS_PER_WALL_SEC`; the fluid solver uses raw
  wall-clock `dt`. Don't cross-mix.
- **Playback time readout is in milliseconds with three decimals** —
  ballistic events are sub-millisecond.
