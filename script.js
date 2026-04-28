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

let currentBasemap = localStorage.getItem('route_basemap') || 'dark';

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
    // Append to #map so the top bar remains fully visible
    document.getElementById('map').appendChild(initialCover);
    
    const params = new URLSearchParams(window.location.search);
    if (params.get('route')) {
        document.getElementById('loading-indicator').style.display = 'flex';
        document.getElementById('loading-phase').textContent = 'Initializing...';
    }
});

const map = new maplibregl.Map({
    container: 'map',
    style: VECTOR_STYLES[currentBasemap] || buildRasterStyle(RASTER_BASEMAPS[currentBasemap]),
    center: [0, 0],
    zoom: 1,
    maxZoom: 20,
    projection: { type: localStorage.getItem('route_projection') || 'mercator' },
    antialias: false,
    fadeDuration: 0,
    trackResize: true,
    transformRequest: (url, resourceType) => {
        // No custom headers to avoid CORS preflight failures on tile servers
    }
});

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

// Module-level state for viewport-aware gradient (needs to be accessible from updateElevationProfile)
let routeGrades = null;
let routePathDistances = null;
let routeTotalDist = 0;
let routeScreenPts = null;

// Performance settings — display only. Backend elevation always uses max resolution.
const PERF_MAP_POINTS = 5000;
const PERF_INTERACTION_POINTS = 1000; // Simplified hit-target for performance
const BACKEND_ELEV_POINTS = 2000; // elevation sample density (increased for smoother hover)

// --- Keybinding Customization ---
const DEFAULT_KEYBINDINGS = {
    toggleElevation: 'e',
    toggleMode: 'b',
    fitRoute: 'f',
    toggleSettings: 't',
    search: 's',
    reverse: 'v',
    deleteLast: 'backspace',
};
let currentKeybindings = { ...DEFAULT_KEYBINDINGS };
let activeCaptureKey = null;

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
    const coords = currentRouteGeoJSON.coordinates;
    const bounds = map.getBounds();
    // Use a small buffer around bounds to ensure smooth transitions
    const west = bounds.getWest(), east = bounds.getEast();
    const south = bounds.getSouth(), north = bounds.getNorth();

    routeScreenPts = coords.map(c => {
        // Strict viewport check to minimize projection overhead
        if (c[0] < west || c[0] > east || c[1] < south || c[1] > north) {
            return null;
        }
        return map.project(c);
    });
}

// Build colored GeoJSON segments and upload to the map.
// Called once after elevation data loads (grade colors) and also immediately
// Rebuild the route colour gradient using MapLibre's native line-gradient.
// We set a single LineString source (lineMetrics:true) and drive colour via
// ['line-progress'] — one continuous gradient, zero segment-boundary artifacts.
function rebuildMapGradient() {
    if (!currentRouteGeoJSON) return;
    const coords = currentRouteGeoJSON.coordinates;

    // Always update the geometry using the decimated version for rendering stability
    const mapCoords = decimateLine(coords, PERF_MAP_POINTS);
    const gradSrc = map.getSource('route-gradient');
    if (gradSrc) gradSrc.setData({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: mapCoords }
    });

    const grades = routeGrades;
    if (!grades || !routePathDistances || routeTotalDist <= 0) {
        // Elevation not loaded yet — flat green placeholder
        // IMPORTANT: line-gradient MUST be a valid interpolate expression, otherwise the shader corrupts
        if (map.getLayer('route-gradient-layer'))
            map.setPaintProperty('route-gradient-layer', 'line-gradient',
                ['interpolate', ['linear'], ['line-progress'], 0, 'rgb(34,197,94)', 1, 'rgb(34,197,94)']);
        return;
    }

    // Downsample gradient stops to avoid shader overflow (max ~1000 stops)
    const MAX_STOPS = 1000;
    const skip = Math.max(1, Math.floor(routePathDistances.length / MAX_STOPS));
    const gradStops = [];
    for (let i = 0; i < routePathDistances.length; i += skip) {
        const frac = Math.min(Math.max(routePathDistances[i] / routeTotalDist, 0), 1);
        gradStops.push(frac, getColorForGrade(grades[i] ?? 0));
    }
    // Ensure final point is included
    if ((routePathDistances.length - 1) % skip !== 0) {
        gradStops.push(1, getColorForGrade(grades[routePathDistances.length - 1] ?? 0));
    }

    if (map.getLayer('route-gradient-layer'))
        map.setPaintProperty('route-gradient-layer', 'line-gradient',
            ['interpolate', ['linear'], ['line-progress'], ...gradStops]);

    updateTurnaroundJoins();
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
        const bIn = getBearing(coords[i - 1], coords[i]);
        const bOut = getBearing(coords[i], coords[i + 1]);
        let delta = Math.abs(bOut - bIn);
        if (delta > 180) delta = 360 - delta;

        if (delta > 130) {
            const pCenter = map.project(coords[i]);
            const pIn = map.project(coords[i - 1]);
            const pOut = map.project(coords[i + 1]);

            // Normal vectors for in/out segments
            const vInX = pCenter.x - pIn.x, vInY = pCenter.y - pIn.y;
            const lIn = Math.sqrt(vInX * vInX + vInY * vInY);
            if (lIn < 0.1) continue;
            const nInX = -vInY / lIn, nInY = vInX / lIn;

            const vOutX = pOut.x - pCenter.x, vOutY = pOut.y - pCenter.y;
            const lOut = Math.sqrt(vOutX * vOutX + vOutY * vOutY);
            if (lOut < 0.1) continue;
            const nOutX = -vOutY / lOut, nOutY = vOutX / lOut;

            // Shift points to where the parallel lines end/start
            const p1xy = [pCenter.x + nInX * pxOffset, pCenter.y + nInY * pxOffset];
            const p2xy = [pCenter.x + nOutX * pxOffset, pCenter.y + nOutY * pxOffset];

            if (isNaN(p1xy[0]) || isNaN(p1xy[1]) || isNaN(p2xy[0]) || isNaN(p2xy[1])) continue;

            const p1 = map.unproject(p1xy);
            const p2 = map.unproject(p2xy);

            turns.push({
                type: 'Feature',
                properties: {
                    idx: i,
                    color: routeGrades ? getColorForGrade(routeGrades[i] ?? 0) : 'rgb(34,197,94)'
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
        elevationChart.update('none');
    }
    lastSegIdx = -1;
    map.getSource('hover-segment')?.setData({ type: 'FeatureCollection', features: [] });
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
        elevationWorker.postMessage({ id, coords });
    });
}

