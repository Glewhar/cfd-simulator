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
        // The suppressor mesh's long axis is Z (200mm-ish), so viewing from +X
        // gives the correct side-view silhouette (length horizontal, OD
        // vertical). Y-view would collapse the length into the V axis and
        // render the suppressor as a tall narrow column.
        projectionAxis: 'x',
        projectionMode: 'section',
        units:          'mm',
        // Authored catalog size — measured from STL bounds (Z = 200mm).
        // Pins the rendered long-axis length so section-slice rounding and
        // unit misinterpretation can't drift the size off catalog.
        physicalLengthInches: 200 / 25.4,   // 7.874"
    },
    muzzle_brake: {
        id:             'muzzle_brake',
        label:          'Muzzle brake',
        url:            'muzzle-break-sample.stl',
        projectionAxis: 'y',
        projectionMode: 'section',
        units:          'mm',
        // Authored catalog size — measured from STL bounds (X = 55.5mm).
        physicalLengthInches: 55.5 / 25.4,  // 2.185"
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
// without losing the user's custom upload. Sample sources carry an authored
// physicalLengthInches that pins the rendered size to catalog dimensions,
// bypassing section-slice rounding.
// deviceSource = { kind:'sample', id, url, label, physicalLengthInches? }
//              | { kind:'file', file, label, physicalLengthInches? } | null
let deviceSource = null;

// Projection + orientation controls (live, re-voxelize on change)
let deviceAxis  = 'y';                              // 'x' | 'y' | 'z'
let deviceMode  = 'section';                        // 'section' | 'silhouette'
let deviceXform = { flipX: false, flipY: false, rotate: 0 };  // rotate ∈ {0,90,180,270}

// Mesh native units for physical-size scaling against the barrel reference.
// STLs carry no unit information, so the user picks mm or inch from the UI.
// Flipping this is a re-PAINT (rebuildObstacles) — no re-voxelization needed
// because the mask's worldPerPixel is in native units regardless of what we
// interpret them as.
let deviceUnits = 'mm';                             // 'mm' | 'inch'

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
const uploadPrompt   = document.getElementById('upload-units-prompt');
const uploadPromptMsg= document.getElementById('upload-prompt-msg');
const uploadPickMmBtn= document.getElementById('upload-pick-mm');
const uploadPickInBtn= document.getElementById('upload-pick-in');
const uploadCancelBtn= document.getElementById('upload-cancel');
const axisButtons    = document.querySelectorAll('.opt-btn[data-axis]');
const modeButtons    = document.querySelectorAll('.opt-btn[data-mode]');
const xformFlipXBtn  = document.getElementById('xform-flipx');
const xformFlipYBtn  = document.getElementById('xform-flipy');
const xformRotateBtn = document.getElementById('xform-rotate');
const unitButtons    = document.querySelectorAll('.opt-btn[data-unit]');
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
const debugBloomCb     = document.getElementById('debug-bloom-enabled');
const debugCurlCb      = document.getElementById('debug-curl-enabled');
const debugBulletBorderCb = document.getElementById('debug-bullet-border-enabled');
const debugGasForceRange  = document.getElementById('debug-gas-force');
const debugGasForceVal    = document.getElementById('debug-gas-force-val');
const debugGasRatioRange  = document.getElementById('debug-gas-ratio');
const debugGasRatioVal    = document.getElementById('debug-gas-ratio-val');
const debugVelDissRange    = document.getElementById('debug-vel-diss');
const debugVelDissVal      = document.getElementById('debug-vel-diss-val');
const debugDenDissRange    = document.getElementById('debug-den-diss');
const debugDenDissVal      = document.getElementById('debug-den-diss-val');
const debugSplatRadiusRange = document.getElementById('debug-splat-radius');
const debugSplatRadiusVal   = document.getElementById('debug-splat-radius-val');
const debugBloomRange      = document.getElementById('debug-bloom');
const debugBloomVal        = document.getElementById('debug-bloom-val');
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
    // In-bore gas push: propellant igniting behind the bullet while it's
    // still inside the barrel.
    inbore:       { color: '#22d3ee', label: 'IGNITION'     },
    // Trailing smoke puffs emitted after the bullet leaves the muzzle.
    smoke:        { color: '#facc15', label: 'EXPANSION'    },
    // One-shot event: the frame the bullet's tip first reaches open air
    // and the flash halo ignites at the muzzle exit.
    muzzle_flash: { color: '#f97316', label: 'MUZZLE FLASH' },
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

// Prior-frame bloom gate, used to fire a single MUZZLE FLASH debug marker
// on the 0 → 1 transition (the frame the bullet tip clears the muzzle).
// Initialised to 1 so IDLE → first-shot transition (1 → 0) primes correctly.
let lastBloomGate = 1;

FluidSim.setBeforeStepCallback(function (dt) {
    // PAUSE freezes solver + sequencer + capture in lock-step.
    if (playbackState !== 'playing') return;

    const splats = fireSequencer.update(dt);
    const nowMs = performance.now();

    // Flash glow lights up the single frame the bullet's tip first reaches
    // open air — past the barrel end, or past the device's exit plane if a
    // suppressor / brake is loaded. `muzzleClearUV` is the rightmost solid
    // pixel in the bullet's lane, computed by the scene painter, so the
    // gate tracks whatever obstacle is actually in front of the bullet.
    // Between shots (IDLE): full, so residual smoke still glows.
    {
        const preset = CALIBER_PRESETS[selectedCaliberId];
        const derived = deriveCaliberVisuals(preset);
        const cfg = window.DEBUG_CONFIG;
        let gate = 1.0;
        let flashMarker = null;
        if (!cfg.bloomEnabled) {
            gate = 0;
        } else if (fireSequencer.isActive) {
            const bullet = fireSequencer.getBullet();
            const clearX = (sceneGeometry && sceneGeometry.muzzleClearUV != null)
                ? sceneGeometry.muzzleClearUV
                : (sceneGeometry ? sceneGeometry.barrelEndX : 0);
            const bulletLenUV = sceneGeometry ? sceneGeometry.bulletLengthUV : 0;
            const tipUV = bullet ? bullet.xUV + bulletLenUV / 2 : 0;
            gate = (bullet && tipUV >= clearX) ? 1 : 0;
            // Single-frame 0 → 1 transition = MUZZLE FLASH ignition.
            // Marker is placed at the muzzle-exit plane, not the bullet's
            // current position, because the flash visually anchors there.
            if (debugMode && gate > 0 && lastBloomGate === 0 && bullet) {
                flashMarker = { x: clearX, y: bullet.yUV, phase: 'muzzle_flash', tEmitted: nowMs };
            }
        }
        lastBloomGate = gate;
        if (flashMarker) debugMarkers.push(flashMarker);
        FluidSim.setConfig('BLOOM_INTENSITY', derived.BLOOM_INTENSITY * cfg.bloomMult * gate);
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
    if (device.units) deviceUnits = device.units;
    syncOptionButtons();

    deviceSource = {
        kind: 'sample',
        id: device.id,
        url: device.url,
        label: device.label,
        physicalLengthInches: device.physicalLengthInches || 0,
    };
    reloadDeviceSource();
}

// ─── Custom mesh upload (CORS-safe: FileReader, no fetch) ───────────────────
deviceUploadBtn.addEventListener('click', () => deviceFileInput.click());

// Holds the parsed-but-not-voxelized mesh between file pick and unit choice.
let pendingUpload = null;   // { file, label, longAxisNative, longAxisName } | null

deviceFileInput.addEventListener('change', () => {
    const file = deviceFileInput.files && deviceFileInput.files[0];
    if (!file) return;
    // Reset the input so picking the same file twice still fires 'change'.
    deviceFileInput.value = '';
    // Parse once up-front to measure native-unit bounds so the prompt can
    // show sanity-checkable inches-for-each-choice next to the buttons.
    setStatus('Measuring ' + file.name + '…');
    Voxelizer.parseFromSource(file).then(parsed => {
        const bounds = Voxelizer.computeBounds(parsed.vertices);
        const rx = bounds.max[0] - bounds.min[0];
        const ry = bounds.max[1] - bounds.min[1];
        const rz = bounds.max[2] - bounds.min[2];
        const longest = Math.max(rx, ry, rz);
        const axisName = (longest === rx) ? 'X' : (longest === ry) ? 'Y' : 'Z';
        pendingUpload = {
            file,
            label: file.name,
            longAxisNative: longest,
            longAxisName:   axisName,
        };
        // Offer both interpretations with a sanity-check readout.
        const asMm  = (longest / 25.4).toFixed(2);
        const asIn  = longest.toFixed(2);
        uploadPromptMsg.textContent =
            file.name + ' · long axis ' + axisName + ' = ' + longest.toFixed(1) + ' units';
        uploadPickMmBtn.textContent = 'Treat as mm (= ' + asMm + '″)';
        uploadPickInBtn.textContent = 'Treat as inches (= ' + asIn + '″)';
        uploadPrompt.style.display = '';
        setStatus('Pick units for ' + file.name);
    }).catch(err => {
        pendingUpload = null;
        uploadPrompt.style.display = 'none';
        setStatus('Error reading ' + file.name + ': ' + err.message);
        console.error(err);
    });
});

function commitPendingUpload(units) {
    if (!pendingUpload) return;
    // Deselect sample buttons — this is a custom upload now.
    deviceButtons.forEach(b => b.classList.remove('active'));
    selectedDeviceId = 'custom';
    deviceOffset = { x: 0, y: 0 };
    deviceUnits = units;
    syncOptionButtons();
    deviceSource = {
        kind: 'file',
        file: pendingUpload.file,
        label: pendingUpload.label,
        physicalLengthInches: 0,  // uploads go through the unit-aware path
    };
    pendingUpload = null;
    uploadPrompt.style.display = 'none';
    reloadDeviceSource();
}

uploadPickMmBtn.addEventListener('click', () => commitPendingUpload('mm'));
uploadPickInBtn.addEventListener('click', () => commitPendingUpload('inch'));
uploadCancelBtn.addEventListener('click', () => {
    pendingUpload = null;
    uploadPrompt.style.display = 'none';
    setStatus('Upload cancelled');
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
        // Stamp the current UI unit choice onto the mask so downstream physical
        // scaling in scene.js reads the user's selection, not the voxelizer's
        // default. Flipping the unit switch later updates this field and
        // repaints without a re-voxelize.
        deviceMask.units = deviceUnits;
        // Samples carry an authored length that overrides unit math; uploads
        // leave this zero so scene.js falls through to the unit-aware path.
        deviceMask.physicalLengthInches = deviceSource.physicalLengthInches || 0;
        renderDevicePreview();
        canvas.classList.add('device-loaded');
        rebuildObstacles();
        deviceStatus.textContent = formatDeviceStatus(label, result);
        setStatus(label + ' loaded · ' + result.triangleCount + ' tris · ready to fire');
    }).catch(err => {
        deviceMask = null;
        deviceStatus.textContent = 'Failed: ' + label;
        setStatus('Error loading ' + label + ': ' + err.message);
        console.error(err);
    });
}

// Status readout: show the mesh's rendered physical length and OD so the
// user can sanity-check the scale against catalog dimensions. The long axis
// (u in mask space) is the bbox width; the cross-axis (v) is the height.
// Prefer the authored physicalLengthInches when present (samples); otherwise
// derive from worldPerPixel × unit factor (uploads).
function formatDeviceStatus(label, result) {
    const pct   = (100 * result.solidPixels / result.totalPixels).toFixed(1);
    const units = result.units || 'mm';
    const u2i   = (units === 'inch' || units === 'in') ? 1 : (1 / 25.4);
    let lenIn, odIn;
    if (result.physicalLengthInches > 0 && result.bboxW > 0) {
        lenIn = result.physicalLengthInches;
        odIn  = (result.bboxH / result.bboxW) * lenIn;
    } else if (result.worldPerPixel > 0) {
        lenIn = result.bboxW * result.worldPerPixel * u2i;
        odIn  = result.bboxH * result.worldPerPixel * u2i;
    } else {
        return label + ' · ' + pct + '% solid';
    }
    // Show in the user-selected unit system for readability.
    if (units === 'inch' || units === 'in') {
        return label + ' · ' + lenIn.toFixed(2) + '" × ' + odIn.toFixed(2) + '" · ' + pct + '% solid';
    }
    const lenMm = lenIn * 25.4, odMm = odIn * 25.4;
    return label + ' · ' + lenMm.toFixed(1) + 'mm × ' + odMm.toFixed(1) + 'mm · ' + pct + '% solid';
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

// Unit switch: cheap — only updates the mesh's unit interpretation and repaints
// obstacles. No re-voxelization because the mask's worldPerPixel is stored in
// the mesh's native units and only multiplied through by the unit factor in
// scene.js.
unitButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        deviceUnits = btn.dataset.unit;
        syncOptionButtons();
        if (deviceMask) {
            deviceMask.units = deviceUnits;
            rebuildObstacles();
            // Refresh the physical-size readout so mm↔inch is sanity-checkable
            // without re-voxelizing.
            if (deviceSource) {
                deviceStatus.textContent = formatDeviceStatus(deviceSource.label, deviceMask);
            }
        }
    });
});

