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

    // Shrinks barrel, bore, and bullet uniformly so that more canvas becomes
    // fluid-expansion room. Everything else is derived from the scaled barrel.
    const BARREL_SCENE_SCALE = 0.45;

    // Floor on the drawn bullet length (texels). Physics bullet length is read
    // back from the drawn length so timing stays consistent with what's drawn.
    const BULLET_MIN_TEXELS = 10;

    // Muzzle-device size is bore-proportional (real brakes/suppressors are
    // ~3-5× bore OD). 6× bore-half-height gives realistic silhouettes even
    // when the bore itself is visually exaggerated.
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
        const barrelTexels = Math.max(8,
            Math.round(reference * preset.BARREL_LENGTH_RATIO * BARREL_SCENE_SCALE));

        // Real-inches ↔ texel ratio, derived from the one physical dimension
        // we know (barrel length). Reused for bullet length.
        const texelsPerInch = barrelTexels / preset.BARREL_LENGTH_INCHES;

        const physicalBulletTexels = preset.BULLET_LENGTH_INCHES * texelsPerInch;
        const bulletLenTexels      = Math.max(BULLET_MIN_TEXELS,
            Math.round(physicalBulletTexels));

        // Visually-exaggerated bore (real bore is sub-pixel on this canvas).
        const boreHalfH        = Math.max(2,
            Math.round(reference * preset.BORE_HALF_H_RATIO * BARREL_SCENE_SCALE));
        const bulletHalfHRatio = preset.BORE_HALF_H_RATIO * 0.92;  // slight clearance

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
            boreHalfH,
            bulletLenTexels, bulletLengthUV, bulletHalfHRatio,
            deviceTargetH, deviceMaxW,
            texelsPerInch,
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
     * @param {number}     [devicePixelsPerInch] if > 0, the mesh is placed at
     *        its REAL size using this factor + `geom.texelsPerInch` — so a 6"
     *        suppressor on a 16" barrel draws at 6/16 of the barrel length.
     *        Falls back to bore-proportional fit-to-box when 0/absent.
     * @returns {Uint8Array} obstacle map (255 = solid, 0 = fluid)
     */
    function buildObstacleTexture(geom, deviceMask, deviceW, deviceH,
                                  deviceScaleMult, offsetX, offsetY, bullet,
                                  devicePixelsPerInch) {
        const { simWidth, simHeight, barrelTexels, boreCenterJ, boreHalfH,
                bulletLenTexels } = geom;
        const data = new Uint8Array(simWidth * simHeight);

        // ── Barrel: solid above/below the bore slot, for the first
        //    `barrelTexels` columns of the scene. ────────────────────────────
        for (let j = 0; j < simHeight; j++) {
            const inBore = Math.abs(j - boreCenterJ) <= boreHalfH;
            if (inBore) continue;
            for (let i = 0; i < barrelTexels; i++) {
                data[j * simWidth + i] = 255;
            }
        }

        // ── Muzzle device ─────────────────────────────────────────────────
        // Majority-coverage downsample from source pixels → dest pixels:
        // mark dest solid when ≥50% of its source box is solid.
        if (deviceMask && deviceW > 0 && deviceH > 0) {
            const unitMult  = (deviceScaleMult > 0) ? deviceScaleMult : 1.0;
            // Real-units path: scale the mask so one mask-pixel represents the
            // same real-world inch count the barrel uses. Fit-to-box path
            // (when pixelsPerInch is unknown): bore-proportional sizing.
            let baseScale;
            if (devicePixelsPerInch > 0 && geom.texelsPerInch > 0) {
                baseScale = geom.texelsPerInch / devicePixelsPerInch;
            } else {
                baseScale = Math.min(geom.deviceMaxW / deviceW,
                                     geom.deviceTargetH / deviceH);
            }
            const canvasCap = Math.min(
                (simWidth  - barrelTexels - 2) / deviceW,
                (simHeight - 4)                / deviceH,
            );
            const scale   = Math.min(baseScale * unitMult, canvasCap);
            const scaledW = Math.max(1, Math.round(deviceW * scale));
            const scaledH = Math.max(1, Math.round(deviceH * scale));

            const ox = (offsetX | 0);
            const oy = (offsetY | 0);
            const startI = barrelTexels + ox;
            const startJ = boreCenterJ - Math.floor(scaledH / 2) + oy;

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
            const bulletHalfH   = Math.max(1,
                Math.round(geom.reference * geom.bulletHalfHRatio * BARREL_SCENE_SCALE));
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

        return data;
    }

    return { computeGeometry, buildObstacleTexture };

})();