// ─── Route layer setup ───────────────────────────────────────────────────────
// Each source and layer has its OWN independent guard so a pre-existing source
// with any one of these names won't silently skip the rest of the block.
function setupRouteLayers() {
    // Terrain / hillshade (elevation data)
    if (!map.getSource('terrain-source'))
        map.addSource('terrain-source', { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, encoding: 'terrarium', maxzoom: 14 });
    if (!map.getSource('hillshade-source'))
        map.addSource('hillshade-source', { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, encoding: 'terrarium', maxzoom: 14 });
    if (!map.getLayer('hillshade-layer'))
        map.addLayer({ id: 'hillshade-layer', type: 'hillshade', source: 'hillshade-source', paint: { 'hillshade-exaggeration': 0.4, 'hillshade-shadow-color': 'rgba(0,0,0,0.5)', 'hillshade-highlight-color': 'rgba(255,255,255,0.1)' }, layout: { visibility: 'none' } });

    // Route sources (buffer:0 / tolerance:0 = exact geometry, no tile padding)
    if (!map.getSource('route'))
        map.addSource('route', { type: 'geojson', data: { type: 'LineString', coordinates: [] }, buffer: 0, tolerance: 0 });
    if (!map.getSource('route-segments'))
        map.addSource('route-segments', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, buffer: 0, tolerance: 0 });

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
                'line-width': 6,
                'line-opacity': 0.97,
                'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgb(34,197,94)', 1, 'rgb(34,197,94)'],
                'line-offset': ['interpolate', ['linear'], ['zoom'],
                    8, 0,
                    12, 2,
                    15, 4,
                    18, 6
                ]
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

    // Highlight for the active segment being hovered (Wider version of the same line, behind it)
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
                'line-offset': ['interpolate', ['linear'], ['zoom'],
                    8, 0,
                    12, 2,
                    15, 4,
                    18, 6
                ]
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
        // Interaction layer uses a simplified version of the line for faster R-tree lookups
        const interactCoords = decimateLine(coords, PERF_INTERACTION_POINTS);
        map.getSource('route').setData({ type: 'LineString', coordinates: interactCoords });

        // Visual layer uses higher resolution
        const mapCoords = decimateLine(coords, PERF_MAP_POINTS);
        map.getSource('route-gradient').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: mapCoords } });

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
    };
    map.on('zoom', updateView);
    map.on('moveend', updateView);
    map.on('zoomend', () => { isZooming = false; updateView(); });
    map.on('zoomstart', () => { isZooming = true; });
    map.on('idle', updateView);
});

map.on('load', () => {
    // Basic setup already done in style.load
});

// Hide hover label when the user is actively panning (not zooming).
// During zoom we want the hover to stay visible and track the cursor.
map.on('movestart', () => { if (!isZooming) hoverInfoEl.style.display = 'none'; });

// Change cursor when hovering the route
map.on('mouseenter', 'route-line', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'route-line', () => { if (!isDraggingLine) map.getCanvas().style.cursor = ''; });

// Throttled Hover Logic: Only runs when mouse is near the route
let lastHoverTime = 0;
map.on('mousemove', 'route-hover-target', (e) => {
    const now = performance.now();
    if (now - lastHoverTime < 16) return; // 60fps throttle
    lastHoverTime = now;

    if (!currentRouteGeoJSON || !routeScreenPts) return;
    const coords = currentRouteGeoJSON.coordinates;
    const mousePt = e.point;
    const threshold = 10000; // 100px radius squared for broad snapping
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

        // Unproject the best screen-space point on the offset line to get geographic coords
        const shiftedLngLat = map.unproject([bestProj.x, bestProj.y]);
        const lng = shiftedLngLat.lng;
        const lat = shiftedLngLat.lat;

        // Map interpolated distance → chart index via routePathDistances
        const ds = elevationChart?.data?.datasets?.[0];
        const ci = bestCi;
        let chartIdx = ci;
        if (routePathDistances && ds?.data?.length) {
            const meters = routePathDistances[ci] + bestT *
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
        showHoverMarker([lng, lat], info);

        const statsDiv = document.getElementById('hover-stats');
        if (statsDiv) {
            statsDiv.style.opacity = '1';
            document.getElementById('hover-dist').textContent = distLabel;
            document.getElementById('hover-elev').textContent = elevLabel;
            document.getElementById('hover-grade').textContent = gradeLabel;
        }

        // Update segment highlight ONLY if the segment has changed
        if (waypointPathIndices.length >= 2 && bestDistSq < highlightThreshold) {
            let segIdx = -1;
            for (let j = 0; j < waypointPathIndices.length - 1; j++) {
                if (ci >= waypointPathIndices[j] && ci < waypointPathIndices[j + 1]) {
                    segIdx = j; break;
                }
            }
            if (segIdx !== -1 && segIdx !== lastSegIdx) {
                lastSegIdx = segIdx;
                const startIndex = waypointPathIndices[segIdx];
                const endIndex = waypointPathIndices[segIdx + 1];
                const subCoords = currentRouteGeoJSON.coordinates.slice(startIndex, endIndex + 1);

                // Build a high-res gradient for the highlight to match the main route perfectly
                const stops = ['interpolate', ['linear'], ['line-progress']];
                // One stop per coordinate in the highlighted segment — matches main gradient exactly
                if (routeGrades && routePathDistances) {
                    const startMeters = routePathDistances[startIndex];
                    const endMeters = routePathDistances[endIndex];
                    const segDist = endMeters - startMeters || 1;

                    for (let idx = startIndex; idx <= endIndex; idx++) {
                        const d = routePathDistances[idx] ?? (idx === 0 ? 0 : routePathDistances[startIndex]);
                        const frac = Math.min(Math.max((d - startMeters) / segDist, 0), 1);
                        if (!isNaN(frac)) stops.push(frac, getColorForGrade(routeGrades[idx] ?? 0));
                    }
                    // Safety: ensure we always have at least 2 stops
                    if (stops.length < 6) { stops.push(0, 'rgb(34,197,94)', 1, 'rgb(34,197,94)'); }
                } else {
                    stops.push(0, 'rgb(34,197,94)', 1, 'rgb(34,197,94)');
                }

                map.setPaintProperty('hover-segment-layer', 'line-gradient', stops);

                map.getSource('hover-segment')?.setData({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: subCoords }
                });
                map.setFilter('turnaround-highlight-layer', ['all', ['>=', ['get', 'idx'], startIndex], ['<=', ['get', 'idx'], endIndex]]);
            }
        } else if (lastSegIdx !== -1) {
            lastSegIdx = -1;
            map.getSource('hover-segment')?.setData({ type: 'FeatureCollection', features: [] });
            map.setFilter('turnaround-highlight-layer', ['==', ['get', 'idx'], -1]);
        }

        if (ci !== lastHoverIdx) {
            lastHoverIdx = ci;
            const ds = elevationChart?.data?.datasets?.[0];
            if (elevationChart && routePathDistances && ds?.data?.length) {
                try {
                    const meters = routePathDistances[ci] + bestT *
                        (routePathDistances[Math.min(ci + 1, routePathDistances.length - 1)] - routePathDistances[ci]);
                    currentHoverDispDist = getDisplayDistance(meters);
                    elevationChart.update('none');
                } catch (err) { console.error(err); }
            }
        }
    } else {
        clearHoverHighlight();
    }
});

