'use strict';

/**
 * Voxelizer — converts a 3D mesh (.obj / .stl) into a 2D binary obstacle mask.
 *
 * Two projection modes:
 *
 *   'section' (default) — CROSS-SECTION through the mesh centre.
 *        For each output pixel, casts an axial ray at the 3D point
 *        (u, v, axisCentre) and counts triangle intersections.
 *        Odd = inside mesh material (solid), even = empty (fluid).
 *        Works correctly for watertight hollow meshes: bore and internal
 *        chambers appear as fluid passages, walls and baffles appear as solid.
 *
 *   'silhouette' — SHADOW projection.
 *        Draws each projected triangle as a filled primitive and ORs them
 *        together. Gives the outer silhouette of the mesh (no internal
 *        features). Correct when the user uploads discrete solid parts
 *        (e.g. individual baffle discs).
 *
 * Both modes share the same axis choice:
 *   'y' — camera along +Y   (top view, UV = XZ)   ← default
 *   'z' — camera along +Z   (front view, UV = XY)
 *   'x' — camera along +X   (side view, UV = YZ)
 *
 * Output: { data: Uint8Array, width, height }
 *   - data[j*width + i] = 255 for solid, 0 for fluid
 *   - row 0 = top of image (standard image convention)
 */

window.Voxelizer = (function () {

    // ── OBJ parser ────────────────────────────────────────────────────────────
    function parseOBJ(text) {
        const vertices = [];
        const faces    = [];
        const lines    = text.split('\n');
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] === 'v') {
                vertices.push([
                    parseFloat(parts[1]),
                    parseFloat(parts[2]),
                    parseFloat(parts[3]),
                ]);
            } else if (parts[0] === 'f') {
                const idx = parts.slice(1).map(p => parseInt(p.split('/')[0]) - 1);
                for (let i = 1; i < idx.length - 1; i++)
                    faces.push([idx[0], idx[i], idx[i + 1]]);
            }
        }
        return { vertices, faces };
    }

    // ── STL parser (binary / ASCII) ───────────────────────────────────────────
    function parseSTL(buffer) {
        if (buffer.byteLength >= 84) {
            const count = new DataView(buffer).getUint32(80, true);
            if (buffer.byteLength === 84 + count * 50)
                return parseSTLBinary(buffer);
        }
        return parseSTLAscii(buffer);
    }

    function parseSTLBinary(buffer) {
        const view  = new DataView(buffer);
        const count = view.getUint32(80, true);
        const vertices = [];
        const faces    = [];
        let offset = 84;
        for (let i = 0; i < count; i++) {
            offset += 12; // skip normal
            const base = vertices.length;
            for (let v = 0; v < 3; v++) {
                vertices.push([
                    view.getFloat32(offset,    true),
                    view.getFloat32(offset+4,  true),
                    view.getFloat32(offset+8,  true),
                ]);
                offset += 12;
            }
            faces.push([base, base+1, base+2]);
            offset += 2; // attribute byte count
        }
        return { vertices, faces };
    }

    function parseSTLAscii(buffer) {
        const text     = new TextDecoder().decode(buffer);
        const vertices = [];
        const faces    = [];
        const re       = /vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            vertices.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
        }
        for (let i = 0; i < vertices.length; i += 3)
            faces.push([i, i+1, i+2]);
        return { vertices, faces };
    }

    // ── Axis bookkeeping ──────────────────────────────────────────────────────
    // Returns [axisIdx, uIdx, vIdx] — the 3D component used for projection
    // (viewing direction) and the two components that span the 2D image plane.
    // Choices give right-handed, familiar orientations for each view.
    function axisIndices(axis) {
        switch (axis) {
            case 'x': return [0, 2, 1]; // side: u=Z, v=Y
            case 'z': return [2, 0, 1]; // front: u=X, v=Y
            default:  return [1, 0, 2]; // 'y' top: u=X, v=Z
        }
    }

    function computeBounds(vertices) {
        const min = [ Infinity,  Infinity,  Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const v of vertices) {
            for (let k = 0; k < 3; k++) {
                if (v[k] < min[k]) min[k] = v[k];
                if (v[k] > max[k]) max[k] = v[k];
            }
        }
        return { min, max };
    }

    // Compute pixel-space mapping: fits mesh UV range into out canvas with padding
    function fitMapping(bounds, uIdx, vIdx, outW, outH, pad) {
        const uRange = bounds.max[uIdx] - bounds.min[uIdx] || 1;
        const vRange = bounds.max[vIdx] - bounds.min[vIdx] || 1;
        const scale  = (1 - 2*pad) * Math.min(outW / uRange, outH / vRange);
        const offU   = (outW - uRange * scale) / 2;
        const offV   = (outH - vRange * scale) / 2;
        return { scale, offU, offV };
    }

    // ── MODE A: SILHOUETTE — union of projected triangles ─────────────────────
    // Draw each triangle as its own filled path. Using one fill per triangle
    // avoids the even-odd / winding cancellation bug that occurs when you batch
    // many overlapping triangles into a single path.
    function rasterizeSilhouette(vertices, faces, axis, outW, outH) {
        const [, uIdx, vIdx] = axisIndices(axis);
        const b = computeBounds(vertices);
        const { scale, offU, offV } = fitMapping(b, uIdx, vIdx, outW, outH, 0.04);

        const c = document.createElement('canvas');
        c.width  = outW;
        c.height = outH;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, outW, outH);
        ctx.fillStyle = '#ffffff';

        // Flip V so larger world-v maps to smaller image-y (image row 0 = top).
        // We flip at draw-time, so the output mask ends up in standard image
        // orientation (row 0 = top of the image).
        function project2D(vert) {
            const cu = (vert[uIdx] - b.min[uIdx]) * scale + offU;
            const cv = outH - ((vert[vIdx] - b.min[vIdx]) * scale + offV);
            return [cu, cv];
        }

        for (const [i0, i1, i2] of faces) {
            const [x0, y0] = project2D(vertices[i0]);
            const [x1, y1] = project2D(vertices[i1]);
            const [x2, y2] = project2D(vertices[i2]);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.closePath();
            ctx.fill(); // nonzero — but each triangle is convex, fills solidly
        }

        const img  = ctx.getImageData(0, 0, outW, outH);
        const mask = new Uint8Array(outW * outH);
        // Standard 50% threshold on Canvas's anti-aliased coverage — keeps
        // the silhouette visually faithful to the mesh. The solver's 1-texel
        // dilation in scene.js handles any sub-pixel walls that fall below
        // this threshold; we don't need to over-thicken the mesh here.
        for (let i = 0; i < mask.length; i++)
            mask[i] = img.data[i * 4] > 128 ? 255 : 0;
        return { data: mask, width: outW, height: outH };
    }

    // ── MODE B: CROSS-SECTION — axial ray-cast inside-mesh test ──────────────
    // For each output pixel (i, j):
    //   1. Map to world (u, v, axisCentre)
    //   2. Cast an axial ray in +axis direction
    //   3. Count ray-triangle intersections
    //   4. Odd count ⇒ point is inside mesh material ⇒ solid
    //
    // Acceleration: per-row active triangle list. Before each row, filter to
    // triangles whose world-v range straddles the row's world-v. Works
    // entirely in world coordinates — no pixel/bin conversion edge cases.
    function rasterizeSection(vertices, faces, axis, outW, outH) {
        const [aIdx, uIdx, vIdx] = axisIndices(axis);
        const b = computeBounds(vertices);
        const { scale, offU, offV } = fitMapping(b, uIdx, vIdx, outW, outH, 0.04);

        // Slice at the mesh centre along the viewing axis.
        const aMid = (b.min[aIdx] + b.max[aIdx]) * 0.5;

        // Flatten per-triangle data into parallel typed arrays for tight loops.
        const F = faces.length;
        const tu0 = new Float64Array(F), tu1 = new Float64Array(F), tu2 = new Float64Array(F);
        const tw0 = new Float64Array(F), tw1 = new Float64Array(F), tw2 = new Float64Array(F);
        const ta0 = new Float64Array(F), ta1 = new Float64Array(F), ta2 = new Float64Array(F);
        const tMinU = new Float64Array(F), tMaxU = new Float64Array(F);
        const tMinV = new Float64Array(F), tMaxV = new Float64Array(F);
        // keepAxial[fi] = 1 if triangle's axial extent can be hit by a +axis ray from aMid.
        const keepAxial = new Uint8Array(F);

        for (let fi = 0; fi < F; fi++) {
            const [i0, i1, i2] = faces[fi];
            const v0 = vertices[i0], v1 = vertices[i1], v2 = vertices[i2];
            const u0 = v0[uIdx], u1 = v1[uIdx], u2 = v2[uIdx];
            const w0 = v0[vIdx], w1 = v1[vIdx], w2 = v2[vIdx];
            const a0 = v0[aIdx], a1 = v1[aIdx], a2 = v2[aIdx];
            tu0[fi] = u0; tu1[fi] = u1; tu2[fi] = u2;
            tw0[fi] = w0; tw1[fi] = w1; tw2[fi] = w2;
            ta0[fi] = a0; ta1[fi] = a1; ta2[fi] = a2;
            tMinU[fi] = Math.min(u0, u1, u2);
            tMaxU[fi] = Math.max(u0, u1, u2);
            tMinV[fi] = Math.min(w0, w1, w2);
            tMaxV[fi] = Math.max(w0, w1, w2);
            keepAxial[fi] = (Math.max(a0, a1, a2) >= aMid) ? 1 : 0;
        }

        const mask = new Uint8Array(outW * outH);
        // Preallocate a scratch buffer for the active-triangle list. A typed
        // array avoids per-row allocation churn on big meshes.
        const active = new Int32Array(F);

        // Center-sample per output pixel. An earlier version 2×2
        // supersampled with any-sub-sample-inside → solid, which captured
        // sub-pixel walls but visibly over-thickened slanted edges by
        // ~½ source-pixel. The visual/solver split in `scene.js` makes
        // that over-thickening unnecessary: any wall that lands in the
        // mask at 1+ pixel width is sealed by the solver's mesh-region
        // dilation. Walls below 1 source-pixel width would not have been
        // user-visible at the rendered resolution anyway — dropping them
        // here is the faithful behavior.
        for (let j = 0; j < outH; j++) {
            // Inverse of worldToPixelV (image row 0 = top = max world v).
            const wv = (outH - j - 0.5 - offV) / scale + b.min[vIdx];

            // Build active list: triangles that cross this row AND can be hit.
            let numActive = 0;
            for (let fi = 0; fi < F; fi++) {
                if (!keepAxial[fi]) continue;
                if (wv < tMinV[fi] || wv > tMaxV[fi]) continue;
                active[numActive++] = fi;
            }

            for (let i = 0; i < outW; i++) {
                const wu = (i + 0.5 - offU) / scale + b.min[uIdx];

                let crossings = 0;
                for (let c = 0; c < numActive; c++) {
                    const fi = active[c];
                    if (wu < tMinU[fi] || wu > tMaxU[fi]) continue;

                    const u0 = tu0[fi], u1 = tu1[fi], u2 = tu2[fi];
                    const w0 = tw0[fi], w1 = tw1[fi], w2 = tw2[fi];

                    // Point-in-projected-triangle via edge sign tests.
                    const d0 = (u1 - u0) * (wv - w0) - (w1 - w0) * (wu - u0);
                    const d1 = (u2 - u1) * (wv - w1) - (w2 - w1) * (wu - u1);
                    const d2 = (u0 - u2) * (wv - w2) - (w0 - w2) * (wu - u2);
                    const anyNeg = (d0 < 0) || (d1 < 0) || (d2 < 0);
                    const anyPos = (d0 > 0) || (d1 > 0) || (d2 > 0);
                    if (anyNeg && anyPos) continue;

                    // area = 2·signed(v0,v1,v2); d1/area = λ_v0, d2/area = λ_v1,
                    // d0/area = λ_v2 (each d_k is 2·signed area of the opposite
                    // sub-triangle (P, v_{k+1}, v_{k+2})).
                    const area = d0 + d1 + d2;
                    if (area === 0) continue;
                    const b0 = d1 / area;
                    const b1 = d2 / area;
                    const b2 = d0 / area;
                    const hitA = b0 * ta0[fi] + b1 * ta1[fi] + b2 * ta2[fi];

                    if (hitA >= aMid) crossings++;
                }
                mask[j * outW + i] = (crossings & 1) ? 255 : 0;
            }
        }

        return { data: mask, width: outW, height: outH };
    }

    // ── Transform mask (flipX / flipY / rotate 0|90|180|270) ──────────────────
    function transformMask(data, w, h, opts) {
        let out = data, ow = w, oh = h;
        const { flipX, flipY, rotate } = opts || {};

        if (flipX) {
            const f = new Uint8Array(ow * oh);
            for (let j = 0; j < oh; j++)
                for (let i = 0; i < ow; i++)
                    f[j * ow + i] = out[j * ow + (ow - 1 - i)];
            out = f;
        }
        if (flipY) {
            const f = new Uint8Array(ow * oh);
            for (let j = 0; j < oh; j++)
                for (let i = 0; i < ow; i++)
                    f[j * ow + i] = out[(oh - 1 - j) * ow + i];
            out = f;
        }
        const rot = ((rotate || 0) % 360 + 360) % 360;
        if (rot === 90) {
            const r = new Uint8Array(oh * ow);
            for (let j = 0; j < oh; j++)
                for (let i = 0; i < ow; i++)
                    r[i * oh + (oh - 1 - j)] = out[j * ow + i];
            out = r; [ow, oh] = [oh, ow];
        } else if (rot === 180) {
            const r = new Uint8Array(ow * oh);
            for (let j = 0; j < oh; j++)
                for (let i = 0; i < ow; i++)
                    r[(oh - 1 - j) * ow + (ow - 1 - i)] = out[j * ow + i];
            out = r;
        } else if (rot === 270) {
            const r = new Uint8Array(oh * ow);
            for (let j = 0; j < oh; j++)
                for (let i = 0; i < ow; i++)
                    r[(ow - 1 - i) * oh + j] = out[j * ow + i];
            out = r; [ow, oh] = [oh, ow];
        }
        return { data: out, width: ow, height: oh };
    }

    function parseMesh(ext, payload) {
        if (ext === 'obj') return parseOBJ(payload);
        if (ext === 'stl') return parseSTL(payload);
        throw new Error('Unsupported format: ' + ext);
    }

    function voxelizeParsed(vertices, faces, axis, resolution, opts) {
        if (!vertices.length || !faces.length) {
            throw new Error('Empty mesh (no vertices / faces parsed)');
        }
        const mode = (opts && opts.mode) || 'section';
        const raw = (mode === 'silhouette')
            ? rasterizeSilhouette(vertices, faces, axis, resolution, resolution)
            : rasterizeSection   (vertices, faces, axis, resolution, resolution);
        const xformed = transformMask(raw.data, raw.width, raw.height, opts);
        let solid = 0;
        for (let i = 0; i < xformed.data.length; i++) if (xformed.data[i]) solid++;
        xformed.solidPixels   = solid;
        xformed.totalPixels   = xformed.data.length;
        xformed.triangleCount = faces.length;
        return xformed;
    }

    // Fetch an .stl / .obj from a URL and voxelize it into a 2D obstacle mask.
    // Used to load the built-in muzzle-device samples from the server.
    function voxelizeFromUrl(url, axis, resolution, opts) {
        axis       = axis       || 'y';
        resolution = resolution || 256;
        const ext  = url.split('.').pop().toLowerCase();
        return fetch(url).then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + url);
            return ext === 'obj' ? r.text() : r.arrayBuffer();
        }).then(payload => {
            const { vertices, faces } = parseMesh(ext, payload);
            return voxelizeParsed(vertices, faces, axis, resolution, opts);
        });
    }

    // Read a user-uploaded File (.stl / .obj) and voxelize it. CORS-safe —
    // never hits the network, so it works even when the page is opened via
    // file:// and fetch() would be blocked by the browser.
    function voxelizeFromFile(file, axis, resolution, opts) {
        axis       = axis       || 'y';
        resolution = resolution || 256;
        const ext  = file.name.split('.').pop().toLowerCase();
        return file.arrayBuffer().then(buf => {
            const payload = (ext === 'obj') ? new TextDecoder().decode(buf) : buf;
            const { vertices, faces } = parseMesh(ext, payload);
            return voxelizeParsed(vertices, faces, axis, resolution, opts);
        });
    }

    return { voxelizeFromUrl, voxelizeFromFile };

})();
