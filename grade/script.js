// grade/script.js

// Shared map styles
const VECTOR_STYLES = {
    dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    light: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    positron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
};

const RASTER_BASEMAPS = {
    topo: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    cyclosm: [
        'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png'
    ],
    osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
};

function buildRasterStyle(tileUrl) {
    const tiles = Array.isArray(tileUrl) ? tileUrl : [tileUrl];
    return {
        version: 8,
        sources: {
            basemap: {
                type: 'raster',
                tiles: tiles,
                tileSize: 256,
                maxzoom: 20
            }
        },
        layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': '#111' } },
            { id: 'basemap-layer', type: 'raster', source: 'basemap' }
        ]
    };
}

// Caching and map state
let currentBasemap = localStorage.getItem('route_basemap') || 'cyclosm';
const cachedCenter = localStorage.getItem('last_map_center');
const cachedZoom = localStorage.getItem('last_map_zoom');
const initialCenter = cachedCenter ? JSON.parse(cachedCenter) : [-122.4194, 37.7749]; // Fallback to SF
const initialZoom = cachedZoom ? parseFloat(cachedZoom) : 14;

// Initialize MapLibre
const map = new maplibregl.Map({
    container: 'map',
    style: VECTOR_STYLES[currentBasemap] || buildRasterStyle(RASTER_BASEMAPS[currentBasemap]),
    center: initialCenter,
    zoom: initialZoom,
    maxZoom: 20,
    maxPitch: 85,
    projection: { type: localStorage.getItem('route_projection') || 'mercator' },
    antialias: false,
    fadeDuration: 0,
    trackResize: true
});

map.dragRotate.enable();
map.touchZoomRotate.enable();

// Double right-click to reset orientation
let lastRightClickTime = 0;
map.getCanvasContainer().addEventListener('mousedown', (e) => {
    if (e.button === 2) {
        const now = Date.now();
        if (now - lastRightClickTime < 350) {
            e.preventDefault();
            e.stopPropagation();
            map.flyTo({ bearing: 0, pitch: 0 });
            lastRightClickTime = 0;
            return;
        }
        lastRightClickTime = now;
    }
}, true);

// Setup elevation worker (located in parent folder)
const elevationWorker = new Worker('../elevation-worker.js?v=' + Date.now());
const _workerCallbacks = new Map();
let _nextWorkerId = 0;

elevationWorker.onmessage = (e) => {
    const cb = _workerCallbacks.get(e.data.id);
    if (cb) {
        _workerCallbacks.delete(e.data.id);
        cb(e.data.elevations);
    }
};

function getHighResElevation(coords) {
    return new Promise(resolve => {
        const id = _nextWorkerId++;
        _workerCallbacks.set(id, resolve);
        elevationWorker.postMessage({ id, coords });
    });
}

// Haversine distance formula
function getDistance(coord1, coord2) {
    const R = 6371000; // Earth's radius in meters
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

// Densify coordinate list to ensure we have nodes at least every maxSegmentLen meters and at least minPoints nodes
function densifyCoordinates(coords, maxSegmentLen = 15, minPoints = 5) {
    const densified = [coords[0]];
    if (coords.length < 2) return coords;

    // Calculate total way distance
    let totalDist = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        totalDist += getDistance(coords[i], coords[i+1]);
    }

    // Determine target spacing to satisfy both maxSegmentLen and minPoints
    let spacing = maxSegmentLen;
    if (totalDist > 0) {
        const minSegments = minPoints - 1;
        const maxSpacingForMinPoints = totalDist / minSegments;
        spacing = Math.min(maxSegmentLen, maxSpacingForMinPoints);
    }

    for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i+1];
        const d = getDistance(p1, p2);
        if (d > spacing) {
            const steps = Math.ceil(d / spacing);
            for (let j = 1; j < steps; j++) {
                const t = j / steps;
                const lng = p1[0] + t * (p2[0] - p1[0]);
                const lat = p1[1] + t * (p2[1] - p1[1]);
                densified.push([lng, lat]);
            }
        }
        densified.push(p2);
    }
    return densified;
}

