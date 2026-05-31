// CartoDB vector tile styles — same visual look as the old raster dark/light tiles
// but rendered by GPU (smaller downloads, crisper at all zoom levels)
const VECTOR_STYLES = {
    dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    light: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    positron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
};

// Raster-only basemaps (no vector equivalent)
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

let currentBasemap = localStorage.getItem('route_basemap') || 'cyclosm';

// Create a persistent cover that hides the map until the initial load and cycle hack is completely finished.
// This perfectly answers the request to "only make it visually load on the second load".
const initialCover = document.createElement('div');
initialCover.id = 'initial-map-cover';
initialCover.style.position = 'absolute';
initialCover.style.inset = '0';
initialCover.style.backgroundColor = '#111';
initialCover.style.zIndex = '999999';
initialCover.style.transition = 'opacity 0.5s ease-in-out';
initialCover.style.pointerEvents = 'none';

initialCover.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:18px; color:#94a3b8; font-family:'Inter', sans-serif;">
        <svg class="initial-spinner" width="44" height="44" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" stroke="#1e293b" stroke-width="2"/>
            <path d="M8 1a7 7 0 0 1 7 7" stroke="#34d399" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <div id="initial-loading-text" style="font-size: 0.9rem; font-weight: 500; letter-spacing: 0.02em;">Loading route...</div>
    </div>
    <style>
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .initial-spinner { animation: spin 0.8s linear infinite; }
    </style>
`;

// Wait for DOM content to be ready
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const routeStr = params.get('route');
    // Only show the loading cover when there are 2+ waypoints (a real route to fetch).
    if (routeStr && routeStr.includes(';')) {
        document.getElementById('map').appendChild(initialCover);
        document.getElementById('loading-indicator').style.display = 'flex';
        document.getElementById('loading-phase').textContent = 'Initializing...';
    } else {
        initialBasemapCycled = true; // nothing to load, skip cover logic
    }
});

const cachedCenter = localStorage.getItem('last_map_center');
const cachedZoom = localStorage.getItem('last_map_zoom');
const initialCenter = cachedCenter ? JSON.parse(cachedCenter) : [0, 0];
const initialZoom = cachedZoom ? parseFloat(cachedZoom) : 1;

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
    trackResize: true,
    transformRequest: (url, resourceType) => {
        // No custom headers to avoid CORS preflight failures on tile servers
    }
});

// Double right-click capture to reset orientation
let lastRightClickTime = 0;
map.getCanvasContainer().addEventListener('mousedown', (e) => {
    if (e.button === 2) { // Right mouse button
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

// Enable native right-click tilt/rotate controls (MapLibre's built-in dragRotate is highly optimized)
map.dragRotate.enable();
map.touchZoomRotate.enable(); // No 'around: center' — use finger midpoint for pinch zoom/rotate

// Middle-click popup helper
let middleClickStartX = null, middleClickStartY = null;

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

let waypoints = [];
let currentDistanceMeters = 0;
let currentUnits = 'imperial';
let markers = [];
let waypointDistances = [];
let currentStats = {
    gain: 0,
    loss: 0,
    min: Infinity,
    max: -Infinity,
    minIdx: 0,
    maxIdx: 0,
    maxUpGrade: 0,
    maxDownGrade: 0,
    maxUpIdx: 0,
    maxDownIdx: 0,
    grades: []
};

// Module-level state for viewport-aware gradient (needs to be accessible from updateElevationProfile)
let routeGrades = null;
let routePathDistances = null;
let routeMercatorDistances = null;
let routeTotalDist = 0;
let routeMercTotalDist = 0;

function getMercatorDistance(c1, c2) {
    const x1 = c1[0] * Math.PI / 180;
    const y1 = Math.log(Math.tan(Math.PI / 4 + c1[1] * Math.PI / 360));
    const x2 = c2[0] * Math.PI / 180;
    const y2 = Math.log(Math.tan(Math.PI / 4 + c2[1] * Math.PI / 360));
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}
let routeScreenPts = null;

// Performance settings — display only. Backend elevation always uses max resolution.
const PERF_MAP_POINTS = 8000;
const PERF_INTERACTION_POINTS = 10000; // Unused for decimation now, keeping as logic reference
const BACKEND_ELEV_POINTS = 2000; // elevation sample density (increased for smoother hover)

// --- Keybinding Customization ---
const DEFAULT_KEYBINDINGS = {
    toggleElevation: 'e',
    toggleMode: 'b',
    fitRoute: 'f',
    toggleSettings: 't',
    search: 's',
    toggleStats: 'm',
    reverse: 'v',
    deleteLast: 'backspace',
    resetOrientation: 'n',
};
let currentKeybindings = { ...DEFAULT_KEYBINDINGS };
let activeCaptureKey = null;
// Mapbox is no longer used to save on data/quota. Elevation uses free Terrarium tiles.
const mapboxToken = '';

function setCookie(name, value, days = 365) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/; SameSite=Strict';
}
function getCookie(name) {
    return document.cookie.split('; ').reduce((r, v) => {
        const parts = v.split('=');
        return parts[0] === name ? decodeURIComponent(parts[1]) : r
    }, '');
}
function loadKeybindings() {
    const saved = getCookie('route_keybindings');
    if (saved) {
        try { currentKeybindings = { ...DEFAULT_KEYBINDINGS, ...JSON.parse(saved) }; } catch (e) { }
    }
}
loadKeybindings();


// Chart and elevation update state — declared here to avoid TDZ errors when
// map.on('load') fires and immediately triggers updateElevationProfile
let elevationChart = null;
let isUpdatingElevation = false;
let lastHoverIdx = -1;
let currentHoverDispDist = null;
let isZooming = false;
let bestCiGlobal = -1; // Exported from mousemove for use in dragging
let waypointPathIndices = []; // Indices in currentRouteGeoJSON.coordinates where waypoints reside
let lastSegIdx = -1;
let currentRoutingMode = 'bike'; // 'bike' or 'direct'
let currentBaseSpeedKmh = parseFloat(localStorage.getItem('route_base_speed')) || 18;

function decodePolyline6(str) {
    let index = 0, lat = 0, lng = 0, coordinates = [];
    while (index < str.length) {
        let b, shift = 0, result = 0;
        do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += ((result & 1) ? ~(result >> 1) : (result >> 1));
        shift = 0; result = 0;
        do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += ((result & 1) ? ~(result >> 1) : (result >> 1));
        coordinates.push([lng / 1e6, lat / 1e6]);
    }
    return coordinates;
}

// Haversine distance between two [lng, lat] points — used in force/direct mode
function turf_distance(a, b) {
    const R = 6371000; // metres
    const φ1 = a[1] * Math.PI / 180, φ2 = b[1] * Math.PI / 180;
    const Δφ = (b[1] - a[1]) * Math.PI / 180;
    const Δλ = (b[0] - a[0]) * Math.PI / 180;
    const s = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function syncRoutingUI() {
    const directCheck = document.getElementById('direct-mode-check');
    if (directCheck) directCheck.checked = forceMode;
}



// Segments are static once built — no need to rebuild them on every pan/zoom.
// Only rebuild routeScreenPts (for hover hit-testing) when map view changes.
function rebuildRouteScreenPts() {
    if (!currentRouteGeoJSON) { routeScreenPts = null; return; }
    // Snapping and interaction are mapped 1:1 with the original coordinates
    // to keep index-based elevation/grade lookups valid.
    const coords = currentRouteGeoJSON.coordinates;
    const bounds = map.getBounds();
    const west = bounds.getWest(), east = bounds.getEast();
    const south = bounds.getSouth(), north = bounds.getNorth();

    routeScreenPts = coords.map(c => {
        if (c[0] < west || c[0] > east || c[1] < south || c[1] > north) {
            return null;
        }
        return map.project(c);
    });
}

let currentDisplayCoords = null; // Miter-corrected display coords, updated by rebuildMapGradient
let rawIndexToDisplayRange = []; // Maps raw coordinates index to [displayStart, displayEnd] indices
let displayIndexToRawIndex = []; // Maps display coordinates index to raw coordinate index
let displayMercatorDistances = []; // Cumulative Mercator distances of displayCoords
let displayMercTotalDist = 0;

// Fixes the line-offset inside-corner overlap at sharp right turns ONLY.
// For positive line-offset (right side), a right turn puts the offset on the
// inside — the two adjacent offset segments cross. Fix: replace the vertex with
// the exact intersection of the two offset lines (the "miter point"), shortening
// both segments so they meet cleanly. Left turns (outside gap) are untouched.
// Only modifies the display source — currentRouteGeoJSON is never changed.
function miterInsideCorners(coords) {
    if (coords.length < 3) {
        rawIndexToDisplayRange = coords.map((_, i) => [i, i]);
        displayIndexToRawIndex = coords.map((_, i) => i);
        return coords;
    }
    const pxOffset = getPixelOffset(map.getZoom());
    if (pxOffset < 1) { // No visible offset at low zooms
        rawIndexToDisplayRange = coords.map((_, i) => [i, i]);
        displayIndexToRawIndex = coords.map((_, i) => i);
        return coords;
    }

    const result = [coords[0]];
    const mapping = [[0, 0]];
    const toRaw = [0];

    for (let i = 1; i < coords.length - 1; i++) {
        const currentLen = result.length;
        const p1 = coords[i - 1], p2 = coords[i], p3 = coords[i + 1];

        // Signed deflection angle. Positive = right turn.
        let d = getBearing(p2, p3) - getBearing(p1, p2);
        while (d > 180) d -= 360;
        while (d < -180) d += 360;

        // Only fix right turns > 30° — these are inside corners for positive offset.
        // Left turns produce a gap (not overlap), already handled by turnaround staples.
        if (d < 30) {
            result.push(p2);
            mapping.push([currentLen, currentLen]);
            toRaw.push(i);
            continue;
        }

        const sc = map.project(p2);
        const s1 = map.project(p1);
        const s3 = map.project(p3);

        const ivX = sc.x - s1.x, ivY = sc.y - s1.y;
        const iLen = Math.sqrt(ivX * ivX + ivY * ivY);
        if (iLen < 1) {
            result.push(p2);
            mapping.push([currentLen, currentLen]);
            toRaw.push(i);
            continue;
        }
        const idX = ivX / iLen, idY = ivY / iLen;

        const ovX = s3.x - sc.x, ovY = s3.y - sc.y;
        const oLen = Math.sqrt(ovX * ovX + ovY * ovY);
        if (oLen < 1) {
            result.push(p2);
            mapping.push([currentLen, currentLen]);
            toRaw.push(i);
            continue;
        }
        const odX = ovX / oLen, odY = ovY / oLen;

        // Right-hand normals for incoming and outgoing directions
        const niX = -idY, niY = idX;
        const noX = -odY, noY = odX;

        // The two offset line anchor points (at the corner vertex, shifted to the right)
        const ax = sc.x + niX * pxOffset, ay = sc.y + niY * pxOffset;
        const bx = sc.x + noX * pxOffset, by = sc.y + noY * pxOffset;

        // Intersect: line through (ax,ay) dir (idX,idY) vs line through (bx,by) dir (odX,odY)
        const cross = idX * odY - idY * odX;
        if (Math.abs(cross) < 1e-10) {
            result.push(p2);
            mapping.push([currentLen, currentLen]);
            toRaw.push(i);
            continue;
        }
        const t = ((bx - ax) * odY - (by - ay) * odX) / cross;
        const s = ((bx - ax) * idY - (by - ay) * idX) / cross;

        // The maximum distance we are willing to shift the vertex along the incoming/outgoing segments
        // to avoid shifting it past the midpoint of the segment.
        const maxShiftI = iLen * 0.45;
        const maxShiftO = oLen * 0.45;

        // Clamp t to be within [-maxShiftI, 0]
        let clampedT = t;
        if (clampedT > 0) clampedT = 0;
        if (clampedT < -maxShiftI) clampedT = -maxShiftI;

        // Clamp s to be within [0, maxShiftO]
        let clampedS = s;
        if (clampedS < 0) clampedS = 0;
        if (clampedS > maxShiftO) clampedS = maxShiftO;

        // Split the corner vertex into two bevel points C1 and C2
        const cx1 = sc.x + clampedT * idX;
        const cy1 = sc.y + clampedT * idY;
        const cx2 = sc.x + clampedS * odX;
        const cy2 = sc.y + clampedS * odY;

        const mPt1 = map.unproject([cx1, cy1]);
        const mPt2 = map.unproject([cx2, cy2]);

        result.push([mPt1.lng, mPt1.lat]);
        result.push([mPt2.lng, mPt2.lat]);
        mapping.push([currentLen, currentLen + 1]);
        toRaw.push(i, i);
    }
    mapping.push([result.length, result.length]);
    toRaw.push(coords.length - 1);
    result.push(coords[coords.length - 1]);

    rawIndexToDisplayRange = mapping;
    displayIndexToRawIndex = toRaw;
    return result;
}

// Build colored GeoJSON segments and upload to the map.
// Called once after elevation data loads (grade colors) and also immediately
// Rebuild the route colour gradient using MapLibre's native line-gradient.
// We set a single LineString source (lineMetrics:true) and drive colour via
// ['line-progress'] — one continuous gradient, zero segment-boundary artifacts.
let _routeGradStops = null;
function rebuildMapGradient() {
    if (!currentRouteGeoJSON) return;
    const coords = currentRouteGeoJSON.coordinates;
    // Using miter-corrected coordinates for the map display.
    const displayCoords = miterInsideCorners(coords);
    currentDisplayCoords = displayCoords; // Store for hover snap engine

    // Calculate display-level Mercator cumulative distances
    displayMercatorDistances = [0];
    let dAcc = 0;
    for (let i = 1; i < displayCoords.length; i++) {
        dAcc += getMercatorDistance(displayCoords[i - 1], displayCoords[i]);
        displayMercatorDistances.push(dAcc);
    }
    displayMercTotalDist = dAcc;

    const gradSrc = map.getSource('route-gradient');
    if (gradSrc) gradSrc.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: displayCoords } });
    rebuildRouteScreenPts(); // Snap engine must reflect the new display line

    const grades = routeGrades;
    if (!grades || !routeMercatorDistances || routeMercTotalDist <= 0) {
        if (map.getLayer('route-gradient-layer'))
            map.setPaintProperty('route-gradient-layer', 'line-gradient',
                ['interpolate', ['linear'], ['line-progress'], 0, 'rgb(34,197,94)', 1, 'rgb(34,197,94)']);
        return;
    }
    const gradStops = [];
    let lastFrac = -1;
    for (let i = 0; i < displayCoords.length; i++) {
        const frac = Math.min(Math.max(displayMercatorDistances[i] / (displayMercTotalDist || 1), 0), 1);
        if (frac <= lastFrac) continue;
        lastFrac = frac;
        const rawIdx = displayIndexToRawIndex[i];
        gradStops.push(frac, getColorForGrade(grades[Math.min(rawIdx + 1, grades.length - 1)] ?? 0));
    }
    if (map.getLayer('route-gradient-layer'))
        map.setPaintProperty('route-gradient-layer', 'line-gradient',
            ['interpolate', ['linear'], ['line-progress'], ...gradStops]);
    updateTurnaroundJoins();
}

// Show the bold gradient hover highlight for the waypoint segment containing route index ci.
function showHoverSegment(ci) {
    if (!currentRouteGeoJSON || !waypointPathIndices || waypointPathIndices.length < 2) return;
    let segIdx = -1;
    for (let j = 0; j < waypointPathIndices.length - 1; j++) {
        if (ci >= waypointPathIndices[j] && ci <= waypointPathIndices[j + 1]) { segIdx = j; break; }
    }
    if (segIdx === -1 || segIdx === lastSegIdx) return;
    lastSegIdx = segIdx;
    const startIndex = waypointPathIndices[segIdx];
    const endIndex = waypointPathIndices[segIdx + 1];

    let subCoords;
    let displayStart = 0;
    let displayEnd = 0;
    if (rawIndexToDisplayRange && rawIndexToDisplayRange[startIndex] && rawIndexToDisplayRange[endIndex] && currentDisplayCoords) {
        displayStart = rawIndexToDisplayRange[startIndex][0];
        displayEnd = rawIndexToDisplayRange[endIndex][0];
        subCoords = currentDisplayCoords.slice(displayStart, displayEnd + 1);
    } else {
        subCoords = currentDisplayCoords ? currentDisplayCoords.slice(startIndex, endIndex + 1) : currentRouteGeoJSON.coordinates.slice(startIndex, endIndex + 1);
    }

    const stops = ['interpolate', ['linear'], ['line-progress']];
    if (routeGrades && displayMercatorDistances && displayMercTotalDist > 0 && subCoords) {
        const startMerc = displayMercatorDistances[displayStart];
        const segMercDist = (displayMercatorDistances[displayEnd] - startMerc) || 1;
        let lastFrac = -1;
        for (let displayIdx = displayStart; displayIdx <= displayEnd; displayIdx++) {
            const frac = Math.min(Math.max((displayMercatorDistances[displayIdx] - startMerc) / segMercDist, 0), 1);
            if (frac <= lastFrac) continue;
            lastFrac = frac;
            const rawIdx = displayIndexToRawIndex[displayIdx];
            stops.push(frac, getColorForGrade(routeGrades[Math.min(rawIdx + 1, routeGrades.length - 1)] ?? 0));
        }
        if (lastFrac < 1) {
            const rawIdx = displayIndexToRawIndex[displayEnd];
            stops.push(1, getColorForGrade(routeGrades[Math.min(rawIdx + 1, routeGrades.length - 1)] ?? 0));
        }
    } else {
        stops.push(0, 'rgb(34,197,94)', 1, 'rgb(34,197,94)');
    }
    map.getSource('hover-segment')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: subCoords } });
    map.setPaintProperty('hover-segment-layer', 'line-gradient', stops);
    // Exclusive-start range: corner at a waypoint boundary (idx==endIndex) is included in the
    // approach segment but excluded from the departure segment — avoids double-bolding.
    map.setFilter('turnaround-highlight-layer', ['all', ['>', ['get', 'idx'], startIndex], ['<=', ['get', 'idx'], endIndex]]);
    map.setFilter('turnaround-layer', ['any', ['<=', ['get', 'idx'], startIndex], ['>', ['get', 'idx'], endIndex]]);
}

function updateTurnaroundJoins() {
    if (!currentRouteGeoJSON || !map.getSource('turnarounds')) return;

    const turns = [];
    const coords = currentRouteGeoJSON.coordinates;
    const pxOffset = getPixelOffset(map.getZoom());

    if (pxOffset < 0.5) {
        map.getSource('turnarounds').setData({ type: 'FeatureCollection', features: [] });
        return;
    }

    for (let i = 1; i < coords.length - 1; i++) {
        // Find preceding coordinate at least 1 meter away from coords[i]
        let prevIdx = i - 1;
        while (prevIdx >= 0 && haversineDistance(coords[prevIdx], coords[i]) < 1) {
            prevIdx--;
        }
        if (prevIdx < 0) continue;

        // Find succeeding coordinate at least 1 meter away from coords[i]
        let nextIdx = i + 1;
        while (nextIdx < coords.length && haversineDistance(coords[i], coords[nextIdx]) < 1) {
            nextIdx++;
        }
        if (nextIdx >= coords.length) continue;

        const bIn = getBearing(coords[prevIdx], coords[i]);
        const bOut = getBearing(coords[i], coords[nextIdx]);

        // Signed deflection: positive = right turn, negative = left turn
        let d = bOut - bIn;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;

        // Draw a visual bridging staple ONLY for sharp left turns (where offset is on the outside, d < -100)
        // or complete 180-degree turnarounds (where the path reverses direction completely, |d| > 135).
        // Sharp right turns do not need a visual bridge.
        if (d < -100 || Math.abs(d) > 135) {
            const pCenter = map.project(coords[i]);
            const pIn = map.project(coords[prevIdx]);
            const pOut = map.project(coords[nextIdx]);

            // Right-hand normal vectors for in/out segments
            const vInX = pCenter.x - pIn.x, vInY = pCenter.y - pIn.y;
            const lIn = Math.sqrt(vInX * vInX + vInY * vInY);
            if (lIn < 0.1) continue;
            const nInX = -vInY / lIn, nInY = vInX / lIn;

            const vOutX = pOut.x - pCenter.x, vOutY = pOut.y - pCenter.y;
            const lOut = Math.sqrt(vOutX * vOutX + vOutY * vOutY);
            if (lOut < 0.1) continue;
            const nOutX = -vOutY / lOut, nOutY = vOutX / lOut;

            // Offset points are on the right side (positive normal)
            const p1xy = [pCenter.x + nInX * pxOffset, pCenter.y + nInY * pxOffset];
            const p2xy = [pCenter.x + nOutX * pxOffset, pCenter.y + nOutY * pxOffset];

            if (isNaN(p1xy[0]) || isNaN(p1xy[1]) || isNaN(p2xy[0]) || isNaN(p2xy[1])) continue;

            const p1 = map.unproject(p1xy);
            const p2 = map.unproject(p2xy);

            turns.push({
                type: 'Feature',
                properties: {
                    idx: i,
                    color: routeGrades ? getColorForGrade(routeGrades[Math.min(i + 1, routeGrades.length - 1)] ?? 0) : 'rgb(34,197,94)'
                },
                geometry: { type: 'LineString', coordinates: [[p1.lng, p1.lat], [p2.lng, p2.lat]] }
            });
        }
    }
    map.getSource('turnarounds').setData({ type: 'FeatureCollection', features: turns });
}




function getBearing(from, to) {
    const lat1 = from[1] * Math.PI / 180, lat2 = to[1] * Math.PI / 180;
    const dLng = (to[0] - from[0]) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(y, x) * 180 / Math.PI;
}

const pinSvg = (color, text = '', strokeWidth = 1) => {
    const path = text
        ? `M12 0C5.37 0 0 5.37 0 12c0 9 12 20 12 20s12-11 12-20c0-6.63-5.37-12-12-12z`
        : `M12 0C5.37 0 0 5.37 0 12c0 9 12 20 12 20s12-11 12-20c0-6.63-5.37-12-12-12zm0 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="34" viewBox="-1 -1 26 35">
    <path d="${path}" fill="${color}" fill-rule="evenodd" stroke="black" stroke-opacity="0.6" stroke-width="${strokeWidth}" />
    <text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" fill="white" font-size="13px" font-family="Arial, sans-serif" font-weight="bold">${text}</text>
