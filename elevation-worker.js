// elevation-worker.js
// Runs entirely off the main thread. Fetches elevation tiles,
// decodes elevation from pixel data, and returns results via postMessage.
// Supports Mapbox Terrain-RGB (high-res) and Mapzen Terrarium (fallback).

const tilePixelCache = new Map();

function lngLatToTilePixel(lng, lat, zoom) {
    const n = Math.pow(2, zoom);
    const tx = (lng + 180) / 360 * n;
    const sinLat = Math.sin(lat * Math.PI / 180);
    const ty = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n;
    const tileX = Math.floor(tx);
    const tileY = Math.floor(ty);
    return { tileX, tileY, pxX: (tx - tileX) * 256, pxY: (ty - tileY) * 256 };
}

function decodePixel(tile, ix, iy) {
    if (!tile || !tile.data) return null;
    const { data, format } = tile;
    const x = Math.min(Math.max(Math.round(ix), 0), 255);
    const y = Math.min(Math.max(Math.round(iy), 0), 255);
    const p = (y * 256 + x) * 4;
    const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
    if (a < 128) return null;

    if (format === 'mapbox') {
        // Mapbox Terrain-RGB: (R * 65536 + G * 256 + B) * 0.1 - 10000
        const v = (r * 65536 + g * 256 + b) * 0.1 - 10000;
        // Filter out extreme outliers, specifically the -10,000m no-data value
        return (v < -1000 || v > 9000) ? null : v;
    } else {
        // Mapzen Terrarium: (R * 256 + G + B / 256) - 32768
        const v = (r * 256 + g + b / 256) - 32768;
        return (v < -1000 || v > 9000) ? null : v;
    }
}

// Cross-tile bilinear interpolation — fully synchronous, all tiles pre-fetched.
function sampleElevationSync(tileCache, zoom, tileX, tileY, pxX, pxY) {
    const x0 = Math.floor(pxX), y0 = Math.floor(pxY);
    const x1 = x0 + 1, y1 = y0 + 1;
    const fx = pxX - x0, fy = pxY - y0;

    function resolve(px, py) {
        const dtx = px >= 256 ? 1 : 0;
        const dty = py >= 256 ? 1 : 0;
        const key = `${zoom}/${tileX + dtx}/${tileY + dty}`;
        return { tile: tileCache.get(key) ?? null, ix: px % 256, iy: py % 256 };
    }

    const c00 = resolve(x0, y0), c10 = resolve(x1, y0);
    const c01 = resolve(x0, y1), c11 = resolve(x1, y1);

    const v00 = decodePixel(c00.tile, c00.ix, c00.iy);
    const v10 = decodePixel(c10.tile, c10.ix, c10.iy);
    const v01 = decodePixel(c01.tile, c01.ix, c01.iy);
    const v11 = decodePixel(c11.tile, c11.ix, c11.iy);

    const anyValid = v00 ?? v10 ?? v01 ?? v11;
    if (anyValid === null || anyValid === undefined) return null;
    const safe = v => (v !== null && v !== undefined) ? v : anyValid;
    return safe(v00) * (1 - fx) * (1 - fy) + safe(v10) * fx * (1 - fy) +
        safe(v01) * (1 - fx) * fy + safe(v11) * fx * fy;
}

// Haversine distance formula inside worker
function getDistance(coord1, coord2) {
    const R = 6371000;
    const lat1 = coord1[1] * Math.PI / 180;
    const lat2 = coord2[1] * Math.PI / 180;
    const dLat = (coord2[1] - coord1[1]) * Math.PI / 180;
    const dLon = (coord2[0] - coord1[0]) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function densifyCoords(coords, maxSpacing = 15.0) {
    if (coords.length < 2) return coords;
    const dense = [coords[0]];
    for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i], p2 = coords[i + 1];
        const d = getDistance(p1, p2);
        if (d > maxSpacing) {
            const numDivisions = Math.ceil(d / maxSpacing);
            for (let k = 1; k < numDivisions; k++) {
                const t = k / numDivisions;
                dense.push([
                    p1[0] + t * (p2[0] - p1[0]),
                    p1[1] + t * (p2[1] - p1[1])
                ]);
            }
        }
        dense.push(p2);
    }
    return dense;
}

