'use strict';

(function () {

// ─── Muzzle-device samples ───────────────────────────────────────────────────
// Pre-voxelized shapes the user can drop in front of the muzzle. The STLs
// ship in the repo root; each entry knows the projection axis/mode the voxel
// slice should use for that particular model.
const MUZZLE_DEVICES = {
    none: {
        id:    'none',
        label: 'Bare muzzle',
    },
    suppressor: {
        id:             'suppressor',
        label:          'Suppressor',
        url:            'supressor_sample.stl',
        projectionAxis: 'y',         // top-down (XZ plane)
        projectionMode: 'section',   // axial cross-section: walls + baffles + bore
    },
    muzzle_brake: {
        id:             'muzzle_brake',
        label:          'Muzzle brake',
        url:            'muzzle-break-sample.stl',
        projectionAxis: 'y',
        projectionMode: 'section',
    },
};

// ─── Playback / sim state ────────────────────────────────────────────────────
let selectedCaliberId = 'cal_223';
let selectedDeviceId  = 'none';
let deviceMask        = null;  // { data: Uint8Array, width, height } or null
let deviceOffset      = { x: 0, y: 0 };  // drag offset in sim-space pixels
let sceneGeometry     = null;  // Scene.computeGeometry() snapshot
let fireSequencer     = new FireSequencer();

// Mesh source: either a built-in sample URL or an uploaded File. Kept so that
// an axis/mode/flip/rotate change can re-voxelize the SAME source in place
// without losing the user's custom upload.
// deviceSource = { kind:'sample', id, url, label } | { kind:'file', file, label } | null
let deviceSource = null;

// Projection + orientation controls (live, re-voxelize on change)
let deviceAxis  = 'y';                              // 'x' | 'y' | 'z'
let deviceMode  = 'section';                        // 'section' | 'silhouette'
let deviceXform = { flipX: false, flipY: false, rotate: 0 };  // rotate ∈ {0,90,180,270}

// Playback state machine
let playbackState = 'idle';  // 'idle' | 'playing' | 'paused'
let autoRepeatTimer = 0;     // seconds remaining before next auto-fire
const AUTO_REPEAT_DELAY_SEC = 3.0;  // gap between auto-looped shots

// Replay frame ring buffer (for scrub-playback while paused)
const REPLAY_FPS         = 30;
const REPLAY_MAX_FRAMES  = 360;   // ≈12 wall-seconds, > one fire sequence
const REPLAY_W           = 640;
const REPLAY_H           = 360;
let replayFrames    = [];
let replayCount     = 0;
let replayWriteIdx  = 0;
let lastFrameGrabMs = 0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const canvas         = document.getElementById('sim-canvas');
const overlay        = document.getElementById('playback-overlay');
const calButtons     = document.querySelectorAll('.cal-btn');
const calDesc        = document.getElementById('cal-desc');
const deviceButtons  = document.querySelectorAll('.device-btn');
const deviceStatus   = document.getElementById('device-status');
const devicePreview  = document.getElementById('device-preview');
const deviceFileInput= document.getElementById('device-file');
const deviceUploadBtn= document.getElementById('device-upload-btn');
const axisButtons    = document.querySelectorAll('.opt-btn[data-axis]');
const modeButtons    = document.querySelectorAll('.opt-btn[data-mode]');
const xformFlipXBtn  = document.getElementById('xform-flipx');
const xformFlipYBtn  = document.getElementById('xform-flipy');
const xformRotateBtn = document.getElementById('xform-rotate');
const fireBtn        = document.getElementById('fire-btn');
const statusText     = document.getElementById('status-text');
const playbackPanel  = document.getElementById('playback-panel');
const playbackSlider = document.getElementById('playback-slider');
const playbackTime   = document.getElementById('playback-time');

// Debug panel
const debugOverlay  = document.getElementById('debug-overlay');
const debugCheckbox = document.getElementById('debug-checkbox');
const debugOptions  = document.getElementById('debug-options');
const debugInboreCb    = document.getElementById('debug-inbore-enabled');
const debugSmokeCb     = document.getElementById('debug-smoke-enabled');
const debugSplatLosCb  = document.getElementById('debug-splat-los');
const debugBloomLosCb  = document.getElementById('debug-bloom-los');
const debugGasForceRange  = document.getElementById('debug-gas-force');
const debugGasForceVal    = document.getElementById('debug-gas-force-val');
const debugGasRatioRange  = document.getElementById('debug-gas-ratio');
const debugGasRatioVal    = document.getElementById('debug-gas-ratio-val');
const debugVelDissInboreRange = document.getElementById('debug-vel-diss-inbore');
const debugVelDissInboreVal   = document.getElementById('debug-vel-diss-inbore-val');
const debugVelDissBloomRange  = document.getElementById('debug-vel-diss-bloom');
const debugVelDissBloomVal    = document.getElementById('debug-vel-diss-bloom-val');
const debugDenDissInboreRange = document.getElementById('debug-den-diss-inbore');
const debugDenDissInboreVal   = document.getElementById('debug-den-diss-inbore-val');
const debugDenDissBloomRange  = document.getElementById('debug-den-diss-bloom');
const debugDenDissBloomVal    = document.getElementById('debug-den-diss-bloom-val');
const debugBloomRange      = document.getElementById('debug-bloom');
const debugBloomVal        = document.getElementById('debug-bloom-val');
const debugBloomOnsetRange = document.getElementById('debug-bloom-onset');
const debugBloomOnsetVal   = document.getElementById('debug-bloom-onset-val');
const debugBloomFadeRange  = document.getElementById('debug-bloom-fade');
const debugBloomFadeVal    = document.getElementById('debug-bloom-fade-val');
const debugCurlRange       = document.getElementById('debug-curl');
const debugCurlVal         = document.getElementById('debug-curl-val');
const debugSmokeDurationRange = document.getElementById('debug-smoke-duration');
const debugSmokeDurationVal   = document.getElementById('debug-smoke-duration-val');
const debugSmokeRateRange     = document.getElementById('debug-smoke-rate');
const debugSmokeRateVal       = document.getElementById('debug-smoke-rate-val');
const debugSmokeForceRange    = document.getElementById('debug-smoke-force');
const debugSmokeForceVal      = document.getElementById('debug-smoke-force-val');
const debugSmokeRadiusRange   = document.getElementById('debug-smoke-radius');
const debugSmokeRadiusVal     = document.getElementById('debug-smoke-radius-val');
const debugBulletBorderRange  = document.getElementById('debug-bullet-border');
const debugBulletBorderVal    = document.getElementById('debug-bullet-border-val');

// Debug markers: each emitted splat is logged with its phase and drawn as a
// fading crosshair so a user can see where each phase emits its gas.
let debugMode = false;
const debugMarkers = [];
const DEBUG_MARKER_LIFE_MS = 450;
const DEBUG_PHASE_STYLE = {
    inbore: { color: '#22d3ee', label: 'MUZZLE FLASH' },
    smoke:  { color: '#facc15', label: 'SMOKE'   },
};

// ─── Collapsible panels / debug groups ───────────────────────────────────────
document.querySelectorAll('[data-toggle="collapse"]').forEach(el => {
    el.addEventListener('click', () => {
        const parent = el.closest('#caliber-panel, #device-panel, .debug-group');
        if (parent) parent.classList.toggle('collapsed');
    });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
FluidSim.init(canvas);

for (let i = 0; i < REPLAY_MAX_FRAMES; i++) {
    const c = document.createElement('canvas');
    c.width = REPLAY_W;
    c.height = REPLAY_H;
    replayFrames.push(c);
}

let lastRebuildHadBullet = false;

FluidSim.setBeforeStepCallback(function (dt) {
    // PAUSE freezes solver + sequencer + capture in lock-step.
    if (playbackState !== 'playing') return;

    const splats = fireSequencer.update(dt);
    const nowMs = performance.now();

    // Phase-swap dissipation live — in-bore vs bloom multipliers take effect
    // the instant the bullet's tail clears the muzzle.
    applyPhaseDissipation();

    // Gate bloom along sim-time so the glow doesn't show during the in-bore
    // push. During FIRING: 0 until simMs ≥ muzzleExitMs + bloomOnsetOffsetMs,
    // then ramps linearly over bloomFadeInMs. Between shots (IDLE): full.
    {
        const preset = CALIBER_PRESETS[selectedCaliberId];
        const cfg = window.DEBUG_CONFIG;
        let gate = 1.0;
        if (fireSequencer.isActive) {
            const tOn = fireSequencer.muzzleExitMs + cfg.bloomOnsetOffsetMs;
            const dT = fireSequencer.simMs - tOn;
            if (dT < 0) gate = 0;
            else if (cfg.bloomFadeInMs > 0) gate = Math.min(1, dT / cfg.bloomFadeInMs);
        }
        FluidSim.setConfig('BLOOM_INTENSITY', preset.BLOOM_INTENSITY * cfg.bloomMult * gate);
    }

    for (const s of splats) {
        FluidSim.splat(s.x, s.y, s.dx, s.dy, s.color, s.radius);
        if (debugMode && s.phase) {
            debugMarkers.push({ x: s.x, y: s.y, phase: s.phase, tEmitted: nowMs });
        }
    }

    // Bullet is an obstacle — repaint the scene every frame it's visible, and
    // once more when it leaves so the phantom bullet clears out.
    const bullet = fireSequencer.isActive ? fireSequencer.getBullet() : null;
    if (bullet) {
        rebuildObstacles(bullet);
        lastRebuildHadBullet = true;
    } else if (lastRebuildHadBullet) {
        rebuildObstacles(null);
        lastRebuildHadBullet = false;
    }

    // Auto-loop only while actively playing.
    if (!fireSequencer.isActive && playbackState === 'playing') {
        autoRepeatTimer -= dt;
        if (autoRepeatTimer <= 0) fireShot();
    }
});

selectCaliber(selectedCaliberId);

// ─── Caliber selection ───────────────────────────────────────────────────────
calButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        selectedCaliberId = btn.dataset.cal;
        calButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectCaliber(selectedCaliberId);
    });
});

