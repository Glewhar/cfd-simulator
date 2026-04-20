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
| `ballistics.js`| `CALIBER_PRESETS`, `FireSequencer`, `BALLISTIC_TIME`, `DEBUG_CONFIG` |
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
Real ballistic values per preset (`MUZZLE_VELOCITY_FPS`, `BARREL_LENGTH_INCHES`,
`BULLET_LENGTH_INCHES`) drive both bullet kinematics AND gas-injection force.
Caliber differences in plume strength fall out of the velocity difference
automatically — no per-preset force tuning.

Each preset also carries:
- **Solver knobs** (multiplied by the matching `DEBUG_CONFIG.*Mult` slider):
  `VELOCITY_DISSIPATION`, `DENSITY_DISSIPATION`, `CURL`, `BLOOM_INTENSITY`.
  `PRESSURE` / `PRESSURE_ITERATIONS` are per-preset (solver stability, no slider).
- **Geometry ratios** (UV space): `BARREL_LENGTH_RATIO`, `BORE_HALF_H_RATIO`.
- **Splat radius**: `SPLAT_RADIUS` (Gaussian kernel width for gas injection).
- **Palette** (four dye tints, used hot → cool):
  `HOT_FLASH` (R/G/B > 4.0, white-hot peak) →
  `MUZZLE_COLOR` (yellow-orange) →
  `COLOR` (deep orange, in-bore start and smoke lerp target) →
  `SMOKE_COLOR` (dim grey-blue).

### Fire sequencer (`ballistics.js`)
Two-phase timeline driven by simulated milliseconds:

1. **`t ∈ (0, muzzleExitMs)` — in-bore gas push.** One splat per frame behind
   the bullet's tail. Force = `v_bullet_field · gasSpeedRatio · GAS_FORCE_SCALE · gasForceMult`,
   ramped by `velFrac` (0 → 1 as the bullet accelerates). Color lerps
   `COLOR → MUZZLE_COLOR → HOT_FLASH`. `gasSpeedRatio` and `gasForceMult`
   are read from `DEBUG_CONFIG` inside `update()` so slider drags take
   effect within the current shot.
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
- `fire(preset, geom)` — start a sequence. `geom` is the canonical geometry
  snapshot (see Scene below); stored for the duration of the shot so
  mid-shot resizes can't shift timing.
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

Returns barrel texels, bore half-height, bullet length in texels and UV,
muzzle-exit UV x, and the device fit-box (height capped at
`DEVICE_HEIGHT_BORE_MULT × bore`, width at `DEVICE_MAX_WIDTH_BARREL_MULT ×
barrel`). Muzzle-device size is bore-proportional, not leftover-canvas-
proportional, so real suppressor/brake proportions hold regardless of
`BARREL_SCENE_SCALE`.

`Scene.buildObstacleTexture(geom, deviceMask?, deviceW?, deviceH?,
deviceScaleMult?, offsetX?, offsetY?, bullet?)` rasterizes the obstacle map:

- Barrel walls above/below the bore slot for the first `barrelTexels` columns.
- Muzzle device (optional): majority-coverage downsample of the device mask
  into the bore-proportional fit-box, offset by drag.
- Bullet silhouette (optional): solid body at value 255 plus an optional
  invisible "skirt" at value 192 (above the 0.5 solid threshold but below
  the 0.9 overlay threshold). The skirt is painted into empty cells only
  so it can't overwrite barrel walls or the device. Gated by
  `DEBUG_CONFIG.bulletBorderEnabled` and scaled by `bulletBorderMult`.

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

Each sample entry in `MUZZLE_DEVICES` (`main.js`) knows its own projection
axis + mode. Selecting a sample fetches the STL, voxelizes it, and uploads
the mask to the fluid sim. The device mask is draggable in sim space.

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
exactly. These three must not diverge — if the sim keeps running while
capture is frozen, the slider range no longer matches what the user saw.

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

The solver has two orthogonal dissipation knobs, both in the advection
shader:

```glsl
float decay = 1.0 + dissipation * dt;
gl_FragColor = result / decay;
```

Higher dissipation → faster exponential decay.

### Velocity (how fast gas moves / how long it persists)

Gas force is derived, not hand-tuned per preset:

