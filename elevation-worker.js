// elevation-worker.js
// Runs entirely off the main thread. Fetches Mapzen Terrarium tiles,
// decodes elevation from pixel data, and returns results via postMessage.

const tilePixelCache = new Map(); // persists across multiple route calculations

function lngLatToTilePixel(lng, lat, zoom) {
    const n = Math.pow(2, zoom);
    const tx = (lng + 180) / 360 * n;
    const sinLat = Math.sin(lat * Math.PI / 180);
    const ty = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n;
    const tileX = Math.floor(tx);
    const tileY = Math.floor(ty);
    return { tileX, tileY, pxX: (tx - tileX) * 256, pxY: (ty - tileY) * 256 };
}

function samplePixelData(imgData, px, py) {
    const x = Math.min(Math.max(px, 0.5), 255.5);
    const y = Math.min(Math.max(py, 0.5), 255.5);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, 255), y1 = Math.min(y0 + 1, 255);
    const fx = x - x0, fy = y - y0;

    function decode(ix, iy) {
        const p = (iy * 256 + ix) * 4;
        const r = imgData[p], g = imgData[p+1], b = imgData[p+2], a = imgData[p+3];
        if (a < 128) return null;
        const v = (r * 256 + g + b / 256) - 32768;
        return (v < -500 || v > 9000) ? null : v;
    }

    const v00 = decode(x0, y0), v10 = decode(x1, y0);
    const v01 = decode(x0, y1), v11 = decode(x1, y1);
    if (v00 === null && v10 === null && v01 === null && v11 === null) return null;
    const safe = v => v !== null ? v : (v00 ?? v10 ?? v01 ?? v11);
    return safe(v00) * (1-fx)*(1-fy) + safe(v10) * fx*(1-fy) +
           safe(v01) * (1-fx)*fy     + safe(v11) * fx*fy;
}

self.onmessage = async (e) => {
    const { id, coords } = e.data;
    const zoom = 14;
    const results = new Array(coords.length).fill(null);
    const tilesNeeded = {};

    for (let i = 0; i < coords.length; i++) {
        const { tileX, tileY } = lngLatToTilePixel(coords[i][0], coords[i][1], zoom);
        const key = `${zoom}/${tileX}/${tileY}`;
        if (!tilesNeeded[key]) tilesNeeded[key] = { tileX, tileY, indices: [] };
        tilesNeeded[key].indices.push(i);
    }

    const tileKeys = Object.keys(tilesNeeded);

    await Promise.all(tileKeys.map(async (key) => {
        let imgData = tilePixelCache.get(key);
        if (!imgData) {
            try {
                const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`);
                if (!res.ok) return;
                const blob = await res.blob();
                const img = await createImageBitmap(blob);
                const canvas = new OffscreenCanvas(256, 256);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                imgData = ctx.getImageData(0, 0, 256, 256).data;
                tilePixelCache.set(key, imgData);
            } catch (_) { return; }
        }
        for (const idx of tilesNeeded[key].indices) {
            const { pxX, pxY } = lngLatToTilePixel(coords[idx][0], coords[idx][1], zoom);
            results[idx] = samplePixelData(imgData, pxX, pxY);
        }
    }));

    self.postMessage({ id, elevations: results });
};