// ─── Muzzle-device selection (sample STLs) ───────────────────────────────────
deviceButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const id = btn.dataset.device;
        deviceButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectSampleDevice(id);
    });
});

function selectSampleDevice(id) {
    selectedDeviceId = id;
    deviceOffset = { x: 0, y: 0 };
    const device = MUZZLE_DEVICES[id];
    if (!device) return;

    if (id === 'none') {
        deviceSource = null;
        deviceMask = null;
        deviceStatus.textContent = 'Bare muzzle';
        devicePreview.style.display = 'none';
        canvas.classList.remove('device-loaded');
        rebuildObstacles();
        setStatus('Bare muzzle · ready to fire');
        return;
    }

    // Adopt the sample's preferred projection so it loads correctly on first
    // click. User can still tweak axis/mode after via the option buttons.
    deviceAxis = device.projectionAxis;
    deviceMode = device.projectionMode;
    syncOptionButtons();

    deviceSource = { kind: 'sample', id: device.id, url: device.url, label: device.label };
    reloadDeviceSource();
}

// ─── Custom mesh upload (CORS-safe: FileReader, no fetch) ───────────────────
deviceUploadBtn.addEventListener('click', () => deviceFileInput.click());

deviceFileInput.addEventListener('change', () => {
    const file = deviceFileInput.files && deviceFileInput.files[0];
    if (!file) return;
    // Deselect sample buttons — this is a custom upload now.
    deviceButtons.forEach(b => b.classList.remove('active'));
    selectedDeviceId = 'custom';
    deviceOffset = { x: 0, y: 0 };
    deviceSource = { kind: 'file', file, label: file.name };
    reloadDeviceSource();
});