</svg>`;
};

function createMarkerIcon(index, total) {
    if (index === 0) return pinSvg('#22c55e'); // Green Start
    if (index === total - 1) return pinSvg('#ef4444'); // Red Finish
    return pinSvg('#4b5563', index); // Dark Grey Numbered Pin
}

const wpIcons = {}; // Cache for Chart.js waypoint icons

function getWpIconImage(index, total) {
    const key = `${index}-${total}`;
    if (wpIcons[key] && !wpIcons[key].complete === false) return wpIcons[key];
    const img = new Image();
    const svg = createMarkerIcon(index, total);
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    wpIcons[key] = img;
    return img;
}

// Hover info is now rendered as a MapLibre circle layer + floating HTML label.
// This avoids all DOM/CSS wrapper square issues from maplibregl.Marker.
const hoverInfoEl = document.createElement('div');
hoverInfoEl.id = 'hover-info';
hoverInfoEl.style.cssText = [
    'position:absolute', 'pointer-events:none', 'display:none',
    'background:rgba(20,20,30,0.85)', 'color:#fff',
    'padding:5px 10px', 'border-radius:8px', 'font-size:0.78rem',
    'font-family:Inter,sans-serif', 'white-space:nowrap',
    'border:1px solid rgba(255,255,255,0.12)', 'z-index:10',
    'backdrop-filter:blur(4px)', 'transform:translate(-50%,-140%)'
].join(';');
document.getElementById('map').appendChild(hoverInfoEl);

function showHoverMarker(lngLat, info) {
    const src = map.getSource('hover-point');
    const coords = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
    if (src) src.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: {} });
    // Position the info label
    if (info) {
        const pt = map.project(coords);
        hoverInfoEl.innerHTML = info;
        hoverInfoEl.style.left = pt.x + 'px';
        hoverInfoEl.style.top = pt.y + 'px';
        hoverInfoEl.style.display = 'block';
    }
}
function hideHoverMarker() {
    const src = map.getSource('hover-point');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
    currentHoverDispDist = null;
    if (elevationChart) {
        elevationChart.setActiveElements([]);
        if (elevationChart.tooltip) elevationChart.tooltip.setActiveElements([]);
        elevationChart.update('none');
    }
    lastSegIdx = -1;
    map.getSource('hover-segment')?.setData({ type: 'FeatureCollection', features: [] });
    map.setFilter('turnaround-highlight-layer', ['==', ['get', 'idx'], -1]);
    map.setFilter('turnaround-layer', null);
    hoverInfoEl.style.display = 'none';
}

function getDisplayDistance(meters) {
    return currentUnits === 'metric' ? meters / 1000 : meters * 0.000621371;
}

function getPixelOffset(zoom) {
    if (zoom <= 8) return 0;
    if (zoom <= 12) return 2 * (zoom - 8) / 4;
    if (zoom <= 15) return 2 + 2 * (zoom - 12) / 3;
    if (zoom <= 18) return 4 + 2 * (zoom - 15) / 3;
    return 6;
}

function updateDistanceUI() {
    if (waypoints.length < 2) {
        document.getElementById('total-distance').textContent = currentUnits === 'metric' ? '0.00 km' : '0.00 mi';
        return;
    }
    if (currentUnits === 'metric') {
        const distanceKm = (currentDistanceMeters / 1000).toFixed(2);
        document.getElementById('total-distance').textContent = distanceKm + ' km';
    } else {
        const distanceMi = (currentDistanceMeters * 0.000621371).toFixed(2);
        document.getElementById('total-distance').textContent = distanceMi + ' mi';
    }
}

// ─── Elevation Web Worker ─────────────────────────────────────────────────────
// All tile fetching and pixel decoding runs off the main thread.
const elevationWorker = new Worker('elevation-worker.js?v=' + Date.now());
const _workerCallbacks = new Map();
let _nextWorkerId = 0;

elevationWorker.onmessage = (e) => {
    const cb = _workerCallbacks.get(e.data.id);
    if (cb) { _workerCallbacks.delete(e.data.id); cb(e.data.elevations); }
};

function getHighResElevation(coords) {
    return new Promise(resolve => {
        const id = _nextWorkerId++;
        _workerCallbacks.set(id, resolve);
        elevationWorker.postMessage({ id, coords, mapboxToken });
    });
}

// ─── Route layer setup ───────────────────────────────────────────────────────
// Each source and layer has its OWN independent guard so a pre-existing source
// with any one of these names won't silently skip the rest of the block.
function setupRouteLayers() {
    // Terrain / hillshade (using free Terrarium elevation data)
    const terrainTiles = ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'];
    const terrainEncoding = 'terrarium';

    if (!map.getSource('terrain-source'))
        map.addSource('terrain-source', { type: 'raster-dem', tiles: terrainTiles, tileSize: 256, encoding: terrainEncoding, maxzoom: 12 });

    // Hillshade can use the same source as terrain to save memory and network
    if (!map.getLayer('hillshade-layer'))
        map.addLayer({ id: 'hillshade-layer', type: 'hillshade', source: 'terrain-source', paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': 'rgba(0,0,0,0.5)', 'hillshade-highlight-color': 'rgba(255,255,255,0.1)' }, layout: { visibility: 'none' } });

    // Route sources (Removed tolerance:0 to allow MapLibre to simplify geometry based on zoom level)
    if (!map.getSource('route'))
        map.addSource('route', { type: 'geojson', data: { type: 'LineString', coordinates: [] } });
    if (!map.getSource('route-segments'))
        map.addSource('route-segments', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // Single LineString with lineMetrics:true — required for line-gradient paint.
    let gradData = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
    if (currentRouteGeoJSON) {
        gradData.geometry.coordinates = decimateLine(currentRouteGeoJSON.coordinates, PERF_MAP_POINTS);
    }

    if (!map.getSource('route-gradient'))
        map.addSource('route-gradient', {
            type: 'geojson',
            data: gradData,
            lineMetrics: true,
            buffer: 8, tolerance: 0
        });

    if (!map.getLayer('route-gradient-layer'))
        map.addLayer({
            id: 'route-gradient-layer',
            type: 'line',
            source: 'route-gradient',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': 'rgb(34,197,94)',
                'line-width': 5,
                'line-opacity': 0.97,
                'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgb(34,197,94)', 1, 'rgb(34,197,94)'],
                'line-offset': ['interpolate', ['linear'], ['zoom'], 8, 0, 12, 2, 15, 4, 18, 6]
            }
        });

    // Transparent interaction layer (hit target for drag, finger cursor)
    if (!map.getLayer('route-line'))
        map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': 20, 'line-opacity': 0 } });

    // Invisible wide hover target (for distance/elev snapping, zero visual impact)
    if (!map.getLayer('route-hover-target'))
        map.addLayer({ id: 'route-hover-target', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': 100, 'line-opacity': 0 } });

    // Turnaround Joins: Lines that bridge the parallel offset lines at sharp turns
    if (!map.getSource('turnarounds'))
        map.addSource('turnarounds', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.getLayer('turnaround-layer'))
        map.addLayer({
            id: 'turnaround-layer',
            type: 'line',
            source: 'turnarounds',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': ['get', 'color'],
                'line-width': 5,
                'line-opacity': 0.97
            }
        }, 'route-gradient-layer');
    if (!map.getLayer('turnaround-highlight-layer'))
        map.addLayer({
            id: 'turnaround-highlight-layer',
            type: 'line',
            source: 'turnarounds',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': ['get', 'color'],
                'line-width': 10,
                'line-opacity': 1.0
            },
            filter: ['==', ['get', 'idx'], -1] // Initially hide
        });

    // Highlight for the active segment being hovered
    if (!map.getSource('hover-segment'))
        map.addSource('hover-segment', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, lineMetrics: true });
    if (!map.getLayer('hover-segment-layer'))
        map.addLayer({
            id: 'hover-segment-layer',
            type: 'line',
            source: 'hover-segment',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-width': 10,
                'line-opacity': 1.0,
                'line-offset': ['interpolate', ['linear'], ['zoom'], 8, 0, 12, 2, 15, 4, 18, 6]
            }
        });

    // Dragging guides (rubber-band lines) — solid grey, no dash
    if (!map.getSource('drag-guide'))
        map.addSource('drag-guide', { type: 'geojson', data: { type: 'LineString', coordinates: [] } });
    if (!map.getLayer('drag-guide-layer'))
        map.addLayer({
            id: 'drag-guide-layer',
            type: 'line',
            source: 'drag-guide',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#9ca3af', 'line-width': 2, 'line-opacity': 0.85 }
        });

    // Preview pin created as an HTML Marker using the same pinSvg shape.
    // Instantiated once and shown/hidden during drag.
    if (!window._dragPreviewMarker) {
        const pinEl = document.createElement('div');
        pinEl.style.cssText = 'pointer-events:none; opacity:0.5;';
        pinEl.innerHTML = pinSvg('#4b5563', '', 0); // Remove border (strokeWidth=0), Dark Grey
        window._dragPreviewMarker = new maplibregl.Marker({ element: pinEl, anchor: 'bottom', offset: [0, 2] })
            .setLngLat([0, 0]);
        // Don't add to map yet — added on first drag
        window._dragPreviewMarker._pinEl = pinEl;
    }

    // Hover circle (Single grey circle with white stroke to match chart style)
    if (!map.getSource('hover-point'))
        map.addSource('hover-point', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.getLayer('hover-circle'))
        map.addLayer({
            id: 'hover-circle',
            type: 'circle',
            source: 'hover-point',
            paint: {
                'circle-radius': 6,
                'circle-color': '#4b5563',
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#ffffff',
                'circle-pitch-alignment': 'map'
            }
        });


    // Re-upload route data if already computed (e.g. after a style swap)
    if (currentRouteGeoJSON && map.getSource('route')) {
        const coords = currentRouteGeoJSON.coordinates;
        map.getSource('route').setData({ type: 'LineString', coordinates: coords });
        // Gradient source uses decimated coords to avoid WebGL vertex limit (65535)
        map.getSource('route-gradient').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: decimateLine(coords, PERF_MAP_POINTS) } });
        rebuildMapGradient();
    }
}
let isFirstLoad = true;
let initialBasemapCycled = false;
map.on('style.load', () => {
    setupRouteLayers();
    if (isFirstLoad) {
        loadStoredSettings();
        loadUrlState();
        isFirstLoad = false;
    }

    const updateView = () => {
        rebuildRouteScreenPts();
        updateTurnaroundJoins();
        rebuildMapGradient(); // Miter point depends on zoom — refresh display coords

        try {
            const center = map.getCenter();
            localStorage.setItem('last_map_center', JSON.stringify([center.lng, center.lat]));
            localStorage.setItem('last_map_zoom', map.getZoom().toString());
        } catch (_) { }
    };
    map.on('moveend', updateView);
    map.on('zoomend', () => { isZooming = false; updateView(); });
    map.on('zoomstart', () => { isZooming = true; });
    const updateCompass = () => {
        const compass = document.getElementById('compass-needle-svg');
        if (compass) compass.style.transform = `rotate(${-map.getBearing()}deg)`;
    };
    map.on('rotate', updateCompass);
    updateCompass();
});

map.on('load', () => {
    // Basic setup already done in style.load
});

// Clear all hover states (marker, label, chart) as soon as the map starts moving or zooming.
// This prevents stale data from being displayed while the route geometry is shifting.
map.on('movestart', () => {
    hideHoverMarker();
    clearHoverHighlight();
    const mobileScreen = document.getElementById('mobile-search-screen');
    const isMobileSearchActive = mobileScreen && mobileScreen.classList.contains('active');
    if (!isMobileSearchActive && window._collapseSearch) {
        window._collapseSearch();
    }
});

// Change cursor when hovering the route
map.on('mouseenter', 'route-line', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'route-line', () => {
    if (!isDraggingLine) {
        map.getCanvas().style.cursor = '';
        clearHoverHighlight();
    }
});

// Throttled Hover Logic: Only runs when mouse is near the route
let lastHoverTime = 0;
function findClosestPointOnLine(mousePt) {
    if (!currentRouteGeoJSON || !routeScreenPts) return { bestCi: -1 };
    const currentOffset = getPixelOffset(map.getZoom());
    let bestDistSq = Infinity;
    let bestCi = -1;
    let bestT = 0;
    let bestProj = { x: 0, y: 0 };

    for (let i = 0; i < routeScreenPts.length - 1; i++) {
        const a = routeScreenPts[i];
        const b = routeScreenPts[i + 1];
        if (!a || !b) continue;
        const abx = b.x - a.x, aby = b.y - a.y;
        const abLenSq = abx * abx + aby * aby;
        if (abLenSq === 0) continue;

        const nx = -aby / Math.sqrt(abLenSq);
        const ny = abx / Math.sqrt(abLenSq);
        const aoX = a.x + nx * currentOffset, aoY = a.y + ny * currentOffset;
        const boX = b.x + nx * currentOffset, boY = b.y + ny * currentOffset;
        const abox = boX - aoX, aboy = boY - aoY;

        let t = ((mousePt.x - aoX) * abox + (mousePt.y - aoY) * aboy) / abLenSq;
        t = Math.max(0, Math.min(1, t));

        const pProjX = aoX + t * abox, pProjY = aoY + t * aboy;
        const dx = pProjX - mousePt.x, dy = pProjY - mousePt.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestCi = i;
            bestT = t;
            bestProj = { x: pProjX, y: pProjY };
        }
    }
    return { bestCi, bestT, bestDistSq, bestProj };
}

map.on('mousemove', 'route-line', (e) => {
    if (window.innerWidth <= 768) return; // Disable hover interaction on mobile
    if (isDraggingLine || isDraggingMarker) {
        clearHoverHighlight();
        return;
    }
    if (map.isMoving() || map.isZooming() || map.isRotating()) {
        clearHoverHighlight();
        return;
    }
    const now = performance.now();
    if (now - lastHoverTime < 16) return; // 60fps throttle
    lastHoverTime = now;

    if (!currentRouteGeoJSON || !routeScreenPts) return;
    const coords = currentRouteGeoJSON.coordinates;
    const mousePt = e.point;
    const highlightThreshold = 225; // 15px radius squared for the visual widening

    // Get current line-offset for projection
    const currentOffset = getPixelOffset(map.getZoom());

    let bestDistSq = Infinity;
    let bestCi = -1;
    let bestT = 0;
    let bestProj = { x: 0, y: 0 };

    for (let i = 0; i < routeScreenPts.length - 1; i++) {
        const a = routeScreenPts[i];
        const b = routeScreenPts[i + 1];
        if (!a || !b) continue; // Skip off-screen segments
        const abx = b.x - a.x, aby = b.y - a.y;
        const abLenSq = abx * abx + aby * aby;
        if (abLenSq === 0) continue;

        const nx = -aby / Math.sqrt(abLenSq);
        const ny = abx / Math.sqrt(abLenSq);

        const aoX = a.x + nx * currentOffset, aoY = a.y + ny * currentOffset;
        const boX = b.x + nx * currentOffset, boY = b.y + ny * currentOffset;
        const abox = boX - aoX, aboy = boY - aoY;

        let t = ((mousePt.x - aoX) * abox + (mousePt.y - aoY) * aboy) / abLenSq;
        t = Math.max(0, Math.min(1, t));

        const pProjX = aoX + t * abox;
        const pProjY = aoY + t * aboy;
        const dx = pProjX - mousePt.x;
        const dy = pProjY - mousePt.y;
        const dSq = dx * dx + dy * dy;

        if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestCi = i;
            bestT = t;
            bestProj = { x: pProjX, y: pProjY };
        }
    }

    if (bestCi !== -1 && bestDistSq < highlightThreshold) {
        bestCiGlobal = bestCi;
        const shiftedLngLat = map.unproject([bestProj.x, bestProj.y]);
        updateHoverHighlight(bestCi, bestT, [shiftedLngLat.lng, shiftedLngLat.lat]);
    } else {
        clearHoverHighlight();
    }
});

function updateHoverHighlight(ci, t, lngLat) {
    const ds = elevationChart?.data?.datasets?.[0];
    let chartIdx = ci;
    if (routePathDistances && ds?.data?.length) {
        const meters = routePathDistances[ci] + t *
            (routePathDistances[Math.min(ci + 1, routePathDistances.length - 1)] - routePathDistances[ci]);
        const dispDist = currentUnits === 'imperial' ? meters / 1609.344 : meters / 1000;
        let lo = 0, hi = ds.data.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ds.data[mid].x < dispDist) lo = mid + 1; else hi = mid;
        }
        chartIdx = lo;
    }
    chartIdx = Math.min(chartIdx, (ds?.data?.length ?? 1) - 1);

    const pt = ds?.data?.[chartIdx];
    const grade = ds?.grades?.[ci];
    const distMeters = routePathDistances?.[ci] ?? 0;
    const dispDist = currentUnits === 'imperial' ? distMeters / 1609.344 : distMeters / 1000;
    const distLabel = dispDist.toFixed(2) + (currentUnits === 'metric' ? ' km' : ' mi');
    const elevVal = pt?.y;
    const elevLabel = elevVal != null ? elevVal.toFixed(1) + (currentUnits === 'metric' ? ' m' : ' ft') : '';
    const gradeLabel = grade !== undefined ? (grade >= 0 ? '+' : '') + grade.toFixed(2) + '%' : '';
    const info = `${distLabel} <span style="color:#888">&nbsp;|&nbsp;</span> ${elevLabel} <span style="color:#888">&nbsp;|&nbsp;</span> ${gradeLabel}`;
    showHoverMarker(lngLat, info);

    const statsDiv = document.getElementById('hover-stats');
    if (statsDiv) {
        statsDiv.style.opacity = '1';
        document.getElementById('hover-dist').textContent = distLabel;
        document.getElementById('hover-elev').textContent = elevLabel;
        document.getElementById('hover-grade').textContent = gradeLabel;
    }

    if (waypointPathIndices.length >= 2) {
        let segIdx = -1;
        for (let j = 0; j < waypointPathIndices.length - 1; j++) {
            if (ci >= waypointPathIndices[j] && ci < waypointPathIndices[j + 1]) {
                segIdx = j; break;
            }
        }
        if (segIdx !== -1 && segIdx !== lastSegIdx) {
            showHoverSegment(ci);
        }
    }

    if (ci !== lastHoverIdx) {
        lastHoverIdx = ci;
        currentHoverDispDist = dispDist; // Sync with chart hover line
        if (elevationChart) {
            elevationChart.update('none');
        }
    }
}

function clearHoverHighlight() {
    const statsDiv = document.getElementById('hover-stats');
    if (statsDiv) statsDiv.style.opacity = '0';
    if (lastHoverIdx !== -1) {
        lastHoverIdx = -1;
        lastSegIdx = -1;
        currentHoverDispDist = null; // Clear chart hover line
        hideHoverMarker();
        map.getSource('hover-segment')?.setData({ type: 'FeatureCollection', features: [] });
        map.setFilter('turnaround-highlight-layer', ['==', ['get', 'idx'], -1]);
        map.setFilter('turnaround-layer', null);
        if (elevationChart) {
            try {
                elevationChart.setActiveElements([]);
                if (elevationChart.tooltip) elevationChart.tooltip.setActiveElements([]);
                elevationChart.update('none');
            } catch (err) { }
        }
    }
}

map.on('mouseleave', clearHoverHighlight);
window.addEventListener('blur', clearHoverHighlight);

// Explicitly clear hover when moving into UI overlays
['top-bar', 'elevation-panel'].forEach(id => {
    document.getElementById(id)?.addEventListener('mouseenter', () => {
        lastHoverIdx = -1;
        hideHoverMarker();
    });
});





function invalidateGPXSegment(idx) {
    if (idx > 0 && segmentModes[idx - 1] === 'gpx') {
        segmentModes[idx - 1] = currentRoutingMode;
        segmentGPXPaths[idx - 1] = null;
    }
    if (idx < segmentModes.length && segmentModes[idx] === 'gpx') {
        segmentModes[idx] = currentRoutingMode;
        segmentGPXPaths[idx] = null;
    }
}

function createMarker(lngLat, index, initialMode) {
    const el = document.createElement('div');
    el.style.width = '24px';
    el.style.height = '34px';
    el.style.cursor = 'pointer';
    el.style.filter = 'drop-shadow(0 2px 2px rgba(0,0,0,0.4))';
    el.innerHTML = pinSvg('#4b5563');

    const marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: true })
        .setLngLat(lngLat)
        .addTo(map);

    const onRightClick = (evt) => {
        if (evt.button === 2) { // Right click
            evt.preventDefault();
            evt.stopPropagation();
            const idx = markers.indexOf(marker);
            if (idx > -1) {
                saveHistory();
                markers.splice(idx, 1);
                waypoints.splice(idx, 1);
                if (idx > 0) {
                    segmentModes.splice(idx - 1, 1);
                    segmentGPXPaths.splice(idx - 1, 1);
                } else {
                    segmentModes.splice(0, 1);
                    segmentGPXPaths.splice(0, 1);
                }
                marker.remove();
                updateRoute();
            }
        }
    };
    marker.getElement().addEventListener('mousedown', (evt) => {
        if (evt.button !== 0) {
            if (evt.button === 2) {
                onRightClick(evt);
            }
            evt.preventDefault();
            evt.stopPropagation();
        }
    }, true);
    marker.getElement().addEventListener('auxclick', onRightClick);
    marker.getElement().addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    // Mobile Long-Press Deletion
    let markerTouchStart = null;
    let markerLongPressTimer = null;
    marker.getElement().addEventListener('touchstart', (e) => {
        window._isMarkerTouch = true;
        markerTouchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        markerLongPressTimer = setTimeout(() => {
            handleLongPress(marker.getLngLat(), marker);
            markerLongPressTimer = null;
        }, 600);
    }, { passive: true });
    marker.getElement().addEventListener('touchend', () => {
        setTimeout(() => { window._isMarkerTouch = false; }, 100);
        if (markerLongPressTimer) { clearTimeout(markerLongPressTimer); markerLongPressTimer = null; }
    }, { passive: true });
    marker.getElement().addEventListener('touchmove', (e) => {
        if (markerLongPressTimer && markerTouchStart) {
            const dist = Math.hypot(e.touches[0].clientX - markerTouchStart.x, e.touches[0].clientY - markerTouchStart.y);
            if (dist > 10) { clearTimeout(markerLongPressTimer); markerLongPressTimer = null; }
        }
    }, { passive: true });

    marker.on('dragstart', () => {
        isDraggingMarker = true;
        window._currentlyDraggingMarker = marker;
        const idx = markers.indexOf(marker);
        if (idx > -1 && waypoints[idx]) {
            window._currentlyDraggingMarkerOriginalLngLat = new maplibregl.LngLat(waypoints[idx][0], waypoints[idx][1]);
        } else {
            window._currentlyDraggingMarkerOriginalLngLat = marker.getLngLat();
        }
        window._currentlyDraggingMarkerCancel = false;
        console.log('[Antigravity] Marker dragstart. idx:', idx, 'Original location set to:', window._currentlyDraggingMarkerOriginalLngLat);
        hideHoverMarker();
        saveHistory();
    });

    marker.on('drag', () => {
        const idx = markers.indexOf(marker);
        if (idx === -1) return;
        const ll = marker.getLngLat();
        const guideCoords = [];
        if (idx > 0) guideCoords.push(waypoints[idx - 1]);
        guideCoords.push([ll.lng, ll.lat]);
        if (idx < waypoints.length - 1) guideCoords.push(waypoints[idx + 1]);
        map.getSource('drag-guide')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: guideCoords } });
    });

    marker.on('dragend', () => {
        console.log('[Antigravity] Marker dragend. window._currentlyDraggingMarkerCancel =', window._currentlyDraggingMarkerCancel);
        if (window._currentlyDraggingMarkerCancel) {
            console.log('[Antigravity] Marker dragend cancelled, aborting save.');
            return;
        }
        isDraggingMarker = false;
        window._currentlyDraggingMarker = null;
        window._currentlyDraggingMarkerOriginalLngLat = null;
        map.getSource('drag-guide')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
        hideHoverMarker();
        const idx = markers.indexOf(marker);
        if (idx > -1) {
            invalidateGPXSegment(idx);
            const ll = marker.getLngLat();
            waypoints[idx] = [ll.lng, ll.lat];
            updateRoute();
        }
    });

    const pos = marker.getLngLat();
    const lngLatArr = [pos.lng, pos.lat];

    if (index !== undefined) {
        markers.splice(index, 0, marker);
        waypoints.splice(index, 0, lngLatArr);
        // Inherit the mode of the segment being split
        let oldMode = initialMode ?? (segmentModes[index - 1] || 'bike');
        if (oldMode === 'gpx') {
            oldMode = currentRoutingMode;
            if (index > 0) {
                segmentModes[index - 1] = currentRoutingMode;
                segmentGPXPaths[index - 1] = null;
            }
        }
        segmentModes.splice(index, 0, oldMode);
        segmentGPXPaths.splice(index, 0, null);
    } else {
        markers.push(marker);
        waypoints.push(lngLatArr);
        if (waypoints.length > 1) {
            segmentModes.push(initialMode ?? currentRoutingMode);
            segmentGPXPaths.push(null);
        }
    }
    refreshMarkerIcons();
    return marker;
}

function refreshMarkerIcons() {
    markers.forEach((m, i) => {
        const el = m.getElement();
        const isEndpoint = (i === 0 || i === markers.length - 1);
        el.style.width = '24px';
        el.style.height = '34px'; // All markers are now pins
        el.innerHTML = createMarkerIcon(i, markers.length);

        // All markers are pins, so all use the same 'bottom' simulation
        m.setOffset([0, -17]);
    });
}

let wasDraggingLine = false;
let isDraggingLine = false;
let isDraggingMarker = false;
let draggedWaypointIndex = -1;

function cancelDraggingGestures() {
    console.log('[Antigravity] cancelDraggingGestures triggered. isDraggingLine:', isDraggingLine, 'isDraggingMarker:', isDraggingMarker);
    if (isDraggingLine && typeof window._activeLineDragCleanup === 'function') {
        console.log('[Antigravity] Cancelling active line drag...');
        window._activeLineDragCleanup();
    }

    const marker = window._currentlyDraggingMarker;
    const orig = window._currentlyDraggingMarkerOriginalLngLat;
    console.log('[Antigravity] Active marker to cancel:', marker, 'Original location:', orig);
    if (marker && orig) {
        window._currentlyDraggingMarkerCancel = true;
        console.log('[Antigravity] Reverting marker setLngLat to:', orig.lng, orig.lat);
        marker.setLngLat(orig);

        // Call MapLibre's internal cleanup methods directly to terminate dragging state
        try {
            if (typeof marker._onUp === 'function') {
                console.log('[Antigravity] Calling marker._onUp() directly');
                marker._onUp(new Event('touchend'));
            } else if (typeof marker._removeDragListeners === 'function') {
                console.log('[Antigravity] Calling marker._removeDragListeners() directly');
                marker._removeDragListeners();
            }
        } catch (err) {
            console.error('[Antigravity] Error calling MapLibre internal cleanup:', err);
        }

        setTimeout(() => {
            window._currentlyDraggingMarkerCancel = false;
        }, 50);
    }

    console.log('[Antigravity] Dispatching mouseup and touchend to window...');
    window.dispatchEvent(new Event('mouseup', { bubbles: true, cancelable: true }));
    window.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));

    isDraggingMarker = false;
    window._currentlyDraggingMarker = null;
    window._currentlyDraggingMarkerOriginalLngLat = null;
    map.getSource('drag-guide')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
}

// Cancel waypoint dragging if a gesture (rotate, pitch, or pinch zoom) starts
map.on('rotatestart', () => { console.log('[Antigravity] map rotatestart'); cancelDraggingGestures(); });
map.on('pitchstart', () => { console.log('[Antigravity] map pitchstart'); cancelDraggingGestures(); });
map.on('zoomstart', () => { console.log('[Antigravity] map zoomstart'); cancelDraggingGestures(); });

// Intercept touch events on capture phase before MapLibre GL stops propagation
const handleMultiTouch = (e) => {
    if (e.touches && e.touches.length > 1) {
        console.log('[Antigravity] handleMultiTouch: touches.length =', e.touches.length, 'isDraggingMarker:', isDraggingMarker, 'isDraggingLine:', isDraggingLine);
        cancelDraggingGestures();
    }
};
window.addEventListener('touchstart', handleMultiTouch, { capture: true, passive: true });
window.addEventListener('touchmove', handleMultiTouch, { capture: true, passive: true });

function distance(p1, p2) {
    const dx = p1[0] - p2[0];
    const dy = p1[1] - p2[1];
    return Math.sqrt(dx * dx + dy * dy);
}

function getInsertIndex(clickedLngLat) {
    if (waypoints.length < 2) return waypoints.length;
    let bestIndex = 1;
    let minIncrease = Infinity;
    for (let i = 0; i < waypoints.length - 1; i++) {
        const p1 = waypoints[i];
        const p2 = waypoints[i + 1];
        const d1 = distance(p1, [clickedLngLat.lng, clickedLngLat.lat]);
        const d2 = distance(p2, [clickedLngLat.lng, clickedLngLat.lat]);
        const dLine = distance(p1, p2);
        const increase = d1 + d2 - dLine;
        if (increase < minIncrease) {
            minIncrease = increase;
            bestIndex = i + 1;
        }
    }
    return bestIndex;
}

map.on('mousedown', 'route-line', onLineDown);
map.on('touchstart', 'route-line', (e) => {
    if (e.points && e.points.length > 1) return; // ignore pinch — don't interfere with MapLibre gesture tracking
    // Do NOT call preventDefault() here — it breaks MapLibre's pinch-zoom origin tracking
    onLineDown(e);
});

function onLineDown(e) {
    if (e.type === 'mousedown' && e.originalEvent.button !== 0) return;
    e.originalEvent?.stopPropagation();

    // Ensure we have a valid snapping point, especially for mobile touchstart
    const { bestCi, bestT, bestDistSq, bestProj } = findClosestPointOnLine(e.point);
    const highlightThreshold = 100 * 100; // More generous for touch
    if (bestCi === -1 || bestDistSq > highlightThreshold) return;

    // Sync global state for the up/move handlers
    bestCiGlobal = bestCi;

    const clickPt = e.point;
    for (const wp of waypoints) {
        const wpPt = map.project(wp);
        const dist = Math.hypot(wpPt.x - clickPt.x, wpPt.y - clickPt.y);
        if (dist < 25) return;
    }

    saveHistory();
    hideHoverMarker();
    isDraggingLine = true;
    wasDraggingLine = true;
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';

    let insertIdx = waypoints.length;
    for (let j = 0; j < waypointPathIndices.length - 1; j++) {
        if (bestCiGlobal >= waypointPathIndices[j] && bestCiGlobal < waypointPathIndices[j + 1]) {
            insertIdx = j + 1;
            break;
        }
    }

    const prevWp = waypoints[insertIdx - 1];
    const nextWp = waypoints[insertIdx];

    const onMove = (moveEvent) => {
        const lngLat = moveEvent.lngLat;
        const guideCoords = [prevWp, [lngLat.lng, lngLat.lat]];
        if (nextWp) guideCoords.push(nextWp);
        map.getSource('drag-guide')?.setData({ type: 'LineString', coordinates: guideCoords });
        const pm = window._dragPreviewMarker;
        if (pm) {
            pm.setLngLat(lngLat);
            if (!pm._added) { pm.addTo(map); pm._added = true; }
        }
    };

    const onUp = (upEvent) => {
        isDraggingLine = false;
        map.dragPan.enable();
        map.getCanvas().style.cursor = 'pointer';
        map.off('mousemove', onMove);
        map.off('touchmove', onMove);
        map.off('mouseup', onUp);
        map.off('touchend', onUp);

        map.getSource('drag-guide')?.setData({ type: 'LineString', coordinates: [] });
        hideHoverMarker();
        const pm = window._dragPreviewMarker;
        if (pm && pm._added) { pm.remove(); pm._added = false; }

        createMarker(upEvent.lngLat, insertIdx);
        updateRoute();
        setTimeout(() => wasDraggingLine = false, 50);
        window._activeLineDragCleanup = null;
    };

    map.on('mousemove', onMove);
    map.on('touchmove', onMove);
    map.on('mouseup', onUp);
    map.on('touchend', onUp);

    window._activeLineDragCleanup = () => {
        isDraggingLine = false;
        map.dragPan.enable();
        map.getCanvas().style.cursor = 'pointer';
        map.off('mousemove', onMove);
        map.off('touchmove', onMove);
        map.off('mouseup', onUp);
        map.off('touchend', onUp);

        map.getSource('drag-guide')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
        hideHoverMarker();
        const pm = window._dragPreviewMarker;
        if (pm && pm._added) { pm.remove(); pm._added = false; }

        wasDraggingLine = true;
        setTimeout(() => wasDraggingLine = false, 100);
        window._activeLineDragCleanup = null;
    };
}

map.on('click', (e) => {
    if (e.originalEvent.button !== 0) return; // Left click only
    if (wasDraggingLine) return;

    // Check if the click is on or too close to an existing waypoint
    const clickedPoint = e.point;
    const tooClose = waypoints.some(wp => {
        const wpPoint = map.project(new maplibregl.LngLat(wp[0], wp[1]));
        return Math.hypot(clickedPoint.x - wpPoint.x, clickedPoint.y - wpPoint.y) < 20;
    });
    if (tooClose) return;

    // Toggle individual segment mode if clicking on the route
    if (lastSegIdx !== -1) {
        saveHistory();
        const current = segmentModes[lastSegIdx] || 'bike';
        let next = 'bike';
        if (current === 'gpx') {
            next = 'bike';
            segmentGPXPaths[lastSegIdx] = null;
        } else if (current === 'bike') next = 'direct';
        else if (current === 'direct') next = 'hike';
        else if (current === 'hike') next = 'bike';
        segmentModes[lastSegIdx] = next;
        updateRoute();
        return;
    }

    saveHistory();
    createMarker(e.lngLat);
    updateRoute();
});

function getWeatherIcon(code) {
    const sunny = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    const cloudy = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`;
    const rain = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="16" y1="13" x2="14" y2="21"/><line x1="8" y1="13" x2="6" y2="21"/><line x1="12" y1="15" x2="10" y2="23"/><path d="M20 16.58A5 5 0 0 0 18 10h-1.26A8 8 0 1 0 4 15.25"/></svg>`;
    const snow = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/><line x1="4.93" y1="19.07" x2="19.07" y2="4.93"/></svg>`;
    const fog = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="10" x2="20" y2="10"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="4" y1="18" x2="20" y2="18"/><line x1="4" y1="6" x2="20" y2="6"/></svg>`;

    if (code === 0) return sunny;
    if (code <= 3) return cloudy;
    if (code <= 48) return fog;
    if (code <= 67) return rain;
    if (code <= 77) return snow;
    if (code <= 82) return rain;
    if (code <= 99) return rain;
    return sunny;
}

function showWeatherPopup(lngLat) {
    if (currentInfoPopup) currentInfoPopup.remove();

    const { lat, lng } = lngLat;
    const units = currentUnits === 'imperial' ? 'fahrenheit' : 'celsius';
    const windUnits = currentUnits === 'imperial' ? 'mph' : 'kmh';
    const tempLabel = currentUnits === 'imperial' ? '°F' : '°C';
    const windLabel = currentUnits === 'imperial' ? 'mph' : 'km/h';

    currentInfoPopup = new maplibregl.Popup({ closeButton: true, className: 'weather-popup', anchor: 'bottom' })
        .setLngLat(lngLat)
        .setHTML(`
            <div style="font-family: 'Inter', sans-serif; min-width: 160px; padding: 4px;">
                <div style="margin-top: 0;">
                    <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" 
                       style="display: flex; align-items: center; color: #3b82f6; text-decoration: underline; text-underline-offset: 2px; font-size: 14px; font-weight: 600; margin-bottom: 8px;">
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; flex-shrink: 0;">
                           <circle cx="12" cy="12" r="8"></circle>
                           <circle cx="12" cy="12" r="4.5" fill="currentColor"></circle>
                           <line x1="12" y1="0" x2="12" y2="4"></line>
                           <line x1="12" y1="20" x2="12" y2="24"></line>
                           <line x1="0" y1="12" x2="4" y2="12"></line>
                           <line x1="20" y1="12" x2="24" y2="12"></line>
                       </svg>
                       ${lat.toFixed(2)}, ${lng.toFixed(2)}
                    </a>
                </div>
                <div id="weather-info">
                    <a href="https://www.windy.com/${lat}/${lng}?${lat},${lng},11" target="_blank" style="text-decoration: none; color: inherit; display: block;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span id="weather-icon" style="display: flex; align-items: center; color: #888;"></span>
                                <span id="weather-temp" style="font-weight: 700; font-size: 16px; text-decoration: underline; text-underline-offset: 2px;">...</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 5px; color: #666; font-size: 12px; font-weight: 500;">
                                <span id="weather-wind">...</span>
                                <span id="wind-arrow" style="display: none; font-size: 14px; transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);">↑</span>
                            </div>
                        </div>
                    </a>
                </div>
            </div>
        `)
        .addTo(map);

    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m,weather_code,wind_direction_10m&temperature_unit=${units}&wind_speed_unit=${windUnits}`)
        .then(r => r.json())
        .then(data => {
            const tempEl = document.getElementById('weather-temp');
            const windEl = document.getElementById('weather-wind');
            const iconEl = document.getElementById('weather-icon');
            const arrowEl = document.getElementById('wind-arrow');
            if (tempEl) tempEl.innerText = `${Math.round(data.current.temperature_2m)}${tempLabel}`;
            if (windEl) windEl.innerText = `${Math.round(data.current.wind_speed_10m)}${windLabel}`;
            if (iconEl) iconEl.innerHTML = getWeatherIcon(data.current.weather_code);
            if (arrowEl && data.current.wind_direction_10m !== undefined) {
                arrowEl.style.display = 'inline-block';
                // Meteorological wind is 'from' direction. We add 180 to point the arrow 'towards' the flow.
                arrowEl.style.transform = `rotate(${data.current.wind_direction_10m + 180}deg)`;
            }
        }).catch(err => console.error('Weather fetch error:', err));
}