```
inBoreForce    = v_bullet_field × gasSpeedRatio × GAS_FORCE_SCALE × gasForceMult
v_bullet_field = physicalMuzzleVelUV × SIM_MS_PER_WALL_SEC × simWidth
```

The only force-related knobs are the constant `GAS_FORCE_SCALE = 80.0` and
the two live sliders `gasForceMult` / `gasSpeedRatio`. `v_bullet_field` uses
the UNSCALED muzzle velocity so `BULLET_VISUAL_SPEED_MULT = 4.0` (applied to
bullet kinematics only) doesn't cross-contaminate gas dynamics.

Per-preset velocity-shape knobs (all in `ballistics.js`, multiplied by the
matching `DEBUG_CONFIG.*Mult`):

| Knob | Range | What it does |
|------|-------|--------------|
| `SPLAT_RADIUS` | ~0.0005–0.0010 | Gaussian injection kernel width |
| `VELOCITY_DISSIPATION` | 0.65–1.30 | Velocity field bulk-motion decay |
| `DENSITY_DISSIPATION` | 3.5–6.0 | Dye (visible smoke) decay |
| `CURL` | 12–35 | Vorticity confinement — eddies, swirl |
| `BLOOM_INTENSITY` | 0.5–1.5 | Visible glow |
| `PRESSURE` / `PRESSURE_ITERATIONS` | — | Solver stability (no slider) |

### Phase-swapped dissipation
`applyPhaseDissipation()` in `main.js` swaps the dissipation multipliers
live: in-bore mult while the bullet is in the barrel, bloom mult after the
tail clears AND during IDLE (so residual smoke between auto-looped shots
decays under the same knob that shaped it).

### Color progression
Four tints per preset, lerped over simulated time inside `update()`:

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
so the glow doesn't show during the in-bore push — the user-visible flash
belongs to muzzle exit. Between shots (IDLE) bloom is held at full so
residual smoke still glows. The whole halo is additionally gated by the
`bloomEnabled` feature toggle (default **OFF** — the raw plume reads
clearer without the halo, and a user can opt in from the debug panel).

### Debug panel — feature toggles vs. sliders
Two knob types in `DEBUG_CONFIG`:
- **`*Enabled` booleans** — full on/off. When OFF, the feature is bypassed
  entirely regardless of slider value. Feature toggles:
  `inboreEnabled`, `smokeEnabled`, `splatLosGuard`, `bloomLosGuard`,
  `bloomEnabled` (default OFF), `curlEnabled`, `bulletBorderEnabled`.
- **`*Mult` / magnitude sliders** — scale a preset value; 1.0× = unchanged.
  Ignored when the matching feature toggle is OFF.

This split lets a user A/B-test a feature without losing their slider
position. Labels in the debug panel are firearms-first (e.g. "Powder
charge" for `gasForceMult`, "Bore seal" for `bulletBorderMult`) — the
tooltip on each row is the canonical explanation.

## Invariants to preserve

- **One geometry object.** Never compute barrel texels / bore half-height /
  bullet length outside `Scene.computeGeometry`. The painter AND the
  sequencer must read the same snapshot.
- **Two obstacle buffers, one solver-facing, one visual-facing.** Any
  morphological op ("seal this thin wall") goes into the solver buffer
  only — never the visual buffer. The user sees the true voxelized width.
- **Pause freezes solver + sequencer + capture.** All three gate on
  `playbackState === 'playing'`. The slider's `max` must match what's in
  the ring buffer.
- **Bullet is an obstacle, not a particle.** It's painted at 255 like any
  wall. The scene must be repainted every frame the bullet moves AND one
  more time after it exits.
- **LOS guards stay ON by default.** The wide smoke Gaussian respects thin
  walls only because of the splat-shader ray-march; the fast advection
  backtrace respects them only because of the backtrace ray-march. Both
  are exposed as debug toggles for A/B comparison but are load-bearing
  defaults.
- **`UNPACK_ALIGNMENT = 1`** before any obstacle `texImage2D` — default
  alignment of 4 scrambles rows when `simWidth % 4 ≠ 0`.
- **Time base is split.** `sequencer.simMs` is stretched through
  `BALLISTIC_TIME.SIM_MS_PER_WALL_SEC`; the fluid solver uses raw wall-clock
  `dt`. Don't cross-mix.
- **Playback time readout is in milliseconds with three decimals** —
  ballistic events are sub-millisecond.