// Re-voxelize the currently selected source with the current axis/mode/orient.
// Called on first selection AND whenever the user toggles an option button.
function reloadDeviceSource() {
    if (!deviceSource) return;
    const label = deviceSource.label;
    deviceStatus.textContent = 'Loading ' + label + '…';
    setStatus('Voxelizing ' + label + '…');

    const opts = {
        mode:   deviceMode,
        flipX:  deviceXform.flipX,
        flipY:  deviceXform.flipY,
        rotate: deviceXform.rotate,
    };

    const p = (deviceSource.kind === 'sample')
        ? Voxelizer.voxelizeFromUrl (deviceSource.url,  deviceAxis, 256, opts)
        : Voxelizer.voxelizeFromFile(deviceSource.file, deviceAxis, 256, opts);

    p.then(result => {
        deviceMask = result;
        renderDevicePreview();
        canvas.classList.add('device-loaded');
        rebuildObstacles();
        const pct = (100 * result.solidPixels / result.totalPixels).toFixed(1);
        deviceStatus.textContent = label + ' · ' + pct + '% solid';
        setStatus(label + ' loaded · ' + result.triangleCount + ' tris · ready to fire');
    }).catch(err => {
        deviceMask = null;
        deviceStatus.textContent = 'Failed: ' + label;
        setStatus('Error loading ' + label + ': ' + err.message);
        console.error(err);
    });
}