// Interpolate elevation at any coord along the densified way profile using clamped projection
function getInterpolatedElevation(coord, denseCoords, denseElevs) {
    if (denseCoords.length === 0) return null;
    if (denseCoords.length === 1) return denseElevs[0];

    let minD = Infinity;
    let bestSegmentIdx = 0; // index of the start of the segment
    let bestT = 0;

    // Find the segment [i, i+1] that is closest to coord
    for (let i = 0; i < denseCoords.length - 1; i++) {
        const A = denseCoords[i];
        const B = denseCoords[i+1];
        
        // Vector projection of coord onto segment AB
        const dx = B[0] - A[0];
        const dy = B[1] - A[1];
        const lenSq = dx * dx + dy * dy;
        
        let t = 0;
        if (lenSq > 0) {
            const ux = coord[0] - A[0];
            const uy = coord[1] - A[1];
            t = (ux * dx + uy * dy) / lenSq;
            // Clamp projection factor to the segment bounds [0, 1]
            t = Math.max(0, Math.min(1, t));
        }
        
        // Find the projected point coordinates
        const projPoint = [A[0] + t * dx, A[1] + t * dy];
        
        // Euclidean distance squared (degrees) - extremely fast, avoids heavy trig in inner loop
        const px = coord[0] - projPoint[0];
        const py = coord[1] - projPoint[1];
        const dSq = px * px + py * py;
        
        if (dSq < minD) {
            minD = dSq;
            bestSegmentIdx = i;
            bestT = t;
        }
    }

    const eStart = denseElevs[bestSegmentIdx];
    const eEnd = denseElevs[bestSegmentIdx + 1];
    
    if (eStart === null || eStart === undefined || eEnd === null || eEnd === undefined) {
        return eStart ?? eEnd ?? null;
    }

    return eStart + bestT * (eEnd - eStart);
}

// Calculate the least squares slope of a segment based on all its node coordinates and elevations
function calculateLeastSquaresSlope(coords, elevations) {
    const N = coords.length;
    if (N < 2) return 0;

    // Calculate cumulative distances along the segment
    const x = [0];
    let distAcc = 0;
    for (let i = 1; i < N; i++) {
        distAcc += getDistance(coords[i - 1], coords[i]);
        x.push(distAcc);
    }

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    let validCount = 0;

    for (let i = 0; i < N; i++) {
        const xi = x[i];
        const yi = elevations[i];
        if (yi === null || yi === undefined) continue;
        sumX += xi;
        sumY += yi;
        sumXY += xi * yi;
        sumXX += xi * xi;
        validCount++;
    }

    if (validCount < 2) return 0;

    const denom = validCount * sumXX - sumX * sumX;
    if (denom === 0) return 0;

    const slope = (validCount * sumXY - sumX * sumY) / denom;
    return isNaN(slope) ? 0 : slope;
}

// Fill any null or undefined elevations in the way using linear interpolation to prevent flat 0% fallbacks
function fillNullElevations(elevations) {
    const N = elevations.length;
    if (N === 0) return;

    let firstNonNullIdx = -1;
    for (let i = 0; i < N; i++) {
        if (elevations[i] !== null && elevations[i] !== undefined) {
            firstNonNullIdx = i;
            break;
        }
    }

    if (firstNonNullIdx === -1) {
        for (let i = 0; i < N; i++) elevations[i] = 0;
        return;
    }

    for (let i = 0; i < firstNonNullIdx; i++) {
        elevations[i] = elevations[firstNonNullIdx];
    }

    let lastValidIdx = firstNonNullIdx;
    for (let i = firstNonNullIdx + 1; i < N; i++) {
        const v = elevations[i];
        if (v !== null && v !== undefined) {
            if (i - lastValidIdx > 1) {
                const startVal = elevations[lastValidIdx];
                const endVal = v;
                const steps = i - lastValidIdx;
                for (let j = 1; j < steps; j++) {
                    elevations[lastValidIdx + j] = startVal + (j / steps) * (endVal - startVal);
                }
            }
            lastValidIdx = i;
        }
    }

    for (let i = lastValidIdx + 1; i < N; i++) {
        elevations[i] = elevations[lastValidIdx];
    }
}

