'use strict';

// ─── Global time scale ────────────────────────────────────────────────────────
// Real ballistic events happen in milliseconds. Each fire sequence is stretched
// in wall-clock time so it's watchable. At 1.0, one simulated millisecond
// plays out over one wall-clock second (1000× slow motion).
window.BALLISTIC_TIME = {
    SIM_MS_PER_WALL_SEC: 1.0,
};

// ─── User-tunable knobs exposed in the Debug panel ───────────────────────────
// Read by FireSequencer.update() every tick AND by main.js when pushing solver
// config. main.js mutates these in place when the user drags sliders. *Mult
// values multiply per-caliber preset values; 1.0 = preset unchanged.
//
// Each *Enabled boolean is an on/off feature toggle. When false, that feature
// is fully disabled (not just scaled to zero) regardless of its slider value —
// this lets a user A/B test a feature without losing their slider setting.
window.DEBUG_CONFIG = {
    // ─── Feature toggles (on/off) ──────────────────────────────────────
    // Gas pushed behind the bullet while it's still inside the barrel.
    // OFF = fire a bullet with no propellant gas injection at all.
    inboreEnabled:       true,
    // Slow trailing smoke that keeps puffing out after the bullet exits.
    // OFF = cloud cuts off at muzzle exit.
    smokeEnabled:        true,
    // Solid walls (barrel, suppressor baffles, brake ports) block gas
    // from leaking through them. OFF = gas can teleport through thin walls.
    splatLosGuard:       true,
    // Solid walls block the muzzle-flash glow from bleeding through steel.
    // OFF = glow passes through solid bodies.
    bloomLosGuard:       true,
    // Halo glow on the hot gas (camera bloom effect). OFF = raw color only,
    // no halo.
    bloomEnabled:        true,
    // Swirl/vorticity confinement — makes gas curl and form eddies.
    // OFF = smoother, more laminar plume with no smoke rings.
    curlEnabled:         true,
    // Invisible solid collar around the bullet modelling obturation
    // (how the bullet seals the bore so gas can't leak past). OFF = gas
    // can slip around the bullet while it's travelling down the barrel.
    bulletBorderEnabled: true,

    // ─── Powder charge & plume shape ───────────────────────────────────
    // How hard the propellant shoves gas behind the bullet. Think powder-
    // charge strength. Higher = bigger, farther-reaching flash.
    gasForceMult:        5.0,
    // Target gas speed as a fraction of bullet speed. 0.1 = gas lags far
    // behind (realistic pressure buildup). >1.0 lets gas race ahead of
    // the bullet (unphysical but good for stylising the plume).
    gasSpeedRatio:       0.1,

    // ─── Motion & smoke fade ───────────────────────────────────────────
    // How fast gas slows down (velocity) and fades from view (density).
    // Multiplies the base dissipation defined in FIRE_MODEL. Higher =
    // faster fade. Applied once on change — no longer phase-swapped.
    velocityDissMult: 1.0,
    densityDissMult:  1.0,
    splatRadiusMult:  1.0,

    // ─── Glow (only active when bloomEnabled) ──────────────────────────
    bloomMult:           0.6,   // halo brightness × caliber preset
    curlMult:            1.0,   // turbulence / eddy strength × caliber preset

    // Glow is silenced during the in-bore push so the visible flash reads
    // as muzzle exit, not initial bore push.
    // Delay = when glow is allowed to turn on, relative to the moment the
    //         bullet tail clears the muzzle. 0 = exactly at exit. Negative
    //         = earlier. Positive = later.
    // Ramp  = how slowly glow swells from 0 → full. 0 = instant pop.
    bloomOnsetOffsetMs:  0.2,
    bloomFadeInMs:       0.05,

    // ─── Trailing smoke (afterburner) ──────────────────────────────────
    // Slow smoke puffs emitted for `smokeDurationMs` after the bullet
    // clears the muzzle. The initial muzzle flash itself is produced by
    // the solver venting accumulated in-bore gas — there's no scripted
    // "exit blast".
    smokeDurationMs:     1.0,   // sim-ms the trail keeps puffing
    smokeRateHz:         13.0,  // puffs per simulated millisecond
    smokeForceMult:      0.45,  // how hard each puff is pushed forward
    smokeRadiusMult:     1.0,   // multiplier on the per-caliber puff size

    // ─── Bore seal (bullet border) ─────────────────────────────────────
    // Scales the invisible solid skirt around the bullet. Physics treats
    // the skirt as solid; the overlay draws only the real bullet.
    bulletBorderMult:    1.0,
};