// ─── Projection-option controls (axis / mode / flip / rotate) ───────────────
axisButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        deviceAxis = btn.dataset.axis;
        syncOptionButtons();
        reloadDeviceSource();
    });
});

modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        deviceMode = btn.dataset.mode;
        syncOptionButtons();
        reloadDeviceSource();
    });
});

xformFlipXBtn.addEventListener('click', () => {
    deviceXform.flipX = !deviceXform.flipX;
    syncOptionButtons();
    reloadDeviceSource();
});

xformFlipYBtn.addEventListener('click', () => {
    deviceXform.flipY = !deviceXform.flipY;
    syncOptionButtons();
    reloadDeviceSource();
});

xformRotateBtn.addEventListener('click', () => {
    deviceXform.rotate = (deviceXform.rotate + 90) % 360;
    syncOptionButtons();
    reloadDeviceSource();
});

function syncOptionButtons() {
    axisButtons.forEach(b =>
        b.classList.toggle('active', b.dataset.axis === deviceAxis));
    modeButtons.forEach(b =>
        b.classList.toggle('active', b.dataset.mode === deviceMode));
    xformFlipXBtn.classList.toggle('active', deviceXform.flipX);
    xformFlipYBtn.classList.toggle('active', deviceXform.flipY);
    xformRotateBtn.classList.toggle('active', deviceXform.rotate !== 0);
    xformRotateBtn.textContent = 'Rotate ' + deviceXform.rotate + '°';
}

// ─── FIRE / PAUSE / PLAY button ──────────────────────────────────────────────
fireBtn.addEventListener('click', onFireButtonClick);
playbackSlider.addEventListener('input', renderScrubFrame);

// ─── Debug controls ──────────────────────────────────────────────────────────
debugCheckbox.addEventListener('change', () => {
    debugMode = debugCheckbox.checked;
    debugMarkers.length = 0;
    debugOptions.classList.toggle('visible', debugMode);
    if (debugMode) {
        sizeDebugOverlayToCanvas();
        debugOverlay.style.display = 'block';
    } else {
        debugOverlay.style.display = 'none';
        const ctx = debugOverlay.getContext('2d');
        ctx.clearRect(0, 0, debugOverlay.width, debugOverlay.height);
    }
});