// Smooth elevations along the way using despiking and Gaussian filtering (matching the main app's route profile logic)
function smoothWayElevations(denseCoords, elevations) {
    if (elevations.length < 3) return;

    // Boundary despiker for start node
    const d01 = getDistance(denseCoords[0], denseCoords[1]);
    const d12 = getDistance(denseCoords[1], denseCoords[2]);
    if (d01 > 0 && d12 > 0 && elevations[0] !== null && elevations[1] !== null && elevations[2] !== null) {
        const g01 = Math.abs(elevations[0] - elevations[1]) / d01;
        const g12 = Math.abs(elevations[1] - elevations[2]) / d12;
        if (g01 > 0.25 && g01 > g12 * 2.0) {
            elevations[0] = elevations[1];
        }
    }

    // Boundary despiker for end node
    const n = elevations.length;
    const dN_2_1 = getDistance(denseCoords[n - 2], denseCoords[n - 1]);
    const dN_3_2 = getDistance(denseCoords[n - 3], denseCoords[n - 2]);
    if (dN_2_1 > 0 && dN_3_2 > 0 && elevations[n - 1] !== null && elevations[n - 2] !== null && elevations[n - 3] !== null) {
        const gN_2_1 = Math.abs(elevations[n - 1] - elevations[n - 2]) / dN_2_1;
        const gN_3_2 = Math.abs(elevations[n - 2] - elevations[n - 3]) / dN_3_2;
        if (gN_2_1 > 0.25 && gN_2_1 > gN_3_2 * 2.0) {
            elevations[n - 1] = elevations[n - 2];
        }
    }

    // Pass 1: Isolation despiker — eliminates single-point glitches.
    for (let pass = 0; pass < 6; pass++) {
        const readElevs = [...elevations];
        for (let i = 1; i < elevations.length - 1; i++) {
            const v = readElevs[i];
            const prev = readElevs[i - 1];
            const next = readElevs[i + 1];
            if (v == null || prev == null || next == null) continue;

            const d1 = getDistance(denseCoords[i - 1], denseCoords[i]);
            const d2 = getDistance(denseCoords[i], denseCoords[i + 1]);
            if (d1 <= 0 || d2 <= 0) continue;
            const rise1 = Math.abs(v - prev);
            const rise2 = Math.abs(v - next);
            const neighborDiff = Math.abs(prev - next);
            const mean = (prev + next) / 2;

            const isOutlier = rise1 > d1 * 0.2 && rise2 > d2 * 0.2;
            const neighborsAgree = neighborDiff < Math.min(rise1, rise2) * 0.5;
            const isNoise = rise1 > 0.5 && rise2 > 0.5 && Math.abs(v - mean) > 0.4;

            if ((isOutlier && neighborsAgree) || isNoise) {
                elevations[i] = mean;
            }
        }
    }

    // Pass 2: Two-tier grade-based filter.
    for (let pass = 0; pass < 5; pass++) {
        const readElevs = [...elevations];
        for (let i = 1; i < elevations.length - 1; i++) {
            const v = readElevs[i], prev = readElevs[i - 1], next = readElevs[i + 1];
            if (v == null || prev == null || next == null) continue;
            const d1 = getDistance(denseCoords[i - 1], denseCoords[i]);
            const d2 = getDistance(denseCoords[i], denseCoords[i + 1]);
            if (d1 <= 0 || d2 <= 0) continue;
            const rise1 = Math.abs(v - prev);
            const rise2 = Math.abs(v - next);
            const g1 = rise1 / d1;
            const g2 = rise2 / d2;
            if (g1 > 1.0 && g2 > 1.0) {
                elevations[i] = (prev + next) / 2;
            } else if (g1 > 0.6 && g2 > 0.6) {
                const neighborDiff = Math.abs(prev - next);
                if (neighborDiff < Math.min(rise1, rise2) * 0.5) {
                    elevations[i] = (prev + next) / 2;
                }
            }
        }
    }

    // Gaussian smoothing kernel (15-point symmetric kernel, sigma ~ 3)
    const GAUSS = [
        0.012, 0.025, 0.047, 0.075, 0.108, 0.138, 0.157, 0.164,
        0.157, 0.138, 0.108, 0.075, 0.047, 0.025, 0.012
    ];
    const WIN_HALF = 7;
    const smoothedElevs = elevations.map((v, i) => {
        if (v == null) return null;
        let sum = 0, weight = 0;
        for (let k = -WIN_HALF; k <= WIN_HALF; k++) {
            const idx = i + k;
            if (idx >= 0 && idx < elevations.length) {
                const e = elevations[idx];
                if (e != null) {
                    const w = GAUSS[k + WIN_HALF];
                    sum += e * w;
                    weight += w;
                }
            }
        }
        return weight > 0 ? sum / weight : v;
    });
    for (let i = 0; i < elevations.length; i++) elevations[i] = smoothedElevs[i];
}