function clearHoverHighlight() {
    const statsDiv = document.getElementById('hover-stats');
    if (statsDiv) statsDiv.style.opacity = '0';
    if (lastHoverIdx !== -1) {
        lastHoverIdx = -1;
        lastSegIdx = -1;
        hideHoverMarker();
        map.getSource('hover-segment')?.setData({ type: 'FeatureCollection', features: [] });
        map.setFilter('turnaround-highlight-layer', ['==', ['get', 'idx'], -1]);
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





function createMarker(lngLat, index) {
    const el = document.createElement('div');
    el.style.width = '24px';
    el.style.height = '34px';
    el.style.cursor = 'pointer';
    el.style.filter = 'drop-shadow(0 2px 2px rgba(0,0,0,0.4))';
    el.innerHTML = pinSvg('#4b5563');

    const marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: true })
        .setLngLat(lngLat)
        .addTo(map);

    const onMiddleClick = (evt) => {
        if (evt.button === 1) { // middle click
            evt.preventDefault();
            evt.stopPropagation();
            const idx = markers.indexOf(marker);
            if (idx > -1) {
                markers.splice(idx, 1);
                waypoints.splice(idx, 1);
                if (idx > 0) segmentModes.splice(idx - 1, 1);
                marker.remove();
                updateRoute();
            }
        }
    };
    marker.getElement().addEventListener('mousedown', onMiddleClick);
    marker.getElement().addEventListener('auxclick', onMiddleClick);

    marker.on('dragend', () => {
        const idx = markers.indexOf(marker);
        if (idx > -1) {
            const ll = marker.getLngLat();
            waypoints[idx] = [ll.lng, ll.lat];
            updateRoute();
        }
    });

    if (index !== undefined) {
        markers.splice(index, 0, marker);
        waypoints.splice(index, 0, [lngLat.lng, lngLat.lat]);
        // Inherit the mode of the segment being split
        const oldMode = segmentModes[index - 1] || 'bike';
        segmentModes.splice(index, 0, oldMode);
    } else {
        markers.push(marker);
        waypoints.push([lngLat.lng, lngLat.lat]);
        if (waypoints.length > 1) {
            segmentModes.push(currentRoutingMode);
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
let draggedWaypointIndex = -1;

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

map.on('mousedown', 'route-line', (e) => {
    if (e.originalEvent.button !== 0) return; // Left click only
    if (!currentRouteGeoJSON || bestCiGlobal === -1) return;

    // 1. DEAD ZONE CHECK: Don't create new waypoint if clicking very close to an existing one
    const clickPt = e.point;
    for (const wp of waypoints) {
        const wpPt = map.project(wp);
        const dist = Math.hypot(wpPt.x - clickPt.x, wpPt.y - clickPt.y);
        if (dist < 25) return; // 25px dead zone to avoid double-drag
    }

    isDraggingLine = true;
    wasDraggingLine = true;
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';

    // Which two waypoints bound this segment?
    let insertIdx = waypoints.length;
    for (let j = 0; j < waypointPathIndices.length - 1; j++) {
        if (bestCiGlobal >= waypointPathIndices[j] && bestCiGlobal < waypointPathIndices[j + 1]) {
            insertIdx = j + 1;
            break;
        }
    }

    // Store neighboring waypoints for rubber-banding
    const prevWp = waypoints[insertIdx - 1];
    const nextWp = waypoints[insertIdx];

    const onMove = (moveEvent) => {
        const lngLat = moveEvent.lngLat;
        // Update rubber-band guide lines
        const guideCoords = [prevWp, [lngLat.lng, lngLat.lat]];
        if (nextWp) guideCoords.push(nextWp);
        map.getSource('drag-guide')?.setData({ type: 'LineString', coordinates: guideCoords });
        // Move and show the ghost pin
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
        map.off('mouseup', onUp);

        // Clear guides and hide ghost pin
        map.getSource('drag-guide')?.setData({ type: 'LineString', coordinates: [] });
        const pm = window._dragPreviewMarker;
        if (pm && pm._added) { pm.remove(); pm._added = false; }

        createMarker(upEvent.lngLat, insertIdx);
        updateRoute();
        setTimeout(() => wasDraggingLine = false, 50);
    };

    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
});

map.on('click', (e) => {
    if (e.originalEvent.button !== 0) return; // Left click only
    if (wasDraggingLine) return;
    saveHistory();
    createMarker(e.lngLat);
    updateRoute();
});

let lastRightClickTime = 0;
map.on('contextmenu', (e) => {
    const now = Date.now();
    if (now - lastRightClickTime < 500) {
        map.flyTo({ pitch: 0, bearing: 0 });
    }
    lastRightClickTime = now;
});

// Disable default browser context menu
document.getElementById('map').addEventListener('contextmenu', (e) => e.preventDefault());

let currentRouteGeoJSON = null;
let needsElevationUpdate = false;
let _elevRetryScheduled = false;
let forceMode = false; // straight-line mode — skips OSRM routing
let segmentModes = []; // 'routed' | 'direct' for each segment between consecutive waypoints

// --- Loading status indicator ---
function setStatus(phase) {
    const el = document.getElementById('loading-indicator');
    const ph = document.getElementById('loading-phase');
    if (el) el.style.display = 'flex';
    if (ph) ph.textContent = phase;
    
    // Also update the initial cover text if visible
    const initialText = document.getElementById('initial-loading-text');
    if (initialText) initialText.textContent = phase;
}
function clearStatus() {
    const el = document.getElementById('loading-indicator');
    if (el) el.style.display = 'none';
}

// Fetch a single routed/direct segment; returns { coords, dist }
async function fetchOneSegment(from, to, mode, avoidUnpaved, excludeParam) {
    if (mode === 'direct') {
        return { coords: [from, to], dist: turf_distance(from, to) };
    }
    try {
        const bProfile = avoidUnpaved ? 'fastbike' : 'trekking';
        const endpoints = [
            `https://brouter.de/brouter?lonlats=${from[0]},${from[1]}|${to[0]},${to[1]}&profile=${bProfile}&alternativeidx=0&format=geojson`,
            `https://routing.openstreetmap.de/routed-bike/route/v1/bicycle/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`,
            `https://router.project-osrm.org/route/v1/cycling/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`
        ];
        for (const url of endpoints) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const data = await resp.json();
                if (data.type === 'FeatureCollection' && data.features.length > 0) {
                    return { coords: data.features[0].geometry.coordinates, dist: parseFloat(data.features[0].properties['track-length']) };
                }
                if (data.code === 'Ok' && data.routes.length > 0) {
                    return { coords: data.routes[0].geometry.coordinates, dist: data.routes[0].distance };
                }
            } catch (e) { continue; }
        }
    } catch (e) { /* fall through */ }
    return { coords: [from, to], dist: turf_distance(from, to) };
}

async function updateRoute() {
    if (waypoints.length === 0 || waypoints.length === 1) {
        if (map.getSource('route')) map.getSource('route').setData({ type: 'LineString', coordinates: [] });
        if (map.getSource('route-segments')) map.getSource('route-segments').setData({ type: 'FeatureCollection', features: [] });
        if (map.getSource('route-gradient')) map.getSource('route-gradient').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
        if (map.getSource('turnarounds')) map.getSource('turnarounds').setData({ type: 'FeatureCollection', features: [] });
        hideHoverMarker();
        currentDistanceMeters = 0;
        currentRouteGeoJSON = null;
        routeGrades = null; routePathDistances = null; routeTotalDist = 0;
        waypointDistances = [];
        updateDistanceUI();
        updateElevationProfile();
        syncUrl();
        clearStatus();
        return;
    }

    const avoidMotorways = document.getElementById('avoid-motorways-check')?.checked ?? true;
    const avoidTolls = document.getElementById('avoid-tolls-check')?.checked ?? true;
    const avoidUnpaved = document.getElementById('avoid-unpaved-check')?.checked ?? false;

    let exclude = [];
    if (avoidMotorways) exclude.push('motorway');
    if (avoidTolls) exclude.push('toll');
    if (avoidUnpaved) exclude.push('unpaved');
    const excludeParam = exclude.length > 0 ? `&exclude=${exclude.join(',')}` : '';

    // --- Routing phase: fetch ALL segments in parallel ---
    const numSegs = waypoints.length - 1;
    setStatus(numSegs === 1 ? 'Routing…' : `Routing ${numSegs} segments…`);

    const segmentPromises = [];
    for (let i = 0; i < numSegs; i++) {
        const mode = segmentModes[i] || 'bike';
        segmentPromises.push(fetchOneSegment(waypoints[i], waypoints[i + 1], mode, avoidUnpaved, excludeParam));
    }
    const segments = await Promise.all(segmentPromises);

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
    // Dynamic sampling: Target 1 point every 5 meters, min 2000, max 15000 points
    const targetPoints = Math.min(15000, Math.max(2000, Math.ceil(totalDist / 5)));
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

    const mapCoords = decimateLine(currentRouteGeoJSON.coordinates, PERF_MAP_POINTS);

    if (map.getSource('route')) map.getSource('route').setData({ type: 'LineString', coordinates: mapCoords });
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
    undoStack.push({ waypoints: waypoints.map(w => [...w]), modes: [...segmentModes] });
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
    segmentModes = [...state.modes];
    // Rebuild markers from saved waypoints
    state.waypoints.forEach(wp => {
        waypoints.push([...wp]);
        const el = document.createElement('div');
        el.style.width = '24px'; el.style.height = '34px';
        el.style.cursor = 'pointer';
        el.style.filter = 'drop-shadow(0 2px 2px rgba(0,0,0,0.4))';
        el.innerHTML = pinSvg('#4b5563');
        const m = new maplibregl.Marker({ element: el, anchor: 'center', draggable: true }).setLngLat(wp).addTo(map);
        m.on('dragend', () => {
            const idx = markers.indexOf(m);
            if (idx > -1) { waypoints[idx] = [m.getLngLat().lng, m.getLngLat().lat]; saveHistory(); updateRoute(); }
        });
        markers.push(m);
    });
    refreshMarkerIcons();
    updateRoute();
    updateUndoRedoBtns();
}

function undo() {
    if (!undoStack.length) return;
    redoStack.push({ waypoints: waypoints.map(w => [...w]), modes: [...segmentModes] });
    applyHistoryState(undoStack.pop());
}

function redo() {
    if (!redoStack.length) return;
    undoStack.push({ waypoints: waypoints.map(w => [...w]), modes: [...segmentModes] });
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
    const gainLossEl = document.getElementById('elev-gain-loss');
    if (gainLossEl) gainLossEl.textContent = '';
    updateRoute();
    updateUndoRedoBtns();
});