// Wire a slider to a DEBUG_CONFIG key. `after` runs post-write (e.g. live
// solver-config push).
function bindSlider(range, valOut, cfgKey, parse, format, after) {
    range.addEventListener('input', () => {
        const v = parse(range.value);
        window.DEBUG_CONFIG[cfgKey] = v;
        valOut.textContent = format(v);
        if (after) after(v);
    });
}

const asFloat  = s => parseFloat(s);
const fmtMult  = v => v.toFixed(2) + '×';
const fmt1Mult = v => v.toFixed(1) + '×';
const fmtVal   = v => v.toFixed(2);

// Push caliber preset × debug multipliers into the solver. Called on caliber
// change and on any multiplier slider targeting solver config. Slider
// default 1.0× = preset unchanged.
function pushSolverMultipliers() {
    const preset = CALIBER_PRESETS[selectedCaliberId];
    const cfg = window.DEBUG_CONFIG;
    FluidSim.setConfig('BLOOM_INTENSITY',      preset.BLOOM_INTENSITY * cfg.bloomMult);
    FluidSim.setConfig('CURL',                 preset.CURL            * cfg.curlMult);
    FluidSim.setConfig('PRESSURE',             preset.PRESSURE);
    FluidSim.setConfig('PRESSURE_ITERATIONS',  preset.PRESSURE_ITERATIONS);
    applyPhaseDissipation();
}

// Phase-swap dissipation: in-bore multiplier while bullet is still in the
// barrel, bloom multiplier during the post-muzzle-exit vent + settling smoke
// + IDLE (so residual smoke between shots decays under the same knob that
// shaped it).
function applyPhaseDissipation() {
    const preset = CALIBER_PRESETS[selectedCaliberId];
    const cfg = window.DEBUG_CONFIG;
    const inInbore = fireSequencer.isActive && fireSequencer.simMs < fireSequencer.muzzleExitMs;
    const velMult = inInbore ? cfg.velocityDissInboreMult : cfg.velocityDissBloomMult;
    const denMult = inInbore ? cfg.densityDissInboreMult  : cfg.densityDissBloomMult;
    FluidSim.setConfig('VELOCITY_DISSIPATION', preset.VELOCITY_DISSIPATION * velMult);
    FluidSim.setConfig('DENSITY_DISSIPATION',  preset.DENSITY_DISSIPATION  * denMult);
}

// Phase toggles
debugInboreCb.addEventListener('change',   () => { window.DEBUG_CONFIG.inboreEnabled = debugInboreCb.checked; });
debugSmokeCb.addEventListener('change',    () => { window.DEBUG_CONFIG.smokeEnabled  = debugSmokeCb.checked; });
debugSplatLosCb.addEventListener('change', () => {
    window.DEBUG_CONFIG.splatLosGuard = debugSplatLosCb.checked;
    FluidSim.setSplatLosGuard(debugSplatLosCb.checked);
});
debugBloomLosCb.addEventListener('change', () => {
    window.DEBUG_CONFIG.bloomLosGuard = debugBloomLosCb.checked;
    FluidSim.setBloomLosGuard(debugBloomLosCb.checked);
});

// Plume / dissipation
bindSlider(debugGasForceRange, debugGasForceVal, 'gasForceMult',    asFloat, fmtMult);
bindSlider(debugGasRatioRange, debugGasRatioVal, 'gasSpeedRatio',   asFloat, fmtVal);
bindSlider(debugVelDissInboreRange, debugVelDissInboreVal, 'velocityDissInboreMult', asFloat, fmtMult, applyPhaseDissipation);
bindSlider(debugVelDissBloomRange,  debugVelDissBloomVal,  'velocityDissBloomMult',  asFloat, fmtMult, applyPhaseDissipation);
bindSlider(debugDenDissInboreRange, debugDenDissInboreVal, 'densityDissInboreMult', asFloat, fmtMult, applyPhaseDissipation);
bindSlider(debugDenDissBloomRange,  debugDenDissBloomVal,  'densityDissBloomMult',  asFloat, fmtMult, applyPhaseDissipation);
bindSlider(debugBloomRange,    debugBloomVal,    'bloomMult',       asFloat, fmtMult, pushSolverMultipliers);
bindSlider(debugCurlRange,     debugCurlVal,     'curlMult',        asFloat, fmtMult, pushSolverMultipliers);
bindSlider(debugBloomOnsetRange, debugBloomOnsetVal, 'bloomOnsetOffsetMs', asFloat, v => (v >= 0 ? '+' : '') + v.toFixed(2) + ' ms');
bindSlider(debugBloomFadeRange,  debugBloomFadeVal,  'bloomFadeInMs',      asFloat, v => v.toFixed(2) + ' ms');