let currentInfoPopup = null;
map.getCanvasContainer().addEventListener('mousedown', (e) => {
    if (e.button === 1) { // Middle mouse button
        middleClickStartX = e.clientX;
        middleClickStartY = e.clientY;
        e.preventDefault(); // Prevent auto-scroll
    }
});
map.on('mouseup', (e) => {
    if (e.originalEvent.button !== 1) return;
    // Only show popup if cursor barely moved (i.e. it was a click, not a pan)
    const dx = e.originalEvent.clientX - middleClickStartX;
    const dy = e.originalEvent.clientY - middleClickStartY;
    if (Math.hypot(dx, dy) < 6) showWeatherPopup(e.lngLat);
});

// Prevent browser context menu on right-click so rotate works cleanly
map.getCanvasContainer().addEventListener('contextmenu', (e) => e.preventDefault());

// Long Press Handler for Mobile
let touchStartPos = null;
let longPressTimer = null;

function handleLongPress(lngLat, targetMarker = null) {
    if (targetMarker) {
        window._isMarkerTouch = false;
        // Delete pin logic
        const idx = markers.indexOf(targetMarker);
        if (idx > -1) {
            saveHistory();
            markers.splice(idx, 1);
            waypoints.splice(idx, 1);
            if (idx > 0) segmentModes.splice(idx - 1, 1);
            targetMarker.remove();
            updateRoute();
        }
    } else {
        // Show weather popup on map
        showWeatherPopup(lngLat);
    }
}