// ─── Shared palette & fire-model constants ───────────────────────────────────
// All calibers share one palette; visible differences come from velocity +
// bore scaling into bloom / splat-radius / curl via deriveCaliberVisuals.
const FIRE_PALETTE = {
    COLOR:        { r: 2.0,  g: 0.7,  b: 0.08 },
    MUZZLE_COLOR: { r: 3.5,  g: 2.3,  b: 0.6  },
    HOT_FLASH:    { r: 5.0,  g: 4.0,  b: 1.9  },
    SMOKE_COLOR:  { r: 0.32, g: 0.30, b: 0.36 },
};

const FIRE_MODEL = {
    V_REF_FPS:            1800,
    BORE_REF_INCHES:      0.30,
    BLOOM_INTENSITY_BASE: 0.9,
    SPLAT_RADIUS_BASE:    0.00070,
    CURL_BASE:            20,
    PRESSURE:             0.82,
    PRESSURE_ITERATIONS:  25,
    VELOCITY_DISSIPATION: 0.9,
    DENSITY_DISSIPATION:  4.0,
    TARGET_IN_BORE_SPLATS: 6,
    // Puff size scales with the bullet's kinetic-energy proxy
    // (bore² × bullet_length × velocity² — a stand-in for ½mv², since bullet
    // mass tracks roughly with bore-area × length). Two anchor calibers fix
    // the line; every other caliber linearly interpolates / extrapolates.
    SMOKE_PUFF_REF_LOW:  { id: 'cal_9mm', PUFF_SIZE: 7  },
    SMOKE_PUFF_REF_HIGH: { id: 'cal_223', PUFF_SIZE: 20 },
};

function bulletEnergyProxy(preset) {
    const v = preset.MUZZLE_VELOCITY_FPS;
    const d = preset.BORE_DIAMETER_INCHES;
    const l = preset.BULLET_LENGTH_INCHES;
    return d * d * l * v * v;
}

function deriveCaliberVisuals(preset) {
    const k_v = preset.MUZZLE_VELOCITY_FPS / FIRE_MODEL.V_REF_FPS;
    const k_b = preset.BORE_DIAMETER_INCHES / FIRE_MODEL.BORE_REF_INCHES;

    const lowRef  = window.CALIBER_PRESETS[FIRE_MODEL.SMOKE_PUFF_REF_LOW.id];
    const highRef = window.CALIBER_PRESETS[FIRE_MODEL.SMOKE_PUFF_REF_HIGH.id];
    const E_low   = bulletEnergyProxy(lowRef);
    const E_high  = bulletEnergyProxy(highRef);
    const t       = (bulletEnergyProxy(preset) - E_low) / (E_high - E_low);
    const SMOKE_PUFF_SIZE =
        FIRE_MODEL.SMOKE_PUFF_REF_LOW.PUFF_SIZE
      + (FIRE_MODEL.SMOKE_PUFF_REF_HIGH.PUFF_SIZE
         - FIRE_MODEL.SMOKE_PUFF_REF_LOW.PUFF_SIZE) * t;

    return {
        BLOOM_INTENSITY: FIRE_MODEL.BLOOM_INTENSITY_BASE * Math.pow(k_v, 1.3),
        SPLAT_RADIUS:    FIRE_MODEL.SPLAT_RADIUS_BASE    * k_b,
        CURL:            FIRE_MODEL.CURL_BASE            * k_v,
        SMOKE_PUFF_SIZE,
    };
}

window.FIRE_PALETTE = FIRE_PALETTE;
window.FIRE_MODEL   = FIRE_MODEL;
window.deriveCaliberVisuals = deriveCaliberVisuals;