// Smoke
bindSlider(debugSmokeDurationRange, debugSmokeDurationVal, 'smokeDurationMs', asFloat, v => v.toFixed(1) + ' ms');
bindSlider(debugSmokeRateRange,     debugSmokeRateVal,     'smokeRateHz',     asFloat, v => v.toFixed(1) + ' Hz');
bindSlider(debugSmokeForceRange,    debugSmokeForceVal,    'smokeForceMult',  asFloat, fmtMult);
bindSlider(debugSmokeRadiusRange,   debugSmokeRadiusVal,   'smokeRadiusMult', asFloat, fmt1Mult);

// Bullet invisible skirt
bindSlider(
    debugBulletBorderRange, debugBulletBorderVal, 'bulletBorderMult',
    asFloat, fmtMult,
    () => rebuildObstacles(),
);

// ─── Drag-to-move muzzle device ──────────────────────────────────────────────
let deviceDrag = null;

canvas.addEventListener('mousedown', e => {
    if (!deviceMask) return;
    e.preventDefault();
    deviceDrag = {
        startPx: e.clientX,
        startPy: e.clientY,
        startOffsetX: deviceOffset.x,
        startOffsetY: deviceOffset.y,
    };
    canvas.classList.add('device-dragging');
});

window.addEventListener('mousemove', e => {
    if (!deviceDrag) return;
    const rect = canvas.getBoundingClientRect();
    const sim = FluidSim.getSimSize();
    const scaleX = sim.width  / rect.width;
    const scaleY = sim.height / rect.height;
    const dx = (e.clientX - deviceDrag.startPx) * scaleX;
    const dy = (e.clientY - deviceDrag.startPy) * scaleY;
    deviceOffset.x = deviceDrag.startOffsetX + dx;
    // Screen Y grows downward but sim j=0 is at the bottom → invert.
    deviceOffset.y = deviceDrag.startOffsetY - dy;
    rebuildObstacles();
});

window.addEventListener('mouseup', () => {
    if (!deviceDrag) return;
    deviceDrag = null;
    canvas.classList.remove('device-dragging');
});

window.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        onFireButtonClick();
    }
});

// ─── Playback state machine ──────────────────────────────────────────────────
function onFireButtonClick() {
    switch (playbackState) {
        case 'idle':    enterPlaying(true);  break;
        case 'playing': enterPaused();       break;
        case 'paused':  enterPlaying(false); break;
    }
}

function enterPlaying(isFresh) {
    playbackState = 'playing';
    fireBtn.textContent = 'PAUSE';
    fireBtn.classList.remove('state-play');
    fireBtn.classList.add('state-pause');
    overlay.style.display = 'none';
    playbackPanel.classList.remove('visible');
    statusText.classList.add('firing');

    // Unfreeze the solver so the live sim resumes from the exact state it
    // was paused in. The replay ring keeps growing where it left off.
    FluidSim.setConfig('PAUSED', false);

    if (isFresh) {
        autoRepeatTimer = 0;
        fireShot();
    }
}