// Split way into equal-length segments targeting ~180 meters, ensuring no tiny tail segments
function splitWayIntoSegments(coords, wayId, targetLen = 180) {
    const segments = [];
    if (coords.length < 2) return segments;

    // Calculate total way distance
    let totalDist = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        totalDist += getDistance(coords[i], coords[i+1]);
    }

    const numSegs = Math.max(1, Math.round(totalDist / targetLen));
    const segLen = totalDist / numSegs;

    let currentSegment = [coords[0]];
    let currentDist = 0;
    let segIdx = 0;

    for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i+1];
        const d = getDistance(p1, p2);

        let rem = d;
        let prevPoint = p1;

        while (segIdx < numSegs - 1 && currentDist + rem > segLen) {
            const needed = segLen - currentDist;
            const t = needed / rem;

            const lng = prevPoint[0] + t * (p2[0] - prevPoint[0]);
            const lat = prevPoint[1] + t * (p2[1] - prevPoint[1]);
            const splitPoint = [lng, lat];

            currentSegment.push(splitPoint);
            segments.push({
                id: `${wayId}_${segIdx++}`,
                coordinates: currentSegment,
                distance: segLen
            });

            currentSegment = [splitPoint];
            currentDist = 0;

            prevPoint = splitPoint;
            rem = rem - needed;
        }

        currentSegment.push(p2);
        currentDist += rem;
    }

    if (currentSegment.length >= 2) {
        segments.push({
            id: `${wayId}_${segIdx++}`,
            coordinates: currentSegment,
            distance: currentDist
        });
    }

    return segments;
}

// Cache for processed ways: wayId -> Array of Segment objects
const wayCache = new Map();
const GRID_SIZE = 0.015; // Grid cell size in degrees (approx 1.6km)
const processedCells = new Set();
let activeQueue = [];
let isQueueRunning = false;

// Sticky/locked popup state
let stickySegmentId = null;
let hoveredSegmentId = null;
let hoverPopup = null;

window.unlockGradePopup = function () {
    stickySegmentId = null;
    hoveredSegmentId = null;
    if (hoverPopup) hoverPopup.remove();
};

// Get midpoint of line coordinates
function getSegmentMidpoint(coordinates) {
    if (!coordinates || coordinates.length === 0) return null;
    if (coordinates.length % 2 === 1) {
        return coordinates[Math.floor(coordinates.length / 2)];
    } else {
        const midIdx = coordinates.length / 2;
        const p1 = coordinates[midIdx - 1];
        const p2 = coordinates[midIdx];
        return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    }
}

// HSL color interpolator for tooltip grades matching map colors
function getGradeColor(grade) {
    const g = Math.min(Math.max(grade, 0), 20);
    const ratio = g / 20;
    const hue = 142 - ratio * 142; // green (142) to red (0)
    return `hsl(${hue}, 80%, 45%)`;
}