// ─── Caliber Presets ──────────────────────────────────────────────────────────
// Physical values only. Visible differences (bloom, curl, splat radius) are
// derived from MUZZLE_VELOCITY_FPS and BORE_DIAMETER_INCHES via
// deriveCaliberVisuals; all calibers share FIRE_PALETTE.
window.CALIBER_PRESETS = {

    cal_223: {
        id:    'cal_223',
        label: '.223 Rem',
        desc:  '55k PSI · 3,000 fps · .224" bore',
        MUZZLE_VELOCITY_FPS:    3000,
        BARREL_LENGTH_INCHES:   2,
        BULLET_LENGTH_INCHES:   0.91,        // M855 62gr FMJ
        BORE_DIAMETER_INCHES:   0.224,
        BARREL_OD_INCHES:       0.75,        // typical AR-15 medium contour
    },

    cal_308: {
        id:    'cal_308',
        label: '.308 Win',
        desc:  '62k PSI · 2,700 fps · .308" bore',
        MUZZLE_VELOCITY_FPS:    2700,
        BARREL_LENGTH_INCHES:   2,
        BULLET_LENGTH_INCHES:   1.22,        // 168gr Sierra MatchKing
        BORE_DIAMETER_INCHES:   0.308,
        BARREL_OD_INCHES:       0.85,        // typical AR-10 / bolt barrel
    },

    cal_300blk_super: {
        id:    'cal_300blk_super',
        label: '300 BLK ⚡',
        desc:  '55k PSI · 2,150 fps · supersonic',
        MUZZLE_VELOCITY_FPS:    2150,
        BARREL_LENGTH_INCHES:   2,
        BULLET_LENGTH_INCHES:   1.14,        // 125gr Sierra MatchKing
        BORE_DIAMETER_INCHES:   0.308,
        BARREL_OD_INCHES:       0.75,        // same platform as .223
    },

    cal_300blk_sub: {
        id:    'cal_300blk_sub',
        label: '300 BLK 🔇',
        desc:  '35k PSI · 1,050 fps · subsonic',
        MUZZLE_VELOCITY_FPS:    1050,
        BARREL_LENGTH_INCHES:   2,
        BULLET_LENGTH_INCHES:   1.43,        // 220gr Sierra MatchKing
        BORE_DIAMETER_INCHES:   0.308,
        BARREL_OD_INCHES:       0.75,        // same platform as .223
    },

    cal_9mm: {
        id:    'cal_9mm',
        label: '9mm',
        desc:  '35k PSI · 1,200 fps · .355" bore',
        MUZZLE_VELOCITY_FPS:    1200,
        BARREL_LENGTH_INCHES:   2,
        BULLET_LENGTH_INCHES:   0.66,        // 147gr — common heavy load
        BORE_DIAMETER_INCHES:   0.355,
        BARREL_OD_INCHES:       0.65,        // pistol / PCC barrel
    },
};

function lerpColor(a, b, t) {
    t = Math.max(0, Math.min(1, t));
    return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
    };
}

// ─── Fire Sequencer ───────────────────────────────────────────────────────────
// Timeline (simulated milliseconds):
//
//   t ∈ (0, muzzleExitMs)       — IN-BORE GAS PUSH. Splats emitted just behind
//                                 the bullet's tail at a target velocity of
//                                 gasSpeedRatio × bullet velocity. Pressure
//                                 accumulates behind the bullet; color ramps
//                                 COLOR → MUZZLE_COLOR → HOT_FLASH.
//   t ∈ (muzzleExit, SEQ_END)   — In-bore injection stops. Accumulated bore
//                                 gas vents through the unblocked muzzle under
//                                 the solver (this is what produces the visible
//                                 muzzle flash). SETTLING SMOKE is emitted for
//                                 longevity.
//   t > muzzleExit + smokeDur   — IDLE.

// The splat shader ADDS F to the velocity texture per frame; advection
// smoothing, the pressure solver, and the moving emission point bleed the
// dye's effective transport velocity well below F. This divisor compensates,
// and the "gasForceMult" debug knob multiplies on top of it.
const GAS_FORCE_SCALE = 80.0;

// Visual-only speedup applied to bullet kinematics. Gas force magnitudes are
// computed from the UNSCALED muzzle velocity so gas dynamics are unchanged.
const BULLET_VISUAL_SPEED_MULT = 1.0;