function smoothElevationsForWay(elevations, coords) {
    if (elevations.length < 3) return elevations;
    const smoothed = [...elevations];
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < elevations.length - 1; i++) {
            const v = smoothed[i], prev = smoothed[i - 1], next = smoothed[i + 1];
            if (v == null || prev == null || next == null) continue;
            const d1 = getDistance(coords[i - 1], coords[i]);
            const d2 = getDistance(coords[i], coords[i + 1]);
            const rise1 = Math.abs(v - prev);
            const rise2 = Math.abs(v - next);
            if (d1 > 0 && d2 > 0 && (rise1 / d1 > 0.4) && (rise2 / d2 > 0.4)) {
                smoothed[i] = (prev + next) / 2;
            }
        }
    }
    const result = [];
    for (let i = 0; i < elevations.length; i++) {
        let sum = 0, count = 0;
        for (let k = -2; k <= 2; k++) {
            const idx = Math.min(Math.max(i + k, 0), elevations.length - 1);
            if (smoothed[idx] != null) {
                sum += smoothed[idx];
                count++;
            }
        }
        result.push(count > 0 ? sum / count : elevations[i]);
    }
    return result;
}

function getElevationAtPoint(p, denseCoords, smoothedElevs) {
    if (denseCoords.length < 2) return smoothedElevs[0] ?? null;
    let bestIdx = 0;
    let minD = Infinity;
    for (let i = 0; i < denseCoords.length - 1; i++) {
        const p1 = denseCoords[i], p2 = denseCoords[i + 1];
        const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;
        let t = ((p[0] - p1[0]) * dx + (p[1] - p1[1]) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const proj = [p1[0] + t * dx, p1[1] + t * dy];
        const dist = getDistance(p, proj);
        if (dist < minD) {
            minD = dist;
            bestIdx = i;
        }
    }
    const p1 = denseCoords[bestIdx], p2 = denseCoords[bestIdx + 1];
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
        t = ((p[0] - p1[0]) * dx + (p[1] - p1[1]) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
    }
    const e1 = smoothedElevs[bestIdx];
    const e2 = smoothedElevs[bestIdx + 1];
    if (e1 != null && e2 != null) return e1 + t * (e2 - e1);
    return e1 ?? e2 ?? null;
}

function splitWayIntoSegments(coords, wayId, maxLen = 80.0) {
    const segments = [];
    if (coords.length < 2) return segments;
    const cumDists = [0];
    let totalDist = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        totalDist += getDistance(coords[i], coords[i + 1]);
        cumDists.push(totalDist);
    }
    if (totalDist <= 0.1) return segments;
    const numSegs = Math.ceil(totalDist / maxLen);
    const segLen = totalDist / numSegs;

    function getPointAtDist(d) {
        if (d <= 0) return { pt: coords[0], idx: 0 };
        if (d >= totalDist) return { pt: coords[coords.length - 1], idx: coords.length - 2 };
        let lo = 0, hi = cumDists.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cumDists[mid] < d) lo = mid + 1; else hi = mid;
        }
        const idx = lo - 1;
        const p1 = coords[idx], p2 = coords[idx + 1];
        const segD = cumDists[idx + 1] - cumDists[idx];
        const t = segD > 0 ? (d - cumDists[idx]) / segD : 0;
        return {
            pt: [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])],
            idx: idx
        };
    }

    for (let s = 0; s < numSegs; s++) {
        const startD = s * segLen;
        const endD = (s + 1) * segLen;
        const midD = (startD + endD) / 2;
        const segCoords = [getPointAtDist(startD).pt];
        for (let i = 1; i < coords.length - 1; i++) {
            if (cumDists[i] > startD && cumDists[i] < endD) {
                segCoords.push(coords[i]);
            }
        }
        segCoords.push(getPointAtDist(endD).pt);
        segments.push({
            id: `${wayId}_${s}`,
            coordinates: segCoords,
            distance: segLen,
            centerDist: midD,
            totalWayDist: totalDist
        });
    }
    return segments;
}

