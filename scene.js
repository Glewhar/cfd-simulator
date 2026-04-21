'use strict';

/**
 * Scene builder — produces the obstacle texture the fluid solver sees AND the
 * canonical scene layout that every subsystem consumes.
 *
 * Canvas layout (UV space, left→right = chamber→muzzle exit):
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ [SOLID BARREL WALL]                                         │
 *   │ ─────────────────╮                                          │
 *   │   BORE (fluid)   │  muzzle     [MUZZLE DEVICE REGION]       │
 *   │ ─────────────────╯  exit ──►   (suppressor / brake shape)   │
 *   │ [SOLID BARREL WALL]                                         │
 *   └─────────────────────────────────────────────────────────────┘
 *     ◄── barrelLengthRatio × simWidth ──►◄── device region ────►
 *
 * Coordinate convention: data[0] is the bottom-left texel (UV v=0).
 *   Row index j=0 is the bottom of the screen, j=simHeight-1 is the top.
 *
 * `computeGeometry(preset, simW, simH)` is the single place that turns a
 * caliber preset into on-screen texels and UV coordinates. Both the obstacle
 * painter AND the fire sequencer consume the same geometry object so the
 * drawn bullet and the physics bullet can never drift apart.
 */

window.Scene = (function () {

    // Single vertical exaggeration factor applied to every physical-inch
    // quantity on the Y axis: bore diameter, bullet diameter, barrel OD, and
    // the cross-axis of uploaded meshes. The real bore is sub-pixel at this
    // canvas resolution, so everything vertical is scaled up for visibility
    // while horizontal dimensions stay true-physical. All Y-axis features
    // share this factor so bore/barrel/mesh ratios stay physically faithful.
    const VERTICAL_SCALE = 1.0;

    // Unified scene inches↔texels scale, caliber-INDEPENDENT. Applied to:
    //   - barrel length  (16" vs 24" now render at the true 2:3 ratio)
    //   - bullet length  (physical, with BULLET_MIN_TEXELS floor for visibility)
    //   - uploaded mesh  (mesh_inches × this = sim texels)
    //
    //   texelsPerInch = reference × SCENE_TEXELS_PER_INCH_OVER_REF
    //
    // Why one constant: the previous per-caliber BARREL_LENGTH_RATIO tuned
    // each barrel's on-screen size aesthetically, which made a 24" .308
    // barrel only 1.1× a 16" .223 instead of the true 1.5×. Any mesh scaled
    // against that non-physical barrel rescaled every caliber swap. With one
    // shared scale, the mesh is automatically physically consistent — it's
    // the same sim-texels per inch no matter which preset is active.
    // Tuned so .308's 24" barrel takes ~36% of reference, leaving plume room.
    const SCENE_TEXELS_PER_INCH_OVER_REF = 0.060;

    // Floor on the drawn bullet length (texels). Physics bullet length is read
    // back from the drawn length so timing stays consistent with what's drawn.
    const BULLET_MIN_TEXELS = 10;

    // Muzzle-device size is bore-proportional (real brakes/suppressors are
    // ~3-5× bore OD). 6× bore-half-height gives realistic silhouettes even
    // when the bore itself is visually exaggerated. Used only as the
    // legacy-fallback sizing region when a mesh has no physical info.
    const DEVICE_HEIGHT_BORE_MULT    = 6.0;
    const DEVICE_MAX_WIDTH_BARREL_MULT = 1.6;

    // Bullet starts just inside the chamber (UV constant, scales with simWidth).
    const BULLET_START_UV = 0.02;

    /**
     * Pure function: caliber preset + sim size → scene geometry.
     * Returns a snapshot that both the painter and the fire sequencer read.
     */
    function computeGeometry(preset, simWidth, simHeight) {
        // Anchor to the shorter axis so the barrel/bore stay fixed on-screen
        // as the window resizes — the longer axis becomes expansion room.
        const reference    = Math.min(simWidth, simHeight);

        // Universal inches↔texels — shared by barrel, bullet, and mesh. Caliber
        // only picks the physical inches; the mapping to sim texels is the
        // same across all presets, so swapping calibers now rescales ONLY the
        // per-caliber physical dimensions (barrel/bullet length) without
        // touching the mesh.
        const texelsPerInch = reference * SCENE_TEXELS_PER_INCH_OVER_REF;

        const barrelTexels = Math.max(8,
            Math.round(preset.BARREL_LENGTH_INCHES * texelsPerInch));

        const physicalBulletTexels = preset.BULLET_LENGTH_INCHES * texelsPerInch;
        const bulletLenTexels      = Math.max(BULLET_MIN_TEXELS,
            Math.round(physicalBulletTexels));

        // Every vertical dimension is derived from real inches × texelsPerInch
        // × VERTICAL_SCALE. Bore, barrel OD, and bullet diameter all share
        // that factor, so their on-screen ratios match their true physical
        // ratios (e.g. a 0.75" OD barrel reads 3.35× a 0.224" bore).
        const boreHalfH     = Math.max(2,
            Math.round(preset.BORE_DIAMETER_INCHES * 0.5 * texelsPerInch * VERTICAL_SCALE));
        const barrelOdHalfH = Math.max(boreHalfH + 2,
            Math.round(preset.BARREL_OD_INCHES    * 0.5 * texelsPerInch * VERTICAL_SCALE));
        // Slight clearance inside the bore so the bullet silhouette doesn't
        // paint into the bore wall.
        const bulletHalfH   = Math.max(1,
            Math.round(preset.BORE_DIAMETER_INCHES * 0.5 * texelsPerInch * VERTICAL_SCALE * 0.92));

        const bulletStartX   = BULLET_START_UV;
        const barrelEndX     = barrelTexels / simWidth;
        const barrelLenUV    = barrelEndX - bulletStartX;
        const bulletLengthUV = bulletLenTexels / simWidth;

        const deviceTargetH = Math.min(simHeight - 4, boreHalfH * 2 * DEVICE_HEIGHT_BORE_MULT);
        const deviceMaxW    = Math.min(simWidth  - barrelTexels - 2,
                                       barrelTexels * DEVICE_MAX_WIDTH_BARREL_MULT);

        return {
            simWidth, simHeight, reference,
            barrelTexels, barrelEndX,
            bulletStartX, barrelLenUV,
            boreCenterJ: Math.floor(simHeight / 2),
            boreHalfH, barrelOdHalfH,
            bulletLenTexels, bulletLengthUV, bulletHalfH,
            deviceTargetH, deviceMaxW,
            texelsPerInch, verticalScale: VERTICAL_SCALE,
        };
    }

    /**
     * Rasterize the obstacle texture: barrel walls + optional muzzle device
     * + optional bullet. Pixel-exact with the geometry snapshot.
     *
     * @param {object}     geom        result of computeGeometry()
     * @param {Uint8Array} [deviceMask]  solidness mask of the muzzle device
     * @param {number}     [deviceW]     deviceMask width  (source pixels)
     * @param {number}     [deviceH]     deviceMask height (source pixels)
     * @param {number}     [deviceScaleMult] multiplier on the base device scale.
     *        1.0 (default) = baseline. Clamped to canvas.
     * @param {number}     [offsetX] drag offset in sim pixels (+right)
     * @param {number}     [offsetY] drag offset in sim pixels (+up)
     * @param {{xUV:number, yUV:number}} [bullet] bullet center position
     * @param {{bboxW:number, bboxH:number, bboxMinI:number, bboxMinJ:number}}
     *        [deviceBBox] bounding box of the mesh's solid cells in mask space.
     *        When supplied, calibration fits the mesh bbox into the scene's
     *        bore-proportional device region (`deviceMaxW × deviceTargetH`) —
     *        this is unit-agnostic and uses the scene's barrel/bore metrics
     *        as the single physical reference. Falls back to full-mask fit
     *        when absent.
     * @returns {{data: Uint8Array, muzzleClearUV: number}}
     *        `data` is the obstacle map (255 = solid, 0 = fluid).
     *        `muzzleClearUV` is the UV x where the bullet first enters open
     *        air — rightmost solid pixel in the bullet's lane, i.e. the end
     *        of the barrel when bare, or the end of the painted device mask
     *        when a device is loaded. Used by the bloom gate to light the
     *        flash the frame the bullet's tip clears the muzzle.
     */
    function buildObstacleTexture(geom, deviceMask, deviceW, deviceH,
                                  deviceScaleMult, offsetX, offsetY, bullet,
                                  deviceBBox) {
        const { simWidth, simHeight, barrelTexels, boreCenterJ, boreHalfH,
                barrelOdHalfH, bulletLenTexels } = geom;
        const data = new Uint8Array(simWidth * simHeight);
        let muzzleClearUV = geom.barrelEndX;

        // ── Barrel: a tube bounded by barrelOdHalfH (not wall-to-wall). Above
        //    and below the tube is open fluid space, so uploaded muzzle
        //    devices sit against an honest outer diameter reference. ────────
        const jLo = Math.max(0, boreCenterJ - barrelOdHalfH);
        const jHi = Math.min(simHeight - 1, boreCenterJ + barrelOdHalfH);
        for (let j = jLo; j <= jHi; j++) {
            if (Math.abs(j - boreCenterJ) <= boreHalfH) continue;  // bore slot
            for (let i = 0; i < barrelTexels; i++) {
                data[j * simWidth + i] = 255;
            }
        }

        // ── Muzzle device ─────────────────────────────────────────────────
        // Majority-coverage downsample from source pixels → dest pixels:
        // mark dest solid when ≥50% of its source box is solid.
        if (deviceMask && deviceW > 0 && deviceH > 0) {
            const unitMult  = (deviceScaleMult > 0) ? deviceScaleMult : 1.0;
            // Physical scale: same inches↔texels mapping as barrel + bullet
            // (geom.texelsPerInch is unified across the scene now, so this
            // is caliber-independent by construction — switching presets
            // rescales the barrel/bullet but leaves the mesh alone).
            //
            //   texelsPerMaskPixel = worldPerPixel × unitToInch × texelsPerInch
            //
            // Falls back to bbox-fit into the bore-proportional device region
            // when the physical info is missing (legacy caller paths).
            const units       = (deviceBBox && deviceBBox.units) || 'mm';
            const unitToInch  = (units === 'inch' || units === 'in') ? 1 : (1 / 25.4);
            const wpp         = deviceBBox ? deviceBBox.worldPerPixel : 0;
            const pLenIn      = deviceBBox ? (deviceBBox.physicalLengthInches || 0) : 0;
            const bboxW       = deviceBBox ? deviceBBox.bboxW : 0;
            // Non-uniform when a physical scale is known: horizontal stays at
            // true-physical (texelsPerInch), vertical picks up VERTICAL_SCALE
            // so the mesh's OD matches the bore/barrel exaggeration regime.
            // The legacy bbox-fit fallback stays uniform — nothing physical
            // to hang a ratio on.
            let baseScaleX, baseScaleY;
            if (pLenIn > 0 && bboxW > 0 && geom.texelsPerInch > 0) {
                // Highest priority: caller supplied the mesh's authored long-axis
                // length (samples tagged with catalog dimensions). Pins the
                // solid bbox's u-extent to exactly that many scene texels,
                // bypassing unit guesses and section-slice rounding.
                baseScaleX = (pLenIn * geom.texelsPerInch) / bboxW;
                baseScaleY = baseScaleX * VERTICAL_SCALE;
            } else if (wpp > 0 && geom.texelsPerInch > 0) {
                baseScaleX = wpp * unitToInch * geom.texelsPerInch;
                baseScaleY = baseScaleX * VERTICAL_SCALE;
            } else {
                const fitW = (bboxW > 0) ? bboxW : deviceW;
                const fitH = (deviceBBox && deviceBBox.bboxH > 0) ? deviceBBox.bboxH : deviceH;
                const fitScale = Math.min(geom.deviceMaxW / fitW,
                                          geom.deviceTargetH / fitH);
                baseScaleX = fitScale;
                baseScaleY = fitScale;
            }
            const canvasCapX = (simWidth  - barrelTexels - 2) / deviceW;
            const canvasCapY = (simHeight - 4)                / deviceH;
            const scaleX  = Math.min(baseScaleX * unitMult, canvasCapX);
            const scaleY  = Math.min(baseScaleY * unitMult, canvasCapY);
            const scaledW = Math.max(1, Math.round(deviceW * scaleX));
            const scaledH = Math.max(1, Math.round(deviceH * scaleY));

            // Anchor the mesh's bbox so its left edge meets the muzzle. Without
            // this, the fitMapping 4% mask padding leaves a visible gap between
            // barrel and device at rest (before any drag offset).
            const bboxShiftI = deviceBBox ? Math.round(deviceBBox.bboxMinI * scaleX) : 0;
            const bboxHalfJ  = deviceBBox
                ? Math.round((deviceBBox.bboxMinJ + deviceBBox.bboxH / 2) * scaleY)
                : Math.floor(scaledH / 2);

            const ox = (offsetX | 0);
            const oy = (offsetY | 0);
            const startI = barrelTexels - bboxShiftI + ox;
            const startJ = boreCenterJ  - bboxHalfJ  + oy;

            // Device exit plane in UV — right edge of the painted bbox. This
            // is the "bullet touches outside air" threshold when a device is
            // loaded. Clamped to [barrelEndX, 1] so negative drag can never
            // pull the gate earlier than the bare-barrel exit.
            const deviceRightI = startI + scaledW;
            muzzleClearUV = Math.min(1, Math.max(geom.barrelEndX,
                                                  deviceRightI / simWidth));

            // djNat = scaledH-1-dj handles Y-flip (source row 0 = top of image).
            for (let dj = 0; dj < scaledH; dj++) {
                const djNat = scaledH - 1 - dj;
                const sj0 = Math.floor( djNat      / scaledH * deviceH);
                let   sj1 = Math.ceil((djNat + 1) / scaledH * deviceH);
                if (sj1 <= sj0) sj1 = sj0 + 1;
                if (sj1 > deviceH) sj1 = deviceH;
                const dstJ = startJ + dj;
                if (dstJ < 0 || dstJ >= simHeight) continue;
                const rowDst = dstJ * simWidth;
                for (let di = 0; di < scaledW; di++) {
                    const si0 = Math.floor( di       / scaledW * deviceW);
                    let   si1 = Math.ceil((di + 1) / scaledW * deviceW);
                    if (si1 <= si0) si1 = si0 + 1;
                    if (si1 > deviceW) si1 = deviceW;
                    let solidCount = 0;
                    let totalCount = 0;
                    for (let sj = sj0; sj < sj1; sj++) {
                        const rowBase = sj * deviceW;
                        for (let si = si0; si < si1; si++) {
                            totalCount++;
                            if (deviceMask[rowBase + si] > 128) solidCount++;
                        }
                    }
                    if (totalCount > 0 && solidCount * 2 >= totalCount) {
                        const dstI = startI + di;
                        if (dstI < 0 || dstI >= simWidth) continue;
                        data[rowDst + dstI] = 255;
                    }
                }
            }
        }

        // ── Bullet silhouette ─────────────────────────────────────────────
        // The visible bullet is painted at value 255. An optional invisible
        // skirt (value 192, below the 0.9 overlay-threshold but above the 0.5
        // physics-solid threshold) is painted FIRST into empty cells only, so
        // it can't overwrite barrel walls or the device. Skirt is asymmetric —
        // wider on the front/top/bottom than behind — so gas can still be
        // injected just behind the tail. `bulletBorderMult` scales the skirt.
        if (bullet) {
            const halfLenTexels = Math.max(1, Math.round(bulletLenTexels / 2));
            const bulletHalfH   = geom.bulletHalfH;
            const centerI       = Math.round(bullet.xUV * simWidth);
            const centerJ       = Math.round(bullet.yUV * simHeight);
            const ogiveLen      = Math.max(1, Math.round(halfLenTexels * 0.7));

            const SKIRT_FRONT_PX = 500;
            const SKIRT_VERT_PX  = 500;
            const SKIRT_BACK_PX  = 10;

            // The bore seal (invisible skirt around the bullet) is disabled
            // either by unchecking the "Bore seal" feature toggle or by setting
            // its slider to 0. Either way, gas will be able to slip around the
            // bullet while it travels down the barrel.
            const cfg = window.DEBUG_CONFIG || {};
            const skirtEnabled = cfg.bulletBorderEnabled !== false;
            const skirtMult = skirtEnabled
                ? Math.max(0, cfg.bulletBorderMult || 0)
                : 0;
            const padFront = Math.round(SKIRT_FRONT_PX * skirtMult);
            const padVert  = Math.round(SKIRT_VERT_PX  * skirtMult);
            const padBack  = Math.round(SKIRT_BACK_PX  * skirtMult);

            // Paint the bullet silhouette, optionally padded asymmetrically.
            const paintBullet = (padF, padB, padV, value, onlyEmpty) => {
                const halfLenFront = halfLenTexels + padF;
                const halfLenBack  = halfLenTexels + padB;
                const bulletHalfP  = bulletHalfH  + padV;
                const ogiveLenP    = ogiveLen     + padF;   // ogive stretches with nose
                const iP0 = Math.max(0, centerI - halfLenBack);
                const iP1 = Math.min(simWidth  - 1, centerI + halfLenFront);
                const jP0 = Math.max(0, centerJ - bulletHalfP);
                const jP1 = Math.min(simHeight - 1, centerJ + bulletHalfP);
                for (let j = jP0; j <= jP1; j++) {
                    for (let i = iP0; i <= iP1; i++) {
                        const fromFront = iP1 - i;
                        if (fromFront < ogiveLenP) {
                            const noseT = fromFront / ogiveLenP;
                            const allowedHalfH = bulletHalfP * Math.sqrt(noseT);
                            if (Math.abs(j - centerJ) > allowedHalfH) continue;
                        }
                        const idx = j * simWidth + i;
                        if (onlyEmpty && data[idx] !== 0) continue;
                        data[idx] = value;
                    }
                }
            };

            if (padFront + padBack + padVert > 0) {
                paintBullet(padFront, padBack, padVert, 192, true);
            }
            paintBullet(0, 0, 0, 255, false);
        }

        return { data, muzzleClearUV };
    }

    return { computeGeometry, buildObstacleTexture };

})();