map.on('touchstart', (e) => {
    if (e.points && e.points.length > 1) return; // Ignore multi-touch
    if (window._isMarkerTouch) return; // Ignore if marker was touched
    touchStartPos = e.point;
    longPressTimer = setTimeout(() => {
        handleLongPress(e.lngLat);
        longPressTimer = null;
    }, 600);
});

map.on('touchend', () => {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
});

map.on('touchmove', (e) => {
    if (longPressTimer && touchStartPos) {
        const dist = Math.hypot(e.point.x - touchStartPos.x, e.point.y - touchStartPos.y);
        if (dist > 10) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentInfoPopup) {
        currentInfoPopup.remove();
    }
});

// Disable default browser context menu
document.getElementById('map').addEventListener('contextmenu', (e) => e.preventDefault());

let currentRouteGeoJSON = null;
let needsElevationUpdate = false;
let _elevRetryScheduled = false;
let forceMode = false; // straight-line mode — skips OSRM routing
let segmentModes = []; // 'routed' | 'direct' | 'gpx' for each segment between consecutive waypoints
let segmentGPXPaths = []; // stores raw coordinates arrays for segments with mode === 'gpx'

// --- Loading status indicator ---
function setStatus(phase) {
    const el = document.getElementById('loading-indicator');
    const ph = document.getElementById('loading-phase');
    if (el) el.style.display = 'flex';
    if (ph) ph.textContent = phase;

    const favMobile = document.getElementById('favicon-mobile');
    if (favMobile) favMobile.classList.add('loading');

    // Also update the initial cover text if visible
    const initialText = document.getElementById('initial-loading-text');
    if (initialText) initialText.textContent = phase;
}
function clearStatus() {
    const el = document.getElementById('loading-indicator');
    if (el) el.style.display = 'none';

    const favMobile = document.getElementById('favicon-mobile');
    if (favMobile) favMobile.classList.remove('loading');
}

const segmentCache = new Map();

function getCacheKey(from, to, mode, avoidUnpaved, excludeParam) {
    const fromStr = `${from[0].toFixed(6)},${from[1].toFixed(6)}`;
    const toStr = `${to[0].toFixed(6)},${to[1].toFixed(6)}`;
    const allowFerries = document.getElementById('allow-ferries-check')?.checked ?? false;
    return `${fromStr}_${toStr}_${mode}_${avoidUnpaved}_${excludeParam}_${allowFerries}`;
}

async function fetchWithTimeout(url, signal, timeoutMs = 2000) {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

    if (signal) {
        if (signal.aborted) {
            clearTimeout(timeoutId);
            throw new DOMException('Aborted', 'AbortError');
        }
        signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            timeoutController.abort();
        });
    }

    try {
        const resp = await fetch(url, { signal: timeoutController.signal });
        clearTimeout(timeoutId);
        return resp;
    } catch (e) {
        clearTimeout(timeoutId);
        if (signal && signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        if (e.name === 'AbortError') {
            throw new DOMException('Request timed out', 'TimeoutError');
        }
        throw e;
    }
}

// Fetch a single routed/direct segment; returns { coords, dist }
async function fetchOneSegment(from, to, mode, avoidUnpaved, excludeParam, signal, segmentIndex) {
    if (mode === 'gpx') {
        const coords = segmentGPXPaths[segmentIndex];
        if (coords && coords.length > 0) {
            let totalDist = 0;
            for (let i = 0; i < coords.length - 1; i++) {
                totalDist += haversineDistance(coords[i], coords[i + 1]);
            }
            return { coords: coords, dist: totalDist };
        }
        return { coords: [from, to], dist: turf_distance(from, to) };
    }

    if (mode === 'direct') {
        return { coords: [from, to], dist: turf_distance(from, to) };
    }

    const key = getCacheKey(from, to, mode, avoidUnpaved, excludeParam);
    if (segmentCache.has(key)) {
        return segmentCache.get(key);
    }

    const allowFerries = document.getElementById('allow-ferries-check')?.checked ?? false;
    const ferryVal = allowFerries ? '1' : '0';

    try {
        const bProfile = (mode === 'hike') ? 'trekking' : 'fastbike-lowtraffic';
        let bRouterUrl = `https://brouter.de/brouter?lonlats=${from[0]},${from[1]}|${to[0]},${to[1]}&profile=${bProfile}&alternativeidx=0&format=geojson&profile:allow_ferries=${ferryVal}`;
        if (avoidUnpaved) {
            bRouterUrl += `&profile:avoid_unpaved=1&profile:avoid_gravel=1`;
        }
        const endpoints = [
            bRouterUrl,
            `https://routing.openstreetmap.de/routed-bike/route/v1/bicycle/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`,
            `https://router.project-osrm.org/route/v1/cycling/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`
        ];
        for (const url of endpoints) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            try {
                // Limit fetch to 10s for brouter and 3s for others to keep response fast
                const timeoutLimit = url.includes('brouter') ? 10000 : 3000;
                const resp = await fetchWithTimeout(url, signal, timeoutLimit);
                if (!resp.ok) {
                    console.warn(`Routing endpoint failed (${resp.status}): ${url}`);
                    continue;
                }
                const data = await resp.json();

                let result = null;
                if (data.type === 'FeatureCollection' && data.features.length > 0) {
                    result = { coords: data.features[0].geometry.coordinates, dist: parseFloat(data.features[0].properties['track-length']) };
                } else if (data.code === 'Ok' && data.routes.length > 0) {
                    result = { coords: data.routes[0].geometry.coordinates, dist: data.routes[0].distance };
                }

                if (result) {
                    console.log(`Routing endpoint succeeded: ${url}`);
                    segmentCache.set(key, result);
                    return result;
                }
            } catch (e) {
                console.warn(`Routing endpoint threw error: ${url}`, e);
                if (e.name === 'AbortError') throw e;
                continue;
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') throw e;
    }
    return { coords: [from, to], dist: turf_distance(from, to) };
}

let currentAbortController = null;

async function updateRoute() {
    if (currentAbortController) {
        currentAbortController.abort();
    }
    const controller = new AbortController();
    currentAbortController = controller;
    const signal = controller.signal;

    if (waypoints.length === 0 || waypoints.length === 1) {
        if (map.getSource('route')) map.getSource('route').setData({ type: 'LineString', coordinates: [] });
        if (map.getSource('route-segments')) map.getSource('route-segments').setData({ type: 'FeatureCollection', features: [] });
        if (map.getSource('route-gradient')) map.getSource('route-gradient').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
        if (map.getSource('turnarounds')) map.getSource('turnarounds').setData({ type: 'FeatureCollection', features: [] });
        hideHoverMarker();
        currentDistanceMeters = 0;
        currentRouteGeoJSON = null;
        routeGrades = null; routePathDistances = null; routeMercatorDistances = null; routeTotalDist = 0; routeMercTotalDist = 0;
        waypointDistances = [];
        updateDistanceUI();
        updateElevationProfile();
        syncUrl();
        clearStatus();
        return;
    }

    // --- Routing phase: fetch ALL segments in parallel ---
    const numSegs = waypoints.length - 1;
    setStatus(numSegs === 1 ? 'Routing…' : `Routing ${numSegs} segments…`);

    let segments = [];
    try {
        const segmentPromises = [];
        for (let i = 0; i < numSegs; i++) {
            const mode = segmentModes[i] || 'bike';
            const avoidUnpaved = (mode !== 'hike');
            let exclude = [];
            if (avoidUnpaved) exclude.push('unpaved');
            const excludeParam = exclude.length > 0 ? `&exclude=${exclude.join(',')}` : '';
            segmentPromises.push(fetchOneSegment(waypoints[i], waypoints[i + 1], mode, avoidUnpaved, excludeParam, signal, i));
        }
        segments = await Promise.all(segmentPromises);
        if (signal.aborted) return;
    } catch (e) {
        if (e.name === 'AbortError') {
            console.log('Routing aborted');
            return;
        }
        throw e;
    }

    // Stitch segments together, removing overlapping boundary points
    let allCoords = [];
    let totalDist = 0;
    segments.forEach((seg, i) => {
        const c = i > 0 ? seg.coords.slice(1) : seg.coords;
        allCoords.push(...c);
        totalDist += seg.dist;
    });

    setStatus('Resampling…');
    currentDistanceMeters = totalDist;
    // Dynamic sampling: Target 1 point every 5 meters, min 2000, max 10000 points
    // (10k max keeps us safely below MapLibre's 65k vertex-per-bucket limit for line-gradients)
    const targetPoints = Math.min(10000, Math.max(2000, Math.ceil(totalDist / 5)));
    const rawCoords = resampleLine(allCoords, targetPoints);
    currentRouteGeoJSON = { type: 'LineString', coordinates: rawCoords };

    // Track which indices in the final path correspond to our waypoints
    waypointPathIndices = waypoints.map(wp => {
        let bestIdx = 0;
        let minDist = Infinity;
        for (let i = 0; i < rawCoords.length; i++) {
            const rc = rawCoords[i];
            if (!rc || isNaN(rc[0]) || isNaN(rc[1])) continue;
            const d = turf_distance(wp, rc);
            if (d < minDist) { minDist = d; bestIdx = i; }
        }
        return bestIdx;
    });

    if (map.getSource('route')) map.getSource('route').setData(currentRouteGeoJSON);
    rebuildMapGradient();
    if (typeof rebuildRouteScreenPts === 'function') rebuildRouteScreenPts();
    updateDistanceUI();
    // Calculate waypoint distances for the chart
    let dSum = 0;
    const dArray = [0];
    for (let i = 1; i < rawCoords.length; i++) {
        dSum += haversineDistance(rawCoords[i - 1], rawCoords[i]);
        dArray.push(dSum);
    }
    waypointDistances = waypointPathIndices.map(idx => dArray[idx]);

    needsElevationUpdate = true;
    updateElevationProfile();
    syncUrl();
    refreshMarkerIcons();
    updateTurnaroundJoins();
}


// --- Undo / Redo ---
// Each history entry is a snapshot of { waypoints, segmentModes }.
// Markers are always derived from waypoints, so only coordinates need saving.
const undoStack = [];
const redoStack = [];

function saveHistory() {
    undoStack.push({
        waypoints: waypoints.map(w => [...w]),
        modes: [...segmentModes],
        gpxPaths: segmentGPXPaths.map(p => p ? p.map(c => [...c]) : null)
    });
    redoStack.length = 0; // clear redo on new action
    updateUndoRedoBtns();
}

function updateUndoRedoBtns() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

function applyHistoryState(state) {
    // Remove current markers
    markers.forEach(m => m.remove());
    markers = [];
    waypoints = [];
    segmentModes = [];
    segmentGPXPaths = [];

    // Rebuild waypoints and markers via createMarker to ensure all listeners (drag, delete) are attached
    state.waypoints.forEach((wp, i) => {
        // createMarker pushes to waypoints/markers/segmentModes internally
        createMarker(wp);
    });

    // Restore the exact modes and GPX paths from history
    segmentModes = [...state.modes];
    segmentGPXPaths = state.gpxPaths ? state.gpxPaths.map(p => p ? p.map(c => [...c]) : null) : [];

    refreshMarkerIcons();
    updateRoute();
    updateUndoRedoBtns();
}

function undo() {
    if (!undoStack.length) return;
    redoStack.push({
        waypoints: waypoints.map(w => [...w]),
        modes: [...segmentModes],
        gpxPaths: segmentGPXPaths.map(p => p ? p.map(c => [...c]) : null)
    });
    applyHistoryState(undoStack.pop());
}

function redo() {
    if (!redoStack.length) return;
    undoStack.push({
        waypoints: waypoints.map(w => [...w]),
        modes: [...segmentModes],
        gpxPaths: segmentGPXPaths.map(p => p ? p.map(c => [...c]) : null)
    });
    applyHistoryState(redoStack.pop());
}

document.getElementById('undo-btn')?.addEventListener('click', undo);
document.getElementById('redo-btn')?.addEventListener('click', redo);
updateUndoRedoBtns();

document.getElementById('clear-route').addEventListener('click', () => {
    saveHistory();
    waypoints = [];
    markers.forEach(m => m.remove());
    markers = [];
    segmentModes = [];
    segmentGPXPaths = [];
    const gainLossEl = document.getElementById('elev-gain-loss');
    if (gainLossEl) gainLossEl.textContent = '';
    updateRoute();
    updateUndoRedoBtns();
});

function getFitBoundsPadding() {
    const mapContainer = map.getContainer();
    const mapRect = mapContainer ? mapContainer.getBoundingClientRect() : null;
    if (!mapRect || mapRect.width === 0 || mapRect.height === 0) {
        return 60;
    }

    // Default base padding in pixels
    let padding = { top: 60, bottom: 60, left: 60, right: 60 };

    function applyPanelPadding(panelId) {
        const isComputer = window.innerWidth > 768;
        if (panelId === 'stats-panel' && !isComputer) {
            return;
        }

        const panel = document.getElementById(panelId);
        if (!panel || panel.offsetWidth === 0 || panel.offsetHeight === 0) {
            return;
        }
        const rect = panel.getBoundingClientRect();
        
        // Relative coordinates to map container
        const panelLeft = rect.left - mapRect.left;
        const panelRight = rect.right - mapRect.left;
        const panelTop = rect.top - mapRect.top;
        const panelBottom = rect.bottom - mapRect.top;

        // Check if it overlaps the map container
        if (rect.bottom >= mapRect.top && rect.top <= mapRect.bottom &&
            rect.right >= mapRect.left && rect.left <= mapRect.right) {
            
            const isFullWidth = rect.width >= mapRect.width * 0.85;
            const isFullHeight = rect.height >= mapRect.height * 0.85;

            if (isComputer && !isFullWidth && !isFullHeight) {
                // Floating panel on computer: compare screen proportions to decide the best axis to pad.
                const widthProportion = rect.width / mapRect.width;
                const heightProportion = rect.height / mapRect.height;

                if (widthProportion > heightProportion) {
                    // Panel is wide/short: pad vertically
                    const isTop = (rect.top + rect.height / 2) < (mapRect.top + mapRect.height / 2);
                    if (isTop) {
                        const overlapTop = Math.max(0, rect.bottom - mapRect.top);
                        padding.top = Math.max(padding.top, overlapTop + 20);
                    } else {
                        const overlapBottom = Math.max(0, mapRect.bottom - rect.top);
                        padding.bottom = Math.max(padding.bottom, overlapBottom + 20);
                    }
                } else {
                    // Panel is tall/narrow: pad horizontally
                    const isLeft = (rect.left + rect.width / 2) < (mapRect.left + mapRect.width / 2);
                    if (isLeft) {
                        const overlapLeft = Math.max(0, rect.right - mapRect.left);
                        padding.left = Math.max(padding.left, overlapLeft + 20);
                    } else {
                        const overlapRight = Math.max(0, mapRect.right - rect.left);
                        padding.right = Math.max(padding.right, overlapRight + 20);
                    }
                }
            } else {
                // Mobile or full-screen panels:
                if (isFullWidth || panelId === 'elevation-panel') {
                    // Default elevation profile style is bottom-aligned
                    const overlapBottom = Math.max(0, mapRect.bottom - rect.top);
                    padding.bottom = Math.max(padding.bottom, overlapBottom + 20);
                } else {
                    // Default stats panel is left-aligned on mobile
                    const overlapLeft = Math.max(0, rect.right - mapRect.left);
                    padding.left = Math.max(padding.left, overlapLeft + 20);
                }
            }
        }
    }

    applyPanelPadding('elevation-panel');
    applyPanelPadding('stats-panel');

    return padding;
}

function fitRoute() {
    if (!currentRouteGeoJSON || currentRouteGeoJSON.coordinates.length === 0) {
        if (waypoints.length > 0) {
            const bounds = new maplibregl.LngLatBounds();
            waypoints.forEach(wp => bounds.extend(wp));
            map.fitBounds(bounds, { padding: getFitBoundsPadding(), duration: 600 });
        }
        return;
    }
    const bounds = new maplibregl.LngLatBounds();
    currentRouteGeoJSON.coordinates.forEach(c => bounds.extend(c));
    map.fitBounds(bounds, { padding: getFitBoundsPadding(), duration: 600 });
}

document.getElementById('fit-route-btn').addEventListener('click', fitRoute);
document.getElementById('reverse-route-btn')?.addEventListener('click', reverseRoute);
document.getElementById('current-location-btn')?.addEventListener('click', () => requestLocation(true));
document.getElementById('reset-orientation-btn')?.addEventListener('click', () => {
    map.flyTo({ bearing: 0, pitch: 0 });
});

// --- Search and Shortcuts ---

(function () {
    const wrapper = document.querySelector('.search-wrapper');
    const input = document.getElementById('map-search');
    const toggleBtn = document.getElementById('search-toggle');
    if (!input || !wrapper || !toggleBtn) return;

    const dropdown = document.getElementById('search-dropdown') || document.createElement('div');
    if (!dropdown.id) {
        dropdown.id = 'search-dropdown';
        wrapper.appendChild(dropdown);
    }

    let debounceTimer = null;
    let currentResults = [];

    const mobileScreen = document.getElementById('mobile-search-screen');
    const mobileInput = document.getElementById('mobile-map-search');
    const mobileBackBtn = document.getElementById('mobile-search-back');
    const mobileClearBtn = document.getElementById('mobile-search-clear');
    const mobileDropdown = document.getElementById('mobile-search-dropdown');

    function closeDropdown() {
        dropdown.innerHTML = '';
        dropdown.style.display = 'none';
    }

    function closeMobileSearch() {
        if (mobileScreen) {
            mobileScreen.classList.remove('active');
            if (mobileInput) mobileInput.blur();
        }
    }

    function openMobileSearch() {
        if (mobileScreen) {
            mobileScreen.classList.add('active');
            if (mobileInput) {
                mobileInput.value = '';
                setTimeout(() => mobileInput.focus(), 200);
            }
            if (mobileDropdown) {
                mobileDropdown.innerHTML = '';
                mobileDropdown.style.display = 'none';
            }
            if (mobileClearBtn) mobileClearBtn.style.display = 'none';
        }
    }

    function collapseSearch() {
        wrapper.classList.remove('expanded');
        const group = wrapper.closest('.icon-btn-group');
        if (group) group.classList.remove('active');
        input.value = '';
        closeDropdown();
        input.blur();
        closeMobileSearch();
    }

    function toggleSearch() {
        if (window.innerWidth <= 768) {
            openMobileSearch();
            return;
        }
        const isExpanded = wrapper.classList.toggle('expanded');
        const group = wrapper.closest('.icon-btn-group');
        if (group) group.classList.toggle('active', isExpanded);

        if (isExpanded) {
            setTimeout(() => input.focus(), 300);
        } else {
            collapseSearch();
        }
    }

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSearch();
    });

    function selectResult(item) {
        // Fly to location only — do NOT add a waypoint
        map.flyTo({ center: [parseFloat(item.lon), parseFloat(item.lat)], zoom: 14 });
        collapseSearch();
    }

    function renderDropdown(results) {
        dropdown.innerHTML = '';
        currentResults = results;
        if (!results.length) { closeDropdown(); return; }
        results.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'search-result-row';
            row.textContent = item.display_name;
            row.addEventListener('mousedown', (e) => {
                e.preventDefault(); // prevent blur firing before click
                selectResult(item);
            });
            dropdown.appendChild(row);
        });
        dropdown.style.display = 'block';
    }

    async function fetchSuggestions(query) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
            const data = await res.json();
            renderDropdown(data);
        } catch (_) { }
    }

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const q = input.value.trim();
        if (q.length < 2) { closeDropdown(); return; }
        debounceTimer = setTimeout(() => fetchSuggestions(q), 250);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (currentResults.length > 0) selectResult(currentResults[0]);
        } else if (e.key === 'Escape') {
            collapseSearch();
        }
    });

    input.addEventListener('blur', () => {
        // Small delay so mousedown on result fires first
        setTimeout(closeDropdown, 150);
    });

    // Mobile Search Input & Event Handlers
    if (mobileInput) {
        mobileInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            const q = mobileInput.value.trim();
            if (q.length === 0) {
                if (mobileClearBtn) mobileClearBtn.style.display = 'none';
            } else {
                if (mobileClearBtn) mobileClearBtn.style.display = 'block';
            }
            if (q.length < 2) {
                if (mobileDropdown) {
                    mobileDropdown.innerHTML = '';
                    mobileDropdown.style.display = 'none';
                }
                return;
            }
            debounceTimer = setTimeout(() => {
                fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`)
                    .then(res => res.json())
                    .then(data => {
                        if (mobileDropdown) {
                            mobileDropdown.innerHTML = '';
                            if (!data.length) {
                                mobileDropdown.style.display = 'none';
                                return;
                            }
                            data.forEach((item) => {
                                const row = document.createElement('div');
                                row.className = 'search-result-row';
                                row.textContent = item.display_name;
                                row.addEventListener('click', () => {
                                    map.flyTo({ center: [parseFloat(item.lon), parseFloat(item.lat)], zoom: 14 });
                                    closeMobileSearch();
                                });
                                mobileDropdown.appendChild(row);
                            });
                            mobileDropdown.style.display = 'block';
                        }
                    })
                    .catch(() => { });
            }, 250);
        });

        mobileInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (mobileDropdown) {
                    const firstRow = mobileDropdown.querySelector('.search-result-row');
                    if (firstRow) firstRow.click();
                }
            } else if (e.key === 'Escape') {
                closeMobileSearch();
            }
        });
    }

    if (mobileBackBtn) {
        mobileBackBtn.addEventListener('click', () => {
            closeMobileSearch();
        });
    }

    if (mobileClearBtn) {
        mobileClearBtn.addEventListener('click', () => {
            if (mobileInput) {
                mobileInput.value = '';
                mobileInput.focus();
            }
            mobileClearBtn.style.display = 'none';
            if (mobileDropdown) {
                mobileDropdown.innerHTML = '';
                mobileDropdown.style.display = 'none';
            }
        });
    }

    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target) && (!mobileScreen || !mobileScreen.contains(e.target)) && e.target.id !== 'search-toggle' && !e.target.closest('#search-toggle')) {
            collapseSearch();
        }
    });

    // Make toggleSearch available globally for hotkey
    window._toggleSearch = toggleSearch;
    window._collapseSearch = collapseSearch;
})();

function reverseRoute() {
    if (waypoints.length < 2) return;
    saveHistory();
    waypoints.reverse();
    markers.reverse();
    segmentModes.reverse();
    markers.forEach(m => m.addTo(map));
    refreshMarkerIcons();
    updateRoute();
}

function deleteLastWaypoint() {
    if (waypoints.length === 0) return;
    saveHistory();
    const idx = waypoints.length - 1;
    const marker = markers[idx];
    markers.splice(idx, 1);
    waypoints.splice(idx, 1);
    if (idx > 0) segmentModes.splice(idx - 1, 1);
    if (marker) marker.remove();
    updateRoute();
    refreshMarkerIcons();
}

window.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    const isInput = activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable;

    // If we are currently capturing a new key for the modal, handle it here
    if (activeCaptureKey && !isInput) {
        e.preventDefault();
        let key = e.key.toLowerCase();
        if (key !== 'escape') {
            currentKeybindings[activeCaptureKey] = key;
        }
        activeCaptureKey = null;
        renderKeybindings();
        return;
    }

    if (isInput) return;

    // Undo / Redo — fixed shortcuts
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault(); undo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault(); redo(); return;
    }

    const key = e.key.toLowerCase();

    if (key === currentKeybindings.toggleElevation) {
        e.preventDefault();
        document.getElementById('elevation-toggle-btn')?.click();
    } else if (key === currentKeybindings.toggleMode) {
        e.preventDefault();
        cycleRoutingMode();
    } else if (key === currentKeybindings.fitRoute) {
        e.preventDefault();
        fitRoute();
    } else if (key === currentKeybindings.toggleSettings) {
        e.preventDefault();
        toggleSettings();
    } else if (key === currentKeybindings.search) {
        e.preventDefault();
        const wrapper = document.querySelector('.search-wrapper');
        const input = document.getElementById('map-search');
        if (wrapper && !wrapper.classList.contains('expanded')) {
            window._toggleSearch?.();
        } else if (input) {
            input.focus();
            input.select();
        }
    } else if (key === currentKeybindings.toggleStats) {
        e.preventDefault();
        toggleStatsPanel();
    } else if (key === currentKeybindings.reverse) {
        e.preventDefault();
        reverseRoute();
    } else if (key === currentKeybindings.deleteLast || key === 'delete' || key === 'backspace') {
        // Special case: Delete/Backspace always available as defaults for deletion
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            document.getElementById('clear-route')?.click();
        } else {
            deleteLastWaypoint();
        }
    } else if (key === currentKeybindings.resetOrientation) {
        e.preventDefault();
        map.flyTo({ bearing: 0, pitch: 0 });
    }
}, true);

// Settings Handlers
document.getElementById('theme').addEventListener('change', (e) => {
    localStorage.setItem('route_theme', e.target.value);
    if (e.target.value === 'light') {
        document.body.classList.add('light-mode');
    } else {
        document.body.classList.remove('light-mode');
    }
});

// Basemap switching — vector styles swap the whole style; raster use inline style
document.getElementById('basemap').addEventListener('change', (e) => {
    const val = e.target.value;
    currentBasemap = val;
    localStorage.setItem('route_basemap', val);

    const newStyle = VECTOR_STYLES[val]
        ? VECTOR_STYLES[val]
        : buildRasterStyle(RASTER_BASEMAPS[val] || RASTER_BASEMAPS.osm);

    map.setStyle(newStyle);

    // After a setStyle() call all custom sources/layers are wiped.
    // Re-add them once the new style is ready.
    // We use both 'style.load' AND a 200ms fallback because inline raster styles
    // can finish loading synchronously before the once() listener is registered.
    let _setupDone = false;
    const _doSetup = () => {
        if (_setupDone) return;
        _setupDone = true;
        setupRouteLayers();
        applyTerrain();
    };
    map.once('style.load', _doSetup);
    setTimeout(() => {
        if (!_setupDone && map.isStyleLoaded()) _doSetup();
    }, 200);
});

document.getElementById('units').addEventListener('change', (e) => {
    currentUnits = e.target.value;
    localStorage.setItem('route_units', currentUnits);
    updateDistanceUI();
    updateSpeedSettingUI();
    // Force chart to re-render with new units (elevation data is cached in the worker tile cache)
    needsElevationUpdate = true;
    if (typeof updateElevationProfile === 'function') updateElevationProfile();
});

document.getElementById('projection').addEventListener('change', (e) => {
    const proj = e.target.value;
    localStorage.setItem('route_projection', proj);
    map.setProjection({ type: proj });
});

// GPX Import: supports track (trkpt) and route/waypoint (rtept, wpt) formats
function importGPX(file) {
    const reader = new FileReader();
    reader.onload = async e => {
        try {
            const xml = new DOMParser().parseFromString(e.target.result, 'application/xml');
            const trkpts = [...xml.querySelectorAll('trkpt')];
            const rtepts = [...xml.querySelectorAll('rtept')];
            const wpts = [...xml.querySelectorAll('wpt')];

            // Clear current route
            waypoints = [];
            markers.forEach(m => m.remove());
            markers = [];
            segmentModes = [];
            segmentGPXPaths = [];
            currentRouteGeoJSON = null;

            if (trkpts.length > 0) {
                // GPS track — use coordinates directly, place markers at start/end only
                const coords = trkpts
                    .map(pt => [parseFloat(pt.getAttribute('lon')), parseFloat(pt.getAttribute('lat'))])
                    .filter(c => !isNaN(c[0]) && !isNaN(c[1]));
                if (coords.length < 2) { alert('GPX track has fewer than 2 valid points.'); return; }

                createMarker({ lng: coords[0][0], lat: coords[0][1] });
                createMarker({ lng: coords[coords.length - 1][0], lat: coords[coords.length - 1][1] });

                // Set segment mode to GPX and store coordinates in segmentGPXPaths
                segmentModes = ['gpx'];
                segmentGPXPaths = [coords];

                await updateRoute();

                const bounds = new maplibregl.LngLatBounds();
                coords.forEach(c => bounds.extend(c));
                map.fitBounds(bounds, { padding: getFitBoundsPadding(), maxZoom: 17, duration: 700 });
            } else {
                // Route/waypoints — create markers and route via OSRM / direct
                const pts = rtepts.length > 0 ? rtepts : wpts;
                if (pts.length < 2) { alert('GPX has fewer than 2 waypoints.'); return; }
                pts.forEach(pt => {
                    const lat = parseFloat(pt.getAttribute('lat'));
                    const lng = parseFloat(pt.getAttribute('lon'));
                    if (!isNaN(lat) && !isNaN(lng)) createMarker({ lng, lat });
                });
                updateRoute();
            }
        } catch (err) {
            console.error('GPX import error:', err);
            alert('Failed to parse GPX file. Make sure it is a valid .gpx file.');
        }
    };
    reader.readAsText(file);
}

// GPX Export: download current route as a standard .gpx track file
function downloadGPX() {
    if (!currentRouteGeoJSON) { alert('No route to download.'); return; }
    const coords = currentRouteGeoJSON.coordinates;
    const chartPts = elevationChart?.data?.datasets?.[0]?.data;

    const trkpts = coords.map((c, i) => {
        let eleTag = '';
        if (chartPts && chartPts.length > 1) {
            const ratio = i / (coords.length - 1);
            const ci = Math.round(ratio * (chartPts.length - 1));
            const displayElev = chartPts[ci]?.y;
            if (displayElev != null) {
                // Convert display value back to metres
                const elevM = currentUnits === 'imperial' ? displayElev / 3.28084 : displayElev;
                eleTag = `\n        <ele>${elevM.toFixed(1)}</ele>`;
            }
        }
        return `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${eleTag}\n      </trkpt>`;
    }).join('\n');

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike Route Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Bike Route</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'bike-route.gpx'; a.click();
    URL.revokeObjectURL(url);
}

function applyTerrain() {
    const val = document.getElementById('hillshade-select')?.value || 'off';
    const exInput = document.getElementById('terrain-exaggeration');

    localStorage.setItem('route_hillshade', val);
    let exVal = parseFloat(exInput.value);
    if (isNaN(exVal)) exVal = 2.0;
    localStorage.setItem('route_exaggeration', exVal);

    // Guard: layers may not exist yet if called before map.on('load') completes
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

    needsElevationUpdate = true;
    if (typeof updateElevationProfile === 'function') updateElevationProfile();
}

function setRoutingMode(mode) {
    currentRoutingMode = mode;
    localStorage.setItem('route_routing_mode', mode);
    const displayMode = mode === 'gpx' ? 'bike' : mode;
    document.getElementById('mode-bike')?.classList.toggle('active', displayMode === 'bike');
    document.getElementById('mode-direct')?.classList.toggle('active', displayMode === 'direct');
    document.getElementById('mode-hike')?.classList.toggle('active', displayMode === 'hike');
}

function cycleRoutingMode() {
    let nextMode = 'bike';
    if (currentRoutingMode === 'bike') nextMode = 'direct';
    else if (currentRoutingMode === 'direct') nextMode = 'hike';
    else if (currentRoutingMode === 'hike') nextMode = 'bike';
    setRoutingMode(nextMode);
}

document.getElementById('mode-bike')?.addEventListener('click', () => {
    if (window.innerWidth <= 768) cycleRoutingMode();
    else setRoutingMode('bike');
});
document.getElementById('mode-direct')?.addEventListener('click', () => {
    if (window.innerWidth <= 768) cycleRoutingMode();
    else setRoutingMode('direct');
});
document.getElementById('mode-hike')?.addEventListener('click', () => {
    if (window.innerWidth <= 768) cycleRoutingMode();
    else setRoutingMode('hike');
});

document.getElementById('hillshade-select')?.addEventListener('change', applyTerrain);
document.getElementById('terrain-exaggeration').addEventListener('change', applyTerrain);

function updateStatsToggleBtn() {
    const panel = document.getElementById('stats-panel');
    const totalDistBtn = document.getElementById('total-distance');
    if (panel && totalDistBtn) {
        const visible = panel.classList.contains('show');
        totalDistBtn.classList.toggle('active', visible);
    }
}

function toggleSettings(event) {
    if (event) event.stopPropagation();
    document.getElementById('settings-menu').classList.toggle('show');
}

function toggleStatsPanel(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('stats-panel');
    const isShow = panel.classList.contains('show');
    if (isShow) {
        panel.classList.remove('show');
        localStorage.setItem('stats_panel_visible', 'false');
    } else {
        panel.classList.add('show');
        localStorage.setItem('stats_panel_visible', 'true');
    }
    updateStatsToggleBtn();
}

document.getElementById('total-distance').addEventListener('click', toggleStatsPanel);
document.getElementById('close-stats-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('stats-panel').classList.remove('show');
    localStorage.setItem('stats_panel_visible', 'false');
    updateStatsToggleBtn();
});

window.addEventListener('click', () => {
    document.getElementById('settings-menu').classList.remove('show');
});

document.getElementById('settings-menu').addEventListener('click', e => e.stopPropagation());
document.getElementById('stats-panel').addEventListener('click', e => e.stopPropagation());

let activeWeatherQueryToken = 0;
const windForecastCache = new Map();

async function fetchWindAtCoordinates(lat, lng) {
    const latRounded = Math.round(lat * 100) / 100;
    const lngRounded = Math.round(lng * 100) / 100;
    const cacheKey = `${latRounded},${lngRounded}`;

    if (windForecastCache.has(cacheKey)) {
        return windForecastCache.get(cacheKey);
    }

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latRounded}&longitude=${lngRounded}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Weather fetch failed: ${resp.status}`);
        const data = await resp.json();

        const result = {
            windSpeedKmh: data.current?.wind_speed_10m ?? 0,
            windDir: data.current?.wind_direction_10m ?? 0
        };
        windForecastCache.set(cacheKey, result);
        return result;
    } catch (e) {
        console.warn(`Could not fetch wind forecast at ${cacheKey}:`, e);
        return { windSpeedKmh: 0, windDir: 0 };
    }
}