window.FireSequencer = class FireSequencer {

    constructor() {
        this.state        = 'IDLE';
        this.simMs        = 0;
        this.preset       = null;
        this.geom         = null;
        this.barrelEndX   = 0.38;
        this.bulletStartX = 0.02;
        this.boreY        = 0.5;
        this.barrelTravelMs     = 1.0;
        this.muzzleExitMs       = 1.0;
        this.muzzleVelUV_per_ms = 0.1;
        this.bulletLengthUV     = 0.02;
        this.smokeCooldownMs    = 0;
        // Bullet velocity in advection-shader units. Stored at fire() time;
        // update() derives per-frame force from it live using current
        // DEBUG_CONFIG multipliers, so sliders take effect within the shot.
        this.v_bullet_field = 0;
    }

    /**
     * Begin a fire sequence.
     *
     * @param {object} preset - CALIBER_PRESETS entry
     * @param {object} geom   - Scene.computeGeometry() snapshot. The painter
     *        and this sequencer read the same geometry so the drawn bullet
     *        and the physics bullet can't drift.
     */
    fire(preset, geom) {
        this.preset       = preset;
        this.geom         = geom;
        this.bulletStartX = geom.bulletStartX;
        this.barrelEndX   = geom.barrelEndX;
        this.bulletLengthUV = geom.bulletLengthUV;
        this.boreY        = 0.5;
        this.simMs        = 0;
        this.state        = 'FIRING';
        this.smokeCooldownMs = 0;

        // Constant-acceleration textbook model:
        //   T_center = 2 · barrel_length / muzzle_velocity   (sim-ms)
        //   v(T)     = 2 · barrel_length / T                 (muzzle velocity)
        //   T_exit   = T_center + (bullet_length / 2) / v(T)
        // T_exit is the moment the bullet TAIL clears the muzzle — when gas
        // can vent freely. In-bore emission stops here.
        const barrelFeet             = preset.BARREL_LENGTH_INCHES / 12;
        const physicalBarrelTravelMs = 2 * barrelFeet / preset.MUZZLE_VELOCITY_FPS * 1000;
        const physicalMuzzleVelUV    = 2 * geom.barrelLenUV / physicalBarrelTravelMs;

        // Bullet kinematics apply the visual speedup; gas force does not.
        this.barrelTravelMs     = physicalBarrelTravelMs / BULLET_VISUAL_SPEED_MULT;
        this.muzzleVelUV_per_ms = physicalMuzzleVelUV    * BULLET_VISUAL_SPEED_MULT;
        this.muzzleExitMs       = this.barrelTravelMs
            + (this.bulletLengthUV / 2) / this.muzzleVelUV_per_ms;

        // Per-sim-ms splat rate, chosen so every caliber gets a comparable
        // dye count during the in-bore push regardless of how short
        // muzzleExitMs ends up. Without this, fast calibers (short muzzle-exit
        // window) would emit 1–2 splats per shot while slow calibers emit 4+.
        this.inBoreSplatRatePerSimMs =
            FIRE_MODEL.TARGET_IN_BORE_SPLATS / this.muzzleExitMs;
        this.derived = deriveCaliberVisuals(preset);

        // Bullet velocity in the advection shader's units (texels per sim-ms,
        // rescaled to the shader's wall-clock seconds at baseline SIM_MS_PER_WALL_SEC=1.0).
        // Uses the UNSCALED muzzle velocity so BULLET_VISUAL_SPEED_MULT
        // doesn't scale gas force. The SIM_MS_PER_WALL_SEC factor is NOT applied
        // here — slow-motion is handled by scaling the solver's dt uniformly
        // (in fluid-core) so advection and decay slow together. Baking the
        // factor into the velocity would slow advection but leave decay at
        // full wall-rate, making the gas "die too fast" under slow-mo.
        this.v_bullet_field = physicalMuzzleVelUV * geom.simWidth;
    }

    get isActive() { return this.state !== 'IDLE'; }

    /**
     * Bullet position in UV space, or null if it's off-canvas / no shot.
     * In-barrel: quadratic accel (x/L = (t/T)²). Past muzzle: constant velocity.
     */
    getBullet() {
        if (this.state === 'IDLE') return null;

        const barrelLenUV = this.geom.barrelLenUV;
        const t = this.simMs;
        const T = this.barrelTravelMs;

        let xUV;
        if (t <= 0) {
            xUV = this.bulletStartX;
        } else if (t < T) {
            const u = t / T;
            xUV = this.bulletStartX + barrelLenUV * u * u;
        } else {
            xUV = this.barrelEndX + this.muzzleVelUV_per_ms * (t - T);
        }
        if (xUV > 1.25) return null;

        // Position only — length/halfH belong to the canonical geom so the
        // drawn and physics bullets can't disagree.
        return { xUV, yUV: this.boreY };
    }

    /**
     * Advance the sequencer by `dtWall` wall-clock seconds.
     * Returns an array of { x, y, dx, dy, color, radius, phase } splats.
     */
    update(dtWall) {
        if (this.state === 'IDLE') return [];
        const dtMs = dtWall * window.BALLISTIC_TIME.SIM_MS_PER_WALL_SEC;
        this.simMs += dtMs;
        const cfg = window.DEBUG_CONFIG;
        const splats = [];

        // Derive gas force LIVE so slider drags take effect within the shot.
        const gasSpeedRatio = Math.max(0.01, Math.min(10.0, cfg.gasSpeedRatio));
        const gasForceMult  = Math.max(0, cfg.gasForceMult);
        const inBoreForce   = this.v_bullet_field * gasSpeedRatio
                              * GAS_FORCE_SCALE * gasForceMult;

        // Sequence end: muzzle exit + chosen smoke window. If the user sets
        // smokeDurationMs to 0, the sequence ends cleanly at muzzle exit.
        const smokeDurationMs = Math.max(0, cfg.smokeDurationMs);
        const sequenceEndMs   = this.muzzleExitMs + smokeDurationMs;

        // ── Phase 1: IN-BORE GAS PUSH ────────────────────────────────────
        if (this.simMs > 0 && this.simMs < this.muzzleExitMs && cfg.inboreEnabled) {
            const velFrac = Math.min(1.0, this.simMs / this.barrelTravelMs);
            const bulletX = this._bulletCenterX();
            const tailX = bulletX - this.bulletLengthUV / 2;
            const gasX  = Math.max(this.bulletStartX, tailX - this.bulletLengthUV * 2.5);

            const perFrameForce = inBoreForce * velFrac;

            // Color ramps COLOR → MUZZLE_COLOR → HOT_FLASH with pressure.
            let color;
            if (velFrac < 0.5) color = lerpColor(FIRE_PALETTE.COLOR,        FIRE_PALETTE.MUZZLE_COLOR, velFrac * 2);
            else               color = lerpColor(FIRE_PALETTE.MUZZLE_COLOR, FIRE_PALETTE.HOT_FLASH,   (velFrac - 0.5) * 2);

            const radius = this.derived.SPLAT_RADIUS * cfg.splatRadiusMult
                           * (1.0 + velFrac * 0.5);

            // Emit a frame-rate-compensated number of splats so fast calibers
            // (tiny muzzleExitMs) get the same total dye count as slow ones.
            const nSplats = Math.max(1, Math.round(this.inBoreSplatRatePerSimMs * dtMs));
            for (let i = 0; i < nSplats; i++) {
                splats.push({
                    x: gasX,
                    y: this.boreY,
                    dx: perFrameForce,
                    dy: 0,
                    color,
                    radius,
                    phase: 'inbore',
                });
            }
        }

        // ── Phase 2: SETTLING SMOKE ──────────────────────────────────────
        if (cfg.smokeEnabled
            && this.simMs > this.muzzleExitMs
            && smokeDurationMs > 0
            && this.simMs < sequenceEndMs) {
            this.smokeCooldownMs -= dtMs;
            if (this.smokeCooldownMs <= 0) {
                const rateHz = Math.max(0.1, cfg.smokeRateHz);
                this.smokeCooldownMs = 1.0 / rateHz;
                const t = (this.simMs - this.muzzleExitMs) / smokeDurationMs;
                const smokeCol  = lerpColor(FIRE_PALETTE.COLOR, FIRE_PALETTE.SMOKE_COLOR, Math.min(1, t * 1.8));
                const smokeBase = inBoreForce * 0.05 * Math.max(0, cfg.smokeForceMult);
                const smokeRadius = this.derived.SPLAT_RADIUS * cfg.splatRadiusMult
                                    * this.derived.SMOKE_PUFF_SIZE
                                    * Math.max(0.1, cfg.smokeRadiusMult);
                splats.push({
                    x: this.barrelEndX + 0.01 + Math.random() * 0.03,
                    y: this.boreY,
                    dx: smokeBase * (1.2 + Math.random() * 1.0),
                    dy: smokeBase * (Math.random() - 0.5) * 0.6,
                    color: smokeCol,
                    radius: smokeRadius,
                    phase: 'smoke',
                });
            }
        }

        // Hold FIRING until the bullet has also left the canvas — otherwise
        // a short smokeDurationMs (or a slow-bullet caliber) would make the
        // bullet vanish mid-flight.
        if (this.simMs > sequenceEndMs && this._bulletCenterX() > 1.25) {
            this.state = 'IDLE';
        }
        return splats;
    }

    // Mirrors the position math in getBullet() so in-bore emission sits
    // exactly behind the drawn bullet.
    _bulletCenterX() {
        const t = this.simMs;
        const T = this.barrelTravelMs;
        if (t <= 0) return this.bulletStartX;
        if (t < T) {
            const u = t / T;
            return this.bulletStartX + this.geom.barrelLenUV * u * u;
        }
        return this.barrelEndX + this.muzzleVelUV_per_ms * (t - T);
    }
};