function syncOptionButtons() {
    axisButtons.forEach(b =>
        b.classList.toggle('active', b.dataset.axis === deviceAxis));
    modeButtons.forEach(b =>
        b.classList.toggle('active', b.dataset.mode === deviceMode));
    unitButtons.forEach(b =>
        b.classList.toggle('active', b.dataset.unit === deviceUnits));
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
// default 1.0× = preset unchanged. Feature toggles zero out their respective
// multipliers so an off feature produces no effect even if the slider is up.
function pushSolverMultipliers() {
    const preset  = CALIBER_PRESETS[selectedCaliberId];
    const derived = deriveCaliberVisuals(preset);
    const cfg     = window.DEBUG_CONFIG;
    const bloom   = cfg.bloomEnabled ? cfg.bloomMult : 0;
    const curl    = cfg.curlEnabled  ? cfg.curlMult  : 0;
    FluidSim.setConfig('BLOOM_INTENSITY',     derived.BLOOM_INTENSITY * bloom);
    FluidSim.setConfig('CURL',                derived.CURL            * curl);
    FluidSim.setConfig('PRESSURE',            FIRE_MODEL.PRESSURE);
    FluidSim.setConfig('PRESSURE_ITERATIONS', FIRE_MODEL.PRESSURE_ITERATIONS);
    applySolverDissipation();
}

// Dissipation is set once on caliber change or slider drag. Base values
// come from FIRE_MODEL, scaled by the live mults.
function applySolverDissipation() {
    const cfg = window.DEBUG_CONFIG;
    FluidSim.setConfig('VELOCITY_DISSIPATION',
        FIRE_MODEL.VELOCITY_DISSIPATION * cfg.velocityDissMult);
    FluidSim.setConfig('DENSITY_DISSIPATION',
        FIRE_MODEL.DENSITY_DISSIPATION  * cfg.densityDissMult);
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

// Feature toggles that fully disable a feature (vs. scaling it to zero).
// Kept separate from the sliders so a user can A/B-test without losing
// their slider settings.
function syncFeatureToggleUI() {
    const cfg = window.DEBUG_CONFIG;
    const rows = {
        'debug-bloom':          cfg.bloomEnabled,
        'debug-curl':           cfg.curlEnabled,
        'debug-bullet-border':  cfg.bulletBorderEnabled,
    };
    for (const id in rows) {
        const el = document.getElementById(id);
        if (el && el.parentElement) el.parentElement.classList.toggle('disabled', !rows[id]);
    }
}

debugBloomCb.checked = window.DEBUG_CONFIG.bloomEnabled;
debugCurlCb.checked  = window.DEBUG_CONFIG.curlEnabled;
debugBulletBorderCb.checked = window.DEBUG_CONFIG.bulletBorderEnabled;
syncFeatureToggleUI();

debugBloomCb.addEventListener('change', () => {
    window.DEBUG_CONFIG.bloomEnabled = debugBloomCb.checked;
    syncFeatureToggleUI();
    pushSolverMultipliers();
});
debugCurlCb.addEventListener('change', () => {
    window.DEBUG_CONFIG.curlEnabled = debugCurlCb.checked;
    syncFeatureToggleUI();
    pushSolverMultipliers();
});
debugBulletBorderCb.addEventListener('change', () => {
    window.DEBUG_CONFIG.bulletBorderEnabled = debugBulletBorderCb.checked;
    syncFeatureToggleUI();
    rebuildObstacles();
});

// Plume / dissipation
bindSlider(debugGasForceRange, debugGasForceVal, 'gasForceMult',    asFloat, fmtMult);
bindSlider(debugGasRatioRange, debugGasRatioVal, 'gasSpeedRatio',   asFloat, fmtVal);
bindSlider(debugVelDissRange,     debugVelDissVal,     'velocityDissMult', asFloat, fmtMult, applySolverDissipation);
bindSlider(debugDenDissRange,     debugDenDissVal,     'densityDissMult',  asFloat, fmtMult, applySolverDissipation);
bindSlider(debugSplatRadiusRange, debugSplatRadiusVal, 'splatRadiusMult',  asFloat, fmtMult);
bindSlider(debugBloomRange,    debugBloomVal,    'bloomMult',       asFloat, fmtMult, pushSolverMultipliers);
bindSlider(debugCurlRange,     debugCurlVal,     'curlMult',        asFloat, fmtMult, pushSolverMultipliers);

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

    const { data: obstacleData, muzzleClearUV } = Scene.buildObstacleTexture(
        sceneGeometry,
        deviceMask ? deviceMask.data   : null,
        deviceMask ? deviceMask.width  : 0,
        deviceMask ? deviceMask.height : 0,
        1.0,
        Math.round(deviceOffset.x),
        Math.round(deviceOffset.y),
        bullet || null,
        deviceMask || null
    );

    // Cache the muzzle-exit threshold on the scene snapshot so the bloom gate
    // can read it. Bare muzzle → barrelEndX; device loaded → rightmost solid
    // pixel of the painted mask.
    sceneGeometry.muzzleClearUV = muzzleClearUV;

    FluidSim.uploadObstacleTexture(obstacleData, W, H);
}

function setStatus(msg) {
    statusText.textContent = msg;
}

setStatus('Ready · press FIRE');

let _lastSimW = 0, _lastSimH = 0;
let _resizePending = false;
window.addEventListener('resize', () => {
    if (_resizePending) return;
    _resizePending = true;
    requestAnimationFrame(() => {
        _resizePending = false;
        const s = FluidSim.getSimSize();
        if (s.width === _lastSimW && s.height === _lastSimH) return;
        _lastSimW = s.width; _lastSimH = s.height;
        rebuildObstacles(fireSequencer && fireSequencer.isActive
            ? fireSequencer.getBullet() : null);
    });
});

})();