function fitRoute() {
    if (!currentRouteGeoJSON || currentRouteGeoJSON.coordinates.length === 0) {
        if (waypoints.length > 0) {
            const bounds = new maplibregl.LngLatBounds();
            waypoints.forEach(wp => bounds.extend(wp));
            map.fitBounds(bounds, { padding: 60, duration: 600 });
        }
        return;
    }
    const bounds = new maplibregl.LngLatBounds();
    currentRouteGeoJSON.coordinates.forEach(c => bounds.extend(c));
    map.fitBounds(bounds, { padding: 60, duration: 600 });
}

document.getElementById('fit-route-btn').addEventListener('click', fitRoute);
document.getElementById('reverse-route-btn')?.addEventListener('click', reverseRoute);

function toggleSettings(event) {
    const menu = document.getElementById('settings-menu');
    if (menu.style.display === 'none' || menu.style.display === '') {
        menu.style.display = 'block';
    } else {
        menu.style.display = 'none';
    }
    if (event) event.stopPropagation();
}

// --- Search and Shortcuts ---

(function () {
    const input = document.getElementById('map-search');
    if (!input) return;

    // Create dropdown container
    const dropdown = document.createElement('div');
    dropdown.id = 'search-dropdown';
    input.parentElement.style.position = 'relative';
    input.parentElement.appendChild(dropdown);

    let debounceTimer = null;
    let currentResults = [];

    function closeDropdown() {
        dropdown.innerHTML = '';
        dropdown.style.display = 'none';
    }

    function selectResult(item) {
        // Fly to location only — do NOT add a waypoint
        map.flyTo({ center: [parseFloat(item.lon), parseFloat(item.lat)], zoom: 14 });
        input.value = '';
        closeDropdown();
        input.blur();
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
            closeDropdown();
        }
    });

    input.addEventListener('blur', () => {
        // Small delay so mousedown on result fires first
        setTimeout(closeDropdown, 150);
    });

    document.addEventListener('click', (e) => {
        if (!input.parentElement.contains(e.target)) closeDropdown();
    });
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
        const nextMode = currentRoutingMode === 'bike' ? 'direct' : 'bike';
        setRoutingMode(nextMode);
    } else if (key === currentKeybindings.fitRoute) {
        e.preventDefault();
        fitRoute();
    } else if (key === currentKeybindings.toggleSettings) {
        e.preventDefault();
        toggleSettings();
    } else if (key === currentKeybindings.search) {
        e.preventDefault();
        const searchInput = document.getElementById('map-search');
        if (searchInput) { searchInput.focus(); searchInput.select(); }
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
    }
});

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
    reader.onload = e => {
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
            currentRouteGeoJSON = null;

            if (trkpts.length > 0) {
                // GPS track — use coordinates directly, place markers at start/end only
                const coords = trkpts
                    .map(pt => [parseFloat(pt.getAttribute('lon')), parseFloat(pt.getAttribute('lat'))])
                    .filter(c => !isNaN(c[0]) && !isNaN(c[1]));
                if (coords.length < 2) { alert('GPX track has fewer than 2 valid points.'); return; }

                createMarker({ lng: coords[0][0], lat: coords[0][1] });
                createMarker({ lng: coords[coords.length - 1][0], lat: coords[coords.length - 1][1] });
                segmentModes = ['direct'];

                let totalDist = 0;
                for (let i = 0; i < coords.length - 1; i++) totalDist += turf_distance(coords[i], coords[i + 1]);
                currentDistanceMeters = totalDist;
                // Dynamic sampling for GPX: 1 point per 5m, capped at 15000
                const targetPoints = Math.min(15000, Math.max(2000, Math.ceil(totalDist / 5)));
                currentRouteGeoJSON = { type: 'LineString', coordinates: resampleLine(coords, targetPoints) };

                // Waypoints for track import are just start and end
                waypointPathIndices = [0, currentRouteGeoJSON.coordinates.length - 1];
                waypointDistances = [0, currentDistanceMeters];

                const mapCoords = decimateLine(currentRouteGeoJSON.coordinates, PERF_MAP_POINTS);
                if (map.getSource('route')) map.getSource('route').setData({ type: 'LineString', coordinates: mapCoords });
                rebuildMapGradient();
                rebuildRouteScreenPts();
                updateDistanceUI();
                refreshMarkerIcons();

                const bounds = new maplibregl.LngLatBounds();
                coords.forEach(c => bounds.extend(c));
                map.fitBounds(bounds, { padding: 60, maxZoom: 17, duration: 700 });

                needsElevationUpdate = true;
                updateElevationProfile();
                syncUrl();
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
    const show = document.getElementById('hillshade-check').checked;
    const exInput = document.getElementById('terrain-exaggeration');

    localStorage.setItem('route_hillshade', show);
    let exVal = parseFloat(exInput.value);
    if (isNaN(exVal)) exVal = 2.0;
    localStorage.setItem('route_exaggeration', exVal);

    // Guard: layers may not exist yet if called before map.on('load') completes
    if (!map.getLayer('hillshade-layer') || !map.getSource('terrain-source')) return;

    if (show) {
        map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
        if (exVal > 0) {
            map.setTerrain({ source: 'terrain-source', exaggeration: exVal });
        } else {
            if (map.getTerrain()) map.setTerrain(null);
        }
    } else {
        map.setLayoutProperty('hillshade-layer', 'visibility', 'none');
        // Only call setTerrain(null) if terrain was previously enabled
        // Calling setTerrain with any source triggers MapLibre's terrain init pipeline
        if (map.getTerrain()) map.setTerrain(null);
    }

    needsElevationUpdate = true;
    if (typeof updateElevationProfile === 'function') updateElevationProfile();
}

function setRoutingMode(mode) {
    currentRoutingMode = mode;
    localStorage.setItem('route_routing_mode', mode);
    document.getElementById('mode-bike')?.classList.toggle('active', mode === 'bike');
    document.getElementById('mode-direct')?.classList.toggle('active', mode === 'direct');
    // Do NOT call updateRoute() here — only affects newly created segments
}

document.getElementById('mode-bike')?.addEventListener('click', () => setRoutingMode('bike'));
document.getElementById('mode-direct')?.addEventListener('click', () => setRoutingMode('direct'));

document.getElementById('hillshade-check').addEventListener('change', applyTerrain);
document.getElementById('terrain-exaggeration').addEventListener('change', applyTerrain);

function toggleSettings(event) {
    if (event) event.stopPropagation();
    document.getElementById('settings-menu').classList.toggle('show');
}

['avoid-motorways-check', 'avoid-tolls-check', 'avoid-unpaved-check'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', (e) => {
        localStorage.setItem('route_' + id.replace(/-/g, '_'), e.target.checked);
        updateRoute();
    });
});