// Setup layers on map load/style changes
function setupGradeLayers() {
    // 3D Terrain / Hillshade sources
    const terrainTiles = ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'];
    const terrainEncoding = 'terrarium';

    if (!map.getSource('terrain-source')) {
        map.addSource('terrain-source', {
            type: 'raster-dem',
            tiles: terrainTiles,
            tileSize: 256,
            encoding: terrainEncoding,
            maxzoom: 12
        });
    }

    if (!map.getLayer('hillshade-layer')) {
        map.addLayer({
            id: 'hillshade-layer',
            type: 'hillshade',
            source: 'terrain-source',
            paint: {
                'hillshade-exaggeration': 0.5,
                'hillshade-shadow-color': 'rgba(0,0,0,0.5)',
                'hillshade-highlight-color': 'rgba(255,255,255,0.1)'
            },
            layout: {
                visibility: 'none'
            }
        });
    }

    if (!map.getSource('grade-roads')) {
        map.addSource('grade-roads', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    // Get current line opacity setting
    const opacityInput = document.getElementById('line-opacity-range');
    const opacityVal = opacityInput ? parseFloat(opacityInput.value) / 100 : 0.8;

    if (!map.getLayer('grade-roads-layer')) {
        map.addLayer({
            id: 'grade-roads-layer',
            type: 'line',
            source: 'grade-roads',
            paint: {
                'line-width': [
                    'interpolate', ['linear'], ['zoom'],
                    12, 1.5,
                    15, 4.5,
                    18, 9
                ],
                'line-color': [
                    'interpolate', ['linear'], ['get', 'grade'],
                    0, '#22c55e',      // flat (green)
                    10, '#eab308',     // 10% (yellow)
                    20, '#ef4444'      // 20%+ (red)
                ],
                'line-opacity': opacityVal,
                'line-opacity-transition': { duration: 0 }
            },
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            }
        });
    }

    if (!map.getLayer('grade-roads-hover-sensor')) {
        map.addLayer({
            id: 'grade-roads-hover-sensor',
            type: 'line',
            source: 'grade-roads',
            paint: {
                'line-width': 18, // Wide invisible hover target
                'line-color': 'rgba(0,0,0,0)',
                'line-opacity': 0
            },
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            }
        });

        // Initialize MapLibre popup for hover functionality (always anchored bottom, above the line)
        hoverPopup = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: 'grade-hover-popup',
            anchor: 'bottom'
        });

        map.on('mousemove', 'grade-roads-hover-sensor', (e) => {
            if (stickySegmentId) return; // Ignore hover updates when locked

            const features = map.queryRenderedFeatures(e.point, { layers: ['grade-roads-hover-sensor'] });
            if (features.length > 0) {
                const feature = features[0];
                const segId = feature.properties.id;

                if (hoveredSegmentId === segId) return; // Skip if already showing this segment
                hoveredSegmentId = segId;

                map.getCanvas().style.cursor = 'pointer';
                const gradePercent = feature.properties.gradePercent;
                const formatted = parseFloat(gradePercent).toFixed(1) + '%';
                const geom = feature.geometry;
                const midpoint = getSegmentMidpoint(geom.coordinates);

                if (midpoint) {
                    hoverPopup.setLngLat(midpoint)
                        .setHTML(`<div style="font-family:'Inter',sans-serif;font-size:0.82rem;font-weight:600;background:var(--bg-panel);padding:2px 4px;">Grade: <span style="color:${getGradeColor(gradePercent)};font-weight:700;">${formatted}</span></div>`)
                        .addTo(map);

                    const el = hoverPopup.getElement();
                    if (el) el.classList.remove('locked');
                }
            }
        });

        map.on('mouseleave', 'grade-roads-hover-sensor', () => {
            map.getCanvas().style.cursor = '';
            hoveredSegmentId = null;
            if (!stickySegmentId) {
                hoverPopup.remove();
            }
        });

        // Click to make hover element stick/lock
        map.on('click', 'grade-roads-hover-sensor', (e) => {
            const features = map.queryRenderedFeatures(e.point, { layers: ['grade-roads-hover-sensor'] });
            if (features.length > 0) {
                const feature = features[0];
                const clickedId = feature.properties.id;

                if (stickySegmentId === clickedId) {
                    // Unstick if clicked again
                    stickySegmentId = null;
                    hoverPopup.remove();
                } else {
                    // Stick to new segment
                    stickySegmentId = clickedId;
                    const gradePercent = feature.properties.gradePercent;
                    const formatted = parseFloat(gradePercent).toFixed(1) + '%';
                    const geom = feature.geometry;
                    const midpoint = getSegmentMidpoint(geom.coordinates);

                    if (midpoint) {
                        const lat = midpoint[1];
                        const lng = midpoint[0];
                        const svUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
                        
                        hoverPopup.setLngLat(midpoint)
                            .setHTML(`<div style="font-family:'Inter',sans-serif;font-size:0.82rem;font-weight:600;background:var(--bg-panel);padding:4px 6px;display:flex;align-items:center;gap:10px;border-bottom:2px solid ${getGradeColor(gradePercent)};">
                                <span>Grade: <span style="color:${getGradeColor(gradePercent)};font-weight:700;">${formatted}</span></span>
                                <div style="display:flex;align-items:center;gap:6px;margin-left:4px;">
                                    <a href="${svUrl}" target="_blank" title="Google Street View" style="color:var(--text-muted);display:flex;align-items:center;text-decoration:none;transition:color 0.2s;" onmouseover="this.style.color='#fbbc05'" onmouseout="this.style.color='var(--text-muted)'">
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                                            <circle cx="12" cy="6" r="3.5"/>
                                            <path d="M12 10.5c-2.3 0-6.1 1.2-6.5 3.5-.2.9.4 1.8 1.4 2l1.6 4.8c.2.6.8 1 1.5 1h4c.7 0 1.3-.4 1.5-1l1.6-4.8c1-.2 1.6-1.1 1.4-2-.4-2.3-4.2-3.5-6.5-3.5z"/>
                                        </svg>
                                    </a>
                                    <button onclick="window.unlockGradePopup()" title="Unlock" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0;display:flex;align-items:center;transition:color 0.2s;" onmouseover="this.style.color='var(--primary)'" onmouseout="this.style.color='var(--text-muted)'">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                            <line x1="18" y1="6" x2="6" y2="18"></line>
                                            <line x1="6" y1="6" x2="18" y2="18"></line>
                                        </svg>
                                    </button>
                                </div>
                            </div>`)
                            .addTo(map);

                        const el = hoverPopup.getElement();
                        if (el) el.classList.add('locked');
                    }
                }
            }
        });

        // Click elsewhere on map to dismiss locked/sticky tooltip
        map.on('click', (e) => {
            const features = map.queryRenderedFeatures(e.point, { layers: ['grade-roads-hover-sensor'] });
            if (features.length === 0) {
                stickySegmentId = null;
                hoverPopup.remove();
            }
        });
    }

    if (!map.getLayer('grade-roads-arrows')) {
        map.addLayer({
            id: 'grade-roads-arrows',
            type: 'symbol',
            source: 'grade-roads',
            layout: {
                'symbol-placement': 'line',
                'symbol-spacing': 80,
                'text-field': '›',
                'text-size': [
                    'interpolate', ['linear'], ['zoom'],
                    13, 12,
                    15, 16,
                    18, 20
                ],
                'text-keep-upright': false,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-anchor': 'center',
                'text-offset': [0, -0.14]
            },
            paint: {
                'text-color': '#ffffff',
                'text-opacity': 0.75,
                'text-halo-color': '#000000',
                'text-halo-width': 1.5
            },
            filter: ['>', ['get', 'gradePercent'], 1.5]
        });
    }
}

