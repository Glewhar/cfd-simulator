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
window.DEBUG_CONFIG = {
    // Phase gates
    inboreEnabled:       true,
    smokeEnabled:        true,
    splatLosGuard:       true,
    bloomLosGuard:       true,

    // Plume / dissipation (the "explosion reach" knobs)
    gasForceMult:        5.0,   // scales gas injection force (primary "stronger gas" knob)
    gasSpeedRatio:       0.1,   // target gas velocity as fraction of bullet velocity
    // Dissipation is phase-swapped live: the in-bore multiplier while the
    // bullet is still in the barrel, the bloom multiplier for the
    // post-muzzle-exit vent + settling smoke + IDLE.
    velocityDissInboreMult: 0.5,
    velocityDissBloomMult:  0.5,
    densityDissInboreMult:  0.25,
    densityDissBloomMult:   0.9,
    bloomMult:           0.2,   // × preset BLOOM_INTENSITY
    curlMult:            1.0,   // × preset CURL (vorticity / eddies)

    // Bloom is silenced during the in-bore push so the user-visible flash
    // belongs to muzzle exit, not the initial bore push. Between shots
    // (IDLE) bloom is held at full so settling smoke still glows.
    bloomOnsetOffsetMs:  0.0,   // sim-ms relative to muzzle exit
    bloomFadeInMs:       0.25,  // linear ramp 0 → full over this window

    // Settling smoke (afterburner) — emitted for `smokeDurationMs` after the
    // bullet clears the muzzle. The muzzle flash is produced by the fluid
    // solver venting accumulated in-bore gas; there's no scripted "exit blast".
    smokeDurationMs:     1.0,
    smokeRateHz:         8.3,
    smokeForceMult:      5.0,
    smokeRadiusMult:     8.0,

    // Invisible solid skirt painted around the bullet to seal the bore
    // against gas squeezing past. Physics treats it as solid; the overlay
    // draws only the real bullet.
    bulletBorderMult:    1.0,
};