window.addEventListener('click', () => {
    document.getElementById('settings-menu').classList.remove('show');
});

document.getElementById('settings-menu').addEventListener('click', e => e.stopPropagation());

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
    const basemap = localStorage.getItem('route_basemap');
    if (basemap) {
        document.getElementById('basemap').value = basemap;
        // Do NOT dispatch — style is already correct from initialization
    }

    // Units — safe, no map side effects
    const units = localStorage.getItem('route_units');
    if (units) {
        currentUnits = units;
        document.getElementById('units').value = units;
        updateDistanceUI();
    }

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
        document.getElementById('hillshade-check').checked = hillshade === 'true';
    }
    const exaggeration = localStorage.getItem('route_exaggeration');
    if (exaggeration !== null) {
        document.getElementById('terrain-exaggeration').value = exaggeration;
    }

    // Apply terrain after all values are set (layers exist by now)
    applyTerrain();

    // Routing options
    ['avoid-motorways-check', 'avoid-tolls-check', 'avoid-unpaved-check'].forEach(id => {
        const val = localStorage.getItem('route_' + id.replace(/-/g, '_'));
        if (val !== null) {
            const el = document.getElementById(id);
            if (el) el.checked = val === 'true';
        }
    });
}

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
    } else if (grade <= 40) {
        // Red for all real steep terrain up to the 40% clamp ceiling
        return 'rgb(239, 68, 68)';
    } else {
        // Purple only above 40% — impossible after clamping, indicates artifact
        return 'rgb(168, 85, 247)';
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
                padding: { top: 20, right: 10, left: 10, bottom: 0 }
            },
            interaction: {
                mode: 'routeHover',
                intersect: false
            },
            onHover: (event, activeElements, chart) => {
                if (!currentRouteGeoJSON || !currentRouteGeoJSON.coordinates) { hideHoverMarker(); return; }

                const data = chart.data.datasets[0]?.data;
                const coords = currentRouteGeoJSON.coordinates;
                if (!data || data.length < 2 || !coords || coords.length < 2) { hideHoverMarker(); return; }

                const xValue = chart.scales.x.getValueForPixel(event.x); // display-unit distance

                // Find the chart data index closest to the hover x
                let low = 0, high = data.length - 2, i = 0;
                while (low <= high) {
                    const mid = (low + high) >> 1;
                    if (data[mid].x <= xValue) { i = mid; low = mid + 1; }
                    else high = mid - 1;
                }

                // Map hover x-value (display distance) → coordinate index via routePathDistances
                // This is accurate even if chart data has been filtered/resampled.
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
                    // Fallback: proportional mapping
                    const ratio = i / Math.max(1, data.length - 1);
                    ci = Math.min(Math.floor(ratio * (coords.length - 1)), coords.length - 2);
                }
                const ciNext = ci + 1;

                const t = (data[i + 1] && data[i + 1].x !== data[i].x)
                    ? Math.max(0, Math.min(1, (xValue - data[i].x) / (data[i + 1].x - data[i].x)))
                    : 0;

                // Get geographic center point
                const lngCenter = coords[ci][0] + t * (coords[ciNext][0] - coords[ci][0]);
                const latCenter = coords[ci][1] + t * (coords[ciNext][1] - coords[ci][1]);

                // Shift to offset side in screen space, then unproject
                const pCenter = map.project([lngCenter, latCenter]);
                const p0 = map.project(coords[ci]);
                const p1 = map.project(coords[ciNext]);
                const vX = p1.x - p0.x, vY = p1.y - p0.y;
                const len = Math.sqrt(vX * vX + vY * vY);
                let shiftedLngLat;
                if (len > 0.1) {
                    const nx = -vY / len, ny = vX / len;
                    const off = getPixelOffset(map.getZoom());
                    shiftedLngLat = map.unproject([pCenter.x + nx * off, pCenter.y + ny * off]);
                } else {
                    shiftedLngLat = { lng: lngCenter, lat: latCenter };
                }
                const lng = shiftedLngLat.lng;
                const lat = shiftedLngLat.lat;

                const ds = chart.data.datasets[0];
                const grade = ds.grades?.[ci];

                // Update vertical hover line
                currentHoverDispDist = xValue;
                chart.update('none');

                const distLabel = xValue.toFixed(2) + (currentUnits === 'metric' ? ' km' : ' mi');
                const elevVal = data[i].y;
                const elevLabel = elevVal != null
                    ? elevVal.toFixed(1) + (currentUnits === 'metric' ? ' m' : ' ft')
                    : '';
                const gradeLabel = grade !== undefined ? (grade >= 0 ? '+' : '') + grade.toFixed(2) + '%' : '';

                const info = `${distLabel} <span style="color:#888">&nbsp;|&nbsp;</span> ${elevLabel} <span style="color:#888">&nbsp;|&nbsp;</span> ${gradeLabel}`;
                showHoverMarker([lng, lat], info);

                const statsDiv = document.getElementById('hover-stats');
                if (statsDiv) {
                    statsDiv.style.opacity = '1';
                    document.getElementById('hover-dist').textContent = distLabel;
                    document.getElementById('hover-elev').textContent = elevLabel;
                    document.getElementById('hover-grade').textContent = gradeLabel;
                }
            },
            onLeave: () => {
                const statsDiv = document.getElementById('hover-stats');
                if (statsDiv) statsDiv.style.opacity = '0';
                hideHoverMarker();
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
                    title: { display: true, text: 'Distance', color: '#aaa' },
                    grid: { color: '#333' },
                    ticks: { color: '#aaa' }
                },
                y: {
                    display: true,
                    title: { display: true, text: 'Elevation', color: '#aaa' },
                    grid: { color: '#333' },
                    ticks: { color: '#aaa' }
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
        }
        return;
    }

    isUpdatingElevation = true;

    try {
        const coords = currentRouteGeoJSON.coordinates;
        const chartData = [];
        const pathDistances = [0];
        let distMeters = 0;
        let maxElev = -Infinity;
        let minElev = Infinity;

        // Fetch highest-res Mapzen Terrarium elevation data
        setStatus('Fetching elevation…');
        const elevations = await getHighResElevation(coords);
        setStatus('Processing…');

        // Null check: if >5% of samples are null, tiles didn't load fully.
        // Schedule a retry in 2s (worker tile cache will be warm by then).
        const nullCount = elevations.filter(v => v == null).length;
        if (nullCount > elevations.length * 0.05) {
            console.warn(`[elev] ${nullCount}/${elevations.length} nulls — scheduling retry`);
            setTimeout(() => { needsElevationUpdate = true; updateElevationProfile(); }, 2000);
        }

        // Build pathDistances for map gradient (elevation/grade rebuilt below via median filter)
        for (let i = 1; i < coords.length; i++) {
            distMeters += haversineDistance(coords[i - 1], coords[i]);
            pathDistances.push(distMeters);
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

        // Gaussian display smoothing: reduces DEM pixel noise from ~5-10ft to ~1-2ft.
        // Uses a symmetric 15-point kernel to handle the longer-wavelength open-water
        // bathymetric noise (which a 5-point kernel can't reach).
        // Applied only to the chart display array; grade calculation still uses raw elevations.
        const GAUSS = [0.04, 0.06, 0.08, 0.09, 0.10, 0.11, 0.12, 0.11, 0.10, 0.09, 0.08, 0.06, 0.04, 0.03, 0.03];
        const WIN_HALF = 7; // 15-point window (indices -7 to +7)
        const displayElevs = elevations.map((v, i) => {
            if (v == null) return null;
            let sum = 0, weight = 0;
            for (let k = -WIN_HALF; k <= WIN_HALF; k++) {
                const e = elevations[i + k];
                if (e != null) { sum += e * GAUSS[k + WIN_HALF]; weight += GAUSS[k + WIN_HALF]; }
            }
            return weight > 0 ? sum / weight : v;
        });

        // Step 2: Calculate raw segment grades (N-1 segments for N coordinates)
        const filteredChartData = [];
        const segmentGrades = [];
        let filteredDist = 0;
        let filteredMax = -Infinity, filteredMin = Infinity;
        for (let i = 0; i < coords.length; i++) {
            const val = elevations[i];       // raw despiked — used for grade calc
            const dval = displayElevs[i];    // Gaussian-smoothed — used for chart
            if (i > 0) {
                const prevVal = elevations[i - 1];
                const d = haversineDistance(coords[i - 1], coords[i]);
                filteredDist += d;
                if (val != null && prevVal != null && d > 0) {
                    segmentGrades.push((val - prevVal) / d * 100);
                } else {
                    segmentGrades.push(0);
                }
            }
            const displayElev = dval != null ? (currentUnits === 'metric' ? dval : dval * 3.28084) : null;
            filteredChartData.push({ x: getDisplayDistance(filteredDist), y: displayElev ?? null });
            if (displayElev != null) {
                filteredMax = Math.max(filteredMax, displayElev);
                filteredMin = Math.min(filteredMin, displayElev);
            }
        }

        // Replace original data with filtered
        chartData.length = 0; filteredChartData.forEach(p => chartData.push(p));
        maxElev = filteredMax; minElev = filteredMin;

        // Calculate total elevation gain and loss from despiked elevations
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
        if (gainLossEl) gainLossEl.textContent = `${gainLabel}  ${lossLabel}`;

        // Step 3: Clamp physically impossible grades and apply distance-aware smoothing.
        // This ensures the smoothing window covers the same physical distance regardless of point density.
        const clampedGrades = segmentGrades.map(g => Math.max(-40, Math.min(40, g)));
        const smoothedSegmentGrades = [];
        const targetWindowMeters = 10; // 10m smoothing window

        for (let i = 0; i < clampedGrades.length; i++) {
            let sum = 0, count = 0;
            let distBack = 0, distFwd = 0;

            // Average current point
            sum += clampedGrades[i]; count++;

            // Scan backward up to targetWindowMeters / 2
            for (let j = i - 1; j >= 0; j--) {
                const d = haversineDistance(coords[j], coords[j + 1]);
                distBack += d;
                if (distBack > targetWindowMeters / 2) break;
                sum += clampedGrades[j]; count++;
            }
            // Scan forward up to targetWindowMeters / 2
            for (let j = i + 1; j < clampedGrades.length; j++) {
                const d = haversineDistance(coords[j], coords[j + 1]);
                distFwd += d;
                if (distFwd > targetWindowMeters / 2) break;
                sum += clampedGrades[j]; count++;
            }
            smoothedSegmentGrades.push(sum / count);
        }
        // Build smoothedGrades for map/chart coloring: length N.
        // Index 0 has no incoming segment, so use the first outgoing grade.
        const smoothedGrades = [smoothedSegmentGrades[0] ?? 0, ...smoothedSegmentGrades];

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
        routeTotalDist = distMeters;

        // Trigger map gradient build — map outline shows until segments are ready
        rebuildMapGradient();
        rebuildRouteScreenPts();

        // If this is the very first full load, literally cycle the basemap to force a hard WebGL rebuild.
        // MapLibre's style diffing ignores identical styles, so we must actually switch to a different style and back.
        if (!initialBasemapCycled && currentRouteGeoJSON) {
            initialBasemapCycled = true;
            setStatus('Finalizing...');
            const basemapSelect = document.getElementById('basemap');
            const originalValue = basemapSelect.value;
            const options = Array.from(basemapSelect.options);
            const alternateOption = options.find(o => o.value !== originalValue) || options[0];

            // Switch to a different basemap (the visual flash is hidden by the persistent #initial-map-cover)
            basemapSelect.value = alternateOption.value;
            basemapSelect.dispatchEvent(new Event('change'));

            // Wait for it to finish tearing down, then swap back to the user's preference
            setTimeout(() => {
                basemapSelect.value = originalValue;
                basemapSelect.dispatchEvent(new Event('change'));
                
                // Wait for the final map to render, then remove the persistent cover
                setTimeout(() => {
                    removeInitialCover();
                }, 300);
            }, 300);
        } else if (!initialBasemapCycled) {
            initialBasemapCycled = true;
            removeInitialCover();
        }

        elevationChart.update('none');
        elevationChart.options.scales.x.max = getDisplayDistance(distMeters);
        elevationChart.options.scales.x.title.text = `Distance (${currentUnits === 'metric' ? 'km' : 'mi'})`;
        elevationChart.options.scales.y.title.text = `Elevation (${currentUnits === 'metric' ? 'm' : 'ft'})`;

        if (maxElev === -Infinity) maxElev = 100;
        if (minElev === Infinity) minElev = 0;
        const elevRange = maxElev - minElev;
        const padding = elevRange === 0 ? 10 : elevRange * 0.35; // Extra padding for taller pins

        elevationChart.options.scales.y.suggestedMax = maxElev + padding;
        elevationChart.options.scales.y.suggestedMin = Math.max(0, minElev - padding);

        try {
            elevationChart.update('none');
        } catch (e) { }

        rebuildMapGradient(); // update line colors on map
        updateTurnaroundJoins(); // update turn colors
        needsElevationUpdate = false;
        // Schedule a warm-cache refresh pass 3s after the first load.
        // Tiles that were slow on the first fetch will be fully cached by then,
        // ensuring grades are correct without requiring a manual waypoint move.
        if (!_elevRetryScheduled) {
            _elevRetryScheduled = true;
            setTimeout(() => {
                _elevRetryScheduled = false;
                if (currentRouteGeoJSON) {
                    needsElevationUpdate = true;
                    updateElevationProfile();
                }
            }, 3000);
        }
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
    } else {
        params.delete('route');
    }
    if (forceMode) params.set('force', '1'); else params.delete('force');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

function loadUrlState() {
    const params = new URLSearchParams(window.location.search);
    // Restore force mode before building the route
    if (params.get('force') === '1') {
        forceMode = true;
        updateForceModeBtn();
    }
    const routeStr = params.get('route');
    if (routeStr) {
        const points = routeStr.split(';');
        for (const pt of points) {
            const [lng, lat] = pt.split(',').map(Number);
            if (!isNaN(lng) && !isNaN(lat)) {
                createMarker({ lng, lat });
            }
        }
        updateRoute();

        if (waypoints.length > 1) {
            const bounds = new maplibregl.LngLatBounds();
            for (const wp of waypoints) {
                bounds.extend(wp);
            }
            map.fitBounds(bounds, { padding: 50, duration: 0 }); // Instant fit on load
            // After camera settles and tiles load, force an elevation refresh
            map.once('idle', () => {
                needsElevationUpdate = true;
                updateElevationProfile();
            });
        } else if (waypoints.length === 1) {
            map.jumpTo({ center: waypoints[0], zoom: 13 });
        }
    } else {
        // No route — remove the initial cover and try geolocation automatically
        removeInitialCover();
        requestLocation();
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

function requestLocation() {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            map.jumpTo({
                center: [pos.coords.longitude, pos.coords.latitude],
                zoom: 13
            });
        },
        () => {
            // If we are at [0,0] zoom 1, stay there.
            // If this was a manual button click, user knows it failed.
        },
        { timeout: 5000, enableHighAccuracy: true }
    );
}


const elPanel = document.getElementById('elevation-panel');
const elHeader = document.getElementById('elevation-header');
const elMinBtn = document.getElementById('elevation-min-btn');

let isDraggingWindow = false;
let startX, startY, initialLeft, initialTop;

elHeader.addEventListener('mousedown', (e) => {
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

document.addEventListener('mousemove', (e) => {
    if (!isDraggingWindow) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const container = document.getElementById('map').getBoundingClientRect();
    const panelW = elPanel.offsetWidth;
    const panelH = elPanel.offsetHeight;
    // Keep panel fully inside the map container
    const newLeft = Math.min(Math.max(initialLeft + dx, container.left), container.right - panelW);
    const newTop = Math.min(Math.max(initialTop + dy, container.top), container.bottom - panelH);
    elPanel.style.left = newLeft + 'px';
    elPanel.style.top = newTop + 'px';
});

document.addEventListener('mouseup', () => {
    if (isDraggingWindow) {
        isDraggingWindow = false;
        saveWindowState();
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
    if (elPanel.classList.contains('minimized')) return;

    // Determine which resizer was clicked by checking classes
    const cl = e.target.classList;
    let resizer = '';
    if (cl.contains('n')) resizer += 'n';
    if (cl.contains('s')) resizer += 's';
    if (cl.contains('e')) resizer += 'e';
    if (cl.contains('w')) resizer += 'w';

    if (!resizer) return;

    isResizing = true;
    currentResizer = resizer;
    resizeStartX = e.clientX; resizeStartY = e.clientY;
    startW = elPanel.offsetWidth; startH = elPanel.offsetHeight;

    if (!elPanel.style.left) elPanel.style.left = elPanel.offsetLeft + 'px';
    if (!elPanel.style.top) elPanel.style.top = elPanel.offsetTop + 'px';

    startLeft = parseFloat(elPanel.style.left);
    startTop = parseFloat(elPanel.style.top);

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
function updateElevationToggleBtn() {
    const visible = elPanel.style.display !== 'none';
    elToggleBtn.textContent = visible ? 'Elevation ↓' : 'Elevation ↑';
    elToggleBtn.style.color = visible ? 'var(--accent)' : 'var(--text-muted)';
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

loadWindowState();

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
    reverse: 'Reverse Entire Route',
    deleteLast: 'Delete Last Point / Clear Route (Ctrl)'
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