self.onmessage = async (e) => {
    const { id, type } = e.data;
    const zoom = 15;

    if (type === 'process-grade-ways') {
        const { ways } = e.data;
        const uniqueCoordsMap = new Map();
        const uniqueCoordsArray = [];
        const getCoordKey = (coord) => `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;

        // Densify coordinates and gather unique coordinates
        for (const wayItem of ways) {
            wayItem.denseCoords = densifyCoords(wayItem.geomCoords, 15.0);
            for (const coord of wayItem.denseCoords) {
                const key = getCoordKey(coord);
                if (!uniqueCoordsMap.has(key)) {
                    uniqueCoordsMap.set(key, uniqueCoordsArray.length);
                    uniqueCoordsArray.push(coord);
                }
            }
        }

        // Determine tiles needed
        const tilesNeeded = new Set();
        for (const coord of uniqueCoordsArray) {
            const { tileX, tileY, pxX, pxY } = lngLatToTilePixel(coord[0], coord[1], zoom);
            tilesNeeded.add(`${zoom}/${tileX}/${tileY}`);
            if (pxX > 254) tilesNeeded.add(`${zoom}/${tileX + 1}/${tileY}`);
            if (pxY > 254) tilesNeeded.add(`${zoom}/${tileX}/${tileY + 1}`);
            if (pxX > 254 && pxY > 254) tilesNeeded.add(`${zoom}/${tileX + 1}/${tileY + 1}`);
        }

        // Fetch tiles and cache
        const localCache = new Map();
        await Promise.all([...tilesNeeded].map(async (key) => {
            if (tilePixelCache.has(key)) {
                localCache.set(key, tilePixelCache.get(key));
                return;
            }
            let data = null;
            let format = 'terrarium';
            try {
                const mzRes = await fetch(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${key}.png`);
                if (mzRes.ok) {
                    const blob = await mzRes.blob();
                    const img = await createImageBitmap(blob);
                    const canvas = new OffscreenCanvas(256, 256);
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0);
                    data = ctx.getImageData(0, 0, 256, 256).data;
                }
            } catch (_) { }
            if (data) {
                const entry = { data, format };
                tilePixelCache.set(key, entry);
                localCache.set(key, entry);
            }
        }));

        // Sample unique elevations
        const uniqueElevations = new Array(uniqueCoordsArray.length).fill(null);
        for (let i = 0; i < uniqueCoordsArray.length; i++) {
            const { tileX, tileY, pxX, pxY } = lngLatToTilePixel(uniqueCoordsArray[i][0], uniqueCoordsArray[i][1], zoom);
            uniqueElevations[i] = sampleElevationSync(localCache, zoom, tileX, tileY, pxX, pxY);
        }

        // Process ways and compute segments
        const allProcessedSegments = [];
        for (const wayItem of ways) {
            const denseElevs = wayItem.denseCoords.map(coord => {
                const key = getCoordKey(coord);
                return uniqueElevations[uniqueCoordsMap.get(key)] ?? null;
            });

            const smoothedElevs = smoothElevationsForWay(denseElevs, wayItem.denseCoords);
            const segments = splitWayIntoSegments(wayItem.geomCoords, wayItem.wayId);

            const cumDists = [0];
            let totalDist = 0;
            for (let i = 0; i < wayItem.geomCoords.length - 1; i++) {
                totalDist += getDistance(wayItem.geomCoords[i], wayItem.geomCoords[i + 1]);
                cumDists.push(totalDist);
            }

            function getPointAtDistInWorker(d) {
                const clampedD = Math.max(0, Math.min(totalDist, d));
                let lo = 0, hi = cumDists.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (cumDists[mid] < clampedD) lo = mid + 1; else hi = mid;
                }
                const idx = Math.max(0, lo - 1);
                const p1 = wayItem.geomCoords[idx], p2 = wayItem.geomCoords[idx + 1] ?? p1;
                const segD = cumDists[idx + 1] - cumDists[idx];
                const t = segD > 0 ? (clampedD - cumDists[idx]) / segD : 0;
                return [
                    p1[0] + t * (p2[0] - p1[0]),
                    p1[1] + t * (p2[1] - p1[1])
                ];
            }

            for (const seg of segments) {
                const baseline = Math.max(60.0, seg.distance);
                const dStart = seg.centerDist - baseline / 2;
                const dEnd = seg.centerDist + baseline / 2;
                const coordStart = getPointAtDistInWorker(dStart);
                const coordEnd = getPointAtDistInWorker(dEnd);

                const elevStart = getElevationAtPoint(coordStart, wayItem.denseCoords, smoothedElevs);
                const elevEnd = getElevationAtPoint(coordEnd, wayItem.denseCoords, smoothedElevs);

                if (elevStart !== null && elevEnd !== null) {
                    const rise = Math.abs(elevEnd - elevStart);
                    const actualRun = Math.max(50.0, Math.min(dEnd, totalDist) - Math.max(0, dStart));
                    seg.gradePercent = (rise / actualRun) * 100;
                } else {
                    seg.gradePercent = 0;
                }
            }

            // Calculate overall average grade for the way using first/last non-null elevations
            let firstElev = null;
            let lastElev = null;
            for (let i = 0; i < smoothedElevs.length; i++) {
                if (smoothedElevs[i] !== null) {
                    firstElev = smoothedElevs[i];
                    break;
                }
            }
            for (let i = smoothedElevs.length - 1; i >= 0; i--) {
                if (smoothedElevs[i] !== null) {
                    lastElev = smoothedElevs[i];
                    break;
                }
            }
            const overallGrade = (firstElev !== null && lastElev !== null && totalDist > 0)
                ? (Math.abs(lastElev - firstElev) / totalDist) * 100
                : 0;

            const threshold = Math.max(overallGrade * 2.2 + 2.5, 4.5);

            // Apply neighbor-grade adoption threshold checks
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                if (seg.gradePercent > threshold) {
                    let leftGrade = null;
                    if (i > 0 && segments[i - 1].gradePercent <= threshold) {
                        leftGrade = segments[i - 1].gradePercent;
                    }
                    let rightGrade = null;
                    if (i < segments.length - 1 && segments[i + 1].gradePercent <= threshold) {
                        rightGrade = segments[i + 1].gradePercent;
                    }

                    if (leftGrade !== null && rightGrade !== null) {
                        seg.gradePercent = (leftGrade + rightGrade) / 2;
                    } else if (leftGrade !== null) {
                        seg.gradePercent = leftGrade;
                    } else if (rightGrade !== null) {
                        seg.gradePercent = rightGrade;
                    } else {
                        seg.gradePercent = overallGrade;
                    }
                }
                seg.grade = Math.min(seg.gradePercent, 20);

                const segElevStart = getElevationAtPoint(seg.coordinates[0], wayItem.denseCoords, smoothedElevs);
                const segElevEnd = getElevationAtPoint(seg.coordinates[seg.coordinates.length - 1], wayItem.denseCoords, smoothedElevs);
                if (segElevStart !== null && segElevEnd !== null && segElevStart > segElevEnd) {
                    seg.coordinates.reverse();
                }
            }
            allProcessedSegments.push({
                wayId: wayItem.wayId,
                segments: segments
            });
        }

        self.postMessage({ id, type, processedWays: allProcessedSegments });
        return;
    }

    // Legacy point-elevation query path (used by main route planner)
    const { coords } = e.data;
    const results = new Array(coords.length).fill(null);
    const tilesNeeded = new Set();
    for (const coord of coords) {
        const { tileX, tileY, pxX, pxY } = lngLatToTilePixel(coord[0], coord[1], zoom);
        tilesNeeded.add(`${zoom}/${tileX}/${tileY}`);
        if (pxX > 254) tilesNeeded.add(`${zoom}/${tileX + 1}/${tileY}`);
        if (pxY > 254) tilesNeeded.add(`${zoom}/${tileX}/${tileY + 1}`);
        if (pxX > 254 && pxY > 254) tilesNeeded.add(`${zoom}/${tileX + 1}/${tileY + 1}`);
    }

    const localCache = new Map();
    await Promise.all([...tilesNeeded].map(async (key) => {
        if (tilePixelCache.has(key)) {
            localCache.set(key, tilePixelCache.get(key));
            return;
        }
        let data = null;
        let format = 'terrarium';
        try {
            const mzRes = await fetch(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${key}.png`);
            if (mzRes.ok) {
                const blob = await mzRes.blob();
                const img = await createImageBitmap(blob);
                const canvas = new OffscreenCanvas(256, 256);
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0);
                data = ctx.getImageData(0, 0, 256, 256).data;
            }
        } catch (_) { }
        if (data) {
            const entry = { data, format };
            tilePixelCache.set(key, entry);
            localCache.set(key, entry);
        }
    }));

    for (let i = 0; i < coords.length; i++) {
        const { tileX, tileY, pxX, pxY } = lngLatToTilePixel(coords[i][0], coords[i][1], zoom);
        results[i] = sampleElevationSync(localCache, zoom, tileX, tileY, pxX, pxY);
    }

    self.postMessage({ id, elevations: results });
};