map.on('style.load', () => {
    setupGradeLayers();
    applyTerrain();
    updateMapData();
});

// Update the map line layer with cached features
function updateMapData() {
    if (!map.getSource('grade-roads')) return;

    const features = [];
    for (const [_, segments] of wayCache.entries()) {
        for (const seg of segments) {
            if (seg.grade !== undefined) {
                features.push({
                    type: 'Feature',
                    id: seg.id, // Set feature id
                    geometry: {
                        type: 'LineString',
                        coordinates: seg.coordinates
                    },
                    properties: {
                        id: seg.id,
                        grade: seg.grade,
                        gradePercent: seg.gradePercent
                    }
                });
            }
        }
    }

    map.getSource('grade-roads').setData({
        type: 'FeatureCollection',
        features: features
    });
}

// Dispatcher to process the pending cells queue starting from the center out
async function runProgressiveLoadQueue() {
    if (isQueueRunning) return;
    isQueueRunning = true;

    const loading = document.getElementById('loading-indicator');
    if (loading) loading.style.display = 'flex';

    while (activeQueue.length > 0) {
        // Sort queue dynamically to always prioritize the closest cell to the current map center
        const mapCenter = map.getCenter();
        for (const task of activeQueue) {
            const cellLng = (task.cx + 0.5) * GRID_SIZE;
            const cellLat = (task.cy + 0.5) * GRID_SIZE;
            task.dist = getDistance([cellLng, cellLat], [mapCenter.lng, mapCenter.lat]);
        }
        activeQueue.sort((a, b) => a.dist - b.dist);

        // Get the closest cell
        const currentTask = activeQueue.shift();
        const { key, cx, cy } = currentTask;

        // Double check we haven't already processed it
        if (processedCells.has(key)) continue;
        processedCells.add(key);

        try {
            // Calculate cell bounds
            const w = cx * GRID_SIZE;
            const e = (cx + 1) * GRID_SIZE;
            const s = cy * GRID_SIZE;
            const n = (cy + 1) * GRID_SIZE;

            const bbox = `${s},${w},${n},${e}`;
            
            // Fetch ways in this cell
            const query = `[out:json][timeout:25];way[highway]["highway"!~"footway|pedestrian|steps|construction|proposed|abandoned|service|track|corridor|elevator|platform|path|bridleway"](${bbox});out geom;`;
            const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
            if (!res.ok) throw new Error('Query failed');

            const data = await res.json();
            const ways = data.elements || [];

            const newWaysToResolve = [];
            for (const way of ways) {
                if (way.type === 'way' && way.geometry && !wayCache.has(way.id)) {
                    const geomCoords = way.geometry.map(p => [p.lon, p.lat]);
                    const denseCoords = densifyCoordinates(geomCoords, 20);
                    newWaysToResolve.push({
                        id: way.id,
                        geomCoords: geomCoords,
                        denseCoords: denseCoords
                    });
                }
            }

            if (newWaysToResolve.length > 0) {
                const uniqueCoordsMap = new Map();
                const uniqueCoordsArray = [];
                const getCoordKey = (coord) => `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;

                for (const wayInfo of newWaysToResolve) {
                    for (const pt of wayInfo.denseCoords) {
                        const key = getCoordKey(pt);
                        if (!uniqueCoordsMap.has(key)) {
                            uniqueCoordsMap.set(key, uniqueCoordsArray.length);
                            uniqueCoordsArray.push(pt);
                        }
                    }
                }

                const uniqueElevations = await getHighResElevation(uniqueCoordsArray);

                for (const wayInfo of newWaysToResolve) {
                    const denseCoords = wayInfo.denseCoords;
                    const elevations = [];
                    for (const pt of denseCoords) {
                        const key = getCoordKey(pt);
                        const idx = uniqueCoordsMap.get(key);
                        elevations.push(uniqueElevations[idx]);
                    }

                    fillNullElevations(elevations);
                    smoothWayElevations(denseCoords, elevations);

                    const segments = splitWayIntoSegments(wayInfo.geomCoords, wayInfo.id);

                    for (const seg of segments) {
                        const coords = seg.coordinates;
                        const dist = seg.distance;
                        const start = coords[0];
                        const end = coords[coords.length - 1];
                        let gradeVal = 0;
                        let isDownhill = false;

                        if (dist >= 60) {
                            const segElevs = [];
                            let hasNull = false;
                            for (const pt of coords) {
                                const el = getInterpolatedElevation(pt, denseCoords, elevations);
                                if (el === null || el === undefined) {
                                    hasNull = true;
                                    break;
                                }
                                segElevs.push(el);
                            }

                            if (!hasNull && segElevs.length >= 2) {
                                const slope = calculateLeastSquaresSlope(coords, segElevs);
                                gradeVal = Math.abs(slope) * 100;
                                isDownhill = segElevs[0] > segElevs[segElevs.length - 1];
                            }
                        } else {
                            const latMid = (start[1] + end[1]) / 2;
                            const lngMid = (start[0] + end[0]) / 2;
                            const dLat = end[1] - start[1];
                            const dLng = end[0] - start[0];
                            const len = Math.sqrt(dLat * dLat + dLng * dLng);

                            if (len === 0) {
                                const elevStart = getInterpolatedElevation(start, denseCoords, elevations);
                                const elevEnd = getInterpolatedElevation(end, denseCoords, elevations);
                                if (elevStart !== null && elevEnd !== null) {
                                    gradeVal = dist > 0 ? (Math.abs(elevEnd - elevStart) / dist) * 100 : 0;
                                    isDownhill = elevStart > elevEnd;
                                }
                            } else {
                                const uLat = dLat / len;
                                const uLng = dLng / len;

                                const degLat = 30 / 111111;
                                const degLng = 30 / (111111 * Math.cos(latMid * Math.PI / 180));

                                const startVirtual = [lngMid - uLng * degLng, latMid - uLat * degLat];
                                const endVirtual = [lngMid + uLng * degLng, latMid + uLat * degLat];

                                const elevStart = getInterpolatedElevation(startVirtual, denseCoords, elevations);
                                const elevEnd = getInterpolatedElevation(endVirtual, denseCoords, elevations);

                                if (elevStart !== null && elevEnd !== null) {
                                    gradeVal = (Math.abs(elevEnd - elevStart) / 60) * 100;
                                    isDownhill = elevStart > elevEnd;
                                }
                            }
                        }

                        if (isNaN(gradeVal) || gradeVal === null || gradeVal === undefined) {
                            gradeVal = 0;
                        }
                        seg.gradePercent = gradeVal;
                        seg.grade = Math.min(gradeVal, 20);

                        if (isDownhill) {
                            seg.coordinates.reverse();
                        }
                    }

                    wayCache.set(wayInfo.id, segments);
                }

                // Incrementally update the map as we load roads tile by tile
                updateMapData();
            }
        } catch (err) {
            console.warn(`Error processing cell ${key}:`, err);
        }

        // yield to keep browser responsive
        await new Promise(r => setTimeout(r, 20));
    }

    isQueueRunning = false;
    if (loading) loading.style.display = 'none';
}

// Fetch ways and process grades using the progressive tiling system
function fetchAndProcessViewport() {
    const zoom = map.getZoom();
    const warning = document.getElementById('zoom-warning');
    
    if (zoom < 13) {
        if (warning) warning.classList.remove('hidden');
        activeQueue = [];
        return;
    } else {
        if (warning) warning.classList.add('hidden');
    }

    const bounds = map.getBounds();
    const mapCenter = map.getCenter();

    // Determine viewport cell bounds with 1-cell prefetch padding
    const w = bounds.getWest() - GRID_SIZE;
    const e = bounds.getEast() + GRID_SIZE;
    const s = bounds.getSouth() - GRID_SIZE;
    const n = bounds.getNorth() + GRID_SIZE;

    const minCx = Math.floor(w / GRID_SIZE);
    const maxCx = Math.floor(e / GRID_SIZE);
    const minCy = Math.floor(s / GRID_SIZE);
    const maxCy = Math.floor(n / GRID_SIZE);

    const newTasks = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
            const key = `${cx},${cy}`;
            if (!processedCells.has(key) && !activeQueue.some(t => t.key === key)) {
                const cellLng = (cx + 0.5) * GRID_SIZE;
                const cellLat = (cy + 0.5) * GRID_SIZE;
                const dist = getDistance([cellLng, cellLat], [mapCenter.lng, mapCenter.lat]);
                newTasks.push({ key, cx, cy, dist });
            }
        }
    }

    if (newTasks.length > 0) {
        activeQueue.push(...newTasks);
        runProgressiveLoadQueue();
    }
}

// Map event listeners
let moveendDebounceTimer = null;
map.on('moveend', () => {
    // Save map coordinates to match planner sync
    localStorage.setItem('last_map_center', JSON.stringify(map.getCenter()));
    localStorage.setItem('last_map_zoom', map.getZoom());

    clearTimeout(moveendDebounceTimer);
    moveendDebounceTimer = setTimeout(() => {
        fetchAndProcessViewport();
    }, 300);
});

// Initial fetch
map.on('load', () => {
    fetchAndProcessViewport();
});

// Settings syncing and interaction handlers
document.getElementById('theme').addEventListener('change', (e) => {
    localStorage.setItem('route_theme', e.target.value);
    if (e.target.value === 'light') {
        document.body.classList.add('light-mode');
    } else {
        document.body.classList.remove('light-mode');
    }
});

document.getElementById('basemap').addEventListener('change', (e) => {
    const val = e.target.value;
    currentBasemap = val;
    localStorage.setItem('route_basemap', val);

    const newStyle = VECTOR_STYLES[val]
        ? VECTOR_STYLES[val]
        : buildRasterStyle(RASTER_BASEMAPS[val] || RASTER_BASEMAPS.osm);

    map.setStyle(newStyle);
});

document.getElementById('projection').addEventListener('change', (e) => {
    localStorage.setItem('route_projection', e.target.value);
    map.setProjection({ type: e.target.value });
});

// Line Opacity handler
document.getElementById('line-opacity-range').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    localStorage.setItem('grade_line_opacity', val);
    document.getElementById('line-opacity-val').textContent = val + '%';
    try {
        if (map && map.getLayer('grade-roads-layer')) {
            map.setPaintProperty('grade-roads-layer', 'line-opacity', val / 100);
        }
    } catch (err) {
        console.warn('Could not set line opacity paint property:', err);
    }
});

// Terrain switcher
function applyTerrain() {
    const val = document.getElementById('hillshade-select')?.value || 'off';
    const exInput = document.getElementById('terrain-exaggeration');

    localStorage.setItem('route_hillshade', val);
    let exVal = parseFloat(exInput.value);
    if (isNaN(exVal)) exVal = 2.0;
    localStorage.setItem('route_exaggeration', exVal);

    if (!map.getLayer('hillshade-layer') || !map.getSource('terrain-source')) return;

    if (val === 'off') {
        map.setLayoutProperty('hillshade-layer', 'visibility', 'none');
        if (map.getTerrain()) map.setTerrain(null);
    } else if (val === 'hillshade') {
        map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
        map.setPaintProperty('hillshade-layer', 'hillshade-exaggeration', 0.5);
        if (map.getTerrain()) map.setTerrain(null);
    } else if (val === 'terrain') {
        map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
        map.setPaintProperty('hillshade-layer', 'hillshade-exaggeration', 0.5);
        map.setTerrain({ source: 'terrain-source', exaggeration: exVal });
    }
}

document.getElementById('hillshade-select')?.addEventListener('change', applyTerrain);
document.getElementById('terrain-exaggeration')?.addEventListener('change', applyTerrain);

// Sync settings UI on load
const storedTheme = localStorage.getItem('route_theme') || 'dark';
document.getElementById('theme').value = storedTheme;
if (storedTheme === 'light') {
    document.body.classList.add('light-mode');
} else {
    document.body.classList.remove('light-mode');
}

const storedBasemap = localStorage.getItem('route_basemap') || 'cyclosm';
document.getElementById('basemap').value = storedBasemap;

const storedProjection = localStorage.getItem('route_projection') || 'mercator';
document.getElementById('projection').value = storedProjection;

// Sync line opacity on load
let storedOpacity = localStorage.getItem('grade_line_opacity') || '80';
// Convert legacy float strings (e.g. "0.8") to integer percents
if (parseFloat(storedOpacity) <= 1.0) {
    storedOpacity = Math.round(parseFloat(storedOpacity) * 100).toString();
}
document.getElementById('line-opacity-range').value = storedOpacity;
document.getElementById('line-opacity-val').textContent = storedOpacity + '%';

// Sync terrain settings on load
const storedHillshade = localStorage.getItem('route_hillshade') || 'off';
if (document.getElementById('hillshade-select')) {
    document.getElementById('hillshade-select').value = storedHillshade;
}
const storedExaggeration = localStorage.getItem('route_exaggeration') || '2.0';
if (document.getElementById('terrain-exaggeration')) {
    document.getElementById('terrain-exaggeration').value = storedExaggeration;
}