function enterPaused() {
    playbackState = 'paused';
    fireBtn.textContent = 'PLAY';
    fireBtn.classList.remove('state-pause');
    fireBtn.classList.add('state-play');
    statusText.classList.remove('firing');
    setStatus('Paused · drag slider to scrub');

    // Freeze the solver. The sequencer freezes via the before-step gate;
    // the capture loop freezes via its own gate. The replay ring buffer
    // becomes a static, finite timeline to scrub.
    FluidSim.setConfig('PAUSED', true);

    if (replayCount === 0) grabReplayFrame(true);

    sizeOverlayToCanvas();
    overlay.style.display = 'block';

    // Slider range matches captured frames exactly.
    playbackPanel.classList.add('visible');
    playbackSlider.max   = Math.max(0, replayCount - 1);
    playbackSlider.value = playbackSlider.max;
    renderScrubFrame();
}

function fireShot() {
    const preset = CALIBER_PRESETS[selectedCaliberId];
    // Reset the replay buffer so the next paused scrub shows only this shot.
    replayCount = 0;
    replayWriteIdx = 0;
    lastFrameGrabMs = 0;
    // Hand the sequencer the SAME geometry the painter uses so the visible
    // bullet's tail clears the muzzle exactly at muzzleExitMs.
    fireSequencer.fire(preset, sceneGeometry);
    autoRepeatTimer = AUTO_REPEAT_DELAY_SEC;

    fireBtn.classList.add('firing');
    setStatus('FIRING — ' + preset.label + ' · ' + preset.desc);
    setTimeout(() => {
        fireBtn.classList.remove('firing');
        if (playbackState === 'playing') setStatus('Looping · click PAUSE to scrub');
    }, 350);
}

// ─── Replay capture ──────────────────────────────────────────────────────────
function grabReplayFrame(force) {
    const now = performance.now();
    if (!force && now - lastFrameGrabMs < 1000 / REPLAY_FPS) return;
    lastFrameGrabMs = now;

    const slot = replayFrames[replayWriteIdx];
    const ctx = slot.getContext('2d');
    // drawImage works because the WebGL context uses preserveDrawingBuffer: true
    ctx.drawImage(canvas, 0, 0, REPLAY_W, REPLAY_H);

    replayWriteIdx = (replayWriteIdx + 1) % REPLAY_MAX_FRAMES;
    if (replayCount < REPLAY_MAX_FRAMES) replayCount++;
}

function renderScrubFrame() {
    if (replayCount === 0) return;
    const idx = Math.max(0, Math.min(parseInt(playbackSlider.value, 10), replayCount - 1));

    // Ring: earliest frame is at replayWriteIdx once full, else at 0.
    const base = (replayCount < REPLAY_MAX_FRAMES) ? 0 : replayWriteIdx;
    const slot = replayFrames[(base + idx) % REPLAY_MAX_FRAMES];

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.drawImage(slot, 0, 0, overlay.width, overlay.height);

    const simMsPerWall = window.BALLISTIC_TIME.SIM_MS_PER_WALL_SEC;
    const tSimMs     = idx / REPLAY_FPS * simMsPerWall;
    const totalSimMs = (replayCount - 1) / REPLAY_FPS * simMsPerWall;
    playbackTime.textContent = tSimMs.toFixed(3) + ' / ' + totalSimMs.toFixed(3) + ' ms';
}

function sizeOverlayToCanvas() {
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
}

function sizeDebugOverlayToCanvas() {
    if (debugOverlay.width !== canvas.width || debugOverlay.height !== canvas.height) {
        debugOverlay.width  = canvas.width;
        debugOverlay.height = canvas.height;
    }
}