function getRouteWeatherSamples() {
    if (!currentRouteGeoJSON || !routePathDistances || routePathDistances.length < 2) return [];

    const coords = currentRouteGeoJSON.coordinates;
    const totalDist = routeTotalDist;
    const interval = Math.max(totalDist / 10, 3218.68); // 1/10th or 2 miles in meters

    const samples = [];
    let nextTarget = 0;

    for (let i = 0; i < coords.length; i++) {
        const d = routePathDistances[i];
        if (d >= nextTarget || i === coords.length - 1) {
            samples.push({
                coord: coords[i],
                rawIdx: i,
                dist: d
            });
            nextTarget += interval;
        }
    }
    return samples;
}

async function fetchRouteWindData(samples) {
    const promises = samples.map(s => fetchWindAtCoordinates(s.coord[1], s.coord[0]));
    const results = await Promise.all(promises);
    return samples.map((s, idx) => ({
        ...s,
        windSpeedKmh: results[idx].windSpeedKmh,
        windDir: results[idx].windDir
    }));
}

function getWindForDistance(routeDist, windSamples) {
    if (!windSamples || windSamples.length === 0) return { windSpeedKmh: 0, windDir: 0 };

    let closestSample = windSamples[0];
    let minDiff = Infinity;

    for (const s of windSamples) {
        const diff = Math.abs(s.dist - routeDist);
        if (diff < minDiff) {
            minDiff = diff;
            closestSample = s;
        }
    }
    return closestSample;
}

function computeDetailedTimeEstimates(coords, elevations, mode, windSamples) {
    if (!coords || coords.length < 2) return { baseMin: 0, windMin: 0 };

    let totalBaseMin = 0;
    let totalWindMin = 0;

    const baseSpeed = currentBaseSpeedKmh;
    const headwindFactor = (mode === 'hike') ? 0.05 : 0.25;
    const minSpeed = (mode === 'hike') ? 1.5 : 5;
    const maxSpeed = (mode === 'hike') ? 8 : 50;
    const ascentPenalty = (mode === 'hike') ? 0.1 : 0.0833;

    let lastBearing = undefined;

    for (let i = 0; i < coords.length - 1; i++) {
        const d = haversineDistance(coords[i], coords[i + 1]);
        if (d <= 0) continue;

        let bearing = 0;
        if (d > 15) {
            bearing = getBearing(coords[i], coords[i + 1]);
            lastBearing = bearing;
        } else if (lastBearing !== undefined) {
            bearing = lastBearing;
        } else {
            // Find next point that is at least 15m away to get a stable initial bearing
            let nextIdx = i + 1;
            while (nextIdx < coords.length && haversineDistance(coords[i], coords[nextIdx]) < 15) {
                nextIdx++;
            }
            if (nextIdx < coords.length) {
                bearing = getBearing(coords[i], coords[nextIdx]);
                lastBearing = bearing;
            } else {
                bearing = getBearing(coords[i], coords[i + 1]);
            }
        }

        const midDist = (routePathDistances[i] + routePathDistances[i + 1]) / 2;
        const wind = getWindForDistance(midDist, windSamples);

        let segmentBaseSpeed = baseSpeed;
        if (mode === 'hike') {
            segmentBaseSpeed = 4.5;
        }

        // Base time (flat + climb)
        const baseFlatMin = (d / 1000) / segmentBaseSpeed * 60;

        // Wind-adjusted time (flat adjusted + climb)
        const relAngle = wind.windDir - bearing;
        const headwind = wind.windSpeedKmh * Math.cos(relAngle * Math.PI / 180);
        let adjSpeed = segmentBaseSpeed - (headwind * headwindFactor);
        adjSpeed = Math.max(minSpeed, Math.min(maxSpeed, adjSpeed));
        const windFlatMin = (d / 1000) / adjSpeed * 60;

        // Climbing penalty
        let climbMin = 0;
        if (elevations && elevations[i] != null && elevations[i + 1] != null) {
            const elevDiff = elevations[i + 1] - elevations[i];
            if (elevDiff > 0) {
                climbMin = elevDiff * ascentPenalty;
            }
        }

        totalBaseMin += baseFlatMin + climbMin;
        totalWindMin += windFlatMin + climbMin;
    }

    return { baseMin: totalBaseMin, windMin: totalWindMin };
}

function getEstimatedTime(distanceMeters, elevationGainMeters, mode) {
    if (distanceMeters <= 0) return 0;

    let speedKmh = currentBaseSpeedKmh;
    let ascentPenaltyMinPerMeter = 0.0833; // 1 min per 12m gain

    if (mode === 'hike') {
        speedKmh = 4.5;
        ascentPenaltyMinPerMeter = 0.1; // 1 min per 10m gain (Naismith's rule)
    } else if (mode === 'direct') {
        speedKmh = 16;
        ascentPenaltyMinPerMeter = 0.0833;
    }

    const flatTimeMin = (distanceMeters / 1000) / speedKmh * 60;
    const climbTimeMin = elevationGainMeters * ascentPenaltyMinPerMeter;
    return flatTimeMin + climbTimeMin;
}

function formatDuration(minutes) {
    if (!minutes || minutes <= 0) return '--';
    const hrs = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    if (hrs > 0) {
        return `${hrs}h ${mins}m`;
    }
    return `${mins}m`;
}