// ─── Caliber Presets ──────────────────────────────────────────────────────────
// Real ballistic values (FPS, barrel length, bullet length) drive bullet
// kinematics AND gas-injection force. Caliber differences in plume strength
// fall out of the velocity difference automatically.
window.CALIBER_PRESETS = {

    cal_223: {
        id:    'cal_223',
        label: '.223 Rem',
        desc:  '55k PSI · 3,000 fps · .224" bore',
        MUZZLE_VELOCITY_FPS:    3000,
        BARREL_LENGTH_INCHES:   16,
        BULLET_LENGTH_INCHES:   0.91,        // M855 62gr FMJ
        VELOCITY_DISSIPATION: 0.72,
        DENSITY_DISSIPATION:  3.9,
        PRESSURE_ITERATIONS:  32,
        CURL:                 35,
        PRESSURE:             0.85,
        BLOOM_INTENSITY:      1.3,
        SPLAT_RADIUS:         0.00055,
        BARREL_LENGTH_RATIO:  0.38,
        BORE_HALF_H_RATIO:    0.036,
        COLOR:        { r: 2.2, g: 0.8, b: 0.08 },
        MUZZLE_COLOR: { r: 4.0, g: 2.5, b: 0.8 },
        HOT_FLASH:    { r: 5.5, g: 4.5, b: 2.2 },
        SMOKE_COLOR:  { r: 0.35, g: 0.35, b: 0.40 },
    },

    cal_308: {
        id:    'cal_308',
        label: '.308 Win',
        desc:  '62k PSI · 2,700 fps · .308" bore',
        MUZZLE_VELOCITY_FPS:    2700,
        BARREL_LENGTH_INCHES:   24,
        BULLET_LENGTH_INCHES:   1.22,        // 168gr Sierra MatchKing
        VELOCITY_DISSIPATION: 0.65,
        DENSITY_DISSIPATION:  3.5,
        PRESSURE_ITERATIONS:  35,
        CURL:                 28,
        PRESSURE:             0.9,
        BLOOM_INTENSITY:      1.5,
        SPLAT_RADIUS:         0.00080,
        BARREL_LENGTH_RATIO:  0.42,
        BORE_HALF_H_RATIO:    0.049,
        COLOR:        { r: 1.8, g: 0.55, b: 0.05 },
        MUZZLE_COLOR: { r: 3.5, g: 2.0, b: 0.4 },
        HOT_FLASH:    { r: 5.0, g: 4.0, b: 1.8 },
        SMOKE_COLOR:  { r: 0.30, g: 0.30, b: 0.36 },
    },

    cal_300blk_super: {
        id:    'cal_300blk_super',
        label: '300 BLK ⚡',
        desc:  '55k PSI · 2,150 fps · supersonic',
        MUZZLE_VELOCITY_FPS:    2150,
        BARREL_LENGTH_INCHES:   9,
        BULLET_LENGTH_INCHES:   1.14,        // 125gr Sierra MatchKing
        VELOCITY_DISSIPATION: 0.85,
        DENSITY_DISSIPATION:  4.2,
        PRESSURE_ITERATIONS:  28,
        CURL:                 30,
        PRESSURE:             0.82,
        BLOOM_INTENSITY:      1.1,
        SPLAT_RADIUS:         0.00080,
        BARREL_LENGTH_RATIO:  0.32,
        BORE_HALF_H_RATIO:    0.049,
        COLOR:        { r: 1.6, g: 0.5, b: 0.06 },
        MUZZLE_COLOR: { r: 3.0, g: 1.8, b: 0.3 },
        HOT_FLASH:    { r: 4.5, g: 3.5, b: 1.5 },
        SMOKE_COLOR:  { r: 0.32, g: 0.30, b: 0.34 },
    },

    cal_300blk_sub: {
        id:    'cal_300blk_sub',
        label: '300 BLK 🔇',
        desc:  '35k PSI · 1,050 fps · subsonic',
        MUZZLE_VELOCITY_FPS:    1050,
        BARREL_LENGTH_INCHES:   9,
        BULLET_LENGTH_INCHES:   1.43,        // 220gr Sierra MatchKing
        VELOCITY_DISSIPATION: 1.30,
        DENSITY_DISSIPATION:  6.0,
        PRESSURE_ITERATIONS:  20,
        CURL:                 15,
        PRESSURE:             0.7,
        BLOOM_INTENSITY:      0.5,
        SPLAT_RADIUS:         0.00080,
        BARREL_LENGTH_RATIO:  0.32,
        BORE_HALF_H_RATIO:    0.049,
        COLOR:        { r: 0.7, g: 0.22, b: 0.03 },
        MUZZLE_COLOR: { r: 1.0, g: 0.4, b: 0.1 },
        HOT_FLASH:    { r: 1.4, g: 0.7, b: 0.15 },
        SMOKE_COLOR:  { r: 0.28, g: 0.28, b: 0.32 },
    },

    cal_9mm: {
        id:    'cal_9mm',
        label: '9mm',
        desc:  '35k PSI · 1,200 fps · .355" bore',
        MUZZLE_VELOCITY_FPS:    1200,
        BARREL_LENGTH_INCHES:   5,
        BULLET_LENGTH_INCHES:   0.66,        // 147gr — common heavy load
        VELOCITY_DISSIPATION: 1.05,
        DENSITY_DISSIPATION:  4.9,
        PRESSURE_ITERATIONS:  20,
        CURL:                 12,
        PRESSURE:             0.72,
        BLOOM_INTENSITY:      0.75,
        SPLAT_RADIUS:         0.00072,
        BARREL_LENGTH_RATIO:  0.22,
        BORE_HALF_H_RATIO:    0.058,
        COLOR:        { r: 1.5, g: 1.0, b: 0.15 },
        MUZZLE_COLOR: { r: 3.0, g: 2.5, b: 0.5 },
        HOT_FLASH:    { r: 4.5, g: 3.8, b: 1.7 },
        SMOKE_COLOR:  { r: 0.34, g: 0.32, b: 0.34 },
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
const BULLET_VISUAL_SPEED_MULT = 4.0;

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

        // Bullet velocity in the advection shader's units:
        //   v_bullet_field = muzzleVelUV_per_ms · SIM_MS_PER_WALL_SEC · simWidth
        // Uses the UNSCALED muzzle velocity so BULLET_VISUAL_SPEED_MULT
        // doesn't scale gas force.
        const timeStretch = window.BALLISTIC_TIME.SIM_MS_PER_WALL_SEC;
        this.v_bullet_field = physicalMuzzleVelUV * timeStretch * geom.simWidth;
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
        const p   = this.preset;
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
            if (velFrac < 0.5) color = lerpColor(p.COLOR,        p.MUZZLE_COLOR, velFrac * 2);
            else               color = lerpColor(p.MUZZLE_COLOR, p.HOT_FLASH,   (velFrac - 0.5) * 2);

            splats.push({
                x: gasX,
                y: this.boreY,
                dx: perFrameForce,
                dy: 0,
                color,
                radius: p.SPLAT_RADIUS * (1.0 + velFrac * 0.5),
                phase: 'inbore',
            });
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
                const smokeCol  = lerpColor(p.COLOR, p.SMOKE_COLOR, Math.min(1, t * 1.8));
                const smokeBase = inBoreForce * 0.05 * Math.max(0, cfg.smokeForceMult);
                splats.push({
                    x: this.barrelEndX + 0.01 + Math.random() * 0.03,
                    y: this.boreY,
                    dx: smokeBase * (1.2 + Math.random() * 1.0),
                    dy: smokeBase * (Math.random() - 0.5) * 0.6,
                    color: smokeCol,
                    radius: p.SPLAT_RADIUS * Math.max(0.1, cfg.smokeRadiusMult),
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