// Debug overlay: renders fading phase markers independent of the solver loop.
function renderDebugOverlay() {
    requestAnimationFrame(renderDebugOverlay);
    if (!debugMode) return;

    sizeDebugOverlayToCanvas();
    const ctx = debugOverlay.getContext('2d');
    ctx.clearRect(0, 0, debugOverlay.width, debugOverlay.height);

    const now = performance.now();
    const W = debugOverlay.width;
    const H = debugOverlay.height;

    for (let i = debugMarkers.length - 1; i >= 0; i--) {
        const m = debugMarkers[i];
        const age = now - m.tEmitted;
        if (age > DEBUG_MARKER_LIFE_MS) { debugMarkers.splice(i, 1); continue; }
        const style = DEBUG_PHASE_STYLE[m.phase];
        if (!style) continue;

        const alpha = 1.0 - age / DEBUG_MARKER_LIFE_MS;
        // UV (0..1) → canvas px. UV y=0 is bottom of the sim, canvas y=0 is top.
        const cx = m.x * W;
        const cy = (1 - m.y) * H;

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 18, cy); ctx.lineTo(cx + 18, cy);
        ctx.moveTo(cx, cy - 18); ctx.lineTo(cx, cy + 18);
        ctx.stroke();

        ctx.font = 'bold 11px SF Mono, Consolas, monospace';
        const text = style.label;
        const tw = ctx.measureText(text).width;
        const padX = 5, padY = 3, boxH = 16;
        const boxX = cx + 16;
        const boxY = cy - boxH / 2 - 14;
        ctx.fillStyle = 'rgba(9, 9, 11, 0.8)';
        ctx.fillRect(boxX, boxY, tw + padX * 2, boxH);
        ctx.fillStyle = style.color;
        ctx.fillText(text, boxX + padX, boxY + boxH - padY - 1);
    }
    ctx.globalAlpha = 1;
}
requestAnimationFrame(renderDebugOverlay);

// Capture loop: only while actively playing. Pausing freezes the buffer so
// the slider has a stable, finite timeline to scrub over.
function captureLoop() {
    if (playbackState === 'playing') grabReplayFrame();
    requestAnimationFrame(captureLoop);
}
requestAnimationFrame(captureLoop);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function renderDevicePreview() {
    if (!deviceMask || !devicePreview) return;
    const pw = devicePreview.width, ph = devicePreview.height;
    const ctx = devicePreview.getContext('2d');
    const img = ctx.createImageData(pw, ph);
    for (let j = 0; j < ph; j++) {
        for (let i = 0; i < pw; i++) {
            const srcI = Math.floor((i / pw) * deviceMask.width);
            const srcJ = Math.floor((j / ph) * deviceMask.height);
            const solid = deviceMask.data[srcJ * deviceMask.width + srcI] > 128;
            const v = solid ? 190 : 28;
            const idx = (j * pw + i) * 4;
            img.data[idx] = v; img.data[idx+1] = v; img.data[idx+2] = solid ? 210 : 28;
            img.data[idx+3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    devicePreview.style.display = 'block';
}

function selectCaliber(caliberId) {
    const preset = CALIBER_PRESETS[caliberId];
    calDesc.textContent = preset.desc;
    pushSolverMultipliers();
    rebuildObstacles();
}

function rebuildObstacles(bullet) {
    const preset = CALIBER_PRESETS[selectedCaliberId];
    const simSize = FluidSim.getSimSize();
    const W = simSize.width;
    const H = simSize.height;

    // Recompute every rebuild so a resize / caliber change can't leave stale
    // geometry. During a fire the sequencer holds its own frozen snapshot
    // so mid-shot timing can't shift.
    sceneGeometry = Scene.computeGeometry(preset, W, H);

    const obstacleData = Scene.buildObstacleTexture(
        sceneGeometry,
        deviceMask ? deviceMask.data   : null,
        deviceMask ? deviceMask.width  : 0,
        deviceMask ? deviceMask.height : 0,
        1.0,
        Math.round(deviceOffset.x),
        Math.round(deviceOffset.y),
        bullet || null
    );

    FluidSim.uploadObstacleTexture(obstacleData, W, H);
}

function setStatus(msg) {
    statusText.textContent = msg;
}

setStatus('Ready · press FIRE');

})();