async function updateStatsUI(totalGainM, totalLossM, minElev, maxElev, smoothedSegmentGrades) {
    const hasRoute = waypoints.length >= 2 && currentRouteGeoJSON && currentRouteGeoJSON.coordinates.length > 0;
    if (!hasRoute) {
        document.getElementById('stats-distance').textContent = '--';
        document.getElementById('stats-time').textContent = '--';
        document.getElementById('stats-ascent').textContent = '--';
        document.getElementById('stats-descent').textContent = '--';

        const minEl = document.getElementById('stats-min');
        const maxEl = document.getElementById('stats-max');
        minEl.textContent = '--';
        maxEl.textContent = '--';

        const upEl = document.getElementById('stats-avg-up');
        const downEl = document.getElementById('stats-avg-down');
        const maxUpEl = document.getElementById('stats-max-up');
        const maxDownEl = document.getElementById('stats-max-down');
        upEl.textContent = '--'; upEl.style.color = '';
        downEl.textContent = '--'; downEl.style.color = '';
        maxUpEl.textContent = '--'; maxUpEl.style.color = '';
        maxDownEl.textContent = '--'; maxDownEl.style.color = '';
        return;
    }

    let distText = '';
    if (currentUnits === 'metric') {
        const distanceKm = (currentDistanceMeters / 1000).toFixed(2);
        distText = distanceKm + ' km';
    } else {
        const distanceMi = (currentDistanceMeters * 0.000621371).toFixed(2);
        distText = distanceMi + ' mi';
    }
    document.getElementById('stats-distance').textContent = distText;

    const getAvgSpeedStr = (minutes) => {
        if (!minutes || minutes <= 0) return '';
        const hours = minutes / 60;
        if (currentUnits === 'metric') {
            const distanceKm = currentDistanceMeters / 1000;
            const avgSpeed = distanceKm / hours;
            return `${avgSpeed.toFixed(1)} km/h`;
        } else {
            const distanceMi = currentDistanceMeters * 0.000621371;
            const avgSpeed = distanceMi / hours;
            return `${avgSpeed.toFixed(1)} mph`;
        }
    };

    // First display base time immediately
    const baseMinutes = getEstimatedTime(currentDistanceMeters, totalGainM, currentRoutingMode);
    document.getElementById('stats-time').textContent = `${formatDuration(baseMinutes)} (${getAvgSpeedStr(baseMinutes)})`;

    // Fetch route-level wind data asynchronously
    const queryToken = ++activeWeatherQueryToken;
    const samples = getRouteWeatherSamples();
    if (samples.length > 0) {
        fetchRouteWindData(samples).then(windSamples => {
            if (queryToken !== activeWeatherQueryToken) return; // stale query

            const coords = currentRouteGeoJSON.coordinates;
            const elevations = currentStats ? currentStats.elevations : null;
            const estimates = computeDetailedTimeEstimates(coords, elevations, currentRoutingMode, windSamples);

            if (estimates.windMin > 0 && queryToken === activeWeatherQueryToken) {
                const baseTimeStr = formatDuration(estimates.baseMin);
                const windTimeStr = formatDuration(estimates.windMin);
                const hasSignificantWind = windSamples.some(s => s.windSpeedKmh > 3);
                if (hasSignificantWind) {
                    document.getElementById('stats-time').textContent = `${windTimeStr} (${getAvgSpeedStr(estimates.windMin)})`;
                } else {
                    document.getElementById('stats-time').textContent = `${baseTimeStr} (${getAvgSpeedStr(estimates.baseMin)})`;
                }
            }
        }).catch(err => console.warn('Wind stats calc error:', err));
    }

    const unitLabel = currentUnits === 'metric' ? 'm' : 'ft';
    const gainVal = currentUnits === 'metric' ? totalGainM : totalGainM * 3.28084;
    const lossVal = currentUnits === 'metric' ? totalLossM : totalLossM * 3.28084;

    document.getElementById('stats-ascent').textContent = `+${Math.round(gainVal)} ${unitLabel}`;
    document.getElementById('stats-descent').textContent = `${Math.round(lossVal)} ${unitLabel}`;

    const minEl = document.getElementById('stats-min');
    const maxEl = document.getElementById('stats-max');
    if (minElev !== undefined && maxElev !== undefined && minElev !== Infinity && maxElev !== -Infinity) {
        minEl.textContent = `${Math.round(minElev)}${unitLabel}`;
        maxEl.textContent = `${Math.round(maxElev)}${unitLabel}`;
    } else {
        minEl.textContent = '--';
        maxEl.textContent = '--';
    }

    const upEl = document.getElementById('stats-avg-up');
    const downEl = document.getElementById('stats-avg-down');
    const maxUpEl = document.getElementById('stats-max-up');
    const maxDownEl = document.getElementById('stats-max-down');

    if (smoothedSegmentGrades && smoothedSegmentGrades.length > 0) {
        let upSum = 0, upCount = 0;
        let downSum = 0, downCount = 0;
        let maxUpGrade = 0;
        let maxDownGrade = 0;

        for (let i = 0; i < smoothedSegmentGrades.length; i++) {
            const grade = smoothedSegmentGrades[i];
            if (grade > 0.5) {
                upSum += grade;
                upCount++;
                if (grade > maxUpGrade) maxUpGrade = grade;
            } else if (grade < -0.5) {
                downSum += grade;
                downCount++;
                if (grade < maxDownGrade) maxDownGrade = grade;
            }
        }
        const avgUpVal = upCount > 0 ? (upSum / upCount) : 0;
        const avgDownVal = downCount > 0 ? (downSum / downCount) : 0;

        upEl.textContent = `+${avgUpVal.toFixed(1)}%`;
        upEl.style.color = getColorForGrade(avgUpVal);

        downEl.textContent = `${avgDownVal.toFixed(1)}%`;
        downEl.style.color = getColorForGrade(avgDownVal);

        maxUpEl.textContent = `+${maxUpGrade.toFixed(1)}%`;
        maxUpEl.style.color = getColorForGrade(maxUpGrade);

        maxDownEl.textContent = `${maxDownGrade.toFixed(1)}%`;
        maxDownEl.style.color = getColorForGrade(maxDownGrade);
    } else {
        upEl.textContent = '--'; upEl.style.color = '';
        downEl.textContent = '--'; downEl.style.color = '';
        maxUpEl.textContent = '--'; maxUpEl.style.color = '';
        maxDownEl.textContent = '--'; maxDownEl.style.color = '';
    }

    // Setup interactive map hovers
    const hoverTargets = [
        { id: 'stats-min', getIdx: () => currentStats.minIdx },
        { id: 'stats-max', getIdx: () => currentStats.maxIdx },
        { id: 'stats-max-up', getIdx: () => currentStats.maxUpIdx },
        { id: 'stats-max-down', getIdx: () => currentStats.maxDownIdx }
    ];

    hoverTargets.forEach(({ id, getIdx }) => {
        const el = document.getElementById(id);
        if (!el) return;

        const newEl = el.cloneNode(true);
        el.parentNode.replaceChild(newEl, el);

        newEl.addEventListener('mouseenter', () => {
            const ci = getIdx();
            if (ci !== undefined && ci >= 0 && currentRouteGeoJSON && currentRouteGeoJSON.coordinates.length > ci) {
                const coords = currentRouteGeoJSON.coordinates;
                const lngLat = coords[ci];
                updateHoverHighlight(ci, 0, lngLat);
            }
        });
        newEl.addEventListener('mouseleave', clearHoverHighlight);
    });
}

function updateSpeedSettingUI() {
    const input = document.getElementById('base-speed-input');
    const label = document.getElementById('speed-unit-label');
    if (!input || !label) return;

    if (currentUnits === 'metric') {
        input.value = currentBaseSpeedKmh.toFixed(1);
        label.textContent = 'km/h';
    } else {
        input.value = (currentBaseSpeedKmh * 0.621371).toFixed(1);
        label.textContent = 'mph';
    }
}

function loadStoredSettings() {
    const mode = localStorage.getItem('route_routing_mode');
    if (mode) {
        setRoutingMode(mode);
    }

    // Theme — purely CSS, safe to dispatch
    const theme = localStorage.getItem('route_theme');
    if (theme) {
        document.getElementById('theme').value = theme;
        document.getElementById('theme').dispatchEvent(new Event('change'));
    }

    // Basemap — the map was ALREADY initialized with the saved basemap style in the
    // constructor. Dispatching 'change' here would call setStyle() again, destroying
    // all our custom sources and layers. Just sync the UI element.
    const basemap = localStorage.getItem('route_basemap') || 'cyclosm';
    document.getElementById('basemap').value = basemap;
    // Do NOT dispatch — style is already correct from initialization

    // Units — safe, no map side effects
    const units = localStorage.getItem('route_units');
    if (units) {
        currentUnits = units;
        document.getElementById('units').value = units;
        updateDistanceUI();
    }

    // Initialize speed input and unit label
    updateSpeedSettingUI();
    document.getElementById('base-speed-input').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) || 0;
        if (val > 0) {
            if (currentUnits === 'metric') {
                currentBaseSpeedKmh = val;
            } else {
                currentBaseSpeedKmh = val / 0.621371;
            }
            localStorage.setItem('route_base_speed', currentBaseSpeedKmh);
            if (currentStats && typeof updateStatsUI === 'function') {
                updateStatsUI(currentStats.gain, currentStats.loss, currentStats.min, currentStats.max, currentStats.grades);
            }
        }
    });

    // Projection — safe after load
    const proj = localStorage.getItem('route_projection');
    if (proj) {
        document.getElementById('projection').value = proj;
        if (map.getProjection()?.type !== proj) {
            map.setProjection({ type: proj });
        }
    }

    // Terrain/hillshade UI values (applyTerrain reads them)
    const hillshade = localStorage.getItem('route_hillshade');
    if (hillshade !== null) {
        let val = hillshade;
        if (val === 'true') val = 'hillshade';
        else if (val === 'false') val = 'off';
        const el = document.getElementById('hillshade-select');
        if (el) el.value = val;
    }
    const exaggeration = localStorage.getItem('route_exaggeration');
    if (exaggeration !== null) {
        document.getElementById('terrain-exaggeration').value = exaggeration;
    }

    // Apply terrain after all values are set (layers exist by now)
    applyTerrain();

    // Routing options

    const allowFerriesVal = localStorage.getItem('route_allow_ferries_check');
    if (allowFerriesVal !== null) {
        const el = document.getElementById('allow-ferries-check');
        if (el) el.checked = allowFerriesVal === 'true';
    }

    const showLocationVal = localStorage.getItem('route_show_location_check');
    const locationEl = document.getElementById('show-location-check');
    if (locationEl) {
        locationEl.checked = showLocationVal !== null ? showLocationVal === 'true' : true;
    }
    updateUserLocationPin();

    // Restore stats panel visibility
    const statsVisible = localStorage.getItem('stats_panel_visible');
    if (statsVisible === 'true') {
        document.getElementById('stats-panel').classList.add('show');
    }
    updateStatsToggleBtn();
}

document.getElementById('allow-ferries-check')?.addEventListener('change', (e) => {
    localStorage.setItem('route_allow_ferries_check', e.target.checked);
    updateRoute();
});

document.getElementById('show-location-check')?.addEventListener('change', () => {
    updateUserLocationPin();
});

// Wire up GPX buttons
document.getElementById('gpx-import-btn').addEventListener('click', () => {
    document.getElementById('gpx-file-input').click();
});
document.getElementById('gpx-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) { importGPX(file); e.target.value = ''; }
});
document.getElementById('gpx-download-btn').addEventListener('click', downloadGPX);

Chart.Interaction.modes.routeHover = function (chart, e, options, useFinalPosition) {
    const items = [];
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data.length) return items;

    const xValue = chart.scales.x.getValueForPixel(e.x);
    const data = chart.data.datasets[0].data;

    let low = 0;
    let high = data.length - 1;
    let minIdx = 0;

    while (low <= high) {
        let mid = Math.floor((low + high) / 2);
        if (data[mid].x < xValue) low = mid + 1;
        else if (data[mid].x > xValue) high = mid - 1;
        else { minIdx = mid; break; }
        if (Math.abs(data[mid].x - xValue) < Math.abs(data[minIdx].x - xValue)) {
            minIdx = mid;
        }
    }

    if (minIdx !== -1) {
        items.push({ datasetIndex: 0, index: minIdx, element: meta.data[minIdx] });
    }
    return items;
};


function haversineDistance(c1, c2) {
    const R = 6371e3;
    const phi1 = c1[1] * Math.PI / 180;
    const phi2 = c2[1] * Math.PI / 180;
    const dPhi = (c2[1] - c1[1]) * Math.PI / 180;
    const dLambda = (c2[0] - c1[0]) * Math.PI / 180;
    const a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function resampleLine(coords, maxPoints = 500) {
    if (coords.length <= 1) return coords;

    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
        totalDist += haversineDistance(coords[i - 1], coords[i]);
    }

    let segmentLength = totalDist / maxPoints;
    if (segmentLength < 5) segmentLength = 5; // Minimum 5m resolution — matches zoom-15 tile pixel size

    const resampled = [];
    resampled.push(coords[0]);
    for (let i = 1; i < coords.length; i++) {
        const p1 = coords[i - 1];
        const p2 = coords[i];
        const dist = haversineDistance(p1, p2);
        if (dist > segmentLength) {
            const numSegments = Math.ceil(dist / segmentLength);
            for (let j = 1; j < numSegments; j++) {
                const t = j / numSegments;
                resampled.push([
                    p1[0] + t * (p2[0] - p1[0]),
                    p1[1] + t * (p2[1] - p1[1])
                ]);
            }
        }
        resampled.push(p2);
    }
    return resampled;
}

// Evenly thin a coords array to at most maxPoints by uniform index stepping
function decimateLine(coords, maxPoints = 100) {
    if (coords.length <= maxPoints) return coords;
    const result = [];
    const step = (coords.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
        result.push(coords[Math.round(i * step)]);
    }
    return result;
}

