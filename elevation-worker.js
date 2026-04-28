// elevation-worker.js
// Runs entirely off the main thread. Fetches Mapzen Terrarium tiles,
// decodes elevation from pixel data, and returns results via postMessage.
//
// Strategy: batch all unique tiles needed (including neighbors for boundary
// cross-interpolation) into a single parallel fetch pass, then sample
// synchronously. This avoids spawning per-point async work.

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

function decodePixel(imgData, ix, iy) {
    if (!imgData) return null;
    const x = Math.min(Math.max(Math.round(ix), 0), 255);
    const y = Math.min(Math.max(Math.round(iy), 0), 255);
    const p = (y * 256 + x) * 4;
    const r = imgData[p], g = imgData[p+1], b = imgData[p+2], a = imgData[p+3];
    if (a < 128) return null;
    const v = (r * 256 + g + b / 256) - 32768;
    return (v < -500 || v > 9000) ? null : v;
}

// Cross-tile bilinear interpolation — fully synchronous, all tiles pre-fetched.
function sampleElevationSync(tileCache, zoom, tileX, tileY, pxX, pxY) {
    const x0 = Math.floor(pxX), y0 = Math.floor(pxY);
    const x1 = x0 + 1, y1 = y0 + 1;
    const fx = pxX - x0, fy = pxY - y0;

    // Resolve each corner to the correct tile + local pixel coords
    function resolve(px, py) {
        const dtx = px >= 256 ? 1 : 0;
        const dty = py >= 256 ? 1 : 0;
        const key = `${zoom}/${tileX + dtx}/${tileY + dty}`;
        return { data: tileCache.get(key) ?? null, ix: px % 256, iy: py % 256 };
    }

    const c00 = resolve(x0, y0), c10 = resolve(x1, y0);
    const c01 = resolve(x0, y1), c11 = resolve(x1, y1);

    const v00 = decodePixel(c00.data, c00.ix, c00.iy);
    const v10 = decodePixel(c10.data, c10.ix, c10.iy);
    const v01 = decodePixel(c01.data, c01.ix, c01.iy);
    const v11 = decodePixel(c11.data, c11.ix, c11.iy);

    const anyValid = v00 ?? v10 ?? v01 ?? v11;
    if (anyValid === null || anyValid === undefined) return null;
    const safe = v => (v !== null && v !== undefined) ? v : anyValid;
    return safe(v00)*(1-fx)*(1-fy) + safe(v10)*fx*(1-fy) +
           safe(v01)*(1-fx)*fy     + safe(v11)*fx*fy;
}

self.onmessage = async (e) => {
    const { id, coords } = e.data;
    const zoom = 15;
    const results = new Array(coords.length).fill(null);

    // Pass 1: collect every unique tile key needed (including +1 neighbors for
    // cross-tile interpolation at boundaries — costs at most ~4x more tiles but
    // these are unique keys so typically adds only a small fringe set).
    const tilesNeeded = new Set();
    for (const coord of coords) {
        const { tileX, tileY, pxX, pxY } = lngLatToTilePixel(coord[0], coord[1], zoom);
        tilesNeeded.add(`${zoom}/${tileX}/${tileY}`);
        // Neighbor tiles for boundary interpolation
        if (pxX > 254) tilesNeeded.add(`${zoom}/${tileX + 1}/${tileY}`);
        if (pxY > 254) tilesNeeded.add(`${zoom}/${tileX}/${tileY + 1}`);
        if (pxX > 254 && pxY > 254) tilesNeeded.add(`${zoom}/${tileX + 1}/${tileY + 1}`);
    }

    // Pass 2: fetch all unique tiles in parallel (already-cached tiles skip fetch)
    const localCache = new Map();
    await Promise.all([...tilesNeeded].map(async (key) => {
        if (tilePixelCache.has(key)) {
            localCache.set(key, tilePixelCache.get(key));
            return;
        }
        try {
            const res = await fetch(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${key}.png`);
            if (!res.ok) return;
            const blob = await res.blob();
            const img = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(256, 256);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, 256, 256).data;
            tilePixelCache.set(key, data);
            localCache.set(key, data);
        } catch (_) { /* tile unavailable */ }
    }));

    // Pass 3: sample all coordinates synchronously from pre-fetched tiles
    for (let i = 0; i < coords.length; i++) {
        const { tileX, tileY, pxX, pxY } = lngLatToTilePixel(coords[i][0], coords[i][1], zoom);
        results[i] = sampleElevationSync(localCache, zoom, tileX, tileY, pxX, pxY);
    }

    self.postMessage({ id, elevations: results });
};