function getColorForGrade(grade) {
    let r, g, b;
    // Downhill
    if (grade <= -20) {
        return 'rgb(138, 43, 226)'; // Purple — extreme downhill (beyond clamp, artifact)
    } else if (grade < 0) {
        const t = (grade + 20) / 20;
        r = 138 + t * (34 - 138);
        g = 43 + t * (197 - 43);
        b = 226 + t * (94 - 226);
    }
    // Uphill
    else if (grade < 5) {
        const t = grade / 5;
        r = 34 + t * (234 - 34);
        g = 197 + t * (179 - 197);
        b = 94 + t * (8 - 94);
    } else if (grade < 15) {
        const t = (grade - 5) / 10;
        r = 234 + t * (239 - 234);
        g = 179 + t * (68 - 179);
        b = 8 + t * (68 - 8);
    } else {
        // Red for all steep uphill terrain
        return 'rgb(239, 68, 68)';
    }
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function initChart() {
    const ctx = document.getElementById('elevation-chart').getContext('2d');
    elevationChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Elevation',
                data: [],
                grades: [],
                borderColor: 'rgba(100,120,160,0.8)',
                backgroundColor: 'rgba(100,120,160,0.15)',
                borderWidth: 4,
                fill: 'start',
                pointRadius: 0,
                pointHoverRadius: 0,
                tension: 0.1,
                spanGaps: true
            }, {
                label: 'Waypoints',
                data: [],
                type: 'scatter',
                pointRadius: 10,
                pointHoverRadius: 12
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: window.innerWidth <= 768 ? 4 : { top: 10, right: 10, left: 10, bottom: 0 }
            },
            interaction: { mode: 'routeHover', intersect: false },
            onLeave: () => {
                const statsDiv = document.getElementById('hover-stats');
                if (statsDiv) statsDiv.style.opacity = '0';
                hideHoverMarker();
                currentHoverDispDist = null;
            },
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false }  // disabled — we use the floating hoverInfoEl instead
            },
            scales: {
                x: {
                    type: 'linear',
                    display: true,
                    min: 0,
                    title: { display: false },
                    grid: { color: '#333' },
                    ticks: {
                        color: '#aaa',
                        padding: window.innerWidth <= 768 ? 2 : 3,
                        align: 'inner',
                        callback: function (value, index, ticks) {
                            if (value === 0) return "Dist.";
                            const maxVal = this.chart.scales.x.max;
                            if (maxVal === null || maxVal === undefined) return value;
                            if (Math.abs(value - maxVal) < 0.001) {
                                if (ticks.length >= 2) {
                                    const secondToLast = ticks[ticks.length - 2].value;
                                    let step = 1;
                                    if (maxVal <= 1) step = 0.2;
                                    else if (maxVal <= 2) step = 0.5;
                                    else if (maxVal <= 5) step = 1;
                                    else if (maxVal <= 10) step = 2;
                                    else if (maxVal <= 25) step = 5;
                                    else if (maxVal <= 55) step = 10;
                                    else if (maxVal <= 115) step = 20;
                                    else if (maxVal <= 250) step = 50;
                                    else step = 100;

                                    if ((maxVal - secondToLast) < step * 0.4) {
                                        return "";
                                    }
                                }
                            }
                            return Math.round(value * 10) / 10;
                        }
                    },
                    afterBuildTicks: (axis) => {
                        if (axis.max === null || axis.max === undefined) return;
                        const maxVal = axis.max;

                        let step = 1;
                        if (maxVal <= 1) step = 0.2;
                        else if (maxVal <= 2) step = 0.5;
                        else if (maxVal <= 5) step = 1;
                        else if (maxVal <= 10) step = 2;
                        else if (maxVal <= 25) step = 5;
                        else if (maxVal <= 55) step = 10;
                        else if (maxVal <= 115) step = 20;
                        else if (maxVal <= 250) step = 50;
                        else step = 100;

                        const ticks = [];
                        let val = 0;
                        while (val <= maxVal) {
                            ticks.push({ value: val });
                            val += step;
                        }

                        const lastStepTickVal = ticks[ticks.length - 1].value;
                        if (Math.abs(maxVal - lastStepTickVal) > 0.001) {
                            ticks.push({ value: maxVal });
                        }

                        axis.ticks = ticks;
                    }
                },
                y: {
                    display: true,
                    title: { display: false },
                    grid: { color: '#333' },
                    ticks: {
                        color: '#aaa',
                        padding: window.innerWidth <= 768 ? 2 : 3,
                        callback: function (value) {
                            if (value === 0) return "Elev.";
                            return value;
                        }
                    }
                }
            }
        },
        plugins: [{
            id: 'hoverLine',
            afterDraw: (chart) => {
                if (currentHoverDispDist !== null && chart.scales.x) {
                    const x = chart.scales.x.getPixelForValue(currentHoverDispDist);
                    const area = chart.chartArea;
                    if (!area || x < area.left || x > area.right) return;
                    const top = area.top;
                    const bottom = area.bottom;
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.beginPath();
                    ctx.moveTo(x, top);
                    ctx.lineTo(x, bottom);
                    ctx.lineWidth = 1.5;
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
                    ctx.setLineDash([5, 5]);
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }, {
            id: 'gradientRebuild',
            // After the chart lays out (including on resize), rebuild gradients so they
            // always span the correct pixel width. Does nothing if no data is loaded yet.
            afterLayout(chart) {
                const ds = chart.data.datasets[0];
                const grades = ds.grades;
                if (!grades || grades.length === 0) return;
                const area = chart.chartArea;
                const ctx = chart.ctx;
                if (!area || !ctx) return;

                const buildGrad = (alpha) => {
                    const grad = ctx.createLinearGradient(area.left, 0, area.right, 0);
                    const STOPS = 300; // Increased from 50 for ultra-high-def color/height sync
                    const data = ds.data;
                    const totalDist = data.length ? data[data.length - 1].x : 1;
                    for (let s = 0; s <= STOPS; s++) {
                        const frac = s / STOPS;
                        const distVal = frac * totalDist;
                        let lo = 0, hi = data.length - 1;
                        while (lo < hi) {
                            const mid = (lo + hi) >> 1;
                            if (data[mid].x < distVal) lo = mid + 1; else hi = mid;
                        }
                        const color = getColorForGrade(grades[lo] ?? 0);
                        grad.addColorStop(frac, color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`));
                    }
                    return grad;
                };

                ds.borderColor = buildGrad(0.95);
                ds.backgroundColor = buildGrad(0.18);
            }
        }]
    });

    const clearHover = () => {
        if (elevationChart) {
            elevationChart.setActiveElements([]);
            if (elevationChart.tooltip) elevationChart.tooltip.setActiveElements([]);
            elevationChart.update('none');
        }
        currentHoverDispDist = null;
        hideHoverMarker();
        const statsDiv = document.getElementById('hover-stats');
        if (statsDiv) statsDiv.style.opacity = '0';
    };

    const handleHoverMove = (clientX) => {
        if (!elevationChart || !currentRouteGeoJSON?.coordinates) return;
        const chart = elevationChart;
        const rect = ctx.canvas.getBoundingClientRect();
        const canvasX = clientX - rect.left;

        // canvasX is in CSS pixels; Chart.js scales use the same coordinate space.
        const xValue = chart.scales.x?.getValueForPixel(canvasX);
        if (xValue == null) return;

        const data = chart.data.datasets[0]?.data;
        const coords = currentRouteGeoJSON.coordinates;
        if (!data || data.length < 2 || !coords || coords.length < 2) return;

        // Binary search: find chart data index just below xValue
        let low = 0, high = data.length - 2, i = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (data[mid].x <= xValue) { i = mid; low = mid + 1; }
            else high = mid - 1;
        }

        // Sub-index interpolation factor between data[i] and data[i+1]
        const t = (data[i + 1] && data[i + 1].x !== data[i].x)
            ? Math.max(0, Math.min(1, (xValue - data[i].x) / (data[i + 1].x - data[i].x)))
            : 0;

        // Map xValue → route coordinate index via cumulative distances (continuous)
        let ci = 0;
        if (routePathDistances && routePathDistances.length === coords.length) {
            const xMeters = currentUnits === 'imperial' ? xValue * 1609.344 : xValue * 1000;
            let lo = 0, hi = routePathDistances.length - 2;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (routePathDistances[mid] <= xMeters) { ci = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            ci = Math.min(ci, coords.length - 2);
        } else {
            ci = Math.min(Math.floor((i / Math.max(1, data.length - 1)) * (coords.length - 1)), coords.length - 2);
        }
        const ciNext = ci + 1;

        // Interpolated geographic position
        const lngC = coords[ci][0] + t * (coords[ciNext][0] - coords[ci][0]);
        const latC = coords[ci][1] + t * (coords[ciNext][1] - coords[ci][1]);

        // Offset marker to sit on the route line (same logic as map hover)
        const pCenter = map.project([lngC, latC]);
        const p0 = map.project(coords[ci]);
        const p1 = map.project(coords[ciNext]);
        const vX = p1.x - p0.x, vY = p1.y - p0.y;
        const segLen = Math.sqrt(vX * vX + vY * vY);
        let markerLngLat;
        if (segLen > 0.1) {
            const nx = -vY / segLen, ny = vX / segLen;
            const off = getPixelOffset(map.getZoom());
            markerLngLat = map.unproject([pCenter.x + nx * off, pCenter.y + ny * off]);
        } else {
            markerLngLat = { lng: lngC, lat: latC };
        }

        // Interpolate elevation and grade continuously
        const ds = chart.data.datasets[0];
        const elevA = data[i]?.y, elevB = data[i + 1]?.y;
        const elevVal = (elevA != null && elevB != null) ? elevA + t * (elevB - elevA) : (elevA ?? null);
        const gradeA = ds.grades?.[ci];
        const gradeB = ds.grades?.[Math.min(ci + 1, (ds.grades?.length ?? 1) - 1)];
        const grade = (gradeA !== undefined && gradeB !== undefined) ? gradeA + t * (gradeB - gradeA) : gradeA;

        // Update hover line on chart
        currentHoverDispDist = xValue;
        chart.update('none');

        const distLabel = xValue.toFixed(2) + (currentUnits === 'metric' ? ' km' : ' mi');
        const elevLabel = elevVal != null ? elevVal.toFixed(1) + (currentUnits === 'metric' ? ' m' : ' ft') : '';
        const gradeLabel = grade !== undefined ? (grade >= 0 ? '+' : '') + grade.toFixed(2) + '%' : '';
        const info = `${distLabel} <span style="color:#888">&nbsp;|&nbsp;</span> ${elevLabel} <span style="color:#888">&nbsp;|&nbsp;</span> ${gradeLabel}`;

        showHoverMarker([markerLngLat.lng, markerLngLat.lat], info);
        showHoverSegment(ci);

        const statsDiv = document.getElementById('hover-stats');
        if (statsDiv) {
            statsDiv.style.opacity = '1';
            document.getElementById('hover-dist').textContent = distLabel;
            document.getElementById('hover-elev').textContent = elevLabel;
            document.getElementById('hover-grade').textContent = gradeLabel;
        }
    };

    ctx.canvas.addEventListener('mouseout', clearHover);
    ctx.canvas.addEventListener('touchend', clearHover, { passive: true });
    ctx.canvas.addEventListener('touchcancel', clearHover, { passive: true });

    ctx.canvas.addEventListener('mousemove', (e) => {
        handleHoverMove(e.clientX);
    });
    ctx.canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length > 0) {
            handleHoverMove(e.touches[0].clientX);
        }
    }, { passive: true });
    ctx.canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
            handleHoverMove(e.touches[0].clientX);
        }
    }, { passive: true });
}


async function updateElevationProfile() {
    if (isUpdatingElevation) return;
    if (!elevationChart) initChart();

    if (!currentRouteGeoJSON || !needsElevationUpdate) {
        if (!currentRouteGeoJSON && elevationChart) {
            elevationChart.data.datasets[0].data = [];
            if (elevationChart.data.datasets[1]) elevationChart.data.datasets[1].data = [];
            elevationChart.update('none');
            hideHoverMarker();
            currentStats = { gain: 0, loss: 0, min: Infinity, max: -Infinity, minIdx: 0, maxIdx: 0, maxUpGrade: 0, maxDownGrade: 0, maxUpIdx: 0, maxDownIdx: 0, grades: [] };
            updateStatsUI(0, 0, Infinity, -Infinity, []);
        }
        return;
    }

    isUpdatingElevation = true;

    try {
        const coords = currentRouteGeoJSON.coordinates;
        const chartData = [];
        const pathDistances = [0];
        const mercDistances = [0];
        let distMeters = 0;
        let mercDist = 0;
        let maxElev = -Infinity;
        let minElev = Infinity;

        // Fetch highest-res Mapzen Terrarium elevation data
        setStatus('Fetching elevation…');
        const elevations = await getHighResElevation(coords);
        setStatus('Processing…');

        // Null check: if samples are null, tiles might still be loading.
        // We log it but don't retry automatically to avoid infinite loops in 'no-data' zones.
        const nullCount = elevations.filter(v => v == null).length;
        if (nullCount > 0) {
            console.warn(`[elev] ${nullCount}/${elevations.length} points have no data (tiles still loading or out of bounds)`);
        }

        // Build pathDistances and mercDistances for map gradient
        for (let i = 1; i < coords.length; i++) {
            distMeters += haversineDistance(coords[i - 1], coords[i]);
            pathDistances.push(distMeters);
            mercDist += getMercatorDistance(coords[i - 1], coords[i]);
            mercDistances.push(mercDist);
        }

        // Pass 1: Isolation despiker — eliminates single-point glitches.
        // 6 passes ensure multi-point clusters are progressively collapsed.
        for (let pass = 0; pass < 6; pass++) {
            const readElevs = [...elevations];
            for (let i = 1; i < elevations.length - 1; i++) {
                const v = readElevs[i];
                const prev = readElevs[i - 1];
                const next = readElevs[i + 1];
                if (v == null || prev == null || next == null) continue;

                const d1 = haversineDistance(coords[i - 1], coords[i]);
                const d2 = haversineDistance(coords[i], coords[i + 1]);
                const rise1 = Math.abs(v - prev);
                const rise2 = Math.abs(v - next);
                const neighborDiff = Math.abs(prev - next);
                const mean = (prev + next) / 2;

                // Condition A: classic spike — both sides >20% grade AND neighbors agree
                const isOutlier = rise1 > d1 * 0.2 && rise2 > d2 * 0.2;
                const neighborsAgree = neighborDiff < Math.min(rise1, rise2) * 0.5;

                // Condition B: small noise — both rises >0.5m and point is far from window mean
                const isNoise = rise1 > 0.5 && rise2 > 0.5 && Math.abs(v - mean) > 0.4;

                if ((isOutlier && neighborsAgree) || isNoise) {
                    elevations[i] = mean;
                }
            }
        }

        // Pass 2: Two-tier grade-based filter.
        // Tier 1 (>100%, no neighborsAgree): Physically impossible for any road. Fix
        //   unconditionally — including the slopes of wide spikes where one neighbor is
        //   at base and the other is elevated (which breaks the neighborsAgree test).
        // Tier 2 (>60%, with neighborsAgree): Catches smaller isolated artifacts.
        //   neighborsAgree protects real sustained climbs where prev/next also differ.
        // 5 passes converge multi-point clusters. Using copies for symmetry.
        for (let pass = 0; pass < 5; pass++) {
            const readElevs = [...elevations];
            for (let i = 1; i < elevations.length - 1; i++) {
                const v = readElevs[i], prev = readElevs[i - 1], next = readElevs[i + 1];
                if (v == null || prev == null || next == null) continue;
                const d1 = haversineDistance(coords[i - 1], coords[i]);
                const d2 = haversineDistance(coords[i], coords[i + 1]);
                if (d1 <= 0 || d2 <= 0) continue;
                const rise1 = Math.abs(v - prev);
                const rise2 = Math.abs(v - next);
                const g1 = rise1 / d1;
                const g2 = rise2 / d2;
                if (g1 > 1.0 && g2 > 1.0) {
                    // Tier 1: Impossible grade — fix without neighborsAgree
                    elevations[i] = (prev + next) / 2;
                } else if (g1 > 0.6 && g2 > 0.6) {
                    // Tier 2: Very steep on both sides — only fix if neighbors agree
                    const neighborDiff = Math.abs(prev - next);
                    if (neighborDiff < Math.min(rise1, rise2) * 0.5) {
                        elevations[i] = (prev + next) / 2;
                    }
                }
            }
        }

        // Aggressive Gaussian smoothing: eliminates the 1-meter 'stepping' artifacts
        // common in free Terrarium data. Using a 31-point symmetric kernel (sigma ~ 8).
        // This is applied directly to the source elevations so that gain/loss 
        // calculations are performed on the cleaned data, preventing noise-induced inflation.
        const GAUSS = [
            0.005, 0.007, 0.010, 0.014, 0.018, 0.024, 0.030, 0.037,
            0.044, 0.052, 0.059, 0.066, 0.073, 0.078, 0.082, 0.084,
            0.082, 0.078, 0.073, 0.066, 0.059, 0.052, 0.044, 0.037,
            0.030, 0.024, 0.018, 0.014, 0.010, 0.007, 0.005
        ];
        const WIN_HALF = 15;
        const smoothedElevs = elevations.map((v, i) => {
            if (v == null) return null;
            let sum = 0, weight = 0;
            for (let k = -WIN_HALF; k <= WIN_HALF; k++) {
                const e = elevations[i + k];
                if (e != null) {
                    const w = GAUSS[k + WIN_HALF];
                    sum += e * w;
                    weight += w;
                }
            }
            return weight > 0 ? sum / weight : v;
        });
        // Replace raw elevations with smoothed ones for all subsequent logic
        for (let i = 0; i < elevations.length; i++) elevations[i] = smoothedElevs[i];

        // Step 2: Prepare chart data and calculate grades
        const filteredChartData = [];
        const pointGrades = elevations.map((v, i) => {
            if (v == null) return 0;
            const prev = elevations[i - 1];
            const next = elevations[i + 1];
            const d1 = i > 0 ? haversineDistance(coords[i - 1], coords[i]) : 0;
            const d2 = i < coords.length - 1 ? haversineDistance(coords[i], coords[i + 1]) : 0;
            if (i === 0) return d2 > 0 ? (next - v) / d2 * 100 : 0;
            if (i === coords.length - 1) return d1 > 0 ? (v - prev) / d1 * 100 : 0;
            return (d1 + d2 > 0) ? (next - prev) / (d1 + d2) * 100 : 0;
        });

        let filteredDist = 0;
        let filteredMax = -Infinity, filteredMin = Infinity;
        let minElevIdx = 0, maxElevIdx = 0;
        for (let i = 0; i < coords.length; i++) {
            const dval = elevations[i];
            if (i > 0) {
                const d = haversineDistance(coords[i - 1], coords[i]);
                filteredDist += d;
            }
            const displayElev = dval != null ? (currentUnits === 'metric' ? dval : dval * 3.28084) : null;
            filteredChartData.push({ x: getDisplayDistance(filteredDist), y: displayElev ?? null });
            if (displayElev != null) {
                if (displayElev > filteredMax) {
                    filteredMax = displayElev;
                    maxElevIdx = i;
                }
                if (displayElev < filteredMin) {
                    filteredMin = displayElev;
                    minElevIdx = i;
                }
            }
        }

        // Replace original data with filtered
        chartData.length = 0; filteredChartData.forEach(p => chartData.push(p));
        maxElev = filteredMax; minElev = filteredMin;

        // Calculate total elevation gain and loss from cleaned elevations
        let totalGainM = 0, totalLossM = 0;
        for (let i = 1; i < elevations.length; i++) {
            if (elevations[i] != null && elevations[i - 1] != null) {
                const diff = elevations[i] - elevations[i - 1];
                if (diff > 0) totalGainM += diff;
                else totalLossM += diff;
            }
        }
        const gainLabel = currentUnits === 'metric'
            ? `+${Math.round(totalGainM)}m`
            : `+${Math.round(totalGainM * 3.28084)}ft`;
        const lossLabel = currentUnits === 'metric'
            ? `${Math.round(totalLossM)}m`
            : `${Math.round(totalLossM * 3.28084)}ft`;
        const gainLossEl = document.getElementById('elev-gain-loss');
        if (gainLossEl) gainLossEl.textContent = '';

        // Step 3: Apply distance-aware smoothing to segment grades.
        // We now use point-centered grades which are mathematically symmetric.
        const smoothingGrades = pointGrades;
        const smoothedSegmentGrades = [];
        const targetWindowMeters = 10; // 10m smoothing window

        for (let i = 0; i < smoothingGrades.length; i++) {
            let sum = 0, count = 0;
            let distBack = 0, distFwd = 0;

            // Average current point
            sum += smoothingGrades[i]; count++;

            // Scan backward up to targetWindowMeters / 2
            for (let j = i - 1; j >= 0; j--) {
                const d = haversineDistance(coords[j], coords[j + 1]);
                distBack += d;
                if (distBack > targetWindowMeters / 2) break;
                sum += smoothingGrades[j]; count++;
            }
            // Scan forward up to targetWindowMeters / 2
            for (let j = i; j < smoothingGrades.length - 1; j++) {
                const d = haversineDistance(coords[j], coords[j + 1]);
                distFwd += d;
                if (distFwd > targetWindowMeters / 2) break;
                sum += smoothingGrades[j + 1]; count++;
            }
            smoothedSegmentGrades.push(sum / count);
        }
        // Build smoothedGrades for map/chart coloring: length N.
        const smoothedGrades = smoothedSegmentGrades;

        // chartData was already set from despiked elevations above — don't overwrite it.
        // maxElev/minElev already correct from filteredChartData pass.

        // Clear icon cache to ensure new text centering is applied
        for (let key in wpIcons) delete wpIcons[key];

        // Chart.js colors segment i (point i → i+1) using borderColor[i].
        // smoothedGrades[i] = grade of segment arriving at point i.
        // Using grades[i] for segment i means the color lags by one segment at
        // transitions — acceptable since the hover tooltip uses the same index.
        const borderColors = smoothedGrades.map(g => getColorForGrade(g));
        // Waypoints on Chart (Excluding endpoints)
        const wpData = [];
        const wpStyles = [];
        if (waypoints.length > 2) {
            for (let i = 1; i < waypoints.length - 1; i++) {
                const wpMeters = waypointDistances[i] || 0;
                const displayWpDist = getDisplayDistance(wpMeters);

                // Find closest index in chartData
                let closestY = 0;
                let minDiff = Infinity;
                for (const pt of chartData) {
                    if (pt.y === null) continue;
                    const d = Math.abs(pt.x - displayWpDist);
                    if (d < minDiff) { minDiff = d; closestY = pt.y; }
                }
                // Add a significant offset (25% of chart height) for the taller pins
                const offset = (maxElev - minElev) * 0.25 || 20;
                wpData.push({ x: displayWpDist, y: closestY + offset });
                wpStyles.push(getWpIconImage(i, waypoints.length));
            }
        }

        elevationChart.data.datasets[0].data = chartData;
        elevationChart.data.datasets[0].grades = smoothedGrades;
        elevationChart.data.datasets[0].borderColor = borderColors;

        if (elevationChart.data.datasets[1]) {
            elevationChart.data.datasets[1].data = wpData;
            elevationChart.data.datasets[1].pointStyle = wpStyles;
        }

        // Store grades/distances for viewport-aware map gradient rebuilds
        routeGrades = smoothedGrades;
        routePathDistances = pathDistances;
        routeMercatorDistances = mercDistances;
        routeTotalDist = distMeters;
        routeMercTotalDist = mercDist;

        rebuildMapGradient();
        rebuildRouteScreenPts();

        if (!initialBasemapCycled) {
            initialBasemapCycled = true;
            removeInitialCover();
        }

        elevationChart.update('none');
        elevationChart.options.scales.x.max = getDisplayDistance(distMeters);

        if (maxElev === -Infinity) maxElev = 100;
        if (minElev === Infinity) minElev = 0;
        const elevRange = maxElev - minElev;
        const padding = elevRange === 0 ? 10 : elevRange * 0.35; // Extra padding for taller pins

        elevationChart.options.scales.y.suggestedMax = maxElev + padding;
        elevationChart.options.scales.y.suggestedMin = Math.max(0, minElev - padding);

        try {
            elevationChart.update('none');
        } catch (e) { }

        let maxUpGrade = 0;
        let maxDownGrade = 0;
        let maxUpIdx = 0;
        let maxDownIdx = 0;

        for (let i = 0; i < smoothedSegmentGrades.length; i++) {
            const grade = smoothedSegmentGrades[i];
            if (grade > 0.5) {
                if (grade > maxUpGrade) {
                    maxUpGrade = grade;
                    maxUpIdx = i;
                }
            } else if (grade < -0.5) {
                if (grade < maxDownGrade) {
                    maxDownGrade = grade;
                    maxDownIdx = i;
                }
            }
        }

        rebuildMapGradient(); // update line colors on map
        updateTurnaroundJoins(); // update turn colors
        currentStats = {
            gain: totalGainM,
            loss: totalLossM,
            min: minElev,
            max: maxElev,
            minIdx: minElevIdx,
            maxIdx: maxElevIdx,
            maxUpGrade: maxUpGrade,
            maxDownGrade: maxDownGrade,
            maxUpIdx: maxUpIdx,
            maxDownIdx: maxDownIdx,
            grades: [...smoothedSegmentGrades],
            elevations: [...elevations]
        };
        updateStatsUI(currentStats.gain, currentStats.loss, currentStats.min, currentStats.max, currentStats.grades);
        needsElevationUpdate = false;
    } finally {
        isUpdatingElevation = false;
        clearStatus();
    }
}

map.on('idle', () => {
    if (needsElevationUpdate) updateElevationProfile();
});

function syncUrl() {
    const params = new URLSearchParams(window.location.search);
    if (waypoints.length > 0) {
        const wpStr = waypoints.map(wp => `${wp[0].toFixed(5)},${wp[1].toFixed(5)}`).join(';');
        params.set('route', wpStr);
        if (segmentModes.length > 0) params.set('modes', segmentModes.join(','));
        else params.delete('modes');
    } else {
        params.delete('route');
        params.delete('modes');
    }
    if (forceMode) params.set('force', '1'); else params.delete('force');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);

    // Persist GPX paths in localStorage
    if (segmentGPXPaths && segmentGPXPaths.some(p => p !== null)) {
        localStorage.setItem('route_gpx_paths', JSON.stringify(segmentGPXPaths));
    } else {
        localStorage.removeItem('route_gpx_paths');
    }
}

function loadUrlState() {
    const params = new URLSearchParams(window.location.search);
    // Restore force mode before building the route
    if (params.get('force') === '1') {
        forceMode = true;
        updateForceModeBtn();
    }
    const routeStr = params.get('route');
    const modeStr = params.get('modes');
    const modes = modeStr ? modeStr.split(',') : [];

    if (routeStr) {
        if (modes.length > 0) {
            const lastMode = modes[modes.length - 1];
            if (['bike', 'direct', 'hike', 'gpx'].includes(lastMode)) {
                currentRoutingMode = lastMode;
                localStorage.setItem('route_routing_mode', lastMode);
                const displayMode = lastMode === 'gpx' ? 'bike' : lastMode;
                document.getElementById('mode-bike')?.classList.toggle('active', displayMode === 'bike');
                document.getElementById('mode-direct')?.classList.toggle('active', displayMode === 'direct');
                document.getElementById('mode-hike')?.classList.toggle('active', displayMode === 'hike');
            }
        }
        const points = routeStr.split(';');
        points.forEach((pt, i) => {
            const [lng, lat] = pt.split(',').map(Number);
            if (!isNaN(lng) && !isNaN(lat)) {
                createMarker({ lng, lat }, undefined, i > 0 ? modes[i - 1] : undefined);
            }
        });

        // Restore GPX paths from localStorage
        const savedGPX = localStorage.getItem('route_gpx_paths');
        if (savedGPX) {
            try {
                const paths = JSON.parse(savedGPX);
                if (paths.length === segmentGPXPaths.length) {
                    segmentGPXPaths = paths;
                }
            } catch (e) {
                console.error('Failed to parse saved GPX paths:', e);
            }
        }

        updateRoute();

        if (waypoints.length > 1) {
            const bounds = new maplibregl.LngLatBounds();
            for (const wp of waypoints) {
                bounds.extend(wp);
            }
            map.fitBounds(bounds, { padding: getFitBoundsPadding(), duration: 0 }); // Instant fit on load
            // After camera settles and tiles load, force an elevation refresh
            map.once('idle', () => {
                needsElevationUpdate = true;
                updateElevationProfile();
            });
        } else if (waypoints.length === 1) {
            map.jumpTo({ center: waypoints[0], zoom: 13 });
            removeInitialCover();
        }
    } else {
        // No route — remove the initial cover. Map remains centered where it last was on startup
        removeInitialCover();
    }
}

function removeInitialCover() {
    const cover = document.getElementById('initial-map-cover');
    if (cover) {
        cover.style.opacity = '0';
        setTimeout(() => {
            if (cover.parentNode) cover.remove();
        }, 500);
        clearStatus();
    }
}

function requestLocation(fly = false) {
    const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname) ||
        window.location.hostname.startsWith('192.168.') ||
        window.location.hostname.startsWith('10.') ||
        window.location.hostname.startsWith('172.') ||
        !("geolocation" in navigator);
    if (isLocalhost) {
        const options = {
            center: [-122.4018, 37.7885],
            zoom: 13,
            speed: 1.5,
            curve: 1.2
        };
        if (fly) {
            map.flyTo(options);
        } else {
            map.jumpTo({ center: options.center, zoom: options.zoom });
        }
        return;
    }

    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const freshLng = pos.coords.longitude;
            const freshLat = pos.coords.latitude;
            const currentCenter = map.getCenter();

            // Check if fresh coordinates differ significantly from current center (~500 meters)
            const diffLng = Math.abs(currentCenter.lng - freshLng);
            const diffLat = Math.abs(currentCenter.lat - freshLat);

            const options = {
                center: [freshLng, freshLat],
                zoom: 13,
                speed: 1.5, // fast flyTo speed
                curve: 1.2
            };

            if (diffLng > 0.005 || diffLat > 0.005) {
                if (fly) {
                    map.flyTo(options);
                } else {
                    map.jumpTo({ center: options.center, zoom: options.zoom });
                }
            }
        },
        () => {
            // Keep current location if fetch fails
        },
        { timeout: 5000, enableHighAccuracy: true }
    );
}


const elPanel = document.getElementById('elevation-panel');
const elHeader = document.getElementById('elevation-header');
const elMinBtn = document.getElementById('elevation-min-btn');

const statsPanel = document.getElementById('stats-panel');
const statsHeader = statsPanel.querySelector('.stats-header');
const closeStatsBtn = document.getElementById('close-stats-btn');

let isDraggingWindow = false;
let startX, startY, initialLeft, initialTop;

let isDraggingStats = false;
let statsStartX, statsStartY, statsInitialLeft, statsInitialTop;

elHeader.addEventListener('mousedown', (e) => {
    if (window.innerWidth <= 768) return; // Disable dragging on mobile
    if (e.target === elMinBtn) return;
    isDraggingWindow = true;
    startX = e.clientX;
    startY = e.clientY;

    const rect = elPanel.getBoundingClientRect();
    elPanel.style.left = rect.left + 'px';
    elPanel.style.top = rect.top + 'px';
    elPanel.style.bottom = 'auto';
    elPanel.style.right = 'auto';

    initialLeft = rect.left;
    initialTop = rect.top;
});

statsHeader.addEventListener('mousedown', (e) => {
    if (window.innerWidth <= 768) return; // Disable dragging on mobile
    if (e.target === closeStatsBtn || e.target.closest('#close-stats-btn')) return;
    isDraggingStats = true;
    statsStartX = e.clientX;
    statsStartY = e.clientY;

    const rect = statsPanel.getBoundingClientRect();
    statsPanel.style.position = 'absolute';
    statsPanel.style.left = rect.left + 'px';
    statsPanel.style.top = rect.top + 'px';
    statsPanel.style.right = 'auto';
    statsPanel.style.bottom = 'auto';

    statsInitialLeft = rect.left;
    statsInitialTop = rect.top;
    e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
    if (isDraggingWindow) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const container = document.getElementById('map').getBoundingClientRect();
        const panelW = elPanel.offsetWidth;
        const panelH = elPanel.offsetHeight;
        const newLeft = Math.min(Math.max(initialLeft + dx, container.left), container.right - panelW);
        const newTop = Math.min(Math.max(initialTop + dy, container.top), container.bottom - panelH);
        elPanel.style.left = newLeft + 'px';
        elPanel.style.top = newTop + 'px';
    } else if (isDraggingStats) {
        const dx = e.clientX - statsStartX;
        const dy = e.clientY - statsStartY;
        const container = document.getElementById('map').getBoundingClientRect();
        const panelW = statsPanel.offsetWidth;
        const panelH = statsPanel.offsetHeight;
        const newLeft = Math.min(Math.max(statsInitialLeft + dx, container.left), container.right - panelW);
        const newTop = Math.min(Math.max(statsInitialTop + dy, container.top), container.bottom - panelH);
        statsPanel.style.left = newLeft + 'px';
        statsPanel.style.top = newTop + 'px';
    }
});

document.addEventListener('mouseup', () => {
    if (isDraggingWindow) {
        isDraggingWindow = false;
        saveWindowState();
    }
    if (isDraggingStats) {
        isDraggingStats = false;
        saveStatsPosition();
    }
});

const resizeObserver = new ResizeObserver(() => {
    if (!elPanel.classList.contains('minimized')) {
        saveWindowState();
    }
});
resizeObserver.observe(elPanel);

document.querySelectorAll('.resizer').forEach(resizer => {
    resizer.addEventListener('mousedown', initResize);
});

let isResizing = false;
let currentResizer = null;
let resizeStartX, resizeStartY, startW, startH, startLeft, startTop;

function initResize(e) {
    if (window.innerWidth <= 768) return; // Disable resizing on mobile
    if (elPanel.classList.contains('minimized')) return;

    const cl = e.target.classList;
    let resizer = '';
    if (cl.contains('ne')) resizer = 'ne';
    else if (cl.contains('nw')) resizer = 'nw';
    else if (cl.contains('se')) resizer = 'se';
    else if (cl.contains('sw')) resizer = 'sw';
    else if (cl.contains('n')) resizer = 'n';
    else if (cl.contains('s')) resizer = 's';
    else if (cl.contains('e')) resizer = 'e';
    else if (cl.contains('w')) resizer = 'w';

    if (!resizer) return;

    isResizing = true;
    currentResizer = resizer;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    startW = elPanel.offsetWidth;
    startH = elPanel.offsetHeight;

    // Use getBoundingClientRect so coords are in the same space as container.getBoundingClientRect()
    const rect = elPanel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    // Lock position using viewport coords so resize math is consistent
    elPanel.style.left = rect.left + 'px';
    elPanel.style.top = rect.top + 'px';
    elPanel.style.bottom = 'auto';
    elPanel.style.right = 'auto';

    document.addEventListener('mousemove', resizeWindow);
    document.addEventListener('mouseup', stopResize);
    e.preventDefault();
}

function resizeWindow(e) {
    if (!isResizing) return;
    const dx = e.clientX - resizeStartX;
    const dy = e.clientY - resizeStartY;
    const container = document.getElementById('map').getBoundingClientRect();
    const MIN_W = 400, MIN_H = 150;

    if (currentResizer.includes('e')) {
        // right edge: clamp so panel doesn't extend past the container's right
        const maxW = container.right - parseFloat(elPanel.style.left);
        elPanel.style.width = Math.min(Math.max(MIN_W, startW + dx), maxW) + 'px';
    }
    if (currentResizer.includes('s')) {
        // bottom edge: clamp so panel doesn't extend past the container's bottom
        const maxH = container.bottom - parseFloat(elPanel.style.top);
        elPanel.style.height = Math.min(Math.max(MIN_H, startH + dy), maxH) + 'px';
    }
    if (currentResizer.includes('w')) {
        // left edge: clamp so panel's left doesn't go past container's left
        const rawW = Math.max(MIN_W, startW - dx);
        const rawLeft = startLeft + startW - rawW;
        const clampedLeft = Math.max(container.left, rawLeft);
        const clampedW = startLeft + startW - clampedLeft;
        elPanel.style.width = Math.max(MIN_W, clampedW) + 'px';
        elPanel.style.left = clampedLeft + 'px';
    }
    if (currentResizer.includes('n')) {
        // top edge: clamp so panel's top doesn't go past container's top
        const rawH = Math.max(MIN_H, startH - dy);
        const rawTop = startTop + startH - rawH;
        const clampedTop = Math.max(container.top, rawTop);
        const clampedH = startTop + startH - clampedTop;
        elPanel.style.height = Math.max(MIN_H, clampedH) + 'px';
        elPanel.style.top = clampedTop + 'px';
    }

    if (elevationChart) elevationChart.resize();
    saveWindowState();
}

function stopResize() {
    isResizing = false;
    document.removeEventListener('mousemove', resizeWindow);
    document.removeEventListener('mouseup', stopResize);
}

elMinBtn.addEventListener('click', () => {
    elPanel.style.display = 'none';
    localStorage.setItem('elevation_panel_visible', 'false');
    updateElevationToggleBtn();
});

const elToggleBtn = document.getElementById('elevation-toggle-btn');
const elToggleGroup = document.getElementById('elevation-toggle-group');
function updateElevationToggleBtn() {
    const visible = elPanel.style.display !== 'none';
    if (visible) {
        elToggleGroup.classList.add('active');
    } else {
        elToggleGroup.classList.remove('active');
    }
}

elToggleBtn.addEventListener('click', () => {
    const visible = elPanel.style.display !== 'none';
    elPanel.style.display = visible ? 'none' : '';
    localStorage.setItem('elevation_panel_visible', !visible);
    updateElevationToggleBtn();
});

function saveWindowState() {
    const state = {
        left: elPanel.style.left,
        top: elPanel.style.top,
        width: elPanel.style.width,
        height: elPanel.style.height,
        bottom: elPanel.style.bottom,
        minimized: elPanel.classList.contains('minimized')
    };
    localStorage.setItem('elevation_window', JSON.stringify(state));
}

function saveStatsPosition() {
    if (window.innerWidth <= 768) return;
    const pos = {
        left: statsPanel.style.left,
        top: statsPanel.style.top
    };
    setCookie('stats_panel_pos', JSON.stringify(pos));
}

function loadWindowState() {
    const stateStr = localStorage.getItem('elevation_window');
    if (stateStr) {
        try {
            const state = JSON.parse(stateStr);
            if (state.left) elPanel.style.left = state.left;
            if (state.top) elPanel.style.top = state.top;
            if (state.width) elPanel.style.width = state.width;
            if (state.height) elPanel.style.height = state.height;
            if (state.bottom) elPanel.style.bottom = state.bottom;
            if (state.minimized) {
                elPanel.classList.add('minimized');
                elMinBtn.textContent = '+';
            }
        } catch (e) { }
    }
}

function loadStatsPosition() {
    if (window.innerWidth <= 768) return;
    const posStr = getCookie('stats_panel_pos');
    if (posStr) {
        try {
            const pos = JSON.parse(posStr);
            if (pos.left) {
                statsPanel.style.position = 'absolute';
                statsPanel.style.left = pos.left;
                statsPanel.style.right = 'auto';
            }
            if (pos.top) {
                statsPanel.style.position = 'absolute';
                statsPanel.style.top = pos.top;
                statsPanel.style.bottom = 'auto';
            }
        } catch (e) { }
    }
}

loadWindowState();
loadStatsPosition();

// Restore elevation panel visibility
const savedVisible = localStorage.getItem('elevation_panel_visible');
if (savedVisible === 'false') {
    elPanel.style.display = 'none';
}
updateElevationToggleBtn();

// --- Keybinding UI Management ---
const ACTION_NAMES = {
    toggleElevation: 'Toggle Elevation Chart',
    toggleMode: 'Toggle Routing Mode (Bike/Direct)',
    fitRoute: 'Fit Map to Route',
    toggleSettings: 'Open/Close Settings',
    search: 'Focus Search Bar',
    toggleStats: 'Toggle Route Statistics',
    reverse: 'Reverse Entire Route',
    deleteLast: 'Delete Last Point / Clear Route (Ctrl)',
    resetOrientation: 'Reset Map Orientation'
};

function renderKeybindings() {
    const list = document.getElementById('keybinding-list');
    if (!list) return;
    list.innerHTML = '';
    Object.keys(currentKeybindings).forEach(action => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:12px 20px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05);';

        const name = document.createElement('span');
        name.textContent = ACTION_NAMES[action];
        name.style.fontSize = '0.85rem';
        name.style.color = 'var(--text-muted)';

        const keyBtn = document.createElement('button');
        let displayKey = currentKeybindings[action].toUpperCase();
        if (displayKey === ' ') displayKey = 'SPACE';
        keyBtn.textContent = displayKey;
        keyBtn.style.cssText = 'min-width:85px; background:var(--btn-bg); border:1px solid var(--border); color:var(--primary); padding:8px 12px; border-radius:8px; font-size:0.75rem; font-family:monospace; font-weight:600; cursor:pointer; transition: all 0.2s;';

        if (activeCaptureKey === action) {
            keyBtn.textContent = '...';
            keyBtn.style.borderColor = 'var(--primary)';
            keyBtn.style.background = 'rgba(52, 211, 153, 0.1)';
        }

        keyBtn.onclick = () => {
            activeCaptureKey = action;
            renderKeybindings();
        };

        row.appendChild(name);
        row.appendChild(keyBtn);
        list.appendChild(row);
    });
}

document.getElementById('open-keybindings').onclick = () => {
    loadKeybindings();
    document.getElementById('keybindings-modal').style.display = 'flex';
    renderKeybindings();
};

document.getElementById('close-keybindings').onclick = () => {
    document.getElementById('keybindings-modal').style.display = 'none';
    activeCaptureKey = null;
};

document.getElementById('save-keybindings').onclick = () => {
    setCookie('route_keybindings', JSON.stringify(currentKeybindings));
    document.getElementById('keybindings-modal').style.display = 'none';
    activeCaptureKey = null;
};

document.getElementById('reset-keybindings').onclick = () => {
    currentKeybindings = { ...DEFAULT_KEYBINDINGS };
    renderKeybindings();
};

function initCustomTooltips() {
    if (window.innerWidth <= 768) return; // Disable on mobile
    const tooltip = document.createElement('div');
    tooltip.className = 'custom-tooltip';
    document.body.appendChild(tooltip);

    let activeEl = null;

    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest('[title]');
        if (!el) return;

        activeEl = el;
        const text = el.getAttribute('title');
        if (!text) return;

        el.setAttribute('data-tooltip', text);
        el.removeAttribute('title');

        tooltip.textContent = text;
        tooltip.classList.add('show');

        const rect = el.getBoundingClientRect();
        tooltip.style.left = Math.max(8, Math.min(window.innerWidth - tooltip.offsetWidth - 8, rect.left + rect.width / 2 - tooltip.offsetWidth / 2)) + 'px';
        tooltip.style.top = (rect.bottom + 8) + 'px';
    });

    document.addEventListener('mouseout', (e) => {
        if (activeEl && !activeEl.contains(e.relatedTarget)) {
            tooltip.classList.remove('show');
            activeEl.setAttribute('title', activeEl.getAttribute('data-tooltip'));
            activeEl.removeAttribute('data-tooltip');
            activeEl = null;
        }
    });
}
initCustomTooltips();

// Mobile drag-to-resize elevation profile
(function () {
    let isMobileResizing = false;
    let mobileStartY = 0;
    let mobileStartH = 0;

    function initMobileResize(e) {
        if (window.innerWidth > 768) return; // Only on mobile
        if (elPanel.classList.contains('minimized')) return;

        isMobileResizing = true;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        mobileStartY = clientY;
        mobileStartH = elPanel.offsetHeight;

        if (e.touches) {
            document.addEventListener('touchmove', mobileResizeWindow, { passive: false });
            document.addEventListener('touchend', stopMobileResize);
        } else {
            document.addEventListener('mousemove', mobileResizeWindow);
            document.addEventListener('mouseup', stopMobileResize);
        }
        if (e.cancelable) e.preventDefault();
    }

    function mobileResizeWindow(e) {
        if (!isMobileResizing) return;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dy = mobileStartY - clientY;
        const newH = Math.max(120, Math.min(window.innerHeight * 0.7, mobileStartH + dy));
        elPanel.style.setProperty('height', newH + 'px', 'important');
        if (elevationChart) elevationChart.resize();
        saveWindowState();
    }

    function stopMobileResize() {
        isMobileResizing = false;
        document.removeEventListener('touchmove', mobileResizeWindow);
        document.removeEventListener('touchend', stopMobileResize);
        document.removeEventListener('mousemove', mobileResizeWindow);
        document.removeEventListener('mouseup', stopMobileResize);
    }

    const elevHeader = document.getElementById('elevation-header');
    if (elevHeader) {
        elevHeader.addEventListener('mousedown', initMobileResize);
        elevHeader.addEventListener('touchstart', initMobileResize, { passive: false });
    }
})();

let userLocationMarker = null;
let userLocationWatchId = null;

function updateUserLocationPin() {
    const showCheck = document.getElementById('show-location-check');
    const isEnabled = showCheck ? showCheck.checked : false;
    localStorage.setItem('route_show_location_check', isEnabled);

    const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname) ||
        window.location.hostname.startsWith('192.168.') ||
        window.location.hostname.startsWith('10.') ||
        window.location.hostname.startsWith('172.') ||
        !("geolocation" in navigator);

    if (!isEnabled) {
        if (userLocationWatchId !== null) {
            if (isLocalhost) {
                clearInterval(userLocationWatchId);
            } else {
                navigator.geolocation.clearWatch(userLocationWatchId);
            }
            userLocationWatchId = null;
        }
        if (userLocationMarker) {
            userLocationMarker.remove();
            userLocationMarker = null;
        }
        return;
    }

    if (isLocalhost) {
        if (userLocationWatchId === null) {
            const updateLocalMarker = () => {
                const lngLat = [-122.4018, 37.7885];
                if (!userLocationMarker) {
                    const el = document.createElement('div');
                    el.style.width = '20px';
                    el.style.height = '20px';
                    el.style.backgroundColor = '#3b82f6';
                    el.style.border = '3px solid #ffffff';
                    el.style.borderRadius = '50%';
                    el.style.boxShadow = '0 0 6px rgba(0,0,0,0.4), 0 0 0 4px rgba(59, 130, 246, 0.4)';
                    el.style.cursor = 'default';
                    userLocationMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
                        .setLngLat(lngLat)
                        .addTo(map);
                } else {
                    userLocationMarker.setLngLat(lngLat);
                }
            };
            updateLocalMarker();
            userLocationWatchId = setInterval(updateLocalMarker, 5000);
        }
        return;
    }

    if (!("geolocation" in navigator)) return;

    if (userLocationWatchId === null) {
        userLocationWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                const lngLat = [pos.coords.longitude, pos.coords.latitude];
                if (!userLocationMarker) {
                    const el = document.createElement('div');
                    el.style.width = '20px';
                    el.style.height = '20px';
                    el.style.backgroundColor = '#3b82f6';
                    el.style.border = '3px solid #ffffff';
                    el.style.borderRadius = '50%';
                    el.style.boxShadow = '0 0 6px rgba(0,0,0,0.4), 0 0 0 4px rgba(59, 130, 246, 0.4)';
                    el.style.cursor = 'default';
                    userLocationMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
                        .setLngLat(lngLat)
                        .addTo(map);
                } else {
                    userLocationMarker.setLngLat(lngLat);
                }
            },
            () => {
                // Ignore errors
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }
}

// Dynamic Top Bar Height Sync (for perfect positioning of mobile panels right against it)
function syncTopBarHeight() {
    const topBar = document.getElementById('top-bar');
    if (topBar) {
        const height = topBar.getBoundingClientRect().height;
        document.documentElement.style.setProperty('--top-bar-height', `${height}px`);
    }
}
window.addEventListener('resize', syncTopBarHeight);
window.addEventListener('orientationchange', syncTopBarHeight);
syncTopBarHeight();
setTimeout(syncTopBarHeight, 100);
setTimeout(syncTopBarHeight, 500);
