window.addEventListener('error', function (e) {
    let errDiv = document.getElementById('debug-error-overlay');
    if (!errDiv) {
        errDiv = document.createElement('div');
        errDiv.id = 'debug-error-overlay';
        errDiv.style = 'position:fixed;bottom:10px;right:10px;background:rgba(220,38,38,0.85);color:white;padding:6px 10px;z-index:999999;font-family:monospace;font-size:11px;max-width:350px;border-radius:6px;word-break:break-all;pointer-events:none;display:none;';
        document.body.appendChild(errDiv);
    }
    errDiv.textContent = e.message + ' at ' + e.filename + ':' + e.lineno;
});

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

// Apply stored theme immediately to avoid any flash of dark theme
const storedInitialTheme = localStorage.getItem('route_theme') || 'dark';
if (window.applyAppTheme) {
    window.applyAppTheme(storedInitialTheme);
} else if (storedInitialTheme === 'light') {
    document.body.classList.add('light-mode');
}

// Create a persistent cover that hides the map until the initial load and cycle hack is completely finished.
// This perfectly answers the request to "only make it visually load on the second load".
const initialCover = document.createElement('div');
initialCover.id = 'initial-map-cover';
if (storedInitialTheme === 'light') {
    initialCover.classList.add('light-mode');
}

initialCover.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:16px; font-family:'Inter', sans-serif;">
        <svg class="initial-spinner" width="44" height="44" viewBox="0 0 16 16" fill="none">
            <circle class="spinner-track" cx="8" cy="8" r="7" stroke-width="2"/>
            <path class="spinner-head" d="M8 1a7 7 0 0 1 7 7" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <div id="initial-loading-text" style="font-size: 0.9rem; font-weight: 500; letter-spacing: 0.02em;">Loading route...</div>
        <button id="initial-clear-route-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            Clear Route & Reload
        </button>
    </div>
`;

document.addEventListener('click', (e) => {
    const btn = e.target.closest('#initial-clear-route-btn');
    if (btn) {
        e.preventDefault();
        e.stopPropagation();
        try {
            localStorage.removeItem('cached_active_route');
            localStorage.removeItem('route_waypoints');
            localStorage.removeItem('route_segment_modes');
            localStorage.removeItem('route_gpx_paths');
        } catch (_) { }
        window.location.href = window.location.origin + window.location.pathname;
    }
}, true);

// Wait for DOM content to be ready
document.addEventListener('DOMContentLoaded', () => {
    let params = new URLSearchParams(window.location.search);
    let routeStr = params.get('route');
    let modeStr = params.get('modes');

    // On mobile app, check cached route in localStorage if no route in URL query
    if (!routeStr) {
        try {
            const cachedRoute = JSON.parse(localStorage.getItem('cached_active_route') || 'null');
            if (cachedRoute && cachedRoute.route) {
                routeStr = cachedRoute.route;
                if (!modeStr && cachedRoute.modes) modeStr = cachedRoute.modes;
            }
        } catch (_) {}
    }

    const modes = modeStr ? modeStr.split(',') : [];
    // Only show the loading cover when there are 2+ waypoints (a real route to fetch) and not a GPX import.
    if (routeStr && routeStr.includes(';') && !modes.includes('gpx')) {
        document.body.appendChild(initialCover);
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
    centerClampedToGround: false,
    projection: { type: localStorage.getItem('route_projection') || 'mercator' },
    antialias: false,
    fadeDuration: 0,
    trackResize: true,
    clickTolerance: 8,
    aroundCenter: false,
    transformRequest: (url, resourceType) => {
        // No custom headers to avoid CORS preflight failures on tile servers
    }
});

// Double right-click capture to reset orientation and right-click drag cursor (grabbing hand)
let isRightClickDragging = false;

map.getCanvasContainer().addEventListener('mousedown', (e) => {
    if (e.button === 2) { // Right mouse button
        isRightClickDragging = true;
        document.body.classList.add('right-click-dragging');
    }
});

window.addEventListener('mouseup', (e) => {
    if (isRightClickDragging) {
        isRightClickDragging = false;
        document.body.classList.remove('right-click-dragging');
    }
});


// Enable native right-click tilt/rotate controls (MapLibre's built-in dragRotate is highly optimized)
map.dragRotate.enable();
map.touchZoomRotate.enable(); // No 'around: center' — use finger midpoint for pinch zoom/rotate
map.scrollZoom.enable({ around: 'center' }); // Zoom around center to bypass expensive 3D terrain raycast intersections on scroll

// Middle-click popup helper
let middleClickStartX = null, middleClickStartY = null;

function buildRasterStyle(tileUrl) {
    const tiles = Array.isArray(tileUrl) ? tileUrl : [tileUrl];
    const isLight = document.body.classList.contains('light-mode') || localStorage.getItem('route_theme') === 'light';
    return {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
            basemap: {
                type: 'raster',
                tiles: tiles,
                tileSize: 256,
                maxzoom: 20
            }
        },
        layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': isLight ? '#ffffff' : '#111111' } },
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

function isTransitPoint(idx) {
    if (!waypointPathIndices || waypointPathIndices.length < 2) return false;
    for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
        if (segmentModes[segI] === 'transit') {
            if (idx > waypointPathIndices[segI] && idx < waypointPathIndices[segI + 1]) {
                return true;
            }
        }
    }
    return false;
}

function isTransitBoundary(idx) {
    if (!waypointPathIndices || waypointPathIndices.length < 2) return false;
    for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
        if (segmentModes[segI] === 'transit') {
            if (idx === waypointPathIndices[segI] || idx === waypointPathIndices[segI + 1]) {
                return true;
            }
        }
    }
    return false;
}

function isTransitSegment(idx) {
    if (!waypointPathIndices || waypointPathIndices.length < 2) return false;
    for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
        if (segmentModes[segI] === 'transit') {
            if (idx >= waypointPathIndices[segI] && idx < waypointPathIndices[segI + 1]) {
                return true;
            }
        }
    }
    return false;
}

function getSegmentModeAtPoint(idx) {
    if (!waypointPathIndices || waypointPathIndices.length < 2) return currentRoutingMode;
    for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
        if (idx >= waypointPathIndices[segI] && idx < waypointPathIndices[segI + 1]) {
            return segmentModes[segI] || currentRoutingMode;
        }
    }
    return segmentModes[segmentModes.length - 1] || currentRoutingMode;
}


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
    toggleStats: 'r',
    reverse: 'v',
    deleteLast: 'backspace',
    resetOrientation: 'n',
    centerLocation: 'c',
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
function getKeyLabel(actionKey) {
    const k = currentKeybindings[actionKey];
    if (!k) return '';
    return k.length === 1 ? k.toUpperCase() : (k.charAt(0).toUpperCase() + k.slice(1));
}

function updateAllButtonTooltips() {
    const setTooltip = (id, baseText, actionKey) => {
        const el = document.getElementById(id);
        if (!el) return;
        const keyLabel = getKeyLabel(actionKey);
        const text = keyLabel ? `${baseText} (${keyLabel})` : baseText;
        if (el.hasAttribute('data-tooltip')) {
            el.setAttribute('data-tooltip', text);
        } else {
            el.setAttribute('title', text);
        }
    };

    setTooltip('total-distance', 'Click to view detailed route statistics', 'toggleStats');
    setTooltip('search-toggle', 'Search locations', 'search');
    setTooltip('fit-route-btn', 'Fit route', 'fitRoute');
    setTooltip('reverse-route-btn', 'Reverse route', 'reverse');
    setTooltip('current-location-btn', 'Center on current location', 'centerLocation');
    setTooltip('reset-orientation-btn', 'Reset orientation', 'resetOrientation');
    setTooltip('elevation-toggle-btn', 'Toggle elevation profile', 'toggleElevation');
    setTooltip('settings-btn', 'Open settings', 'toggleSettings');

    const modeKey = getKeyLabel('toggleMode');
    const bikeBtn = document.getElementById('mode-bike');
    if (bikeBtn) {
        const text = modeKey ? `Cycling (Paved routes) (${modeKey})` : 'Cycling (Paved routes)';
        if (bikeBtn.hasAttribute('data-tooltip')) bikeBtn.setAttribute('data-tooltip', text);
        else bikeBtn.setAttribute('title', text);
    }
    const directBtn = document.getElementById('mode-direct');
    if (directBtn) {
        const text = modeKey ? `Direct (Straight line) (${modeKey})` : 'Direct (Straight line)';
        if (directBtn.hasAttribute('data-tooltip')) directBtn.setAttribute('data-tooltip', text);
        else directBtn.setAttribute('title', text);
    }
    const hikeBtn = document.getElementById('mode-hike');
    if (hikeBtn) {
        const text = modeKey ? `Hiking/MTB (Allow unpaved) (${modeKey})` : 'Hiking/MTB (Allow unpaved)';
        if (hikeBtn.hasAttribute('data-tooltip')) hikeBtn.setAttribute('data-tooltip', text);
        else hikeBtn.setAttribute('title', text);
    }
    const transitBtn = document.getElementById('mode-transit');
    if (transitBtn) {
        const text = modeKey ? `Gap (Skip segment) (${modeKey})` : 'Gap (Skip segment)';
        if (transitBtn.hasAttribute('data-tooltip')) transitBtn.setAttribute('data-tooltip', text);
        else transitBtn.setAttribute('title', text);
    }
}

function loadKeybindings() {
    const saved = getCookie('route_keybindings');
    if (saved) {
        try { currentKeybindings = { ...DEFAULT_KEYBINDINGS, ...JSON.parse(saved) }; } catch (e) { }
    }
    updateAllButtonTooltips();
}
loadKeybindings();


// Chart and elevation update state — declared here to avoid TDZ errors when
// map.on('load') fires and immediately triggers updateElevationProfile
let elevationChart = null;
let isUpdatingElevation = false;
let currentElevationQueryId = 0;
let currentHoverDispDist = null;
let currentNavDispDist = null;
let isNavOnRoute = false;
let isLiveNavActive = false;
let isInitialNavCameraSet = false;
let lastVibratedTurnIndex = -1;
let currentHeading = 0;
let lastGpsLngLat = null;
let isZooming = false;
let routeScreenPtsDirty = true;
let bestCiGlobal = -1; // Exported from mousemove for use in dragging
let waypointPathIndices = []; // Indices in currentRouteGeoJSON.coordinates where waypoints reside
let lastSegIdx = -1;
let lastHoverIdx = -1;
let currentRoutingMode = 'bike'; // 'bike' or 'direct'
let currentBaseSpeedKmh = parseFloat(localStorage.getItem('route_base_speed')) || 18;
let routeTurnInstructions = [];

async function snapToNearestRoad(lngLat) {
    const lng = Array.isArray(lngLat) ? lngLat[0] : (lngLat ? lngLat.lng : NaN);
    const lat = Array.isArray(lngLat) ? lngLat[1] : (lngLat ? lngLat.lat : NaN);
    if (isNaN(lng) || isNaN(lat)) return lngLat;
    const endpoints = [
        `https://router.project-osrm.org/nearest/v1/cycling/${lng},${lat}`,
        `https://routing.openstreetmap.de/routed-bike/nearest/v1/bicycle/${lng},${lat}`
    ];
    for (const url of endpoints) {
        try {
            const resp = await fetchWithTimeout(url, null, 2500);
            if (!resp.ok) continue;
            const data = await resp.json();
            if (data.code === 'Ok' && data.waypoints && data.waypoints[0]?.location) {
                const loc = data.waypoints[0].location;
                // Only snap if within 250 meters of a road to avoid jumps
                if ((data.waypoints[0].distance || 0) <= 250) {
                    return [loc[0], loc[1]];
                }
            }
        } catch (_) {
            continue;
        }
    }
    return [lng, lat];
}

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
    if (!currentRouteGeoJSON) { routeScreenPts = null; displayScreenPts = null; return; }
    const coords = currentRouteGeoJSON.coordinates;
    routeScreenPts = coords.map(c => map.project(c));

    if (currentDisplayCoords) {
        displayScreenPts = currentDisplayCoords.map(c => map.project(c));
    } else {
        displayScreenPts = null;
    }
}

let currentDisplayCoords = null; // Miter-corrected display coords, updated by rebuildMapGradient
let displayScreenPts = null; // Screen points of currentDisplayCoords
let rawIndexToDisplayRange = []; // Maps raw coordinates index to [displayStart, displayEnd] indices
let displayIndexToRawIndex = []; // Maps display coordinates index to raw coordinate index
let displayMercatorDistances = []; // Cumulative Mercator distances of displayCoords
let displayMercTotalDist = 0;
let lastHoverTime = 0; // Throttle timestamp for hover events

let isRouteLeftHandDriving = false;

let currentMapColorMode = 'grade'; // 'grade', 'road', or 'surface'
let routeRoadTypes = [];
let routeSurfaceTypes = [];
let isHighPerformance = false;
let currentRouteSegments = [];

const roadColors = {
    cycleway: '#10b981',
    quiet: '#3b82f6',
    track: '#d97706',
    major: '#ef4444',
    other: '#6b7280'
};

const surfaceColors = {
    paved: '#06b6d4',
    unpaved: '#854d0e',
    unknown: '#4b5563'
};

function isLeftHandDriving(lng, lat) {
    // UK & Ireland
    if (lat >= 49.8 && lat <= 60.9 && lng >= -10.5 && lng <= 1.8) return true;
    // Japan
    if (lat >= 24.0 && lat <= 46.0 && lng >= 122.0 && lng <= 146.0) return true;
    // Australia
    if (lat >= -44.0 && lat <= -10.0 && lng >= 112.0 && lng <= 154.0) return true;
    // New Zealand
    if (lat >= -48.0 && lat <= -34.0 && lng >= 166.0 && lng <= 179.0) return true;
    // India, Pakistan, Bangladesh, Nepal, Sri Lanka
    if (lat >= 5.0 && lat <= 37.0 && lng >= 60.0 && lng <= 98.0) return true;
    // Thailand, Malaysia, Singapore, Indonesia
    if (lat >= -11.0 && lat <= 21.0 && lng >= 95.0 && lng <= 141.0) return true;
    // Southern Africa
    if (lat >= -35.0 && lat <= -17.0 && lng >= 11.0 && lng <= 36.0) return true;
    return false;
}

// Fixes the line-offset inside-corner overlap at sharp right turns ONLY.
// For positive line-offset (right side), a right turn puts the offset on the
// inside — the two adjacent offset segments cross. Fix: replace the vertex with
// the exact intersection of the two offset lines (the "miter point"), shortening
// both segments so they meet cleanly. Left turns (outside gap) are untouched.
// Only modifies the display source — currentRouteGeoJSON is never changed.
function miterInsideCorners(coords) {
    if (coords.length < 3 || map.getZoom() < 14) {
        rawIndexToDisplayRange = coords.map((_, i) => [i, i]);
        displayIndexToRawIndex = coords.map((_, i) => i);
        return coords;
    }
    const pxOffset = getPixelOffset(map.getZoom()) * (isRouteLeftHandDriving ? -1 : 1);
    if (Math.abs(pxOffset) < 1.0) { // No visible offset at low zooms
        rawIndexToDisplayRange = coords.map((_, i) => [i, i]);
        displayIndexToRawIndex = coords.map((_, i) => i);
        return coords;
    }

    const result = [coords[0]];
    const mapping = [[0, 0]];
    const toRaw = [0];

    for (let i = 1; i < coords.length - 1; i++) {
        const currentLen = result.length;
        const p2 = coords[i];

        // Never subdivide or displace waypoint pins — the route must reach each waypoint pin directly
        const isWp = waypoints && waypoints.some(wp => haversineDistance(wp, p2) < 2.0);
        if (isWp || isTransitSegment(i - 1) || isTransitSegment(i) || isTransitPoint(i) || isTransitBoundary(i)) {
            result.push(p2);
            mapping.push([currentLen, currentLen]);
            toRaw.push(i);
            continue;
        }

        let prevIdx = i - 1;
        while (prevIdx >= 0 && haversineDistance(coords[prevIdx], p2) < 0.5) prevIdx--;
        if (prevIdx < 0) {
            result.push(p2);
            mapping.push([currentLen, currentLen]);
            toRaw.push(i);
            continue;
        }

        let nextIdx = i + 1;
        while (nextIdx < coords.length && haversineDistance(p2, coords[nextIdx]) < 0.5) nextIdx++;
        if (nextIdx >= coords.length) {
            result.push(p2);
            mapping.push([currentLen, currentLen]);
            toRaw.push(i);
            continue;
        }

        const p1 = coords[prevIdx], p3 = coords[nextIdx];

        // Signed deflection angle. Positive = right turn.
        let d = getBearing(p2, p3) - getBearing(p1, p2);
        while (d > 180) d -= 360;
        while (d < -180) d += 360;

        const latRad = p2[1] * Math.PI / 180;
        const cosLat = Math.cos(latRad);
        const metersPerPx = 78271.51696 * cosLat / Math.pow(2, map.getZoom());
        const distMeters = Math.abs(pxOffset) * metersPerPx;

        // Reserve staples strictly for true dead-end turnarounds (|d| >= 170°).
        // Keep p2 untouched so the route display line reaches coords[i] directly and connects seamlessly to the turnaround staple without a gap.
        if (Math.abs(d) >= 170) {
            result.push(p2);
            mapping.push([currentLen, currentLen]);
            toRaw.push(i);
            continue;
        }

        const isInside = (pxOffset > 0 && d > 0) || (pxOffset < 0 && d < 0);

        // Subdivide sharp turns into two smooth sub-bends around p2:
        // - Inside corners (sharp right turns >= 110°): eliminates inside crossover loops.
        // - Outside corners (sharp left turns >= 120°): bridges the acute outside corner seamlessly.
        // - All turns < 120° (non-sharp left turns and 90° corners): stay completely sharp as untouched single points.
        const shouldSubdivide = (isInside && Math.abs(d) >= 110 && Math.abs(d) < 170) ||
            (!isInside && Math.abs(d) >= 120 && Math.abs(d) < 170);

        if (shouldSubdivide) {
            const d1 = haversineDistance(p1, p2);
            const d2 = haversineDistance(p2, p3);
            const maxMeters = isInside ? Math.max(6 * metersPerPx, distMeters * 1.2) : 3 * metersPerPx;
            const shift1 = Math.min(maxMeters, d1 * (isInside ? 0.8 : 0.4));
            const shift2 = Math.min(maxMeters, d2 * (isInside ? 0.8 : 0.4));

            const r1 = d1 > 0 ? shift1 / d1 : 0;
            const r2 = d2 > 0 ? shift2 / d2 : 0;

            const mPt1 = [
                p2[0] - r1 * (p2[0] - p1[0]),
                p2[1] - r1 * (p2[1] - p1[1])
            ];
            const mPt2 = [
                p2[0] + r2 * (p3[0] - p2[0]),
                p2[1] + r2 * (p3[1] - p2[1])
            ];

            result.push(mPt1);
            result.push(mPt2);
            mapping.push([currentLen, currentLen + 1]);
            toRaw.push(i, i);
            continue;
        }

        // All non-hairpin turns (< 120°) keep p2 untouched so MapLibre renders native crisp miter corners with zero rounding.
        result.push(p2);
        mapping.push([currentLen, currentLen]);
        toRaw.push(i);
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
let _activeExtraGradientLayers = 0;

function cleanupExtraGradientLayers() {
    if (_activeExtraGradientLayers > 0) {
        for (let i = 1; i <= _activeExtraGradientLayers; i++) {
            const layerId = 'route-gradient-layer-' + i;
            const srcId = 'route-gradient-' + i;
            if (map.getLayer(layerId)) map.removeLayer(layerId);
            if (map.getSource(srcId)) map.removeSource(srcId);
        }
        _activeExtraGradientLayers = 0;
    }
}

let _routeGradStops = null;
function rebuildMapGradient() {
    if (!currentRouteGeoJSON || !currentRouteGeoJSON.coordinates || currentRouteGeoJSON.coordinates.length === 0) {
        cleanupExtraGradientLayers();
        return;
    }
    const coords = currentRouteGeoJSON.coordinates;

    const mult = isRouteLeftHandDriving ? -1 : 1;
    const offsetExpression = ['interpolate', ['linear'], ['zoom'], 8, 0, 12, 2 * mult, 15, 4 * mult, 18, 6 * mult, 24, 6 * mult];
    if (map.getLayer('route-gradient-layer')) map.setPaintProperty('route-gradient-layer', 'line-offset', offsetExpression);
    if (map.getLayer('route-line')) map.setPaintProperty('route-line', 'line-offset', offsetExpression);
    if (map.getLayer('route-hover-target')) map.setPaintProperty('route-hover-target', 'line-offset', offsetExpression);
    if (map.getLayer('hover-segment-layer')) map.setPaintProperty('hover-segment-layer', 'line-offset', offsetExpression);

    if (isHighPerformance) {
        cleanupExtraGradientLayers();
        rawIndexToDisplayRange = coords.map((_, i) => [i, i]);
        displayIndexToRawIndex = coords.map((_, i) => i);
        currentDisplayCoords = coords;

        const gradSrc = map.getSource('route-gradient');
        if (gradSrc) gradSrc.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
        const dispSrc = map.getSource('route-display');
        if (dispSrc) dispSrc.setData({ type: 'LineString', coordinates: coords });
        routeScreenPtsDirty = true;

        if (map.getLayer('route-gradient-layer')) {
            map.setPaintProperty('route-gradient-layer', 'line-gradient',
                ['interpolate', ['linear'], ['line-progress'], 0, '#2563eb', 1, '#2563eb']);
        }
        if (map.getSource('turnarounds')) {
            map.getSource('turnarounds').setData({ type: 'FeatureCollection', features: [] });
        }
        return;
    }

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

    // Build route-display geometry without transit gaps so hover targets don't span gaps
    const dispSrc = map.getSource('route-display');
    if (dispSrc) {
        const lineParts = [];
        let curPart = [];
        for (let i = 0; i < displayCoords.length; i++) {
            const rawIdx = (displayIndexToRawIndex && displayIndexToRawIndex[i] !== undefined) ? displayIndexToRawIndex[i] : i;
            if (isTransitSegment(rawIdx)) {
                if (curPart.length > 0 && isTransitBoundary(rawIdx)) {
                    curPart.push(displayCoords[i]);
                }
                if (curPart.length > 1) lineParts.push(curPart);
                curPart = [];
            } else {
                curPart.push(displayCoords[i]);
            }
        }
        if (curPart.length > 1) lineParts.push(curPart);

        if (lineParts.length > 1) {
            dispSrc.setData({ type: 'MultiLineString', coordinates: lineParts });
        } else {
            dispSrc.setData({ type: 'LineString', coordinates: displayCoords });
        }
    }
    routeScreenPtsDirty = true;

    // Partition route into continuous routed sections (omitting transit gaps)
    // Each continuous section gets its own LineString with 100% full-opacity gradient stops,
    // terminating cleanly at its boundary waypoint with zero texture bleed or gap.
    const continuousSections = [];
    if (waypointPathIndices && waypointPathIndices.length >= 2 && segmentModes && segmentModes.includes('transit')) {
        let currentStart = 0;
        for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
            if (segmentModes[segI] === 'transit') {
                if (waypointPathIndices[segI] > currentStart) {
                    continuousSections.push({
                        startRaw: currentStart,
                        endRaw: waypointPathIndices[segI]
                    });
                }
                currentStart = waypointPathIndices[segI + 1];
            }
        }
        if (currentStart < coords.length - 1) {
            continuousSections.push({
                startRaw: currentStart,
                endRaw: coords.length - 1
            });
        }
    } else {
        continuousSections.push({
            startRaw: 0,
            endRaw: coords.length - 1
        });
    }

    const grades = routeGrades;

    for (let sIndex = 0; sIndex < continuousSections.length; sIndex++) {
        const sec = continuousSections[sIndex];
        let dispStart = sec.startRaw;
        let dispEnd = sec.endRaw;
        if (rawIndexToDisplayRange && rawIndexToDisplayRange[sec.startRaw] && rawIndexToDisplayRange[sec.endRaw]) {
            dispStart = rawIndexToDisplayRange[sec.startRaw][0];
            dispEnd = rawIndexToDisplayRange[sec.endRaw][1] ?? rawIndexToDisplayRange[sec.endRaw][0];
        }
        const secDisplayCoords = displayCoords.slice(dispStart, dispEnd + 1);
        if (secDisplayCoords.length < 2) continue;

        let secDist = 0;
        const secMercDists = [0];
        for (let j = 1; j < secDisplayCoords.length; j++) {
            secDist += getMercatorDistance(secDisplayCoords[j - 1], secDisplayCoords[j]);
            secMercDists.push(secDist);
        }

        const secGradStops = [];
        let lastFrac = -1;
        let prevColor = null;

        for (let j = 0; j < secDisplayCoords.length; j++) {
            let frac = Math.min(Math.max(secMercDists[j] / (secDist || 1), 0), 1);
            if (frac <= lastFrac) continue;
            const displayIdx = dispStart + j;
            const rawIdx = (displayIndexToRawIndex && displayIndexToRawIndex[displayIdx] !== undefined) ? displayIndexToRawIndex[displayIdx] : displayIdx;

            let color = 'rgb(34,197,94)';
            if (currentMapColorMode === 'grade' && grades) {
                color = getColorForGrade(grades[Math.min(rawIdx + 1, grades.length - 1)] ?? 0);
            } else if (currentMapColorMode === 'road') {
                const rt = routeRoadTypes[Math.min(rawIdx, routeRoadTypes.length - 1)] || 'other';
                color = roadColors[rt] || '#6b7280';
            } else if (currentMapColorMode === 'surface') {
                const st = routeSurfaceTypes[Math.min(rawIdx, routeSurfaceTypes.length - 1)] || 'unknown';
                color = surfaceColors[st] || '#4b5563';
            }

            if (prevColor !== null && prevColor !== color) {
                const stepDown = Math.max(lastFrac + 0.000001, frac - 0.000001);
                if (stepDown > lastFrac && stepDown < frac) {
                    secGradStops.push(stepDown, prevColor);
                    lastFrac = stepDown;
                }
            }
            secGradStops.push(frac, color);
            lastFrac = frac;
            prevColor = color;
        }

        if (secGradStops.length < 4) {
            const fallbackColor = prevColor || 'rgb(34,197,94)';
            secGradStops.length = 0;
            secGradStops.push(0, fallbackColor, 1, fallbackColor);
        }

        const srcId = sIndex === 0 ? 'route-gradient' : 'route-gradient-' + sIndex;
        const layerId = sIndex === 0 ? 'route-gradient-layer' : 'route-gradient-layer-' + sIndex;

        if (sIndex === 0) {
            const gradSrc = map.getSource(srcId);
            if (gradSrc) gradSrc.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: secDisplayCoords } });
            if (map.getLayer(layerId)) {
                map.setPaintProperty(layerId, 'line-gradient',
                    ['interpolate', ['linear'], ['line-progress'], ...secGradStops]);
                map.setPaintProperty(layerId, 'line-offset', offsetExpression);
            }
        } else {
            if (!map.getSource(srcId)) {
                map.addSource(srcId, {
                    type: 'geojson',
                    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: secDisplayCoords } },
                    lineMetrics: true,
                    maxzoom: 24,
                    buffer: 8, tolerance: 0
                });
            } else {
                map.getSource(srcId).setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: secDisplayCoords } });
            }

            if (!map.getLayer(layerId)) {
                map.addLayer({
                    id: layerId,
                    type: 'line',
                    source: srcId,
                    layout: { 'line-join': 'miter', 'line-miter-limit': 4, 'line-cap': 'round' },
                    paint: {
                        'line-color': 'rgb(34,197,94)',
                        'line-width': 5,
                        'line-opacity': 0.97,
                        'line-offset': offsetExpression,
                        'line-gradient': ['interpolate', ['linear'], ['line-progress'], ...secGradStops]
                    }
                }, 'route-line');
            } else {
                map.setPaintProperty(layerId, 'line-gradient',
                    ['interpolate', ['linear'], ['line-progress'], ...secGradStops]);
                map.setPaintProperty(layerId, 'line-offset', offsetExpression);
            }
        }
    }

    // Clean up any extra section layers from previous routes with more transit segments
    for (let k = continuousSections.length; k <= _activeExtraGradientLayers; k++) {
        if (k === 0) continue;
        const layerId = 'route-gradient-layer-' + k;
        const srcId = 'route-gradient-' + k;
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(srcId)) map.removeSource(srcId);
    }
    _activeExtraGradientLayers = Math.max(0, continuousSections.length - 1);

    updateTurnaroundJoins();
    updateAngleDebugDisplay();
}

// Show the bold gradient hover highlight for the waypoint segment containing route index ci.
function showHoverSegment(ci) {
    if (!currentRouteGeoJSON || !waypointPathIndices || waypointPathIndices.length < 2) return;
    let segIdx = -1;
    for (let j = 0; j < waypointPathIndices.length - 1; j++) {
        if (ci >= waypointPathIndices[j] && ci <= waypointPathIndices[j + 1]) { segIdx = j; break; }
    }
    if (segIdx === -1 || segIdx === lastSegIdx) return;
    if (segmentModes[segIdx] === 'transit') {
        if (map.getLayer('hover-segment-layer')) {
            map.setLayoutProperty('hover-segment-layer', 'visibility', 'none');
        }
        return;
    }
    lastSegIdx = segIdx;
    const startIndex = waypointPathIndices[segIdx];
    const endIndex = waypointPathIndices[segIdx + 1];

    let subCoords;
    let displayStart = 0;
    let displayEnd = 0;
    if (rawIndexToDisplayRange && rawIndexToDisplayRange[startIndex] && rawIndexToDisplayRange[endIndex] && currentDisplayCoords) {
        displayStart = rawIndexToDisplayRange[startIndex][0];
        displayEnd = rawIndexToDisplayRange[endIndex][1] ?? rawIndexToDisplayRange[endIndex][0];
        subCoords = currentDisplayCoords.slice(displayStart, displayEnd + 1);
    } else {
        subCoords = currentDisplayCoords ? currentDisplayCoords.slice(startIndex, endIndex + 1) : currentRouteGeoJSON.coordinates.slice(startIndex, endIndex + 1);
    }

    const segMode = segmentModes[segIdx] || 'bike';
    const stops = ['interpolate', ['linear'], ['line-progress']];
    if (segMode === 'transit') {
        stops.push(0, '#94a3b8', 1, '#94a3b8');
    } else if (isHighPerformance) {
        stops.push(0, '#2563eb', 1, '#2563eb');
    } else if (routeGrades && displayMercatorDistances && displayMercTotalDist > 0 && subCoords) {
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
    if (map.getLayer('hover-segment-layer')) {
        map.setLayoutProperty('hover-segment-layer', 'visibility', 'none');
    }
    map.getSource('hover-segment')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: subCoords } });
    map.setPaintProperty('hover-segment-layer', 'line-gradient', stops);
    requestAnimationFrame(() => {
        if (map.getLayer('hover-segment-layer')) {
            map.setLayoutProperty('hover-segment-layer', 'visibility', 'visible');
        }
    });
    window.activeHoverStart = startIndex;
    window.activeHoverEnd = endIndex;
    updateTurnaroundJoins();

    // Inclusive range: corner at a waypoint boundary (idx >= startIndex && idx <= endIndex)
    // is included whenever hovering either the approach segment or departure segment.
    map.setFilter('turnaround-highlight-layer', ['all', ['>=', ['get', 'idx'], startIndex], ['<=', ['get', 'idx'], endIndex]]);
    map.setFilter('turnaround-layer', ['any', ['<', ['get', 'idx'], startIndex], ['>', ['get', 'idx'], endIndex]]);
}

function offsetLatLng(lngLat, offsetMeters, bearingDegrees) {
    const lat = lngLat[1];
    const lng = lngLat[0];
    const brng = bearingDegrees * Math.PI / 180;

    // Degrees per meter
    const latDegPerMeter = 1.0 / 111320.0;
    const lngDegPerMeter = 1.0 / (111320.0 * Math.cos(lat * Math.PI / 180));

    const dLat = offsetMeters * Math.cos(brng) * latDegPerMeter;
    const dLng = offsetMeters * Math.sin(brng) * lngDegPerMeter;

    return [lng + dLng, lat + dLat];
}

function updateTurnaroundJoins() {
    if (!currentRouteGeoJSON || !map.getSource('turnarounds')) return;

    const zoom = map.getZoom();
    if (zoom < 14) {
        map.getSource('turnarounds').setData({ type: 'FeatureCollection', features: [] });
        return;
    }

    const coords = currentRouteGeoJSON.coordinates;
    const mult = isRouteLeftHandDriving ? -1 : 1;
    const pxOffset = getPixelOffset(zoom) * mult;

    const turns = [];
    for (let i = 1; i < coords.length - 1; i++) {
        if (isTransitSegment(i - 1) || isTransitSegment(i) || isTransitPoint(i) || isTransitBoundary(i)) continue;
        // Find preceding coordinate at least 0.5 meter away from coords[i]
        let prevIdx = i - 1;
        while (prevIdx >= 0 && haversineDistance(coords[prevIdx], coords[i]) < 0.5) {
            prevIdx--;
        }
        if (prevIdx < 0) continue;

        // Find succeeding coordinate at least 0.5 meter away from coords[i]
        let nextIdx = i + 1;
        while (nextIdx < coords.length && haversineDistance(coords[i], coords[nextIdx]) < 0.5) {
            nextIdx++;
        }
        if (nextIdx >= coords.length) continue;

        const bIn = getBearing(coords[prevIdx], coords[i]);
        const bOut = getBearing(coords[i], coords[nextIdx]);

        // Signed deflection: positive = right turn, negative = left turn
        let d = bOut - bIn;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;

        // Reserve staples strictly for true dead-end turnarounds (|d| >= 170°)
        if (Math.abs(d) < 170) continue;

        const latRad = coords[i][1] * Math.PI / 180;
        const metersPerPixel = 78271.51696 * Math.cos(latRad) / Math.pow(2, zoom);

        // Check if this turnaround is currently in the active hovered segment
        const isHovered = (window.activeHoverStart !== undefined && window.activeHoverStart !== -1 && i > window.activeHoverStart && i <= window.activeHoverEnd);

        let turnColor = 'rgb(34,197,94)';
        if (currentMapColorMode === 'grade') {
            turnColor = routeGrades ? getColorForGrade(routeGrades[Math.min(i + 1, routeGrades.length - 1)] ?? 0) : 'rgb(34,197,94)';
        } else if (currentMapColorMode === 'road') {
            const rt = routeRoadTypes[Math.min(i, routeRoadTypes.length - 1)] || 'other';
            turnColor = roadColors[rt] || '#6b7280';
        } else if (currentMapColorMode === 'surface') {
            const st = routeSurfaceTypes[Math.min(i, routeSurfaceTypes.length - 1)] || 'unknown';
            turnColor = surfaceColors[st] || '#4b5563';
        }

        const offsetDist = Math.abs(pxOffset) * metersPerPixel;
        const p1 = offsetLatLng(coords[i], offsetDist, bIn + 90 * mult);
        const p2 = offsetLatLng(coords[i], offsetDist, bOut + 90 * mult);

        turns.push({
            type: 'Feature',
            properties: {
                idx: i,
                color: turnColor
            },
            geometry: {
                type: 'LineString',
                coordinates: [p1, p2]
            }
        });
    }
    map.getSource('turnarounds').setData({ type: 'FeatureCollection', features: turns });
}

// ─── Localhost Turn Angle Debugger ─────────────────────────────────────────
let isAngleDebugMode = false;

function updateAngleDebugDisplay() {
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '0.0.0.0';
    if (!map || !map.getSource('debug-angles')) return;

    if (!isAngleDebugMode || !isLocalhost || !currentRouteGeoJSON) {
        map.getSource('debug-angles').setData({ type: 'FeatureCollection', features: [] });
        return;
    }

    const coords = currentRouteGeoJSON.coordinates;
    const features = [];

    for (let i = 1; i < coords.length - 1; i++) {
        let prevIdx = i - 1;
        while (prevIdx >= 0 && haversineDistance(coords[prevIdx], coords[i]) < 0.5) prevIdx--;
        if (prevIdx < 0) continue;

        let nextIdx = i + 1;
        while (nextIdx < coords.length && haversineDistance(coords[i], coords[nextIdx]) < 0.5) nextIdx++;
        if (nextIdx >= coords.length) continue;

        const bIn = getBearing(coords[prevIdx], coords[i]);
        const bOut = getBearing(coords[i], coords[nextIdx]);

        let d = bOut - bIn;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;

        if (Math.abs(d) < 0.5) continue; // Skip straight lines (< 0.5 deg)

        const roundedD = Math.round(d);
        const signStr = d > 0 ? '+' : '';
        const label = `${signStr}${roundedD}°`;

        // Color coding: Red (#ef4444) for Right turns (+), Blue (#3b82f6) for Left turns (-)
        const color = d > 0 ? '#ef4444' : '#3b82f6';

        features.push({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: coords[i]
            },
            properties: {
                label: label,
                color: color
            }
        });
    }

    map.getSource('debug-angles').setData({
        type: 'FeatureCollection',
        features: features
    });
}




function getBearing(from, to) {
    const lat1 = from[1] * Math.PI / 180, lat2 = to[1] * Math.PI / 180;
    const dLng = (to[0] - from[0]) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(y, x) * 180 / Math.PI;
}

const pinSvg = (color, text = '', strokeWidth = 1, height = 34) => {
    const path = text
        ? `M12 0C5.37 0 0 5.37 0 12c0 9 12 20 12 20s12-11 12-20c0-6.63-5.37-12-12-12z`
        : `M12 0C5.37 0 0 5.37 0 12c0 9 12 20 12 20s12-11 12-20c0-6.63-5.37-12-12-12zm0 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="${height}" viewBox="-1 -1 26 ${height + 1}">
    <path d="${path}" fill="${color}" fill-rule="evenodd" stroke="white" stroke-width="${strokeWidth}" stroke-linejoin="round" />
    <text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" fill="white" font-size="13px" font-family="Arial, sans-serif" font-weight="bold">${text}</text>
</svg>`;
};

const circleSvg = (color, text = '', strokeWidth = 1, height = 22) => {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="${height}" viewBox="0 0 22 ${height}">
    <circle cx="11" cy="11" r="8.5" fill="${color}" stroke="white" stroke-width="${strokeWidth}" />
    ${text ? `<text x="11" y="10.5" text-anchor="middle" dominant-baseline="central" fill="white" font-size="11px" font-family="Arial, sans-serif" font-weight="bold">${text}</text>` : ''}
</svg>`;
};

const flagSvg = (color, text = '', isGraphIcon = false) => {
    if (isGraphIcon) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="66" viewBox="0 0 50 66">
    <line x1="26" y1="2" x2="26" y2="33" stroke="white" stroke-width="4" stroke-linecap="round" />
    <line x1="26" y1="2" x2="26" y2="33" stroke="${color}" stroke-width="2" stroke-linecap="round" />
    <circle cx="26" cy="2" r="1.5" fill="${color}" stroke="white" stroke-width="1" />
    <path d="M26 4 H46 V19 H26 Z" fill="${color}" stroke="white" stroke-width="1" stroke-linejoin="round" />
    ${text ? `<text x="36" y="11.5" text-anchor="middle" dominant-baseline="central" fill="white" font-size="10px" font-family="Arial, sans-serif" font-weight="bold">${text}</text>` : ''}
</svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="-1 -1 28 36">
    <line x1="4" y1="2" x2="4" y2="33" stroke="white" stroke-width="4" stroke-linecap="round" />
    <line x1="4" y1="2" x2="4" y2="33" stroke="${color}" stroke-width="2" stroke-linecap="round" />
    <circle cx="4" cy="2" r="1.5" fill="${color}" stroke="white" stroke-width="1" />
    <path d="M4 4 H24 V19 H4 Z" fill="${color}" stroke="white" stroke-width="1" stroke-linejoin="round" />
    ${text ? `<text x="14" y="11.5" text-anchor="middle" dominant-baseline="central" fill="white" font-size="10px" font-family="Arial, sans-serif" font-weight="bold">${text}</text>` : ''}
</svg>`;
};

function getDirectDistanceMeters(coord1, coord2) {
    if (!coord1 || !coord2) return 0;
    const R = 6371000;
    const dLat = (coord2[1] - coord1[1]) * Math.PI / 180;
    const dLng = (coord2[0] - coord1[0]) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(coord1[1] * Math.PI / 180) * Math.cos(coord2[1] * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function showLongSegmentDialog(miles, km) {
    return new Promise((resolve) => {
        const modal = document.getElementById('long-segment-modal');
        const msg = document.getElementById('long-segment-msg');
        const btnCancel = document.getElementById('long-segment-cancel');
        const btnConfirm = document.getElementById('long-segment-confirm');

        if (!modal || !btnCancel || !btnConfirm) {
            return resolve(true);
        }

        if (msg) {
            msg.textContent = `This segment is ~${miles} miles (~${km} km) and may be too long to load correctly. Continue?`;
        }

        modal.style.display = 'flex';

        const cleanup = (result) => {
            modal.style.display = 'none';
            btnCancel.onclick = null;
            btnConfirm.onclick = null;
            window.removeEventListener('keydown', onKeyDown);
            resolve(result);
        };

        const onKeyDown = (e) => {
            if (e.key === 'Escape') cleanup(false);
            if (e.key === 'Enter') cleanup(true);
        };

        btnCancel.onclick = () => cleanup(false);
        btnConfirm.onclick = () => cleanup(true);
        window.addEventListener('keydown', onKeyDown);
    });
}

async function checkLongSegmentWarning(idx) {
    if (waypoints.length < 2) return true;

    const LIMIT_METERS = 250 * 1609.344; // 250 miles = 402,336m
    let maxSegmentMeters = 0;

    if (idx > 0 && waypoints[idx - 1] && waypoints[idx]) {
        if (segmentModes[idx - 1] !== 'transit') {
            const d = getDirectDistanceMeters(waypoints[idx - 1], waypoints[idx]);
            if (d > maxSegmentMeters) maxSegmentMeters = d;
        }
    }
    if (idx < waypoints.length - 1 && waypoints[idx] && waypoints[idx + 1]) {
        if (segmentModes[idx] !== 'transit') {
            const d = getDirectDistanceMeters(waypoints[idx], waypoints[idx + 1]);
            if (d > maxSegmentMeters) maxSegmentMeters = d;
        }
    }

    if (maxSegmentMeters <= LIMIT_METERS) {
        return true;
    }

    const miles = Math.round(maxSegmentMeters / 1609.344);
    const km = Math.round(maxSegmentMeters / 1000);

    const approved = await showLongSegmentDialog(miles, km);
    return approved;
}

function createMarkerIcon(index, total) {
    const waypointStyle = localStorage.getItem('route_waypoint_style') || 'circle';
    if (waypointStyle === 'circle') {
        if (index === 0) return circleSvg('#22c55e', '', 1); // Green Start
        if (index === total - 1) return circleSvg('#ef4444', '', 1); // Red Finish
        return circleSvg('#1f2937', index, 1); // Dark Grey Numbered Circle
    } else if (waypointStyle === 'flag') {
        if (index === 0) return flagSvg('#22c55e', ''); // Green Start Flag
        if (index === total - 1) return flagSvg('#ef4444', ''); // Red Finish Flag
        return flagSvg('#1f2937', index); // Dark Grey Numbered Flag
    } else {
        if (index === 0) return pinSvg('#22c55e'); // Green Start
        if (index === total - 1) return pinSvg('#ef4444'); // Red Finish
        return pinSvg('#1f2937', index); // Dark Grey Numbered Pin
    }
}

function clearWpIconsCache() {
    for (const key in wpIcons) {
        delete wpIcons[key];
    }
}

const wpIcons = {}; // Cache for Chart.js waypoint icons

function getWpIconImage(index, total) {
    const waypointStyle = localStorage.getItem('route_waypoint_style') || 'circle';
    const key = `${index}-${total}-${waypointStyle}`;
    if (wpIcons[key] && wpIcons[key].complete) return wpIcons[key];

    const img = new Image();
    img.onload = () => {
        if (elevationChart) {
            elevationChart.update('none');
        }
    };
    let svg;
    if (waypointStyle === 'circle') {
        svg = circleSvg(
            index === 0 ? '#22c55e' : (index === total - 1 ? '#ef4444' : '#1f2937'),
            index === 0 || index === total - 1 ? '' : index,
            1, // 1px white stroke
            48 // Height of 48px offsets the 11px radius circle up by 13px (radius + 2px)
        );
    } else if (waypointStyle === 'flag') {
        svg = flagSvg(
            index === 0 ? '#22c55e' : (index === total - 1 ? '#ef4444' : '#1f2937'),
            index === 0 || index === total - 1 ? '' : index,
            true // isGraphIcon = true
        );
    } else {
        // Standard pin with height 72px offsets the 34px pin up by 19px (17px + 2px)
        svg = pinSvg(
            index === 0 ? '#22c55e' : (index === total - 1 ? '#ef4444' : '#1f2937'),
            index === 0 || index === total - 1 ? '' : index,
            1,
            72
        );
    }

    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    wpIcons[key] = img;
    return img;
}

const hoverInfoEl = document.createElement('div');
hoverInfoEl.id = 'hover-info';

// Lightweight DOM-based hover circle element to avoid WebGL state flushes
const hoverCircleEl = document.createElement('div');
hoverCircleEl.id = 'hover-circle-dom';

let dragGuideSvgEl = null;
let dragGuidePathEl = null;

function ensureDragGuideSVGAppended() {
    if (!dragGuideSvgEl && map) {
        const container = (map.getCanvasContainer && map.getCanvasContainer()) || (map.getContainer && map.getContainer()) || document.getElementById('map');
        if (container) {
            dragGuideSvgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            dragGuideSvgEl.id = 'drag-guide-svg-overlay';
            dragGuideSvgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;display:none;';

            dragGuidePathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            dragGuidePathEl.setAttribute('fill', 'none');
            dragGuidePathEl.setAttribute('stroke', 'rgba(148, 163, 184, 0.65)');
            dragGuidePathEl.setAttribute('stroke-width', '2.5');
            dragGuidePathEl.setAttribute('stroke-linecap', 'round');
            dragGuidePathEl.setAttribute('stroke-linejoin', 'round');

            dragGuideSvgEl.appendChild(dragGuidePathEl);
            if (container.firstChild) {
                container.insertBefore(dragGuideSvgEl, container.firstChild);
            } else {
                container.appendChild(dragGuideSvgEl);
            }
        }
    }
}

function updateDragGuideSVG(currentLngLat, prevWp, nextWp) {
    ensureDragGuideSVGAppended();
    if (!dragGuideSvgEl || !dragGuidePathEl || !map) return;

    const currCoords = Array.isArray(currentLngLat) ? currentLngLat : [currentLngLat.lng, currentLngLat.lat];
    const currPt = map.project(currCoords);
    let d = '';

    if (prevWp) {
        const p1 = map.project(prevWp);
        d += `M ${p1.x} ${p1.y} L ${currPt.x} ${currPt.y}`;
    }
    if (nextWp) {
        const p2 = map.project(nextWp);
        if (!d) d += `M ${currPt.x} ${currPt.y}`;
        d += ` L ${p2.x} ${p2.y}`;
    }

    if (d) {
        dragGuidePathEl.setAttribute('d', d);
        dragGuideSvgEl.style.display = 'block';
    } else {
        dragGuideSvgEl.style.display = 'none';
    }
}

function hideDragGuideSVG() {
    if (dragGuideSvgEl) {
        dragGuideSvgEl.style.display = 'none';
    }
}

function ensureHoverElementsAppended() {
    if (!hoverInfoEl.parentNode && map) {
        const container = (map.getCanvasContainer && map.getCanvasContainer()) || (map.getContainer && map.getContainer()) || document.getElementById('map');
        if (container) {
            container.appendChild(hoverInfoEl);
            container.appendChild(hoverCircleEl);
        }
    }
}

function showHoverMarker(lngLat, info) {
    ensureHoverElementsAppended();
    let pt;
    if (lngLat && typeof lngLat.x === 'number' && typeof lngLat.y === 'number') {
        pt = lngLat;
    } else if (map && typeof map.project === 'function') {
        const coords = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
        pt = map.project(coords);
    } else {
        return;
    }

    // Position DOM hover circle
    hoverCircleEl.style.left = pt.x + 'px';
    hoverCircleEl.style.top = pt.y + 'px';
    hoverCircleEl.style.display = 'block';

    // Position the info label
    if (info) {
        hoverInfoEl.innerHTML = info;
        hoverInfoEl.style.left = pt.x + 'px';
        hoverInfoEl.style.top = pt.y + 'px';
        hoverInfoEl.style.display = 'block';
    }
}
function hideHoverMarker() {
    // Exit early if hover elements are already hidden to prevent expensive flushes on drag/pan/zoom start
    if (hoverCircleEl.style.display === 'none' && hoverInfoEl.style.display === 'none') {
        return;
    }
    currentHoverDispDist = null;
    if (elevationChart) {
        try {
            elevationChart.setActiveElements([]);
            if (elevationChart.tooltip) elevationChart.tooltip.setActiveElements([]);
            elevationChart.update('none');
        } catch (err) { }
    }
    lastSegIdx = -1;
    map.getSource('hover-segment')?.setData({ type: 'FeatureCollection', features: [] });
    if (map.isStyleLoaded()) {
        try {
            if (map.getLayer('turnaround-highlight-layer')) map.setFilter('turnaround-highlight-layer', ['==', ['get', 'idx'], -1]);
            if (map.getLayer('turnaround-layer')) map.setFilter('turnaround-layer', null);
        } catch (_) {}
    }
    window.activeHoverStart = -1;
    window.activeHoverEnd = -1;
    updateTurnaroundJoins();

    hoverCircleEl.style.display = 'none';
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
    const hasRoute = waypoints.length >= 2;
    const shareBtn = document.getElementById('share-route-btn');
    const dlBtn = document.getElementById('gpx-download-btn');
    if (shareBtn) shareBtn.disabled = !hasRoute;
    if (dlBtn) dlBtn.disabled = !hasRoute;

    if (!hasRoute) {
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

function parseRoadTypes(segments) {
    let stats = {
        road: {
            cycleway: 0,
            track: 0,
            quiet: 0,
            major: 0,
            other: 0
        },
        surface: {
            paved: 0,
            unpaved: 0,
            unknown: 0
        }
    };

    let totalDist = 0;

    segments.forEach(seg => {
        if (seg.isTransit || seg.dist <= 0) return; // Skip transit gap segments
        if (!seg.messages || seg.messages.length < 2) {
            stats.road.other += seg.dist;
            stats.surface.unknown += seg.dist;
            totalDist += seg.dist;
            return;
        }

        const firstMsg = seg.messages[0];
        const header = Array.isArray(firstMsg) ? firstMsg : (typeof firstMsg === 'string' ? firstMsg.split('\t') : null);

        if (!header) {
            stats.road.other += seg.dist;
            stats.surface.unknown += seg.dist;
            totalDist += seg.dist;
            return;
        }

        let tagsIdx = header.indexOf('WayTags');
        if (tagsIdx === -1) tagsIdx = header.indexOf('Tags');
        const distIdx = header.indexOf('Distance');

        if (tagsIdx === -1 || distIdx === -1) {
            stats.road.other += seg.dist;
            stats.surface.unknown += seg.dist;
            totalDist += seg.dist;
            return;
        }

        let lastTags = '';
        for (let i = 1; i < seg.messages.length; i++) {
            const rowVal = seg.messages[i];
            const row = Array.isArray(rowVal) ? rowVal : (typeof rowVal === 'string' ? rowVal.split('\t') : null);
            if (!row || row.length <= Math.max(tagsIdx, distIdx)) continue;

            const dist = parseFloat(row[distIdx]) || 0;
            if (dist <= 0) continue;

            let tags = row[tagsIdx] || '';
            if (tags.trim()) {
                lastTags = tags;
            } else {
                tags = lastTags;
            }
            totalDist += dist;

            let roadType = 'other';
            if (tags.includes('highway=cycleway')) {
                roadType = 'cycleway';
            } else if (tags.includes('highway=track') || tags.includes('highway=path') || tags.includes('highway=footway') || tags.includes('highway=bridleway') || tags.includes('highway=pedestrian')) {
                roadType = 'track';
            } else if (tags.includes('highway=residential') || tags.includes('highway=living_street') || tags.includes('highway=service') || tags.includes('highway=unclassified')) {
                roadType = 'quiet';
            } else if (tags.includes('highway=motorway') || tags.includes('highway=trunk') || tags.includes('highway=primary') || tags.includes('highway=secondary') || tags.includes('highway=tertiary')) {
                roadType = 'major';
            }
            stats.road[roadType] += dist;

            let surfaceType = 'unknown';
            if (tags.includes('surface=asphalt') || tags.includes('surface=concrete') || tags.includes('surface=paved') || tags.includes('surface=paving_stones') || tags.includes('surface=sett') || tags.includes('surface=tarmac')) {
                surfaceType = 'paved';
            } else if (tags.includes('surface=gravel') || tags.includes('surface=fine_gravel') || tags.includes('surface=unpaved') || tags.includes('surface=dirt') || tags.includes('surface=earth') || tags.includes('surface=sand') || tags.includes('surface=ground') || tags.includes('surface=grass') || tags.includes('surface=compacted') || tags.includes('surface=pebblestone') || tags.includes('surface=wood')) {
                surfaceType = 'unpaved';
            }
            stats.surface[surfaceType] += dist;
        }
    });

    return { stats, totalDist };
}

function updateRouteTypesUI(segments) {
    const container = document.getElementById('route-types-panel');
    if (!container) return;

    if (isHighPerformance || !segments || segments.length === 0) {
        container.style.display = 'none';
        return;
    }

    const { stats, totalDist } = parseRoadTypes(segments);
    if (totalDist <= 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';

    const roadBar = document.getElementById('road-class-bar');
    if (!roadBar) return;
    roadBar.innerHTML = '';

    const roadDefs = {
        cycleway: { color: '#10b981', label: 'Cycleway' },
        quiet: { color: '#3b82f6', label: 'Quiet Street' },
        track: { color: '#d97706', label: 'Path / Track' },
        major: { color: '#ef4444', label: 'Major Road' },
        other: { color: '#6b7280', label: 'Other / Direct' }
    };

    const formatDist = (d) => {
        if (currentUnits === 'metric') {
            if (d >= 1000) return `${(d / 1000).toFixed(1)} km`;
            return `${Math.round(d)} m`;
        } else {
            const miles = d * 0.000621371;
            if (miles >= 0.1) return `${miles.toFixed(2)} mi`;
            return `${Math.round(miles * 5280)} ft`;
        }
    };

    // Render Road Bar
    Object.keys(roadDefs).forEach(key => {
        const dist = stats.road[key];
        if (dist <= 0) return;
        const pct = (dist / totalDist) * 100;

        const el = document.createElement('div');
        el.style.width = `${pct}%`;
        el.style.height = '100%';
        el.style.backgroundColor = roadDefs[key].color;
        el.style.transition = 'width 0.3s ease';
        el.title = `${roadDefs[key].label}: ${formatDist(dist)} (${pct.toFixed(0)}%)`;
        roadBar.appendChild(el);
    });

    const updateBarHighlights = () => {
        roadBar.style.outline = currentMapColorMode === 'road' ? '2px solid var(--primary)' : 'none';
    };

    updateBarHighlights();

    roadBar.onclick = (e) => {
        e.stopPropagation();
        if (currentMapColorMode === 'road') {
            currentMapColorMode = 'grade';
        } else {
            currentMapColorMode = 'road';
        }
        updateBarHighlights();
        rebuildMapGradient();
    };
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
        map.addSource('terrain-source', { type: 'raster-dem', tiles: terrainTiles, tileSize: 256, encoding: terrainEncoding, maxzoom: 11 });

    if (!map.getSource('hillshade-source'))
        map.addSource('hillshade-source', { type: 'raster-dem', tiles: terrainTiles, tileSize: 256, encoding: terrainEncoding, maxzoom: 11 });

    if (!map.getLayer('hillshade-layer'))
        map.addLayer({ id: 'hillshade-layer', type: 'hillshade', source: 'hillshade-source', paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': 'rgba(0,0,0,0.5)', 'hillshade-highlight-color': 'rgba(255,255,255,0.1)' }, layout: { visibility: 'none' } });

    // Route sources (Removed tolerance:0 to allow MapLibre to simplify geometry based on zoom level)
    if (!map.getSource('route'))
        map.addSource('route', { type: 'geojson', data: { type: 'LineString', coordinates: [] } });
    if (!map.getSource('route-segments'))
        map.addSource('route-segments', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // Single LineString with lineMetrics:true — required for line-gradient paint.
    let gradData = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
    if (currentRouteGeoJSON) {
        gradData.geometry.coordinates = currentDisplayCoords || currentRouteGeoJSON.coordinates;
    }

    if (!map.getSource('route-gradient'))
        map.addSource('route-gradient', {
            type: 'geojson',
            data: gradData,
            lineMetrics: true,
            maxzoom: 24,
            buffer: 8, tolerance: 0
        });

    if (!map.getSource('route-display'))
        map.addSource('route-display', {
            type: 'geojson',
            data: { type: 'LineString', coordinates: [] },
            maxzoom: 24,
            buffer: 8, tolerance: 0
        });

    if (!map.getLayer('route-gradient-layer'))
        map.addLayer({
            id: 'route-gradient-layer',
            type: 'line',
            source: 'route-gradient',
            layout: { 'line-join': 'miter', 'line-miter-limit': 4, 'line-cap': 'round' },
            paint: {
                'line-color': 'rgb(34,197,94)',
                'line-width': 5,
                'line-opacity': 0.97,
                'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgb(34,197,94)', 1, 'rgb(34,197,94)'],
                'line-offset': ['interpolate', ['linear'], ['zoom'], 8, 0, 12, 2, 15, 4, 18, 6, 24, 6]
            }
        });

    // Off-route dynamic guidance arrow pointing from user location dot to closest point on route
    if (!map.getSource('nav-offroute-arrow-source')) {
        map.addSource('nav-offroute-arrow-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    if (!map.getLayer('nav-offroute-arrow-line')) {
        map.addLayer({
            id: 'nav-offroute-arrow-line',
            type: 'line',
            source: 'nav-offroute-arrow-source',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': '#ef4444',
                'line-width': 3.5,
                'line-opacity': 0.9
            }
        });
    }

    // Transparent interaction layer (hit target for drag, finger cursor)
    if (!map.getLayer('route-line'))
        map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route-display',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': '#000',
                'line-width': 20,
                'line-opacity': 0,
                'line-offset': ['interpolate', ['linear'], ['zoom'], 8, 0, 12, 2, 15, 4, 18, 6, 24, 6]
            }
        });

    // Invisible wide hover target (for distance/elev snapping, zero visual impact)
    if (!map.getLayer('route-hover-target'))
        map.addLayer({
            id: 'route-hover-target',
            type: 'line',
            source: 'route-display',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': '#000',
                'line-width': 100,
                'line-opacity': 0,
                'line-offset': ['interpolate', ['linear'], ['zoom'], 8, 0, 12, 2, 15, 4, 18, 6, 24, 6]
            }
        });

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
        });
    // Highlight for the active segment being hovered
    if (!map.getSource('hover-segment'))
        map.addSource('hover-segment', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, lineMetrics: true });
    if (!map.getLayer('hover-segment-layer'))
        map.addLayer({
            id: 'hover-segment-layer',
            type: 'line',
            source: 'hover-segment',
            layout: { 'line-join': 'miter', 'line-miter-limit': 4, 'line-cap': 'round' },
            paint: {
                'line-width': 8,
                'line-opacity': 1.0,
                'line-offset': ['interpolate', ['linear'], ['zoom'], 8, 0, 12, 2, 15, 4, 18, 6, 24, 6]
            }
        });

    if (!map.getLayer('turnaround-highlight-layer'))
        map.addLayer({
            id: 'turnaround-highlight-layer',
            type: 'line',
            source: 'turnarounds',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': ['get', 'color'],
                'line-width': 8,
                'line-opacity': 1.0
            },
            filter: ['==', ['get', 'idx'], -1] // Initially hide
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

    // Distance markers layer
    if (!map.getSource('distance-markers-source')) {
        map.addSource('distance-markers-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            maxzoom: 24,
            buffer: 128,
            tolerance: 0
        });
    }
    if (!map.getLayer('distance-markers-layer')) {
        map.addLayer({
            id: 'distance-markers-layer',
            type: 'symbol',
            source: 'distance-markers-source',
            layout: {
                'text-field': ['get', 'text'],
                'text-size': 12,
                'text-font': ['Noto Sans Bold'],
                'text-allow-overlap': true,
                'text-ignore-placement': true
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': '#000000',
                'text-halo-width': 2
            }
        });
    }

    // Debug Turn Angles layer (Localhost only)
    if (!map.getSource('debug-angles')) {
        map.addSource('debug-angles', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    if (!map.getLayer('debug-angles-layer')) {
        map.addLayer({
            id: 'debug-angles-layer',
            type: 'symbol',
            source: 'debug-angles',
            layout: {
                'text-field': ['get', 'label'],
                'text-size': 13,
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-offset': [0, -1.2]
            },
            paint: {
                'text-color': ['get', 'color'],
                'text-halo-color': '#ffffff',
                'text-halo-width': 2
            }
        });
    }

    // Preview pin created as an HTML Marker matching placed waypoints
    // Instantiated once and shown/hidden during drag.
    if (!window._dragPreviewMarker) {
        const pinEl = document.createElement('div');
        pinEl.style.cssText = 'pointer-events:none; opacity:0.9; filter:drop-shadow(0 2px 2px rgba(0,0,0,0.4));';
        window._dragPreviewMarker = new maplibregl.Marker({ element: pinEl, anchor: 'center' })
            .setLngLat([0, 0]);
        window._dragPreviewMarker._pinEl = pinEl;
        updateDragPreviewAppearance(1, 2);
    }

    // Hover circle is handled via lightweight DOM elements to avoid WebGL state flushes
    let isUpdatingRoute = false;
    const originalQueryTerrainElevation = map.queryTerrainElevation ? map.queryTerrainElevation.bind(map) : null;
    if (originalQueryTerrainElevation) {
        map.queryTerrainElevation = function (...args) {
            if (isDraggingMarker || isDraggingLine || isUpdatingRoute) return 0;
            return originalQueryTerrainElevation(...args);
        };
    }


    // Re-upload route data if already computed (e.g. after a style swap)
    if (currentRouteGeoJSON && map.getSource('route')) {
        const coords = currentRouteGeoJSON.coordinates;
        map.getSource('route').setData({ type: 'LineString', coordinates: coords });
        if (map.getSource('route-display')) {
            map.getSource('route-display').setData({ type: 'LineString', coordinates: currentDisplayCoords || coords });
        }
        rebuildMapGradient();
        updateDistanceMarkers();
        updateTurnaroundJoins();
    }
}
let isFirstLoad = true;
let initialBasemapCycled = false;
map.on('style.load', () => {
    setupRouteLayers();
    if (isFirstLoad) {
        loadStoredSettings();
        updateDistanceUI();
        const openedPendingFile = checkPendingNativeRouteFile();
        const openedPendingLocation = checkPendingNativeLocation();
        if (!openedPendingFile && !openedPendingLocation) {
            loadUrlState();
        }
        isFirstLoad = false;
    }

    let lastRebuildZoom = map.getZoom();
    let _lastDistMarkerUpdate = 0;
    const updateView = () => {
        routeScreenPtsDirty = true;
        const currentZoom = map.getZoom();
        if (currentZoom !== lastRebuildZoom) {
            lastRebuildZoom = currentZoom;
            updateTurnaroundJoins();
            rebuildMapGradient(); // Miter point depends on zoom — refresh display coords
        }
        updateDistanceMarkers();

        try {
            const center = map.getCenter();
            localStorage.setItem('last_map_center', JSON.stringify([center.lng, center.lat]));
            localStorage.setItem('last_map_zoom', currentZoom.toString());
        } catch (_) { }
    };
    map.on('moveend', updateView);
    map.on('pitchend', updateView);
    map.on('rotateend', () => { routeScreenPtsDirty = true; });
    map.on('zoom', () => {
        routeScreenPtsDirty = true;
        const now = performance.now();
        if (now - _lastDistMarkerUpdate > 32) {
            _lastDistMarkerUpdate = now;
            updateDistanceMarkers();
        }
    });
    map.on('zoomend', () => {
        isZooming = false;
        updateView();
        updateTurnaroundJoins();
        updateDistanceMarkers();
    });
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

// Change cursor when hovering the route and prime screen coordinates asynchronously/ahead of mousemove
map.on('mouseenter', 'route-line', () => {
    map.getCanvas().style.cursor = 'pointer';
    if (window.innerWidth <= 768) return;
    const coords = currentRouteGeoJSON?.coordinates;
    const dispCoords = currentDisplayCoords || coords;
    if (dispCoords && (routeScreenPtsDirty || !cachedScreenPts)) {
        getCachedScreenPts(dispCoords);
    }
});
map.on('mouseleave', 'route-line', () => {
    if (!isDraggingLine) {
        map.getCanvas().style.cursor = '';
        clearHoverHighlight();
    }
});

function getMiteredOffsetPts(pts, currentOffset) {
    const n = pts.length;
    const offsetPts = new Array(n);
    if (n === 0) return offsetPts;

    const normals = new Array(n - 1);
    const dirs = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!a || !b) {
            normals[i] = null;
            dirs[i] = null;
            continue;
        }
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.1) {
            normals[i] = null;
            dirs[i] = null;
        } else {
            normals[i] = { x: -dy / len, y: dx / len };
            dirs[i] = { x: dx, y: dy, len: len };
        }
    }

    for (let i = 0; i < n; i++) {
        const pt = pts[i];
        if (!pt) {
            offsetPts[i] = null;
            continue;
        }

        if (i === 0) {
            const norm = normals[0];
            if (norm) {
                offsetPts[0] = { x: pt.x + norm.x * currentOffset, y: pt.y + norm.y * currentOffset };
            } else {
                offsetPts[0] = { x: pt.x, y: pt.y };
            }
            continue;
        }

        if (i === n - 1) {
            const norm = normals[n - 2];
            if (norm) {
                offsetPts[n - 1] = { x: pt.x + norm.x * currentOffset, y: pt.y + norm.y * currentOffset };
            } else {
                offsetPts[n - 1] = { x: pt.x, y: pt.y };
            }
            continue;
        }

        const norm1 = normals[i - 1];
        const norm2 = normals[i];
        const dir1 = dirs[i - 1];
        const dir2 = dirs[i];

        if (!norm1 || !norm2 || !dir1 || !dir2) {
            const norm = norm1 || norm2;
            if (norm) {
                offsetPts[i] = { x: pt.x + norm.x * currentOffset, y: pt.y + norm.y * currentOffset };
            } else {
                offsetPts[i] = { x: pt.x, y: pt.y };
            }
            continue;
        }

        const dx1 = dir1.x, dy1 = dir1.y;
        const dx2 = dir2.x, dy2 = dir2.y;
        const cross = dx1 * dy2 - dy1 * dx2;

        if (Math.abs(cross) < 1e-5) {
            offsetPts[i] = { x: pt.x + norm1.x * currentOffset, y: pt.y + norm1.y * currentOffset };
            continue;
        }

        const ax = pt.x + norm1.x * currentOffset;
        const ay = pt.y + norm1.y * currentOffset;
        const bx = pt.x + norm2.x * currentOffset;
        const by = pt.y + norm2.y * currentOffset;

        const t = ((bx - ax) * dy2 - (by - ay) * dx2) / cross;

        const maxShift1 = dir1.len * 0.45;
        const maxShift2 = dir2.len * 0.45;

        let clampedT = t;
        if (clampedT > 0) clampedT = 0;
        if (clampedT < -maxShift1) clampedT = -maxShift1;

        const miterPt = { x: ax + clampedT * dx1, y: ay + clampedT * dy1 };
        offsetPts[i] = miterPt;
    }

    return offsetPts;
}

let cachedScreenPts = null;
let cachedTerrainScreenPts = [];

function fastProjectCoord(coord) {
    if (map && map.transform) {
        if (typeof map.transform.locationToScreenPoint === 'function') {
            return map.transform.locationToScreenPoint(maplibregl.LngLat.convert(coord));
        }
    }
    return map.project(coord);
}

function getCachedScreenPts(dispCoords) {
    if (routeScreenPtsDirty || !cachedScreenPts || cachedScreenPts.length !== dispCoords.length) {
        cachedScreenPts = dispCoords.map(c => fastProjectCoord(c));
        cachedTerrainScreenPts = [];
        routeScreenPtsDirty = false;
    }
    return cachedScreenPts;
}

function findClosestPointOnLine(mousePt) {
    if (!currentRouteGeoJSON) return { bestCi: -1 };
    const coords = currentRouteGeoJSON.coordinates;
    const dispCoords = currentDisplayCoords || coords;
    if (!coords || coords.length === 0) return { bestCi: -1 };

    const screenPts = getCachedScreenPts(dispCoords);

    let bestDistSq = Infinity;
    let bestCost = Infinity;
    let bestCi = -1;
    let bestT = 0;
    let bestProj = { x: 0, y: 0 };

    const zoom = map.getZoom();
    const currentOffset = getPixelOffset(zoom) * (isRouteLeftHandDriving ? -1 : 1);
    const mX = mousePt.x;
    const mY = mousePt.y;
    const hasTerrain = !!(map.getTerrain && map.getTerrain());

    // Step 1: Find candidate segments
    const candidates = [];

    if (hasTerrain) {
        // In 3D terrain mode, mouse coordinates map to geographic coordinates via unproject.
        // Screen-space 2D coordinates on mountains are displaced, but geographic distance is invariant.
        const mouseLngLat = map.unproject([mX, mY]);
        const mLng = mouseLngLat.lng;
        const mLat = mouseLngLat.lat;
        // Search window in geographic degrees (~300m radius depending on zoom)
        const geoMargin = Math.max(0.002, 0.05 / Math.pow(2, Math.max(0, zoom - 10)));

        for (let i = 0; i < dispCoords.length - 1; i++) {
            const rawIdx = (displayIndexToRawIndex && displayIndexToRawIndex[i] !== undefined) ? displayIndexToRawIndex[i] : i;
            if (isTransitSegment(rawIdx)) continue;
            const a = dispCoords[i];
            const b = dispCoords[i + 1];
            if (!a || !b) continue;

            const minLng = (a[0] < b[0] ? a[0] : b[0]) - geoMargin;
            const maxLng = (a[0] > b[0] ? a[0] : b[0]) + geoMargin;
            const minLat = (a[1] < b[1] ? a[1] : b[1]) - geoMargin;
            const maxLat = (a[1] > b[1] ? a[1] : b[1]) + geoMargin;
            if (mLng < minLng || mLng > maxLng || mLat < minLat || mLat > maxLat) continue;

            const midLng = (a[0] + b[0]) * 0.5;
            const midLat = (a[1] + b[1]) * 0.5;
            const dLng = midLng - mLng;
            const dLat = midLat - mLat;
            candidates.push({ i, dist: dLng * dLng + dLat * dLat });
        }
    } else {
        const margin = 80;
        for (let i = 0; i < dispCoords.length - 1; i++) {
            const rawIdx = (displayIndexToRawIndex && displayIndexToRawIndex[i] !== undefined) ? displayIndexToRawIndex[i] : i;
            if (isTransitSegment(rawIdx)) continue;
            const screenA = screenPts[i];
            const screenB = screenPts[i + 1];
            if (!screenA || !screenB) continue;

            const minX = (screenA.x < screenB.x ? screenA.x : screenB.x) - margin;
            const maxX = (screenA.x > screenB.x ? screenA.x : screenB.x) + margin;
            const minY = (screenA.y < screenB.y ? screenA.y : screenB.y) - margin;
            const maxY = (screenA.y > screenB.y ? screenA.y : screenB.y) + margin;
            if (mX < minX || mX > maxX || mY < minY || mY > maxY) continue;

            const midX = (screenA.x + screenB.x) * 0.5;
            const midY = (screenA.y + screenB.y) * 0.5;
            candidates.push({ i, dist: (midX - mX) * (midX - mX) + (midY - mY) * (midY - mY) });
        }
    }

    if (candidates.length > 20) {
        candidates.sort((a, b) => a.dist - b.dist);
        candidates.length = 20;
    }

    // Step 2: Evaluate candidates with true 3D screen endpoints
    for (let k = 0; k < candidates.length; k++) {
        const i = candidates[k].i;
        let screenA, screenB;
        if (hasTerrain) {
            screenA = cachedTerrainScreenPts[i] || (cachedTerrainScreenPts[i] = map.project(dispCoords[i]));
            screenB = cachedTerrainScreenPts[i + 1] || (cachedTerrainScreenPts[i + 1] = map.project(dispCoords[i + 1]));
        } else {
            screenA = screenPts[i];
            screenB = screenPts[i + 1];
        }
        if (!screenA || !screenB) continue;

        const abx = screenB.x - screenA.x, aby = screenB.y - screenA.y;
        const segLenSq = abx * abx + aby * aby;
        if (segLenSq === 0) continue;

        const len = Math.sqrt(segLenSq);
        const nx = -aby / len, ny = abx / len;
        const aOffX = screenA.x + nx * currentOffset, aOffY = screenA.y + ny * currentOffset;
        const bOffX = screenB.x + nx * currentOffset, bOffY = screenB.y + ny * currentOffset;

        const sX = bOffX - aOffX, sY = bOffY - aOffY;
        const sLenSq = sX * sX + sY * sY;
        if (sLenSq === 0) continue;

        let t = ((mX - aOffX) * sX + (mY - aOffY) * sY) / sLenSq;
        if (t < 0) t = 0; else if (t > 1) t = 1;

        const pProjX = aOffX + t * sX, pProjY = aOffY + t * sY;
        const dx = pProjX - mX, dy = pProjY - mY;
        const dSq = dx * dx + dy * dy;

        if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestCi = i;
            bestT = t;
            bestProj = { x: pProjX, y: pProjY };
        }
    }

    let rawCi = bestCi;
    if (displayIndexToRawIndex && bestCi !== -1) {
        rawCi = displayIndexToRawIndex[bestCi] ?? bestCi;
    }
    return { bestCi: rawCi, displayCi: bestCi, bestT, bestDistSq, bestProj };
}

let isHoveringMarker = false;

map.on('mousemove', 'route-line', (e) => {
    if (window.innerWidth <= 768) return; // Disable hover interaction on mobile
    if (isDraggingLine || isDraggingMarker || isHoveringMarker || isDraggingWindow || isDraggingStats || isResizing) {
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

    const { bestCi, displayCi, bestT, bestDistSq, bestProj } = findClosestPointOnLine(e.point);

    if (bestCi !== -1) {
        bestCiGlobal = bestCi;
        const coords = currentRouteGeoJSON.coordinates;
        const dispCoords = currentDisplayCoords || coords;
        const dIdx = (displayCi !== undefined && displayCi >= 0) ? displayCi : bestCi;
        const c1 = dispCoords[dIdx] || coords[bestCi];
        const c2 = dispCoords[Math.min(dIdx + 1, dispCoords.length - 1)] || c1;
        const lng = c1[0] + bestT * (c2[0] - c1[0]);
        const lat = c1[1] + bestT * (c2[1] - c1[1]);

        // bestProj is already the exact projected point on the offset 3D segment in screen space
        updateHoverHighlight(bestCi, bestT, [lng, lat], bestProj);
    } else {
        clearHoverHighlight();
    }
});

function getOffsetScreenPt(ci) {
    if (ci === undefined || ci < 0 || !map || !currentRouteGeoJSON || !currentRouteGeoJSON.coordinates) return null;
    const coords = currentRouteGeoJSON.coordinates;
    if (ci >= coords.length) return null;

    const displayCoords = currentDisplayCoords || coords;
    let pIdx = ci;
    if (typeof rawIndexToDisplayRange !== 'undefined' && rawIndexToDisplayRange[ci]) {
        pIdx = rawIndexToDisplayRange[ci][0] ?? ci;
    }
    pIdx = Math.min(pIdx, displayCoords.length - 1);

    const p2 = map.project(displayCoords[pIdx]);
    if (!p2) return null;

    const p1 = (pIdx > 0) ? map.project(displayCoords[pIdx - 1]) : null;
    const p3 = (pIdx < displayCoords.length - 1) ? map.project(displayCoords[pIdx + 1]) : null;

    const pxOffset = getPixelOffset(map.getZoom()) * (isRouteLeftHandDriving ? -1 : 1);
    if (Math.abs(pxOffset) < 0.5) {
        return p2;
    }

    let nx = 0, ny = 0;
    if (p1 && p3) {
        const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
        const n1x = -dy1 / len1, n1y = dx1 / len1;

        const dx2 = p3.x - p2.x, dy2 = p3.y - p2.y;
        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
        const n2x = -dy2 / len2, n2y = dx2 / len2;

        nx = (n1x + n2x) / 2;
        ny = (n1y + n2y) / 2;
        const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
        nx /= nlen; ny /= nlen;
    } else if (p1) {
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        nx = -dy / len; ny = dx / len;
    } else if (p3) {
        const dx = p3.x - p2.x, dy = p3.y - p2.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        nx = -dy / len; ny = dx / len;
    }

    return {
        x: p2.x + nx * pxOffset,
        y: p2.y + ny * pxOffset
    };
}

let isFlyToActive = false;
let activeStatIdx = -1;

function updateHoverHighlight(ci, t = 0, lngLat, screenPt) {
    if (isDraggingWindow || isDraggingStats || isResizing) {
        clearHoverHighlight(true);
        return;
    }
    if (ci !== undefined && ci >= 0 && (isTransitPoint(ci) || isTransitSegment(ci))) {
        clearHoverHighlight();
        return;
    }
    if (!screenPt && ci !== undefined && ci >= 0) {
        screenPt = getOffsetScreenPt(ci);
    }
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
    const gradeColor = grade !== undefined ? getColorForGrade(grade) : 'rgb(34,197,94)';
    showHoverMarker(screenPt || lngLat, info, gradeColor);

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
            if (ci >= waypointPathIndices[j] && ci <= waypointPathIndices[j + 1]) {
                segIdx = j; break;
            }
        }
        if (segIdx !== -1 && segIdx !== lastSegIdx) {
            showHoverSegment(ci);
        }
    }

    lastHoverIdx = ci;
    currentHoverDispDist = dispDist; // Sync with chart hover line
    if (elevationChart) {
        elevationChart.update('none'); // Update vertical line on elevation chart continuously
    }
}

let hoverFrameLoopId = null;

function ensureHoverFrameLoopRunning() {
    if (hoverFrameLoopId) return;
    function loop() {
        if (activeStatIdx >= 0 && currentRouteGeoJSON && currentRouteGeoJSON.coordinates && activeStatIdx < currentRouteGeoJSON.coordinates.length) {
            const lngLat = currentRouteGeoJSON.coordinates[activeStatIdx];
            const screenPt = getOffsetScreenPt(activeStatIdx);
            if (screenPt) {
                updateHoverHighlight(activeStatIdx, 0, lngLat, screenPt);
            }
            hoverFrameLoopId = requestAnimationFrame(loop);
        } else {
            hoverFrameLoopId = null;
        }
    }
    hoverFrameLoopId = requestAnimationFrame(loop);
}

function clearHoverHighlight(force) {
    if (isFlyToActive && !force) return;
    const statsDiv = document.getElementById('hover-stats');
    if (statsDiv) statsDiv.style.opacity = '0';
    if (lastHoverIdx !== -1) {
        lastHoverIdx = -1;
        lastSegIdx = -1;
        currentHoverDispDist = null; // Clear chart hover line
        hideHoverMarker();
        if (elevationChart) {
            elevationChart.update('none');
        }
        if (map.getLayer('hover-segment-layer')) {
            map.setLayoutProperty('hover-segment-layer', 'visibility', 'none');
        }
        if (map.getLayer('turnaround-highlight-layer')) {
            map.setFilter('turnaround-highlight-layer', ['==', ['get', 'idx'], -1]);
        }
        if (map.getLayer('turnaround-layer')) {
            map.setFilter('turnaround-layer', null);
        }
    }
}

map.on('mouseleave', clearHoverHighlight);
map.on('movestart', () => {
    if (!isFlyToActive) {
        activeStatIdx = -1;
        clearHoverHighlight(false);
    }
});
map.on('touchstart', (e) => {
    isFlyToActive = false;
    activeStatIdx = -1;
    if (!e.originalEvent?.target?.closest('.maplibregl-marker') && !e.originalEvent?.target?.closest('.custom-marker')) {
        window._isMarkerTouch = false;
    }
    clearHoverHighlight(true);
    document.activeElement?.blur();
});
map.on('mousedown', () => {
    clearHoverHighlight();
    document.activeElement?.blur();
});
window.addEventListener('blur', clearHoverHighlight);

// Explicitly clear hover when moving into UI overlays
['top-bar', 'elevation-panel', 'right-panel', 'search-container'].forEach(id => {
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
    const waypointStyle = localStorage.getItem('route_waypoint_style') || 'circle';
    if (waypointStyle === 'circle') {
        el.style.width = '22px';
        el.style.height = '22px';
    } else if (waypointStyle === 'flag') {
        el.style.width = '26px';
        el.style.height = '34px';
    } else {
        el.style.width = '24px';
        el.style.height = '34px';
    }
    el.style.cursor = 'pointer';
    el.style.filter = 'drop-shadow(0 2px 2px rgba(0,0,0,0.4))';
    el.innerHTML = '';

    const marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: true })
        .setLngLat(lngLat)
        .addTo(map);

    function deleteMarker(m) {
        if (isLiveNavActive) return;
        isHoveringMarker = false;
        const idx = markers.indexOf(m);
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
            m.remove();
            updateRoute();
        }
    }

    const onRightClick = (evt) => {
        if (evt.button === 2) { // Right click
            evt.preventDefault();
            evt.stopPropagation();
            showWeatherPopup(marker.getLngLat());
        }
    };
    marker.getElement().addEventListener('mousedown', (evt) => {
        if (evt.button === 2) {
            onRightClick(evt);
            evt.preventDefault();
            evt.stopPropagation();
        }
    });
    marker.getElement().addEventListener('auxclick', onRightClick);
    marker.getElement().addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    marker.getElement().addEventListener('mouseenter', () => {
        isHoveringMarker = true;
        clearHoverHighlight();
    });
    marker.getElement().addEventListener('mouseleave', () => {
        isHoveringMarker = false;
    });

    let markerWasDragged = false;
    marker.getElement().addEventListener('click', (evt) => {
        evt.stopPropagation();
        if (isLiveNavActive) return;
        if (!markerWasDragged) {
            deleteMarker(marker);
        }
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

    let cachedPrevWpPt = null;
    let cachedNextWpPt = null;
    let dragGuideRaf = null;

    marker.on('dragstart', () => {
        markerWasDragged = true;
        isDraggingMarker = true;
        isHoveringMarker = false;
        if (isDraggingLine) {
            isDraggingLine = false;
            hideDragGuideSVG();
        }
        window._currentlyDraggingMarker = marker;
        const idx = markers.indexOf(marker);
        if (idx > -1 && waypoints[idx]) {
            window._currentlyDraggingMarkerOriginalLngLat = new maplibregl.LngLat(waypoints[idx][0], waypoints[idx][1]);
        } else {
            window._currentlyDraggingMarkerOriginalLngLat = marker.getLngLat();
        }
        window._currentlyDraggingMarkerCancel = false;

        cachedPrevWpPt = null;
        cachedNextWpPt = null;

        hideHoverMarker();
        clearHoverHighlight();
    });

    marker.on('drag', () => {
        if (!dragGuideRaf) {
            dragGuideRaf = requestAnimationFrame(() => {
                dragGuideRaf = null;
                if (!isDraggingMarker || !marker) return;

                const idx = markers.indexOf(marker);
                if (idx === -1) return;

                const prevWp = idx > 0 ? waypoints[idx - 1] : null;
                const nextWp = idx < waypoints.length - 1 ? waypoints[idx + 1] : null;
                updateDragGuideSVG(marker.getLngLat(), prevWp, nextWp);
            });
        }
    });

    marker.on('dragend', () => {
        if (dragGuideRaf) { cancelAnimationFrame(dragGuideRaf); dragGuideRaf = null; }
        cachedPrevWpPt = null;
        cachedNextWpPt = null;
        hideDragGuideSVG();
        window._wasDraggingMarker = true;
        setTimeout(() => { markerWasDragged = false; window._wasDraggingMarker = false; }, 200);
        console.log('[Antigravity] Marker dragend. window._currentlyDraggingMarkerCancel =', window._currentlyDraggingMarkerCancel);
        if (window._currentlyDraggingMarkerCancel) {
            console.log('[Antigravity] Marker dragend cancelled, aborting save.');
            return;
        }
        isDraggingMarker = false;
        const origLngLat = window._currentlyDraggingMarkerOriginalLngLat;
        window._currentlyDraggingMarker = null;
        window._currentlyDraggingMarkerOriginalLngLat = null;
        hideHoverMarker();
        const idx = markers.indexOf(marker);
        if (idx > -1) {
            const ll = marker.getLngLat();
            const prevWp = waypoints[idx];
            waypoints[idx] = [ll.lng, ll.lat];

            checkLongSegmentWarning(idx).then((approved) => {
                if (!approved) {
                    if (origLngLat) {
                        marker.setLngLat(origLngLat);
                        waypoints[idx] = [origLngLat.lng, origLngLat.lat];
                    } else if (prevWp) {
                        marker.setLngLat(prevWp);
                        waypoints[idx] = prevWp;
                    }
                    return;
                }
                saveHistory();
                invalidateGPXSegment(idx);
                updateRoute();
            });
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
    const waypointStyle = localStorage.getItem('route_waypoint_style') || 'circle';
    markers.forEach((m, i) => {
        const el = m.getElement();
        if (waypointStyle === 'circle') {
            el.style.width = '22px';
            el.style.height = '22px';
            el.innerHTML = createMarkerIcon(i, markers.length);
            m.setOffset([0, 0]);
        } else if (waypointStyle === 'flag') {
            el.style.width = '26px';
            el.style.height = '34px';
            el.innerHTML = createMarkerIcon(i, markers.length);
            m.setOffset([9, -16]);
        } else {
            el.style.width = '24px';
            el.style.height = '34px';
            el.innerHTML = createMarkerIcon(i, markers.length);
            m.setOffset([0, -17]);
        }
    });

    updateDragPreviewAppearance(waypoints.length, waypoints.length + 1);
}

function updateDragPreviewAppearance(insertIdx = 1, total = 2) {
    if (!window._dragPreviewMarker) return;
    const waypointStyle = localStorage.getItem('route_waypoint_style') || 'circle';
    const el = window._dragPreviewMarker.getElement();
    el.style.opacity = '0.9';
    el.style.pointerEvents = 'none';
    el.style.filter = 'drop-shadow(0 2px 2px rgba(0,0,0,0.4))';

    if (waypointStyle === 'circle') {
        el.style.width = '22px';
        el.style.height = '22px';
        el.innerHTML = createMarkerIcon(insertIdx, total);
        window._dragPreviewMarker.setOffset([0, 0]);
    } else if (waypointStyle === 'flag') {
        el.style.width = '26px';
        el.style.height = '34px';
        el.innerHTML = createMarkerIcon(insertIdx, total);
        window._dragPreviewMarker.setOffset([9, -16]);
    } else {
        el.style.width = '24px';
        el.style.height = '34px';
        el.innerHTML = createMarkerIcon(insertIdx, total);
        window._dragPreviewMarker.setOffset([0, -17]);
    }
}

let wasDraggingLine = false;
let isDraggingLine = false;
let isDraggingMarker = false;
let draggedWaypointIndex = -1;

function cancelDraggingGestures() {
    if (!isDraggingLine && !isDraggingMarker && !window._currentlyDraggingMarker) {
        return;
    }
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

    isDraggingMarker = false;
    window._currentlyDraggingMarker = null;
    window._currentlyDraggingMarkerOriginalLngLat = null;
    map.getSource('drag-guide')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
}

// Cancel waypoint dragging if a gesture (rotate, pitch, or pinch zoom) starts
map.on('rotatestart', () => { console.log('[Antigravity] map rotatestart'); cancelDraggingGestures(); });
map.on('pitchstart', () => { console.log('[Antigravity] map pitchstart'); cancelDraggingGestures(); });
map.on('zoomstart', () => { console.log('[Antigravity] map zoomstart'); cancelDraggingGestures(); });
map.on('rotateend', () => {
    isRightClickDragging = false;
    document.body.classList.remove('right-click-dragging');
});
map.on('pitchend', () => {
    isRightClickDragging = false;
    document.body.classList.remove('right-click-dragging');
});

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
map.on('touchstart', 'route-line', onLineDown);

function onLineDown(e) {
    if (isLiveNavActive) return;
    if (e.type === 'mousedown' && e.originalEvent.button !== 0) return;
    if (isDraggingMarker || (window.innerWidth > 768 && isHoveringMarker) || window._currentlyDraggingMarker || window._isMarkerTouch) return;
    
    // Ensure we have a valid snapping point, especially for mobile touchstart
    const { bestCi, bestT, bestDistSq, bestProj } = findClosestPointOnLine(e.point);
    const isTouch = e.type === 'touchstart' || (e.originalEvent && e.originalEvent.touches);
    const highlightThreshold = isTouch ? (45 * 45) : (25 * 25); // Generous 45px touch radius for mobile fingers
    if (bestCi === -1 || bestDistSq > highlightThreshold) return;
    if (isTransitPoint(bestCi) || isTransitSegment(bestCi)) return; // Do not drag or insert points on transit gap segments

    e.originalEvent?.stopPropagation();

    // Sync global state for the up/move handlers
    bestCiGlobal = bestCi;

    const clickPt = e.point;
    for (const wp of waypoints) {
        const wpPt = map.project(wp);
        const dist = Math.hypot(wpPt.x - clickPt.x, wpPt.y - clickPt.y);
        if (dist < 35) return;
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
    updateDragPreviewAppearance(insertIdx, waypoints.length + 1);

    let lastDragLngLat = null;

    const onMove = (moveEvent) => {
        let lngLat = moveEvent.lngLat;
        if (!lngLat && moveEvent.touches && moveEvent.touches.length > 0) {
            const touch = moveEvent.touches[0];
            const rect = map.getCanvasContainer().getBoundingClientRect();
            lngLat = map.unproject([touch.clientX - rect.left, touch.clientY - rect.top]);
        }
        if (!lngLat) return;
        lastDragLngLat = lngLat;
        updateDragGuideSVG(lngLat, prevWp, nextWp);
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
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onUp);
        window.removeEventListener('touchcancel', onUp);

        hideDragGuideSVG();
        hideHoverMarker();
        const pm = window._dragPreviewMarker;
        if (pm && pm._added) { pm.remove(); pm._added = false; }

        let finalLngLat = upEvent?.lngLat;
        if (!finalLngLat && upEvent?.changedTouches && upEvent.changedTouches.length > 0) {
            const touch = upEvent.changedTouches[0];
            const rect = map.getCanvasContainer().getBoundingClientRect();
            finalLngLat = map.unproject([touch.clientX - rect.left, touch.clientY - rect.top]);
        }
        if (!finalLngLat) {
            finalLngLat = lastDragLngLat;
        }

        if (finalLngLat) {
            const newMarker = createMarker(finalLngLat, insertIdx);
            checkLongSegmentWarning(insertIdx).then((approved) => {
                if (!approved) {
                    const idx = markers.indexOf(newMarker);
                    if (idx > -1) {
                        markers.splice(idx, 1);
                        waypoints.splice(idx, 1);
                        segmentModes.splice(idx > 0 ? idx - 1 : 0, 1);
                        segmentGPXPaths.splice(idx > 0 ? idx - 1 : 0, 1);
                        newMarker.remove();
                        refreshMarkerIcons();
                    }
                    return;
                }
                saveHistory();
                updateRoute();
            });
        }
        setTimeout(() => wasDraggingLine = false, 50);
        window._activeLineDragCleanup = null;
    };

    map.on('mousemove', onMove);
    map.on('touchmove', onMove);
    map.on('mouseup', onUp);
    map.on('touchend', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp, { passive: true });
    window.addEventListener('touchcancel', onUp, { passive: true });

    window._activeLineDragCleanup = () => {
        isDraggingLine = false;
        map.dragPan.enable();
        map.getCanvas().style.cursor = 'pointer';
        map.off('mousemove', onMove);
        map.off('touchmove', onMove);
        map.off('mouseup', onUp);
        map.off('touchend', onUp);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onUp);
        window.removeEventListener('touchcancel', onUp);

        hideDragGuideSVG();
        hideHoverMarker();
        const pm = window._dragPreviewMarker;
        if (pm && pm._added) { pm.remove(); pm._added = false; }

        wasDraggingLine = true;
        setTimeout(() => wasDraggingLine = false, 100);
        window._activeLineDragCleanup = null;
    };
}

map.on('click', (e) => {
    if (isLiveNavActive) return;
    // On mobile touch devices, e.originalEvent can be a TouchEvent where button is undefined or not set.
    // Only return if button is explicitly defined and is not the primary button (0).
    if (e.originalEvent && typeof e.originalEvent.button === 'number' && e.originalEvent.button !== 0) return;
    if (wasDraggingLine || window._wasDraggingMarker || isDraggingMarker) return;

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
        else if (current === 'hike') next = 'transit';
        else if (current === 'transit') next = 'bike';
        segmentModes[lastSegIdx] = next;
        updateRoute();
        return;
    }

    const newMarker = createMarker(e.lngLat);
    const newIdx = waypoints.length - 1;
    checkLongSegmentWarning(newIdx).then((approved) => {
        if (!approved) {
            const idx = markers.indexOf(newMarker);
            if (idx > -1) {
                markers.splice(idx, 1);
                waypoints.splice(idx, 1);
                if (idx > 0) {
                    segmentModes.splice(idx - 1, 1);
                    segmentGPXPaths.splice(idx - 1, 1);
                } else {
                    segmentModes.splice(0, 1);
                    segmentGPXPaths.splice(0, 1);
                }
                newMarker.remove();
                refreshMarkerIcons();
            }
            return;
        }
        saveHistory();
        updateRoute();
    });
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

function openExternalMap(lat, lng, label) {
    if (window.AndroidMaterialTheme && typeof window.AndroidMaterialTheme.openMapLocation === 'function') {
        window.AndroidMaterialTheme.openMapLocation(lat, lng, label || '');
        return;
    }
    window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, '_blank');
}
window.openExternalMap = openExternalMap;

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
            <div style="font-family: 'Inter', sans-serif; padding: 0; white-space: nowrap;">
                <div style="margin-top: 0; padding-right: 20px;">
                    <a href="#" onclick="openExternalMap(${lat}, ${lng}); return false;" 
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
                <div style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; opacity: 0.7;">
                        <path d="m8 3 4 8 5-5 5 15H2L8 3z"/>
                    </svg>
                    <span>Elev: <span id="weather-elev-val" style="font-weight: 600; color: var(--text-main);">Fetching...</span></span>
                </div>
                <div id="weather-info">
                    <a href="https://www.windy.com/${lat}/${lng}?${lat},${lng},11" target="_blank" style="text-decoration: none; color: inherit; display: block;">
                        <div style="display: flex; justify-content: flex-start; align-items: center; gap: 14px;">
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

    const popupNode = currentInfoPopup.getElement();
    const targetElevEl = popupNode ? popupNode.querySelector('#weather-elev-val') : null;
    const targetTempEl = popupNode ? popupNode.querySelector('#weather-temp') : null;
    const targetWindEl = popupNode ? popupNode.querySelector('#weather-wind') : null;
    const targetIconEl = popupNode ? popupNode.querySelector('#weather-icon') : null;
    const targetArrowEl = popupNode ? popupNode.querySelector('#wind-arrow') : null;

    // Fetch and display elevation using the settings units
    getHighResElevation([[lng, lat]]).then(elevs => {
        const elevVal = elevs[0];
        if (targetElevEl) {
            if (elevVal != null) {
                const converted = currentUnits === 'imperial' ? elevVal * 3.28084 : elevVal;
                const unitLabel = currentUnits === 'imperial' ? ' ft' : ' m';
                targetElevEl.innerText = `${converted.toFixed(1)}${unitLabel}`;
            } else {
                targetElevEl.innerText = 'No data';
            }
        }
    }).catch(err => {
        console.error('Elevation query error:', err);
        if (targetElevEl) targetElevEl.innerText = 'No data';
    });

    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m,weather_code,wind_direction_10m&temperature_unit=${units}&wind_speed_unit=${windUnits}`)
        .then(r => r.json())
        .then(data => {
            if (targetTempEl) targetTempEl.innerText = `${Math.round(data.current.temperature_2m)}${tempLabel}`;
            if (targetWindEl) targetWindEl.innerText = `${Math.round(data.current.wind_speed_10m)}${windLabel}`;
            if (targetIconEl) targetIconEl.innerHTML = getWeatherIcon(data.current.weather_code);
            if (targetArrowEl && data.current.wind_direction_10m !== undefined) {
                targetArrowEl.style.display = 'inline-block';
                // Meteorological wind is 'from' direction. We add 180 to point the arrow 'towards' the flow.
                targetArrowEl.style.transform = `rotate(${data.current.wind_direction_10m + 180}deg)`;
            }
        }).catch(err => console.error('Weather fetch error:', err));
}

let currentInfoPopup = null;
let rightClickStartX = 0;
let rightClickStartY = 0;
let pendingRightClickTimer = null;
let lastRightClickTimestamp = 0;
const weatherPrefetchCache = new Map();

function prefetchWeatherPopupData(lngLat) {
    const { lat, lng } = lngLat;
    const units = currentUnits === 'imperial' ? 'fahrenheit' : 'celsius';
    const windUnits = currentUnits === 'imperial' ? 'mph' : 'kmh';
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;

    if (!weatherPrefetchCache.has(key)) {
        const fetchPromise = fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m,weather_code,wind_direction_10m&temperature_unit=${units}&wind_speed_unit=${windUnits}`)
            .then(r => r.json())
            .catch(err => null);
        weatherPrefetchCache.set(key, fetchPromise);
    }
    getHighResElevation([[lng, lat]]).catch(() => { });
}

let hasRightClickDragged = false;

map.getCanvasContainer().addEventListener('mousedown', (e) => {
    if (e.button === 2) { // Right mouse button
        rightClickStartX = e.clientX;
        rightClickStartY = e.clientY;
        hasRightClickDragged = false;
    }
});

map.getCanvasContainer().addEventListener('mousemove', (e) => {
    if (rightClickStartX !== null && rightClickStartY !== null) {
        const dx = e.clientX - rightClickStartX;
        const dy = e.clientY - rightClickStartY;
        if (Math.hypot(dx, dy) >= 5) {
            hasRightClickDragged = true;
        }
    }
});

map.on('mouseup', (e) => {
    if (e.originalEvent.button !== 2) return;
    if (hasRightClickDragged) {
        rightClickStartX = null;
        rightClickStartY = null;
        hasRightClickDragged = false;
        return;
    }
    // Only show popup if cursor barely moved (i.e. it was a click, not a right-drag pan/rotate)
    const dx = e.originalEvent.clientX - rightClickStartX;
    const dy = e.originalEvent.clientY - rightClickStartY;
    if (Math.hypot(dx, dy) >= 8) return;

    const now = performance.now();
    if (now - lastRightClickTimestamp < 350) {
        // Double right-click: reset orientation and cancel popup
        if (pendingRightClickTimer) {
            clearTimeout(pendingRightClickTimer);
            pendingRightClickTimer = null;
        }
        lastRightClickTimestamp = 0;
        map.flyTo({ bearing: 0, pitch: 0, speed: 2.8, curve: 1.4 });
        return;
    }
    lastRightClickTimestamp = now;

    if (isLiveNavActive) return;
    if (pendingRightClickTimer) {
        clearTimeout(pendingRightClickTimer);
    }

    const targetLngLat = e.lngLat;
    prefetchWeatherPopupData(targetLngLat);

    pendingRightClickTimer = setTimeout(() => {
        pendingRightClickTimer = null;
        showWeatherPopup(targetLngLat);
    }, 300);
});

// Prevent browser context menu on right-click so rotate & popup work cleanly
map.getCanvasContainer().addEventListener('contextmenu', (e) => e.preventDefault());

// Long Press Handler for Mobile
let touchStartPos = null;
let longPressTimer = null;

function handleLongPress(lngLat, targetMarker = null) {
    if (isLiveNavActive) return;
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
    if (window._isMarkerTouch || isDraggingLine || isDraggingMarker) return;
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

// Forward wheel events over right-click weather popups directly to MapLibre canvas so scroll-to-zoom works there,
// while blocking map zoom when scrolling over settings, elevation profile, or graph windows.
window.addEventListener('wheel', (e) => {
    if (!map) return;
    const weatherPopup = e.target.closest('.weather-popup, .maplibregl-popup, .mapboxgl-popup');
    if (weatherPopup) {
        const canvas = map.getCanvas();
        if (canvas) {
            canvas.dispatchEvent(new WheelEvent('wheel', {
                clientX: e.clientX,
                clientY: e.clientY,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                deltaZ: e.deltaZ,
                deltaMode: e.deltaMode,
                bubbles: true,
                cancelable: true
            }));
        }
        return;
    }

    const blockedUI = e.target.closest('#top-bar, .settings-content, .floating-window, #elevation-panel, #stats-panel, .stats-panel, #right-panel, #context-menu');
    if (blockedUI) {
        e.stopPropagation();
    }
}, { capture: true });

// Disable default browser context menu
document.getElementById('map').addEventListener('contextmenu', (e) => e.preventDefault());

let currentRouteGeoJSON = null;
let needsElevationUpdate = false;
let _elevRetryScheduled = false;
let forceMode = false; // straight-line mode — skips OSRM routing
let segmentModes = []; // 'routed' | 'direct' | 'gpx' for each segment between consecutive waypoints
let segmentGPXPaths = []; // stores raw coordinates arrays for segments with mode === 'gpx'

// --- Toast notification system ---
function showToast(message, type = 'error') {
    let toast = document.getElementById('app-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.className = 'toast-notification';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `toast-notification ${type} show`;

    // Auto-hide after 4 seconds
    clearTimeout(toast.timeoutId);
    toast.timeoutId = setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

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

    if (mode === 'transit') {
        return { coords: [from, to], dist: 0, isTransit: true };
    }

    const key = getCacheKey(from, to, mode, avoidUnpaved, excludeParam);
    if (segmentCache.has(key)) {
        return segmentCache.get(key);
    }

    const allowFerries = document.getElementById('allow-ferries-check')?.checked ?? false;
    const ferryVal = allowFerries ? '1' : '0';

    try {
        const bProfile = (mode === 'hike') ? 'trekking' : 'fastbike-lowtraffic';
        let bRouterUrl = `https://brouter.de/brouter?lonlats=${from[0]},${from[1]}|${to[0]},${to[1]}&profile=${bProfile}&alternativeidx=0&format=geojson&profile:allow_ferries=${ferryVal}&turnInstructionMode=1`;
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
                    const feature = data.features[0];
                    result = {
                        coords: feature.geometry.coordinates,
                        dist: parseFloat(feature.properties['track-length']),
                        messages: feature.properties.messages,
                        voicehints: feature.properties.voicehints
                    };
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
    const fallbackResult = { coords: [from, to], dist: turf_distance(from, to), failed: true };
    segmentCache.set(key, fallbackResult);
    return fallbackResult;
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
        if (map.getSource('route-transit')) map.getSource('route-transit').setData({ type: 'FeatureCollection', features: [] });
        if (map.getSource('route-gradient')) map.getSource('route-gradient').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
        cleanupExtraGradientLayers();
        if (map.getSource('route-display')) map.getSource('route-display').setData({ type: 'LineString', coordinates: [] });
        if (map.getSource('turnarounds')) map.getSource('turnarounds').setData({ type: 'FeatureCollection', features: [] });
        hideHoverMarker();
        currentDistanceMeters = 0;
        currentRouteGeoJSON = null;
        isRouteLeftHandDriving = false;
        routeGrades = null; routePathDistances = null; routeMercatorDistances = null; routeTotalDist = 0; routeMercTotalDist = 0;
        waypointDistances = [];
        updateDistanceUI();
        currentMapColorMode = 'grade';
        routeRoadTypes = [];
        routeSurfaceTypes = [];
        updateRouteTypesUI([]);
        updateElevationProfile();
        updateDistanceMarkers();
        if (typeof stopLiveNavigation === 'function') stopLiveNavigation();
        syncUrl();
        clearStatus();
        return;
    }

    // --- Routing phase: fetch segments in parallel ---
    const numSegs = waypoints.length - 1;

    let uncachedCount = 0;
    for (let i = 0; i < numSegs; i++) {
        const mode = segmentModes[i] || 'bike';
        if (mode !== 'direct' && mode !== 'gpx' && mode !== 'transit') {
            const avoidUnpaved = (mode !== 'hike');
            let exclude = [];
            if (avoidUnpaved) exclude.push('unpaved');
            const excludeParam = exclude.length > 0 ? `&exclude=${exclude.join(',')}` : '';
            const key = getCacheKey(waypoints[i], waypoints[i + 1], mode, avoidUnpaved, excludeParam);
            if (!segmentCache.has(key)) {
                uncachedCount++;
            }
        }
    }

    if (uncachedCount > 0) {
        setStatus(uncachedCount === 1 ? 'Routing 1 segment…' : `Routing ${uncachedCount} of ${numSegs} segments…`);
    } else {
        setStatus('Updating route…');
    }

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

        // Warn if any routed segment had to fall back to a straight line due to API failures
        const anyFailed = segments.some(seg => seg.failed);
        if (anyFailed) {
            showToast("Could not find route. Using straight-line fallback.", "warning");
        }
    } catch (e) {
        clearStatus();
        if (e.name === 'AbortError') {
            console.log('Routing aborted');
            return;
        }
        showToast("Routing failed. Please check your internet connection.");
        throw e;
    }

    // Ensure EVERY segment connects cleanly to its waypoint pins with zero gap.
    // BRouter snaps endpoints to the nearest road network node; if that node is even slightly
    // away from the clicked waypoint pin, connect it directly so the line reaches the pin.
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg || !seg.coords || seg.coords.length === 0) continue;
        const pStart = waypoints[i];
        const pEnd = waypoints[i + 1];

        if (seg.isTransit) {
            seg.coords = [pStart, pEnd];
        } else {
            // Normal routed segment: ensure endpoints touch waypoints[i] and waypoints[i + 1] exactly
            if (haversineDistance(seg.coords[0], pStart) > 0.5) {
                seg.coords.unshift(pStart);
            } else {
                seg.coords[0] = pStart;
            }
            const lastIdx = seg.coords.length - 1;
            if (haversineDistance(seg.coords[lastIdx], pEnd) > 0.5) {
                seg.coords.push(pEnd);
            } else {
                seg.coords[lastIdx] = pEnd;
            }
        }
    }

    // Stitch segments together, resampling each routed segment individually.
    // Transit gap segments only keep their start, collinear buffer, and end points without interpolating
    // thousands of 5m points across the gap, preventing massive elevation queries and freezes.
    let allCoords = [];
    let totalDist = 0;
    segments.forEach((seg) => {
        if (!seg.isTransit) {
            totalDist += seg.dist;
        }
    });

    setStatus('Resampling…');
    currentDistanceMeters = totalDist;

    const exactWpIndices = [0];
    segments.forEach((seg, segIdx) => {
        if (seg.isTransit) {
            const c = (allCoords.length > 0) ? seg.coords.slice(1) : seg.coords;
            allCoords.push(...c);
        } else {
            const segDist = seg.dist;
            const segPoints = isHighPerformance
                ? Math.min(2500, Math.max(50, Math.ceil(segDist / 20)))
                : Math.min(10000, Math.max(200, Math.ceil(segDist / 5)));
            const resampled = resampleLine(seg.coords, segPoints);
            const c = (allCoords.length > 0) ? resampled.slice(1) : resampled;
            allCoords.push(...c);
        }
        exactWpIndices.push(allCoords.length - 1);
    });

    const rawCoords = allCoords;
    currentRouteGeoJSON = { type: 'LineString', coordinates: rawCoords };
    if (rawCoords.length > 0) {
        isRouteLeftHandDriving = isLeftHandDriving(rawCoords[0][0], rawCoords[0][1]);
    } else {
        isRouteLeftHandDriving = false;
    }

    routeRoadTypes = [];
    routeSurfaceTypes = [];

    if (!isHighPerformance) {
        // Build lookup for road types and surface types for resampled rawCoords
        const originalPoints = [];
        segments.forEach(seg => {
            const hasMessages = seg.messages && seg.messages.length >= 2;
            let tagsIdx = -1, distIdx = -1;
            let header = null;
            const msgNodes = [];

            if (hasMessages) {
                const firstMsg = seg.messages[0];
                header = Array.isArray(firstMsg) ? firstMsg : (typeof firstMsg === 'string' ? firstMsg.split('\t') : null);
                if (header) {
                    tagsIdx = header.indexOf('WayTags');
                    if (tagsIdx === -1) tagsIdx = header.indexOf('Tags');
                    distIdx = header.indexOf('Distance');
                    const lonIdx = header.indexOf('Longitude');
                    const latIdx = header.indexOf('Latitude');

                    if (tagsIdx !== -1 && lonIdx !== -1 && latIdx !== -1) {
                        let lastTags = '';
                        for (let m = 1; m < seg.messages.length; m++) {
                            const rowVal = seg.messages[m];
                            const row = Array.isArray(rowVal) ? rowVal : (typeof rowVal === 'string' ? rowVal.split('\t') : null);
                            if (row && row.length > Math.max(tagsIdx, lonIdx, latIdx)) {
                                const mLng = parseFloat(row[lonIdx]) / 1000000;
                                const mLat = parseFloat(row[latIdx]) / 1000000;
                                let tags = row[tagsIdx] || '';
                                if (tags.trim()) {
                                    lastTags = tags;
                                } else {
                                    tags = lastTags;
                                }
                                msgNodes.push({
                                    coord: [mLng, mLat],
                                    tags: tags
                                });
                            }
                        }
                    }
                }
            }

            for (let i = 0; i < seg.coords.length; i++) {
                const c = seg.coords[i];
                let roadType = 'other';
                let surfaceType = 'unknown';

                if (msgNodes.length > 0) {
                    let bestMIdx = 0;
                    let minDist = Infinity;
                    for (let m = 0; m < msgNodes.length; m++) {
                        const dLng = msgNodes[m].coord[0] - c[0];
                        const dLat = msgNodes[m].coord[1] - c[1];
                        const dSq = dLng * dLng + dLat * dLat;
                        if (dSq < minDist) {
                            minDist = dSq;
                            bestMIdx = m;
                        }
                    }
                    const tags = msgNodes[bestMIdx].tags;
                    if (tags.includes('highway=cycleway')) {
                        roadType = 'cycleway';
                    } else if (tags.includes('highway=track') || tags.includes('highway=path') || tags.includes('highway=footway') || tags.includes('highway=bridleway') || tags.includes('highway=pedestrian')) {
                        roadType = 'track';
                    } else if (tags.includes('highway=residential') || tags.includes('highway=living_street') || tags.includes('highway=service') || tags.includes('highway=unclassified')) {
                        roadType = 'quiet';
                    } else if (tags.includes('highway=motorway') || tags.includes('highway=trunk') || tags.includes('highway=primary') || tags.includes('highway=secondary') || tags.includes('highway=tertiary')) {
                        roadType = 'major';
                    }

                    if (tags.includes('surface=asphalt') || tags.includes('surface=concrete') || tags.includes('surface=paved') || tags.includes('surface=paving_stones') || tags.includes('surface=sett') || tags.includes('surface=tarmac')) {
                        surfaceType = 'paved';
                    } else if (tags.includes('surface=gravel') || tags.includes('surface=fine_gravel') || tags.includes('surface=unpaved') || tags.includes('surface=dirt') || tags.includes('surface=earth') || tags.includes('surface=sand') || tags.includes('surface=ground') || tags.includes('surface=grass') || tags.includes('surface=compacted') || tags.includes('surface=pebblestone') || tags.includes('surface=wood')) {
                        surfaceType = 'unpaved';
                    }
                }

                originalPoints.push({
                    coord: c,
                    roadType,
                    surfaceType
                });
            }
        });

        rawCoords.forEach(c => {
            let bestIdx = 0;
            let minDist = Infinity;
            for (let i = 0; i < originalPoints.length; i++) {
                const op = originalPoints[i];
                const dLng = op.coord[0] - c[0];
                const dLat = op.coord[1] - c[1];
                const dSq = dLng * dLng + dLat * dLat;
                if (dSq < minDist) {
                    minDist = dSq;
                    bestIdx = i;
                }
            }
            routeRoadTypes.push(originalPoints[bestIdx].roadType);
            routeSurfaceTypes.push(originalPoints[bestIdx].surfaceType);
        });
    }

    // Exact waypoint indices corresponding to segment boundaries
    waypointPathIndices = exactWpIndices;

    // Build routeTurnInstructions from segments with BRouter voicehints
    routeTurnInstructions = [];
    if (segments && segments.length > 0) {
        segments.forEach((seg) => {
            if (seg.voicehints && seg.coords && seg.coords.length > 0) {
                seg.voicehints.forEach(vh => {
                    const coordIdx = vh[0];
                    const cmd = vh[1];
                    const angle = vh[4] || 0;
                    const c = seg.coords[coordIdx];
                    if (!c) return;

                    let type = 'straight';
                    let icon = 'straight';
                    let text = 'Continue';

                    switch (cmd) {
                        case 1: type = 'straight'; icon = 'straight'; text = 'Continue straight'; break;
                        case 2: type = 'turn-left'; icon = 'left'; text = 'Turn left'; break;
                        case 3: type = 'slight-left'; icon = 'slight-left'; text = 'Slight left'; break;
                        case 4: type = 'sharp-left'; icon = 'sharp-left'; text = 'Turn sharp left'; break;
                        case 5: type = 'turn-right'; icon = 'right'; text = 'Turn right'; break;
                        case 6: type = 'slight-right'; icon = 'slight-right'; text = 'Slight right'; break;
                        case 7: type = 'sharp-right'; icon = 'sharp-right'; text = 'Turn sharp right'; break;
                        case 8: type = 'slight-left'; icon = 'slight-left'; text = 'Keep left'; break;
                        case 9: type = 'slight-right'; icon = 'slight-right'; text = 'Keep right'; break;
                        case 10: type = 'roundabout'; icon = 'roundabout'; text = 'Enter roundabout'; break;
                        case 11:
                            type = angle < 0 ? 'u-turn-left' : 'u-turn-right';
                            icon = angle < 0 ? 'uturn-left' : 'uturn-right';
                            text = angle < 0 ? 'Make a U-turn to the left' : 'Make a U-turn to the right';
                            break;
                        default:
                            if (angle >= 45) { type = 'turn-right'; icon = 'right'; text = 'Turn right'; }
                            else if (angle <= -45) { type = 'turn-left'; icon = 'left'; text = 'Turn left'; }
                            break;
                    }
                    if (type === 'straight') return;

                    // Match to closest coordinate index in resampled rawCoords
                    let bestIdx = 0;
                    let minDist = Infinity;
                    for (let r = 0; r < rawCoords.length; r++) {
                        const d = turf_distance(c, rawCoords[r]);
                        if (d < minDist) { minDist = d; bestIdx = r; }
                    }
                    routeTurnInstructions.push({
                        rawIdx: bestIdx,
                        coord: c,
                        type: type,
                        text: text,
                        icon: icon,
                        isIntersection: true
                    });
                });
            }
        });
        routeTurnInstructions.sort((a, b) => a.rawIdx - b.rawIdx);
    }

    if (map.getSource('route')) map.getSource('route').setData(currentRouteGeoJSON);
    if (map.getSource('route-transit')) map.getSource('route-transit').setData({ type: 'FeatureCollection', features: [] });

    rebuildMapGradient();
    routeScreenPtsDirty = true;
    updateDistanceUI();
    currentRouteSegments = segments;
    updateRouteTypesUI(segments);
    // Calculate waypoint distances for the chart (excluding transit segments)
    let dSum = 0;
    const dArray = [0];
    for (let i = 1; i < rawCoords.length; i++) {
        if (!isTransitSegment(i - 1)) {
            dSum += haversineDistance(rawCoords[i - 1], rawCoords[i]);
        }
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
        gpxPaths: segmentGPXPaths.map(p => p ? [...p] : null)
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

function clearRoute(withHistory = true) {
    if (withHistory) saveHistory();
    waypoints = [];
    markers.forEach(m => m.remove());
    markers = [];
    segmentModes = [];
    segmentGPXPaths = [];
    const gainLossEl = document.getElementById('elev-gain-loss');
    if (gainLossEl) gainLossEl.textContent = '';
    updateRoute();
    updateDistanceMarkers();
    if (typeof stopLiveNavigation === 'function') stopLiveNavigation();
    updateUndoRedoBtns();
}

document.getElementById('clear-route').addEventListener('click', () => {
    clearRoute(true);
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

function fitBoundsSmart(bounds, extraOptions = {}) {
    if (!map || !bounds) return;
    const is3D = (map && map.getTerrain && map.getTerrain()) ||
        (document.getElementById('hillshade-select')?.value === 'terrain');

    const padding = getFitBoundsPadding();
    if (is3D) {
        const exaggeration = typeof getTerrainExaggeration === 'function' ? getTerrainExaggeration() : 2.0;
        const extraPad = Math.round(35 * exaggeration);
        padding.top += extraPad;
        padding.bottom += extraPad;
        padding.left += extraPad;
        padding.right += extraPad;
    }

    const options = {
        padding,
        speed: 2.8,
        curve: 1.4,
        ...extraOptions
    };

    if (is3D) {
        const exaggeration = typeof getTerrainExaggeration === 'function' ? getTerrainExaggeration() : 2.0;
        const maxZoom3D = Math.max(10, 16.0 - (exaggeration * 0.5));
        if (!options.maxZoom || options.maxZoom > maxZoom3D) {
            options.maxZoom = maxZoom3D;
        }
    }

    map.fitBounds(bounds, options);
}

function fitRoute() {
    if (!currentRouteGeoJSON || currentRouteGeoJSON.coordinates.length === 0) {
        if (waypoints.length > 0) {
            const bounds = new maplibregl.LngLatBounds();
            waypoints.forEach(wp => bounds.extend(wp));
            fitBoundsSmart(bounds);
        }
        return;
    }
    const bounds = new maplibregl.LngLatBounds();
    currentRouteGeoJSON.coordinates.forEach(c => bounds.extend(c));
    fitBoundsSmart(bounds);
}

document.getElementById('fit-route-btn').addEventListener('click', fitRoute);
document.getElementById('reverse-route-btn')?.addEventListener('click', reverseRoute);
document.getElementById('current-location-btn')?.addEventListener('click', () => requestLocation(true));
document.getElementById('reset-orientation-btn')?.addEventListener('click', () => {
    map.flyTo({ bearing: 0, pitch: 0, speed: 2.8, curve: 1.4 });
});

// Store last known user coordinates [lng, lat]
let currentUserCoords = null;

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
            mobileScreen.style.display = 'none';
            if (mobileInput) mobileInput.blur();
        }
    }

    function openMobileSearch() {
        if (mobileScreen) {
            mobileScreen.style.display = 'flex';
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

    function escapeSearchHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
    }

    function selectResult(item) {
        const lng = parseFloat(item.lon);
        const lat = parseFloat(item.lat);
        if (isNaN(lng) || isNaN(lat)) return;
        map.flyTo({ center: [lng, lat], zoom: 14, speed: 2.8, curve: 1.4 });
        showWeatherPopup({ lng, lat });
        collapseSearch();
        closeMobileSearch();
    }

    function formatSearchResult(item) {
        const rawName = item.name || (item.display_name ? item.display_name.split(',')[0].trim() : 'Location');
        const addr = item.address || {};
        const subParts = [];
        const loc = addr.suburb || addr.neighbourhood || addr.quarter;
        if (loc && loc !== rawName) subParts.push(loc);
        const city = addr.city || addr.town || addr.village || addr.municipality;
        if (city && city !== rawName && !subParts.includes(city)) subParts.push(city);
        const region = addr.state || addr.country;
        if (region && !subParts.includes(region)) subParts.push(region);

        let subText = subParts.join(', ');
        if (!subText && item.display_name) {
            const parts = item.display_name.split(',').map(s => s.trim());
            subText = parts.slice(1, 4).join(', ');
        }

        let distText = '';
        if (item._distMeters != null && isFinite(item._distMeters) && item._distMeters < 500000) {
            const isImperial = currentUnits !== 'metric';
            if (isImperial) {
                const mi = item._distMeters / 1609.344;
                distText = mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
            } else {
                const km = item._distMeters / 1000;
                distText = km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
            }
        }

        return { name: rawName, subText, distText };
    }

    function createResultRow(item, onSelect) {
        const { name, subText, distText } = formatSearchResult(item);
        const row = document.createElement('div');
        row.className = 'search-result-row';
        row.innerHTML = `
            <div style="font-weight: 600; font-size: 0.92rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeSearchHtml(name)}</div>
            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeSearchHtml(subText)}</span>
                ${distText ? `<span style="font-weight: 500; color: var(--primary); white-space: nowrap; flex-shrink: 0;">${distText}</span>` : ''}
            </div>
        `;
        row.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelect(item);
        });
        return row;
    }

    // Search cache and request cancellation for snappy search results
    const searchCache = new Map();
    let searchAbortController = null;

    async function searchLocations(query) {
        if (!query || query.trim().length < 2) return [];
        const cleanQuery = query.trim();

        // Check if query is GPS coordinate format: "lat, lng" or "lat lng"
        const coordMatch = cleanQuery.match(/^([+-]?\d+(?:\.\d+)?)[,\s]+([+-]?\d+(?:\.\d+)?)$/);
        if (coordMatch) {
            const val1 = parseFloat(coordMatch[1]);
            const val2 = parseFloat(coordMatch[2]);
            let lat = null, lng = null;
            if (val1 >= -90 && val1 <= 90 && val2 >= -180 && val2 <= 180) {
                lat = val1; lng = val2;
            } else if (val2 >= -90 && val2 <= 90 && val1 >= -180 && val1 <= 180) {
                lat = val2; lng = val1;
            }
            if (lat !== null && lng !== null) {
                return [{
                    name: `Coordinates (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
                    display_name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
                    lat: lat.toString(),
                    lon: lng.toString(),
                    address: {}
                }];
            }
        }

        // Reference point for local proximity ranking & biasing
        let refPoint = null;
        if (currentUserCoords && Array.isArray(currentUserCoords) && currentUserCoords.length >= 2) {
            refPoint = { lng: currentUserCoords[0], lat: currentUserCoords[1] };
        } else if (typeof map !== 'undefined' && map.getCenter) {
            const center = map.getCenter();
            if (center) refPoint = { lng: center.lng, lat: center.lat };
        }

        const cacheKey = `${cleanQuery.toLowerCase()}_${refPoint ? `${refPoint.lng.toFixed(2)},${refPoint.lat.toFixed(2)}` : ''}`;
        if (searchCache.has(cacheKey)) {
            return searchCache.get(cacheKey);
        }

        // Cancel previous pending search request immediately so results don't lag or conflict
        if (searchAbortController) {
            searchAbortController.abort();
        }
        searchAbortController = new AbortController();
        const signal = searchAbortController.signal;

        // Fast endpoint: Photon (Komoot search index built for OSM autocomplete, <250ms)
        const queryPhoton = async () => {
            let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQuery)}&limit=8`;
            if (refPoint) {
                url += `&lat=${refPoint.lat.toFixed(4)}&lon=${refPoint.lng.toFixed(4)}`;
            }
            const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } });
            if (!res.ok) return [];
            const data = await res.json();
            if (!data || !data.features || !data.features.length) return [];

            return data.features.map(f => {
                const p = f.properties || {};
                const c = f.geometry?.coordinates || [];
                const subParts = [];
                if (p.district && p.district !== p.name) subParts.push(p.district);
                if (p.city && p.city !== p.name && !subParts.includes(p.city)) subParts.push(p.city);
                if (p.state && !subParts.includes(p.state)) subParts.push(p.state);
                if (p.country && !subParts.includes(p.country)) subParts.push(p.country);

                return {
                    name: p.name || p.street || 'Location',
                    display_name: [p.name, ...subParts].filter(Boolean).join(', '),
                    lon: c[0]?.toString(),
                    lat: c[1]?.toString(),
                    address: {
                        suburb: p.district,
                        city: p.city || p.town || p.village,
                        state: p.state,
                        country: p.country
                    }
                };
            });
        };

        // Fallback endpoint: Nominatim with soft viewbox bias (non-restricted)
        const queryNominatim = async () => {
            let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cleanQuery)}&limit=8&addressdetails=1`;
            if (typeof map !== 'undefined' && map.getBounds) {
                const b = map.getBounds();
                if (b) {
                    const west = Math.max(-180, Math.min(180, b.getWest()));
                    const east = Math.max(-180, Math.min(180, b.getEast()));
                    const south = Math.max(-85, Math.min(85, b.getSouth()));
                    const north = Math.max(-85, Math.min(85, b.getNorth()));
                    if (isFinite(west) && isFinite(east) && isFinite(south) && isFinite(north) && west < east && south < north) {
                        url += `&viewbox=${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)},${south.toFixed(4)}`;
                    }
                }
            }
            const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        };

        try {
            // Attempt fast autocomplete index first; fallback to Nominatim if empty
            let items = [];
            try {
                items = await queryPhoton();
            } catch (photonErr) {
                if (photonErr.name === 'AbortError') throw photonErr;
                items = [];
            }

            if (!items || items.length === 0) {
                items = await queryNominatim();
            }
            if (!items || !items.length) return [];

            if (refPoint) {
                items.forEach(item => {
                    const itemLng = parseFloat(item.lon);
                    const itemLat = parseFloat(item.lat);
                    if (!isNaN(itemLng) && !isNaN(itemLat)) {
                        item._distMeters = haversineDistance([refPoint.lng, refPoint.lat], [itemLng, itemLat]);
                    } else {
                        item._distMeters = Infinity;
                    }
                });
                items.sort((a, b) => (a._distMeters || Infinity) - (b._distMeters || Infinity));
            }

            if (searchCache.size > 80) searchCache.clear();
            searchCache.set(cacheKey, items);
            return items;
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn('Search query failed:', err);
            }
            return [];
        }
    }

    function renderDropdown(results) {
        dropdown.innerHTML = '';
        currentResults = results || [];
        if (!currentResults.length) { closeDropdown(); return; }
        currentResults.forEach((item) => {
            const row = createResultRow(item, selectResult);
            row.addEventListener('mousedown', (e) => e.preventDefault()); // Prevent blur before click
            dropdown.appendChild(row);
        });
        dropdown.style.display = 'block';
    }

    async function fetchSuggestions(query) {
        const data = await searchLocations(query);
        if (data && data.length) {
            renderDropdown(data);
        } else if (input.value.trim().length >= 2) {
            closeDropdown();
        }
    }

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const q = input.value.trim();
        if (q.length < 2) {
            if (searchAbortController) searchAbortController.abort();
            closeDropdown();
            return;
        }
        debounceTimer = setTimeout(() => fetchSuggestions(q), 140);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (currentResults.length > 0) selectResult(currentResults[0]);
        } else if (e.key === 'Escape') {
            collapseSearch();
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(closeDropdown, 150);
    });

    // Mobile Search Input & Event Handlers
    let mobileResults = [];
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
                if (searchAbortController) searchAbortController.abort();
                if (mobileDropdown) {
                    mobileDropdown.innerHTML = '';
                    mobileDropdown.style.display = 'none';
                }
                mobileResults = [];
                return;
            }
            debounceTimer = setTimeout(async () => {
                const data = await searchLocations(q);
                mobileResults = data;
                if (mobileDropdown) {
                    mobileDropdown.innerHTML = '';
                    if (!data.length) {
                        mobileDropdown.style.display = 'none';
                        return;
                    }
                    data.forEach((item) => {
                        const row = createResultRow(item, selectResult);
                        mobileDropdown.appendChild(row);
                    });
                    mobileDropdown.style.display = 'flex';
                }
            }, 140);
        });

        mobileInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (mobileResults.length > 0) {
                    selectResult(mobileResults[0]);
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
            mobileResults = [];
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
    if (isLiveNavActive) return;
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
        if (key === 'escape' || key === 'esc') {
            currentKeybindings[activeCaptureKey] = '';
        } else {
            // Check for duplicate keybindings
            let duplicateAction = null;
            Object.keys(currentKeybindings).forEach(act => {
                if (act !== activeCaptureKey && currentKeybindings[act] && currentKeybindings[act] === key) {
                    duplicateAction = act;
                }
            });

            if (duplicateAction) {
                let keyName = key.length === 1 ? key.toUpperCase() : (key.charAt(0).toUpperCase() + key.slice(1));
                if (key === ' ') keyName = 'Space';
                const actionName = ACTION_NAMES[duplicateAction] || duplicateAction;
                alert(`"${keyName}" is already bound to ${actionName}.`);
            } else {
                currentKeybindings[activeCaptureKey] = key;
            }
        }
        activeCaptureKey = null;
        renderKeybindings();
        updateAllButtonTooltips();
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

    // Localhost Debug Mode toggle: 'd'
    if (key === 'd') {
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '0.0.0.0';
        if (isLocalhost) {
            e.preventDefault();
            isAngleDebugMode = !isAngleDebugMode;
            updateAngleDebugDisplay();
            showToast(isAngleDebugMode ? 'Debug Mode: Turn Angles ON' : 'Debug Mode: Turn Angles OFF', isAngleDebugMode ? 'success' : 'info');
            return;
        }
    }

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
        map.flyTo({ bearing: 0, pitch: 0, speed: 2.8, curve: 1.4 });
    } else if (key === currentKeybindings.centerLocation) {
        e.preventDefault();
        requestLocation(true);
    }
}, true);

function updateWaypointIconsOnChart() {
    if (!elevationChart || !elevationChart.data?.datasets?.[1] || waypoints.length === 0) return;
    const wpStyles = [];
    for (let i = 0; i < waypoints.length; i++) {
        wpStyles.push(getWpIconImage(i, waypoints.length));
    }
    elevationChart.data.datasets[1].pointStyle = wpStyles;
    elevationChart.update('none');
}

document.getElementById('waypoint-style-select')?.addEventListener('change', (e) => {
    localStorage.setItem('route_waypoint_style', e.target.value);
    refreshMarkerIcons();
    clearWpIconsCache();
    updateWaypointIconsOnChart();
});

document.getElementById('show-distance-markers-check')?.addEventListener('change', (e) => {
    localStorage.setItem('route_show_distance_markers', e.target.checked ? 'true' : 'false');
    updateDistanceMarkers();
});

document.getElementById('nav-vibration-check')?.addEventListener('change', (e) => {
    localStorage.setItem('route_nav_vibration', e.target.checked ? 'true' : 'false');
});

document.getElementById('high-perf-check')?.addEventListener('change', (e) => {
    isHighPerformance = e.target.checked;
    localStorage.setItem('route_high_performance', isHighPerformance ? 'true' : 'false');
    updateRoute().catch(err => console.error("Error updating route on HP toggle:", err));
});

// Settings Handlers
document.getElementById('theme').addEventListener('change', (e) => {
    const val = e.target.value;
    localStorage.setItem('route_theme', val);
    if (window.applyAppTheme) {
        window.applyAppTheme(val);
    } else {
        const isLight = val === 'light';
        if (isLight) {
            document.body.classList.add('light-mode');
            document.documentElement.classList.add('light-mode');
        } else {
            document.body.classList.remove('light-mode');
            document.documentElement.classList.remove('light-mode');
        }
    }
    const isLightNow = document.body.classList.contains('light-mode');
    if (map && map.getLayer && map.getLayer('bg')) {
        map.setPaintProperty('bg', 'background-color', isLightNow ? '#ffffff' : '#111111');
    }
    updateChartTheme();
});

// Basemap switching — vector styles swap the whole style; raster use inline style
document.getElementById('basemap').addEventListener('change', (e) => {
    const val = e.target.value;
    currentBasemap = val;
    localStorage.setItem('route_basemap', val);

    const newStyle = VECTOR_STYLES[val]
        ? VECTOR_STYLES[val]
        : buildRasterStyle(RASTER_BASEMAPS[val] || RASTER_BASEMAPS.osm);

    _activeExtraGradientLayers = 0;
    map.setStyle(newStyle, { diff: false });

    // After a setStyle() call all custom sources/layers are wiped.
    // Re-add them once the new style is ready.
    // We use both 'style.load' AND a fallback timer because inline raster styles
    // or loaded styles can finish synchronously before once() is triggered.
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
    updateDistanceMarkers();

    // Dynamically refresh the weather & elevation popup if it is currently open
    if (currentInfoPopup && currentInfoPopup.isOpen()) {
        showWeatherPopup(currentInfoPopup.getLngLat());
    }
});



// ==========================================
// Multi-Format Route Import & Export Engine
// Supports GPX, FIT (.fit), TCX (.tcx), KML (.kml), GeoJSON (.geojson/.json)
// ==========================================

// Garmin FIT 16-entry CRC table
const FIT_CRC_TABLE = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400
];

function computeFitCRC(crc, byte) {
    let tmp = FIT_CRC_TABLE[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ FIT_CRC_TABLE[byte & 0xF];
    tmp = FIT_CRC_TABLE[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ FIT_CRC_TABLE[(byte >> 4) & 0xF];
    return crc;
}

// Minimal binary FIT course decoder
function parseFITRoute(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 14) throw new Error('File is too short to be a FIT file.');
    const headerSize = view.getUint8(0);
    const tag = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (tag !== '.FIT') throw new Error('Invalid FIT header signature.');

    let offset = headerSize;
    const dataEnd = headerSize + view.getUint32(4, true);
    const localDefs = new Map();
    const coords = [];

    while (offset < dataEnd && offset < view.byteLength) {
        const header = view.getUint8(offset++);
        if ((header & 0x80) !== 0) {
            // Compressed timestamp data message
            const localNum = (header >> 5) & 0x03;
            const def = localDefs.get(localNum);
            if (!def) break;
            offset += def.size;
            continue;
        }

        const isDefinition = (header & 0x40) !== 0;
        const localNum = header & 0x0F;

        if (isDefinition) {
            const hasDevData = (header & 0x20) !== 0;
            offset++; // reserved
            const arch = view.getUint8(offset++);
            const littleEndian = (arch === 0);
            const globalMsgNum = view.getUint16(offset, littleEndian);
            offset += 2;
            const fieldCount = view.getUint8(offset++);
            const fields = [];
            let totalSize = 0;
            for (let f = 0; f < fieldCount; f++) {
                const fNum = view.getUint8(offset++);
                const fSize = view.getUint8(offset++);
                const fBase = view.getUint8(offset++);
                fields.push({ num: fNum, size: fSize, base: fBase, offset: totalSize });
                totalSize += fSize;
            }
            if (hasDevData) {
                const devFieldCount = view.getUint8(offset++);
                for (let d = 0; d < devFieldCount; d++) {
                    offset += 2;
                    const dSize = view.getUint8(offset++);
                    totalSize += dSize;
                }
            }
            localDefs.set(localNum, { globalMsgNum, littleEndian, fields, size: totalSize });
        } else {
            // Data message
            const def = localDefs.get(localNum);
            if (!def) break;
            if (offset + def.size > view.byteLength) break;

            if (def.globalMsgNum === 20) { // Record message
                let lat = null;
                let lon = null;
                let ele = null;
                for (const f of def.fields) {
                    const fPos = offset + f.offset;
                    if (f.num === 0 && f.size === 4) { // position_lat (sint32 semicircles)
                        const val = view.getInt32(fPos, def.littleEndian);
                        if (val !== 0x7FFFFFFF) lat = val * (180 / 2147483648);
                    } else if (f.num === 1 && f.size === 4) { // position_long (sint32 semicircles)
                        const val = view.getInt32(fPos, def.littleEndian);
                        if (val !== 0x7FFFFFFF) lon = val * (180 / 2147483648);
                    } else if (f.num === 2 && f.size === 2) { // altitude (uint16, 5/m - 500m)
                        const val = view.getUint16(fPos, def.littleEndian);
                        if (val !== 0xFFFF) ele = (val / 5) - 500;
                    }
                }
                if (lat != null && lon != null && !isNaN(lat) && !isNaN(lon)) {
                    coords.push(ele != null ? [lon, lat, ele] : [lon, lat]);
                }
            }
            offset += def.size;
        }
    }
    return coords;
}

// Garmin FIT Course builder
function buildFITCourse(coords, elevations, courseName = 'Bike Route') {
    const records = [];
    const baseEpoch = Math.floor(Date.now() / 1000) - 631065600; // FIT Epoch (1989-12-31 00:00:00 UTC)
    let cumulativeDistMeters = 0;

    for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        if (i > 0) {
            const prev = coords[i - 1];
            cumulativeDistMeters += getSegmentDistanceMeters(prev[1], prev[0], c[1], c[0]);
        }
        const timeSec = baseEpoch + Math.round(cumulativeDistMeters / 6.0); // approx 21.6 km/h
        const eleM = elevations?.[i] != null ? elevations[i] : (c[2] != null ? c[2] : 0);
        records.push({
            lon: c[0],
            lat: c[1],
            dist: cumulativeDistMeters,
            ele: eleM,
            time: timeSec
        });
    }

    const payload = [];

    // Definition Msg: File ID (Global 0, Local 0)
    payload.push(
        0x40, 0x00, 0x00, 0x00, 0x00, 0x04,
        0, 1, 0x00,       // type: enum
        1, 2, 0x84,       // manufacturer: uint16
        2, 2, 0x84,       // product: uint16
        4, 4, 0x86        // time_created: uint32
    );
    // Data Msg: File ID (Course = 6)
    const fileIdData = new Uint8Array(9);
    const fidView = new DataView(fileIdData.buffer);
    fidView.setUint8(0, 6); // Course
    fidView.setUint16(1, 1, true); // Garmin
    fidView.setUint16(3, 1, true);
    fidView.setUint32(5, baseEpoch, true);
    payload.push(0x00, ...fileIdData);

    // Definition Msg: Course (Global 31, Local 1)
    payload.push(
        0x41, 0x00, 0x00, 31, 0x00, 0x02,
        4, 1, 0x00,       // sport: enum (2 = cycling)
        5, 16, 0x07       // name: string 16 bytes
    );
    // Data Msg: Course
    const courseData = new Uint8Array(17);
    courseData[0] = 2; // Cycling
    const enc = new TextEncoder().encode(courseName.slice(0, 15));
    courseData.set(enc, 1);
    payload.push(0x01, ...courseData);

    // Definition Msg: Record (Global 20, Local 2)
    payload.push(
        0x42, 0x00, 0x00, 20, 0x00, 0x05,
        253, 4, 0x86,     // timestamp: uint32
        0, 4, 0x85,       // position_lat: sint32
        1, 4, 0x85,       // position_long: sint32
        2, 2, 0x84,       // altitude: uint16
        5, 4, 0x86        // distance: uint32 (cm: meters * 100)
    );

    // Record Data messages
    const recBuf = new Uint8Array(18);
    const recView = new DataView(recBuf.buffer);
    for (const r of records) {
        payload.push(0x02);
        recView.setUint32(0, r.time, true);
        recView.setInt32(4, Math.round(r.lat * (2147483648 / 180)), true);
        recView.setInt32(8, Math.round(r.lon * (2147483648 / 180)), true);
        const altRaw = Math.max(0, Math.min(65534, Math.round((r.ele + 500) * 5)));
        recView.setUint16(12, altRaw, true);
        recView.setUint32(14, Math.round(r.dist * 100), true);
        payload.push(...recBuf);
    }

    const dataBytes = new Uint8Array(payload);
    const header = new Uint8Array(14);
    const hView = new DataView(header.buffer);
    hView.setUint8(0, 14);     // Header size
    hView.setUint8(1, 0x20);   // Protocol 2.0
    hView.setUint16(2, 2132, true); // Profile 21.32
    hView.setUint32(4, dataBytes.length, true);
    header[8] = 0x2E; header[9] = 0x46; header[10] = 0x49; header[11] = 0x54; // '.FIT'

    // Compute header CRC
    let hCrc = 0;
    for (let i = 0; i < 12; i++) hCrc = computeFitCRC(hCrc, header[i]);
    hView.setUint16(12, hCrc, true);

    // Full file CRC
    let fileCrc = 0;
    for (let i = 0; i < header.length; i++) fileCrc = computeFitCRC(fileCrc, header[i]);
    for (let i = 0; i < dataBytes.length; i++) fileCrc = computeFitCRC(fileCrc, dataBytes[i]);

    const result = new Uint8Array(14 + dataBytes.length + 2);
    result.set(header, 0);
    result.set(dataBytes, 14);
    const rView = new DataView(result.buffer);
    rView.setUint16(14 + dataBytes.length, fileCrc, true);
    return result;
}

function getSegmentDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Extract elevation array matching coordinates
function getRouteElevationArray(coords) {
    const chartPts = elevationChart?.data?.datasets?.[0]?.data;
    if (!chartPts || chartPts.length < 2) return null;
    return coords.map((c, i) => {
        const ratio = i / Math.max(1, coords.length - 1);
        const ci = Math.round(ratio * (chartPts.length - 1));
        const displayElev = chartPts[ci]?.y;
        if (displayElev == null) return c[2] != null ? c[2] : 0;
        return currentUnits === 'imperial' ? displayElev / 3.28084 : displayElev;
    });
}

// Unified parser for all route file formats
async function parseRouteData(file) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.fit')) {
        const buffer = await file.arrayBuffer();
        const coords = parseFITRoute(buffer);
        if (coords.length < 2) throw new Error('FIT file contains fewer than 2 coordinate points.');
        return { type: 'track', coords };
    }

    const text = await file.text();
    const trimmed = text.trim();

    // GeoJSON detection by extension or content structure
    if (name.endsWith('.geojson') || name.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const json = JSON.parse(text);
            const coords = [];
            const extractCoords = obj => {
                if (!obj) return;
                if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
                    obj.features.forEach(extractCoords);
                } else if (obj.type === 'Feature' && obj.geometry) {
                    extractCoords(obj.geometry);
                } else if (obj.type === 'LineString' && Array.isArray(obj.coordinates)) {
                    coords.push(...obj.coordinates);
                } else if (obj.type === 'MultiLineString' && Array.isArray(obj.coordinates)) {
                    obj.coordinates.forEach(ls => coords.push(...ls));
                }
            };
            extractCoords(json);
            const valid = coords.filter(c => Array.isArray(c) && !isNaN(c[0]) && !isNaN(c[1]));
            if (valid.length >= 2) return { type: 'track', coords: valid };
        } catch (_) {
            // If JSON parsing fails, fall through to XML/FIT/etc
        }
    }

    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const parserError = xml.querySelector('parsererror');
    if (parserError && !name.endsWith('.kml') && !name.endsWith('.tcx') && !trimmed.includes('<gpx') && !trimmed.includes('<kml')) {
        // Check if maybe it's binary FIT file with different extension
        try {
            const buffer = await file.arrayBuffer();
            const coords = parseFITRoute(buffer);
            if (coords && coords.length >= 2) return { type: 'track', coords };
        } catch (_) {}
        throw new Error('Could not parse route file. Supported formats: GPX, FIT, TCX, KML, GeoJSON.');
    }

    // TCX Format
    const trackpoints = [...xml.querySelectorAll('Trackpoint')];
    if (trackpoints.length > 0) {
        const coords = [];
        trackpoints.forEach(tp => {
            const latEl = tp.querySelector('LatitudeDegrees');
            const lonEl = tp.querySelector('LongitudeDegrees');
            const altEl = tp.querySelector('AltitudeMeters');
            if (latEl && lonEl) {
                const lat = parseFloat(latEl.textContent.trim());
                const lon = parseFloat(lonEl.textContent.trim());
                const ele = altEl ? parseFloat(altEl.textContent.trim()) : null;
                if (!isNaN(lat) && !isNaN(lon)) {
                    coords.push(ele != null && !isNaN(ele) ? [lon, lat, ele] : [lon, lat]);
                }
            }
        });
        if (coords.length >= 2) return { type: 'track', coords };
    }

    // KML Format
    const coordNodes = [...xml.querySelectorAll('coordinates')];
    if (coordNodes.length > 0) {
        const coords = [];
        coordNodes.forEach(node => {
            const raw = node.textContent.trim().split(/\s+/);
            raw.forEach(tuple => {
                const parts = tuple.split(',').map(p => parseFloat(p.trim()));
                if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                    coords.push(parts.length >= 3 && !isNaN(parts[2]) ? [parts[0], parts[1], parts[2]] : [parts[0], parts[1]]);
                }
            });
        });
        if (coords.length >= 2) return { type: 'track', coords };
    }

    // GPX Tracks
    const trkpts = [...xml.querySelectorAll('trkpt')];
    if (trkpts.length > 0) {
        const coords = trkpts
            .map(pt => {
                const lon = parseFloat(pt.getAttribute('lon'));
                const lat = parseFloat(pt.getAttribute('lat'));
                const eleEl = pt.querySelector('ele');
                const ele = eleEl ? parseFloat(eleEl.textContent) : null;
                return (ele != null && !isNaN(ele)) ? [lon, lat, ele] : [lon, lat];
            })
            .filter(c => !isNaN(c[0]) && !isNaN(c[1]));
        if (coords.length >= 2) return { type: 'track', coords };
    }

    // GPX Route / Waypoints
    const rtepts = [...xml.querySelectorAll('rtept')];
    const wpts = [...xml.querySelectorAll('wpt')];
    const pts = rtepts.length > 0 ? rtepts : wpts;
    if (pts.length >= 2) {
        const markers = pts.map(pt => ({
            lat: parseFloat(pt.getAttribute('lat')),
            lng: parseFloat(pt.getAttribute('lon'))
        })).filter(m => !isNaN(m.lat) && !isNaN(m.lng));
        if (markers.length >= 2) return { type: 'waypoints', markers };
    }

    throw new Error('No recognized route or track data found in file.');
}

// Master Import Function
async function importRouteFile(file) {
    try {
        const result = await parseRouteData(file);

        // Clear current route
        waypoints = [];
        markers.forEach(m => m.remove());
        markers = [];
        segmentModes = [];
        segmentGPXPaths = [];
        currentRouteGeoJSON = null;

        if (result.type === 'track') {
            const coords = result.coords;
            createMarker({ lng: coords[0][0], lat: coords[0][1] });
            createMarker({ lng: coords[coords.length - 1][0], lat: coords[coords.length - 1][1] });

            segmentModes = ['gpx'];
            segmentGPXPaths = [coords.map(c => [c[0], c[1]])];

            await updateRoute();

            const bounds = new maplibregl.LngLatBounds();
            coords.forEach(c => bounds.extend([c[0], c[1]]));
            fitBoundsSmart(bounds, { maxZoom: 17, duration: 700 });
        } else if (result.type === 'waypoints') {
            result.markers.forEach(pt => createMarker({ lng: pt.lng, lat: pt.lat }));
            updateRoute();
        }
    } catch (err) {
        console.error('Route import error:', err);
        alert('Failed to import route file: ' + (err.message || 'Unsupported format.'));
    }
}

// Master Export Function
function openDownloadModal() {
    if (!currentRouteGeoJSON || !currentRouteGeoJSON.coordinates?.length) {
        showToast('No route to download.', 'warning');
        return;
    }

    const format = localStorage.getItem('route_export_format') || 'gpx';
    const modal = document.getElementById('download-modal');
    const input = document.getElementById('download-filename-input');
    const extLabel = document.getElementById('download-extension-label');

    if (!modal) {
        exportRoute(format, 'bike-route');
        return;
    }

    if (extLabel) extLabel.textContent = `.${format}`;
    if (input) {
        input.value = 'bike-route';
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);
    }

    modal.style.display = 'flex';
}

function closeDownloadModal() {
    const modal = document.getElementById('download-modal');
    if (modal) modal.style.display = 'none';
}

function exportRoute(format = 'gpx', customTitle = 'bike-route') {
    if (!currentRouteGeoJSON || !currentRouteGeoJSON.coordinates?.length) {
        showToast('No route to download.', 'warning');
        return;
    }

    const coords = currentRouteGeoJSON.coordinates;
    const elevations = getRouteElevationArray(coords);
    let title = (customTitle || 'bike-route').trim().replace(/[/\\?%*:|"<>]/g, '_');
    if (!title) title = 'bike-route';

    let blob;
    let mimeType;

    if (format === 'fit') {
        const fitBytes = buildFITCourse(coords, elevations, title);
        mimeType = 'application/octet-stream';
        blob = new Blob([fitBytes], { type: mimeType });
    } else if (format === 'tcx') {
        const tcx = buildTCX(coords, elevations, title);
        mimeType = 'application/vnd.garmin.tcx+xml';
        blob = new Blob([tcx], { type: mimeType });
    } else if (format === 'kml') {
        const kml = buildKML(coords, elevations, title);
        mimeType = 'application/vnd.google-earth.kml+xml';
        blob = new Blob([kml], { type: mimeType });
    } else if (format === 'geojson') {
        const geojson = buildGeoJSON(coords, elevations);
        mimeType = 'application/geo+json';
        blob = new Blob([geojson], { type: mimeType });
    } else {
        // GPX fallback
        const gpx = buildGPX(coords, elevations, title);
        mimeType = 'application/gpx+xml';
        blob = new Blob([gpx], { type: mimeType });
    }

    triggerDownload(blob, `${title}.${format}`, mimeType);
}

async function triggerDownload(blob, filename, mimeType = 'application/octet-stream') {
    // 1. Android native DownloadManager / MediaStore Downloads folder with system notification
    if (window.AndroidMaterialTheme && typeof window.AndroidMaterialTheme.saveToDownloads === 'function') {
        try {
            const reader = new FileReader();
            const base64Promise = new Promise((resolve, reject) => {
                reader.onloadend = () => {
                    const res = reader.result;
                    const b64 = res.split(',')[1] || res;
                    resolve(b64);
                };
                reader.onerror = reject;
            });
            reader.readAsDataURL(blob);
            const base64Data = await base64Promise;

            const resStr = window.AndroidMaterialTheme.saveToDownloads(filename, base64Data, mimeType);
            const parsed = JSON.parse(resStr || '{}');
            if (parsed && parsed.success) {
                showToast(`Downloaded ${filename} to Downloads folder`, 'success');
                return;
            }
        } catch (err) {
            console.warn('Native saveToDownloads failed, trying fallbacks:', err);
        }
    }

    // 2. Capacitor Filesystem fallback
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
        try {
            const { Filesystem } = window.Capacitor.Plugins;
            const reader = new FileReader();
            const base64Promise = new Promise((resolve, reject) => {
                reader.onloadend = () => {
                    const result = reader.result;
                    const base64 = result.split(',')[1] || result;
                    resolve(base64);
                };
                reader.onerror = reject;
            });
            reader.readAsDataURL(blob);
            const base64Data = await base64Promise;

            await Filesystem.writeFile({
                path: filename,
                data: base64Data,
                directory: 'DOCUMENTS'
            });
            showToast(`Saved ${filename} to Documents`, 'success');
            return;
        } catch (err) {
            console.warn('Filesystem fallback failed, falling back to browser download:', err);
        }
    }

    // 3. Standard browser fallback
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast(`Downloading ${filename}...`, 'info');
}

function buildGPX(coords, elevations, name = 'Bike Route') {
    // If route contains transit segments, split into multiple <trkseg> blocks omitting transit spans
    const trksegs = [];
    if (waypointPathIndices && waypointPathIndices.length >= 2 && segmentModes.some(m => m === 'transit')) {
        let currentSegPts = [];
        for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
            const mode = segmentModes[segI] || 'bike';
            const sStart = waypointPathIndices[segI];
            const sEnd = waypointPathIndices[segI + 1];

            if (mode === 'transit') {
                if (currentSegPts.length > 0) {
                    trksegs.push(currentSegPts);
                    currentSegPts = [];
                }
            } else {
                const startPtIdx = (currentSegPts.length > 0) ? sStart + 1 : sStart;
                for (let i = startPtIdx; i <= sEnd; i++) {
                    const c = coords[i];
                    if (!c) continue;
                    const ele = elevations?.[i] != null ? elevations[i] : (c[2] != null ? c[2] : null);
                    const eleTag = ele != null ? `\n        <ele>${Number(ele).toFixed(1)}</ele>` : '';
                    currentSegPts.push(`      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${eleTag}\n      </trkpt>`);
                }
            }
        }
        if (currentSegPts.length > 0) {
            trksegs.push(currentSegPts);
        }
    } else {
        const trkpts = coords.map((c, i) => {
            const ele = elevations?.[i] != null ? elevations[i] : (c[2] != null ? c[2] : null);
            const eleTag = ele != null ? `\n        <ele>${Number(ele).toFixed(1)}</ele>` : '';
            return `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${eleTag}\n      </trkpt>`;
        });
        trksegs.push(trkpts);
    }

    const trksegXml = trksegs.map(pts => `    <trkseg>\n${pts.join('\n')}\n    </trkseg>`).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike Route Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
${trksegXml}
  </trk>
</gpx>`;
}

function buildTCX(coords, elevations, name = 'Bike Route') {
    const baseTime = new Date();
    let cumulativeDist = 0;

    const trackpoints = coords.map((c, i) => {
        if (i > 0 && !isTransitSegment(i - 1)) {
            const prev = coords[i - 1];
            cumulativeDist += getSegmentDistanceMeters(prev[1], prev[0], c[1], c[0]);
        }
        if (isTransitPoint(i)) return null;
        const ptTime = new Date(baseTime.getTime() + Math.round((cumulativeDist / 6.0) * 1000)).toISOString();
        const ele = elevations?.[i] != null ? elevations[i] : (c[2] != null ? c[2] : 0);
        return `          <Trackpoint>
            <Time>${ptTime}</Time>
            <Position>
              <LatitudeDegrees>${c[1].toFixed(6)}</LatitudeDegrees>
              <LongitudeDegrees>${c[0].toFixed(6)}</LongitudeDegrees>
            </Position>
            <AltitudeMeters>${Number(ele).toFixed(1)}</AltitudeMeters>
            <DistanceMeters>${cumulativeDist.toFixed(1)}</DistanceMeters>
          </Trackpoint>`;
    }).filter(Boolean).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Courses>
    <Course>
      <Name>${name}</Name>
      <Lap>
        <TotalTimeSeconds>${Math.round(cumulativeDist / 6.0)}</TotalTimeSeconds>
        <DistanceMeters>${cumulativeDist.toFixed(1)}</DistanceMeters>
        <BeginPosition>
          <LatitudeDegrees>${coords[0][1].toFixed(6)}</LatitudeDegrees>
          <LongitudeDegrees>${coords[0][0].toFixed(6)}</LongitudeDegrees>
        </BeginPosition>
        <EndPosition>
          <LatitudeDegrees>${coords[coords.length - 1][1].toFixed(6)}</LatitudeDegrees>
          <LongitudeDegrees>${coords[coords.length - 1][0].toFixed(6)}</LongitudeDegrees>
        </EndPosition>
        <Intensity>Active</Intensity>
      </Lap>
      <Track>
${trackpoints}
      </Track>
    </Course>
  </Courses>
</TrainingCenterDatabase>`;
}

function buildKML(coords, elevations, name = 'Bike Route') {
    const coordinatesStr = coords.map((c, i) => {
        const ele = elevations?.[i] != null ? elevations[i] : (c[2] != null ? c[2] : 0);
        return `${c[0].toFixed(6)},${c[1].toFixed(6)},${Number(ele).toFixed(1)}`;
    }).join(' ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${name}</name>
    <Placemark>
      <name>${name}</name>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coordinatesStr}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}

function buildGeoJSON(coords, elevations) {
    const coordinates3D = coords.map((c, i) => {
        const ele = elevations?.[i] != null ? elevations[i] : (c[2] != null ? c[2] : 0);
        return [Number(c[0].toFixed(6)), Number(c[1].toFixed(6)), Number(Number(ele).toFixed(1))];
    });

    const data = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: {
                    name: 'Bike Route',
                    generator: 'Bike Route Planner'
                },
                geometry: {
                    type: 'LineString',
                    coordinates: coordinates3D
                }
            }
        ]
    };
    return JSON.stringify(data, null, 2);
}

// Backward compatibility alias
function downloadGPX() {
    exportRoute('gpx');
}
function importGPX(file) {
    importRouteFile(file);
}

function refreshMarkerPositions() {
    if (typeof markers !== 'undefined' && Array.isArray(markers)) {
        markers.forEach(m => {
            if (m && typeof m.setLngLat === 'function') {
                const ll = m.getLngLat();
                if (ll) m.setLngLat(ll);
            }
        });
    }
    if (typeof userLocationMarker !== 'undefined' && userLocationMarker && typeof userLocationMarker.setLngLat === 'function') {
        const ull = userLocationMarker.getLngLat();
        if (ull) userLocationMarker.setLngLat(ull);
    }
    if (window._dragPreviewMarker && window._dragPreviewMarker._added) {
        const dll = window._dragPreviewMarker.getLngLat();
        if (dll) window._dragPreviewMarker.setLngLat(dll);
    }
    if (map && typeof map.triggerRepaint === 'function') {
        map.triggerRepaint();
    }
}

function applyTerrain() {
    const val = document.getElementById('hillshade-select')?.value || 'off';
    const exInput = document.getElementById('terrain-exaggeration');

    localStorage.setItem('route_hillshade', val);
    let exVal = parseFloat(exInput ? exInput.value : 2.0);
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
        // Keep hillshade visible along with 3D terrain using separate sources to prevent warnings
        map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
        map.setPaintProperty('hillshade-layer', 'hillshade-exaggeration', 0.5);
        map.setTerrain({ source: 'terrain-source', exaggeration: exVal });
    }

    rebuildMapGradient();
    needsElevationUpdate = true;
    if (typeof updateElevationProfile === 'function') updateElevationProfile();
    refreshMarkerPositions();
    requestAnimationFrame(refreshMarkerPositions);
    setTimeout(refreshMarkerPositions, 60);
    setTimeout(refreshMarkerPositions, 180);
    setTimeout(refreshMarkerPositions, 350);
}

function setRoutingMode(mode) {
    currentRoutingMode = mode;
    localStorage.setItem('route_routing_mode', mode);
    const displayMode = mode === 'gpx' ? 'bike' : mode;
    document.getElementById('mode-bike')?.classList.toggle('active', displayMode === 'bike');
    document.getElementById('mode-direct')?.classList.toggle('active', displayMode === 'direct');
    document.getElementById('mode-hike')?.classList.toggle('active', displayMode === 'hike');
    document.getElementById('mode-transit')?.classList.toggle('active', displayMode === 'transit');
}

function cycleRoutingMode() {
    let nextMode = 'bike';
    if (currentRoutingMode === 'bike') nextMode = 'direct';
    else if (currentRoutingMode === 'direct') nextMode = 'transit';
    else if (currentRoutingMode === 'transit') nextMode = 'hike';
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
document.getElementById('mode-transit')?.addEventListener('click', () => {
    if (window.innerWidth <= 768) cycleRoutingMode();
    else setRoutingMode('transit');
});

document.getElementById('hillshade-select')?.addEventListener('change', applyTerrain);
const terrainExEl = document.getElementById('terrain-exaggeration');
if (terrainExEl) {
    terrainExEl.addEventListener('input', applyTerrain);
    terrainExEl.addEventListener('change', applyTerrain);
}
map.on('terrain', refreshMarkerPositions);

function updateStatsToggleBtn() {
    const panel = document.getElementById('stats-panel');
    const totalDistBtn = document.getElementById('total-distance');
    if (panel && totalDistBtn) {
        const visible = panel.classList.contains('show');
        totalDistBtn.classList.toggle('active', visible);
        const key = (currentKeybindings?.toggleStats || 'r').toUpperCase();
        totalDistBtn.title = `Click to view detailed route statistics (${key})`;
    }
}

function toggleSettings(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('settings-menu');
    const isShowing = menu.classList.toggle('show');
    if (isShowing) {
        clearHoverHighlight(true);
        hideHoverMarker();
    }
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
const brandLogoBtn = document.getElementById('brand-logo-btn');
if (brandLogoBtn) {
    const isNativeApp = Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    if (isNativeApp) {
        brandLogoBtn.setAttribute('href', 'javascript:void(0)');
        brandLogoBtn.setAttribute('title', 'Reload app');
        brandLogoBtn.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.reload();
        });
    } else {
        brandLogoBtn.setAttribute('href', 'https://ioncook.github.io');
        brandLogoBtn.setAttribute('title', 'Go to Homepage');
    }
}
document.getElementById('close-stats-btn')?.addEventListener('click', (e) => {
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
        let maxUpGrade = -Infinity;
        let maxDownGrade = Infinity;

        for (let i = 0; i < smoothedSegmentGrades.length; i++) {
            if (isTransitPoint(i) || isTransitSegment(i)) continue;
            const grade = smoothedSegmentGrades[i];
            if (grade == null || isNaN(grade)) continue;
            if (grade > 0.5) {
                upSum += grade;
                upCount++;
            } else if (grade < -0.5) {
                downSum += grade;
                downCount++;
            }
            if (grade > maxUpGrade) maxUpGrade = grade;
            if (grade < maxDownGrade) maxDownGrade = grade;
        }
        const avgUpVal = upCount > 0 ? (upSum / upCount) : 0;
        const avgDownVal = downCount > 0 ? (downSum / downCount) : 0;

        upEl.textContent = `+${avgUpVal.toFixed(1)}%`;
        upEl.style.color = getColorForGrade(avgUpVal);

        downEl.textContent = `${avgDownVal.toFixed(1)}%`;
        downEl.style.color = getColorForGrade(avgDownVal);

        maxUpEl.textContent = (maxUpGrade >= 0 ? '+' : '') + maxUpGrade.toFixed(1) + '%';
        maxUpEl.style.color = getColorForGrade(maxUpGrade);

        maxDownEl.textContent = (maxDownGrade >= 0 ? '+' : '') + maxDownGrade.toFixed(1) + '%';
        maxDownEl.style.color = getColorForGrade(maxDownGrade);
    } else {
        upEl.textContent = '--'; upEl.style.color = '';
        downEl.textContent = '--'; downEl.style.color = '';
        maxUpEl.textContent = '--'; maxUpEl.style.color = '';
        maxDownEl.textContent = '--'; maxDownEl.style.color = '';
    }

    // Setup interactive map hovers & 30-60fps unified frame loop
    const hoverTargets = [
        { id: 'stats-min', getIdx: () => currentStats.minIdx },
        { id: 'stats-max', getIdx: () => currentStats.maxIdx },
        { id: 'stats-max-up', getIdx: () => currentStats.maxUpIdx },
        { id: 'stats-max-down', getIdx: () => currentStats.maxDownIdx }
    ];

    hoverTargets.forEach(({ id, getIdx }) => {
        const el = document.getElementById(id);
        if (!el || el._hasStatListeners) return;
        el._hasStatListeners = true;

        function triggerStatHover(ci) {
            if (isDraggingWindow || isDraggingStats || isResizing) return;
            if (ci !== undefined && ci >= 0 && currentRouteGeoJSON && currentRouteGeoJSON.coordinates && currentRouteGeoJSON.coordinates.length > ci) {
                activeStatIdx = ci;
                ensureHoverFrameLoopRunning();
                const coords = currentRouteGeoJSON.coordinates;
                const lngLat = coords[ci];
                const screenPt = getOffsetScreenPt(ci);
                updateHoverHighlight(ci, 0, lngLat, screenPt);
            }
        }

        // Desktop hover preview
        el.addEventListener('mouseenter', () => {
            const ci = getIdx();
            triggerStatHover(ci);
        });

        el.addEventListener('mouseleave', () => {
            if ('ontouchstart' in window && isFlyToActive) return;
            activeStatIdx = -1;
            isFlyToActive = false;
            clearHoverHighlight(true);
        });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        function getTerrainExaggeration() {
            if (!map || !map.getTerrain()) return 1.0;
            const exInput = document.getElementById('terrain-exaggeration');
            const stored = localStorage.getItem('route_exaggeration');
            const val = parseFloat(stored || (exInput ? exInput.value : '2.0'));
            return (isNaN(val) || val < 0) ? 1.0 : val;
        }

        function flyToStatPoint(ci) {
            if (isDraggingWindow || isResizing) return;
            if (ci === undefined || ci < 0 || !currentRouteGeoJSON || !currentRouteGeoJSON.coordinates || currentRouteGeoJSON.coordinates.length <= ci) return;
            activeStatIdx = ci;
            ensureHoverFrameLoopRunning();
            isFlyToActive = true;
            const lngLat = currentRouteGeoJSON.coordinates[ci];

            let elev = 0;
            if (map && typeof map.queryTerrainElevation === 'function') {
                const tElev = map.queryTerrainElevation(lngLat);
                if (tElev !== null && tElev !== undefined && !isNaN(tElev)) {
                    elev = tElev;
                }
            }
            if (!elev && elevationChart && elevationChart.data && elevationChart.data.datasets && elevationChart.data.datasets[0]) {
                const chartPts = elevationChart.data.datasets[0].data;
                if (chartPts && chartPts[ci] && typeof chartPts[ci].y === 'number') {
                    elev = chartPts[ci].y;
                }
            }
            if (!elev && Array.isArray(lngLat) && lngLat.length >= 3 && typeof lngLat[2] === 'number') {
                elev = lngLat[2];
            }

            const is3D = (map && map.getTerrain && map.getTerrain()) ||
                (document.getElementById('hillshade-select')?.value === 'terrain');

            let targetZoom = 16;
            if (is3D) {
                const exaggeration = getTerrainExaggeration();
                const effectiveElev = (elev && !isNaN(elev)) ? Math.max(0, elev * exaggeration) : 0;
                // Base desired zoom at sea level is 16 (ref camera height ~350m).
                // Compensate target zoom for local exaggerated terrain height so camera maintains ~350m clearance above ground:
                const zoomCorrection = Math.log2(1 + (effectiveElev / 350));
                targetZoom = Math.max(10, Math.min(16, 16 - zoomCorrection));
            }

            map.flyTo({
                center: [lngLat[0], lngLat[1]],
                zoom: targetZoom,
                speed: 2.8,
                curve: 1.4,
                essential: true
            });
        }

        // Mobile touch & long-press handling
        let touchTimer = null;
        let isLongPress = false;

        el.addEventListener('touchstart', () => {
            isLongPress = false;
            const ci = getIdx();
            triggerStatHover(ci);
            if (touchTimer) clearTimeout(touchTimer);
            touchTimer = setTimeout(() => {
                isLongPress = true;
                const ci = getIdx();
                flyToStatPoint(ci);
                if (navigator.vibrate) try { navigator.vibrate(35); } catch (_) { }
            }, 350);
        }, { passive: true });

        el.addEventListener('touchend', () => {
            if (touchTimer) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
        });

        el.addEventListener('touchmove', () => {
            if (touchTimer) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
        }, { passive: true });

        // Desktop click handling
        el.addEventListener('click', () => {
            const isMobileTouch = 'ontouchstart' in window && window.innerWidth <= 768;
            if (!isMobileTouch && !isLongPress) {
                const ci = getIdx();
                flyToStatPoint(ci);
            }
        });
    });
    updateDistanceMarkers();
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

    // Export format setting — default to 'gpx'
    const savedExportFormat = localStorage.getItem('route_export_format') || 'gpx';
    const exportSelect = document.getElementById('export-format-select');
    if (exportSelect) {
        exportSelect.value = savedExportFormat;
        exportSelect.addEventListener('change', (e) => {
            localStorage.setItem('route_export_format', e.target.value);
            const dlBtn = document.getElementById('gpx-download-btn');
            if (dlBtn) {
                dlBtn.title = `Download Route (.${e.target.value})`;
            }
        });
        const dlBtn = document.getElementById('gpx-download-btn');
        if (dlBtn) {
            dlBtn.title = `Download Route (.${savedExportFormat})`;
        }
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
    const waypointStyle = localStorage.getItem('route_waypoint_style') || 'circle';
    const wpStyleEl = document.getElementById('waypoint-style-select');
    if (wpStyleEl) {
        wpStyleEl.value = waypointStyle;
    }

    const showDistanceMarkersVal = localStorage.getItem('route_show_distance_markers');
    const distanceMarkersEl = document.getElementById('show-distance-markers-check');
    if (distanceMarkersEl) {
        distanceMarkersEl.checked = showDistanceMarkersVal !== null ? showDistanceMarkersVal === 'true' : false;
    }

    const navVibrationVal = localStorage.getItem('route_nav_vibration');
    const navVibrationEl = document.getElementById('nav-vibration-check');
    if (navVibrationEl) {
        navVibrationEl.checked = navVibrationVal !== null ? navVibrationVal === 'true' : true;
    }

    const highPerfVal = localStorage.getItem('route_high_performance');
    const highPerfEl = document.getElementById('high-perf-check');
    if (highPerfEl) {
        isHighPerformance = highPerfVal === 'true';
        highPerfEl.checked = isHighPerformance;
    }

    updateUserLocationPin();
    updateDistanceMarkers();

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

// Wire up Route Import / Export buttons
const downloadBtn = document.getElementById('gpx-download-btn');

document.getElementById('gpx-import-btn')?.addEventListener('click', () => {
    document.getElementById('gpx-file-input').click();
});
document.getElementById('gpx-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) { importRouteFile(file); e.target.value = ''; }
});

downloadBtn?.addEventListener('click', () => {
    openDownloadModal();
});

document.getElementById('download-modal-close')?.addEventListener('click', closeDownloadModal);
document.getElementById('download-modal-cancel')?.addEventListener('click', closeDownloadModal);
document.getElementById('download-modal-confirm')?.addEventListener('click', () => {
    const input = document.getElementById('download-filename-input');
    const customTitle = (input ? input.value : 'bike-route') || 'bike-route';
    const format = localStorage.getItem('route_export_format') || 'gpx';
    closeDownloadModal();
    exportRoute(format, customTitle);
});
document.getElementById('download-filename-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('download-modal-confirm')?.click();
    } else if (e.key === 'Escape') {
        closeDownloadModal();
    }
});

// Wire up Share button
const shareBtn = document.getElementById('share-route-btn');
shareBtn?.addEventListener('click', async () => {
    if (waypoints.length < 2) {
        showToast('Please add at least 2 points to share a route.', 'warning');
        return;
    }

    // Build the share URL pointing to ioncook.github.io/bike-route-planner
    const params = new URLSearchParams();
    const wpStr = waypoints.map(wp => `${wp[0].toFixed(5)},${wp[1].toFixed(5)}`).join(';');
    params.set('route', wpStr);
    if (segmentModes.length > 0) params.set('modes', segmentModes.join(','));
    if (forceMode) params.set('force', '1');

    const shareUrl = `https://ioncook.github.io/bike-route-planner/?${params.toString()}`;
    const distText = document.getElementById('total-distance')?.textContent?.trim() || '';
    const shareTitle = 'Bike Route Planner Route';
    const shareText = distText ? `Bike route (${distText})` : 'Bike route';

    // 1. Try Capacitor native Share plugin if available
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share) {
        try {
            await window.Capacitor.Plugins.Share.share({
                title: shareTitle,
                text: shareText,
                url: shareUrl,
                dialogTitle: 'Share Route'
            });
            return;
        } catch (err) {
            if (err.name !== 'AbortError') console.warn('Capacitor share cancelled or failed:', err);
            return;
        }
    }

    // 2. Try standard navigator.share
    if (navigator.share) {
        try {
            await navigator.share({
                title: shareTitle,
                text: shareText,
                url: shareUrl
            });
            return;
        } catch (err) {
            if (err.name !== 'AbortError') console.warn('Navigator share error:', err);
            return;
        }
    }

    // 3. Fallback: Copy to clipboard
    try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('Route link copied to clipboard!', 'info');
    } catch (_) {
        prompt('Copy this route link:', shareUrl);
    }
});

Chart.Interaction.modes.routeHover = function (chart, e, options, useFinalPosition) {
    const items = [];
    if (isDraggingWindow || isResizing || isDraggingStats) return items;
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
                backgroundColor: document.body.classList.contains('light-mode') ? 'rgba(100,120,160,0.45)' : 'rgba(100,120,160,0.15)',
                borderWidth: 4,
                fill: 'start',
                pointRadius: 0,
                pointHoverRadius: 0,
                tension: 0.1,
                spanGaps: false,
                order: 2
            }, {
                label: 'Waypoints',
                data: [],
                type: 'scatter',
                pointRadius: 10,
                pointHoverRadius: 12,
                order: 1
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: window.innerWidth <= 768 ? { top: 10, right: 4, left: 2, bottom: 0 } : { top: 10, right: 10, left: 5, bottom: 0 }
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
                        autoSkip: false,
                        padding: window.innerWidth <= 768 ? 2 : 3,
                        callback: function (value, index, ticks) {
                            if (index === 0) return "Elev.";
                            return value;
                        }
                    }
                }
            }
        },
        plugins: [{
            id: 'hoverLine',
            beforeDatasetsDraw: (chart) => {
                if (!chart.scales.x) return;
                const area = chart.chartArea;
                if (!area) return;

                let targetDist = null;
                if (currentHoverDispDist !== null) {
                    targetDist = currentHoverDispDist;
                } else if (isLiveNavActive && isNavOnRoute && currentNavDispDist !== null) {
                    targetDist = currentNavDispDist;
                }

                if (targetDist !== null) {
                    const x = chart.scales.x.getPixelForValue(targetDist);
                    if (x < area.left || x > area.right) return;
                    const top = area.top;
                    const bottom = area.bottom;
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.beginPath();
                    ctx.moveTo(x, top);
                    ctx.lineTo(x, bottom);
                    ctx.lineWidth = 1.5;
                    ctx.strokeStyle = document.body.classList.contains('light-mode')
                        ? 'rgba(0, 0, 0, 0.45)'
                        : 'rgba(255, 255, 255, 0.6)';
                    ctx.setLineDash([]);
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
                    const STOPS = 300; // Ultra-high-def color/height sync
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
                        const pt = data[lo];
                        let grade = pt ? pt.grade : 0;
                        if (grade === undefined && pt && pt.rawIdx != null) {
                            grade = grades[pt.rawIdx] ?? 0;
                        }
                        if (pt && pt.y === null) {
                            if (lo + 1 < data.length && data[lo + 1].y !== null) {
                                grade = data[lo + 1].grade ?? (data[lo + 1].rawIdx != null ? grades[data[lo + 1].rawIdx] : 0);
                            } else if (lo > 0 && data[lo - 1].y !== null) {
                                grade = data[lo - 1].grade ?? (data[lo - 1].rawIdx != null ? grades[data[lo - 1].rawIdx] : 0);
                            }
                        }
                        const color = getColorForGrade(grade ?? 0);
                        grad.addColorStop(frac, color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`));
                    }
                    return grad;
                };

                const isLight = document.body.classList.contains('light-mode');
                ds.borderColor = buildGrad(0.95);
                ds.backgroundColor = buildGrad(isLight ? 0.45 : 0.18);
            }
        }]
    });

    const clearHover = () => {
        currentHoverDispDist = null;
        if (elevationChart) {
            elevationChart.setActiveElements([]);
            if (elevationChart.tooltip) elevationChart.tooltip.setActiveElements([]);
            elevationChart.update('none');
        }
        hideHoverMarker();
        const statsDiv = document.getElementById('hover-stats');
        if (statsDiv && !isLiveNavActive) statsDiv.style.opacity = '0';
    };

    const handleHoverMove = (clientX) => {
        isFlyToActive = false;
        activeStatIdx = -1;
        if (!elevationChart || !currentRouteGeoJSON?.coordinates) return;
        const chart = elevationChart;
        const rect = ctx.canvas.getBoundingClientRect();
        const canvasX = clientX - rect.left;

        let targetCanvasX = canvasX;
        if (chart.chartArea) {
            targetCanvasX = Math.max(chart.chartArea.left, Math.min(chart.chartArea.right, canvasX));
        }

        // canvasX is in CSS pixels; Chart.js scales use the same coordinate space.
        const xValue = chart.scales.x?.getValueForPixel(targetCanvasX);
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
        if (ci >= 0 && (isTransitPoint(ci) || isTransitSegment(ci))) {
            clearHover();
            return;
        }
        const ciNext = ci + 1;

        // Interpolated geographic position
        const displayCoords = currentDisplayCoords || coords;
        const displayIdx = rawIndexToDisplayRange[ci]?.[0] ?? ci;
        const displayIdxNext = rawIndexToDisplayRange[ciNext]?.[0] ?? ciNext;
        const lngC = displayCoords[displayIdx][0] + t * (displayCoords[displayIdxNext][0] - displayCoords[displayIdx][0]);
        const latC = displayCoords[displayIdx][1] + t * (displayCoords[displayIdxNext][1] - displayCoords[displayIdx][1]);

        // Offset marker to sit on the route line (same logic as map hover)
        const pCenter = map.project([lngC, latC]);
        const p0 = map.project(displayCoords[displayIdx]);
        const p1 = map.project(displayCoords[displayIdxNext]);
        const vX = p1.x - p0.x, vY = p1.y - p0.y;
        const segLen = Math.sqrt(vX * vX + vY * vY);
        let markerLngLat;
        let markerScreenPt = null;
        if (segLen > 0.1) {
            const nx = -vY / segLen, ny = vX / segLen;
            const off = getPixelOffset(map.getZoom()) * (isRouteLeftHandDriving ? -1 : 1);
            markerScreenPt = { x: pCenter.x + nx * off, y: pCenter.y + ny * off };
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

        showHoverMarker(markerScreenPt || [markerLngLat.lng, markerLngLat.lat], info);
        showHoverSegment(ci);

        const statsDiv = document.getElementById('hover-stats');
        if (statsDiv) {
            statsDiv.style.opacity = '1';
            document.getElementById('hover-dist').textContent = distLabel;
            document.getElementById('hover-elev').textContent = elevLabel;
            document.getElementById('hover-grade').textContent = gradeLabel;
        }
    };

    let isPointerDragging = false;

    ctx.canvas.addEventListener('pointerdown', (e) => {
        isPointerDragging = true;
        try { ctx.canvas.setPointerCapture(e.pointerId); } catch (_) {}
        handleHoverMove(e.clientX);
    });
    ctx.canvas.addEventListener('pointermove', (e) => {
        if (isPointerDragging || e.buttons > 0) {
            handleHoverMove(e.clientX);
        }
    });
    const handlePointerEnd = (e) => {
        if (isPointerDragging) {
            isPointerDragging = false;
            try { ctx.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
            clearHover();
        }
    };
    ctx.canvas.addEventListener('pointerup', handlePointerEnd);
    ctx.canvas.addEventListener('pointercancel', handlePointerEnd);

    ctx.canvas.addEventListener('mouseout', clearHover);
    ctx.canvas.addEventListener('touchend', (e) => {
        clearHover();
    });
    ctx.canvas.addEventListener('touchcancel', (e) => {
        clearHover();
    });

    ctx.canvas.addEventListener('mousemove', (e) => {
        handleHoverMove(e.clientX);
    });
    ctx.canvas.addEventListener('touchstart', (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (e.touches.length > 0) {
            handleHoverMove(e.touches[0].clientX);
        }
    }, { passive: false });
    ctx.canvas.addEventListener('touchmove', (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (e.touches.length > 0) {
            handleHoverMove(e.touches[0].clientX);
        }
    }, { passive: false });

    updateChartTheme();
}

function updateChartTheme() {
    if (!elevationChart) return;
    const computed = window.getComputedStyle(document.documentElement);
    const isLight = document.body.classList.contains('light-mode');

    // Resolve border / grid line color from CSS variables (supports Material, Dark, Light)
    let gridColor = computed.getPropertyValue('--border').trim();
    if (!gridColor || gridColor === '') {
        gridColor = isLight ? 'rgba(0, 0, 0, 0.12)' : '#333333';
    } else {
        // If border is hex/rgb, soften slightly for grid lines
        if (gridColor.startsWith('#')) {
            const r = parseInt(gridColor.slice(1, 3), 16) || 128;
            const g = parseInt(gridColor.slice(3, 5), 16) || 128;
            const b = parseInt(gridColor.slice(5, 7), 16) || 128;
            gridColor = `rgba(${r}, ${g}, ${b}, ${isLight ? 0.35 : 0.6})`;
        }
    }

    // Resolve tick text color from CSS variables
    let tickColor = computed.getPropertyValue('--text-muted').trim();
    if (!tickColor || tickColor === '') {
        tickColor = isLight ? '#475569' : '#aaaaaa';
    }

    // Update X-axis colors
    if (elevationChart.options.scales.x) {
        elevationChart.options.scales.x.grid.color = gridColor;
        elevationChart.options.scales.x.ticks.color = tickColor;
    }

    // Update Y-axis colors
    if (elevationChart.options.scales.y) {
        elevationChart.options.scales.y.grid.color = gridColor;
        elevationChart.options.scales.y.ticks.color = tickColor;
    }

    elevationChart.update();
}


async function updateElevationProfile() {
    const queryId = ++currentElevationQueryId;
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
        if (queryId !== currentElevationQueryId) return; // Stale query, abort!

        setStatus('Processing…');

        // Null check: if samples are null, tiles might still be loading.
        // We log it but don't retry automatically to avoid infinite loops in 'no-data' zones.
        const nullCount = elevations.filter(v => v == null).length;
        if (nullCount > 0) {
            console.warn(`[elev] ${nullCount}/${elevations.length} points have no data (tiles still loading or out of bounds)`);
        }

        // Build pathDistances and mercDistances for map gradient (excluding transit distance)
        for (let i = 1; i < coords.length; i++) {
            const inTransit = isTransitSegment(i - 1);
            if (!inTransit) {
                distMeters += haversineDistance(coords[i - 1], coords[i]);
            }
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
                let idx = i + k;
                let e = null;
                if (idx >= 0 && idx < elevations.length) {
                    e = elevations[idx];
                } else if (idx < 0) {
                    // Start boundary reflection
                    const reflectedIdx = -idx;
                    if (reflectedIdx < elevations.length && elevations[0] != null && elevations[reflectedIdx] != null) {
                        e = 2 * elevations[0] - elevations[reflectedIdx];
                    }
                } else {
                    // End boundary reflection
                    const reflectedIdx = 2 * elevations.length - 2 - idx;
                    if (reflectedIdx >= 0 && elevations[elevations.length - 1] != null && elevations[reflectedIdx] != null) {
                        e = 2 * elevations[elevations.length - 1] - elevations[reflectedIdx];
                    }
                }

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
            if (v == null || isTransitPoint(i)) return null;

            let prevVal = null;
            let d1 = 0;
            for (let j = i - 1; j >= 0; j--) {
                if (isTransitSegment(j)) break; // Don't look across transit gap
                if (elevations[j] != null) {
                    const dist = haversineDistance(coords[j], coords[i]);
                    if (dist > 2.0) {
                        prevVal = elevations[j];
                        d1 = dist;
                        break;
                    }
                }
            }
            if (prevVal === null && i > 0 && !isTransitSegment(i - 1) && elevations[i - 1] != null) {
                prevVal = elevations[i - 1];
                d1 = haversineDistance(coords[i - 1], coords[i]);
            }

            let nextVal = null;
            let d2 = 0;
            for (let j = i + 1; j < elevations.length; j++) {
                if (isTransitSegment(j - 1)) break; // Don't look across transit gap
                if (elevations[j] != null) {
                    const dist = haversineDistance(coords[i], coords[j]);
                    if (dist > 2.0) {
                        nextVal = elevations[j];
                        d2 = dist;
                        break;
                    }
                }
            }
            if (nextVal === null && i < elevations.length - 1 && !isTransitSegment(i) && elevations[i + 1] != null) {
                nextVal = elevations[i + 1];
                d2 = haversineDistance(coords[i], coords[i + 1]);
            }

            if (i === 0 || prevVal === null) {
                return (nextVal != null && d2 > 0) ? (nextVal - v) / d2 * 100 : null;
            }
            if (i === coords.length - 1 || nextVal === null) {
                return (prevVal != null && d1 > 0) ? (v - prevVal) / d1 * 100 : null;
            }

            if (prevVal != null && nextVal != null && (d1 + d2) > 0) {
                return (nextVal - prevVal) / (d1 + d2) * 100;
            } else if (prevVal != null && d1 > 0) {
                return (v - prevVal) / d1 * 100;
            } else if (nextVal != null && d2 > 0) {
                return (nextVal - v) / d2 * 100;
            }
            return null;
        });

        let filteredDist = 0;
        let filteredMax = -Infinity, filteredMin = Infinity;
        let minElevIdx = 0, maxElevIdx = 0;
        for (let i = 0; i < coords.length; i++) {
            const inTransit = isTransitPoint(i);
            const dval = elevations[i];
            const distM = pathDistances[i] ?? filteredDist;
            filteredDist = distM;
            const displayElev = dval != null ? (currentUnits === 'metric' ? dval : dval * 3.28084) : null;
            const ptX = getDisplayDistance(distM);

            if (inTransit) {
                // Inside transit gap: break the chart line
                if (filteredChartData.length > 0 && filteredChartData[filteredChartData.length - 1].y !== null) {
                    filteredChartData.push({ x: ptX, y: null });
                }
            } else {
                // If the previous point was inside transit (or was null), ensure null separates before starting new segment
                let wasJustTransit = false;
                if (waypointPathIndices && waypointPathIndices.length >= 2) {
                    for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
                        if (segmentModes[segI] === 'transit' && i === waypointPathIndices[segI + 1]) {
                            wasJustTransit = true;
                            break;
                        }
                    }
                }
                if (wasJustTransit && filteredChartData.length > 0 && filteredChartData[filteredChartData.length - 1].y !== null) {
                    filteredChartData.push({ x: ptX, y: null });
                }

                filteredChartData.push({ x: ptX, y: displayElev ?? null, rawIdx: i });
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
        }

        // Replace original data with filtered
        chartData.length = 0; filteredChartData.forEach(p => chartData.push(p));
        maxElev = filteredMax; minElev = filteredMin;

        // Calculate total elevation gain and loss from cleaned elevations (excluding transit segments)
        let totalGainM = 0, totalLossM = 0;
        for (let i = 1; i < elevations.length; i++) {
            if (elevations[i] != null && elevations[i - 1] != null) {
                let inTransit = false;
                if (waypointPathIndices && waypointPathIndices.length >= 2) {
                    for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
                        if (segmentModes[segI] === 'transit') {
                            if (i > waypointPathIndices[segI] && i <= waypointPathIndices[segI + 1]) {
                                inTransit = true;
                                break;
                            }
                        }
                    }
                }
                if (!inTransit) {
                    const diff = elevations[i] - elevations[i - 1];
                    if (diff > 0) totalGainM += diff;
                    else totalLossM += diff;
                }
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
            if (isTransitPoint(i)) {
                smoothedSegmentGrades.push(null);
                continue;
            }
            let sum = 0, count = 0;
            let distBack = 0, distFwd = 0;

            if (smoothingGrades[i] != null) {
                sum += smoothingGrades[i];
                count++;
            }

            for (let j = i - 1; j >= 0; j--) {
                if (isTransitSegment(j)) break; // Do not smooth across transit gap
                const d = haversineDistance(coords[j], coords[j + 1]);
                distBack += d;
                if (distBack > targetWindowMeters / 2) break;
                if (smoothingGrades[j] != null) {
                    sum += smoothingGrades[j];
                    count++;
                }
            }

            for (let j = i; j < smoothingGrades.length - 1; j++) {
                if (isTransitSegment(j)) break; // Do not smooth across transit gap
                const d = haversineDistance(coords[j], coords[j + 1]);
                distFwd += d;
                if (distFwd > targetWindowMeters / 2) break;
                if (smoothingGrades[j + 1] != null) {
                    sum += smoothingGrades[j + 1];
                    count++;
                }
            }

            if (count > 0) {
                smoothedSegmentGrades.push(sum / count);
            } else {
                let fallback = 0;
                for (let j = i; j >= 0; j--) {
                    if (isTransitSegment(j)) break;
                    if (smoothingGrades[j] != null) { fallback = smoothingGrades[j]; break; }
                }
                if (fallback === 0) {
                    for (let j = i; j < smoothingGrades.length; j++) {
                        if (isTransitSegment(j - 1)) break;
                        if (smoothingGrades[j] != null) { fallback = smoothingGrades[j]; break; }
                    }
                }
                smoothedSegmentGrades.push(fallback);
            }
        }
        // Build smoothedGrades for map/chart coloring: length N.
        const smoothedGrades = smoothedSegmentGrades;

        // chartData was already set from despiked elevations above — don't overwrite it.
        // maxElev/minElev already correct from filteredChartData pass.

        // Clear icon cache to ensure new text centering is applied
        for (let key in wpIcons) delete wpIcons[key];

        // Attach smoothed grades directly to chartData points and sync borderColors
        chartData.forEach(pt => {
            if (pt.rawIdx != null) {
                pt.grade = smoothedGrades[pt.rawIdx] ?? 0;
            } else {
                pt.grade = 0;
            }
        });
        const borderColors = chartData.map(pt => pt.y === null ? 'transparent' : getColorForGrade(pt.grade ?? 0));
        // Waypoints on Chart (Excluding endpoints)
        const wpData = [];
        const wpStyles = [];
        if (waypoints.length > 2) {
            for (let i = 1; i < waypoints.length - 1; i++) {
                const wpMeters = waypointDistances[i] || 0;
                const displayWpDist = getDisplayDistance(wpMeters);
                const wpRawIdx = waypointPathIndices?.[i];
                let wpY = null;
                if (wpRawIdx !== undefined && elevations[wpRawIdx] != null) {
                    wpY = currentUnits === 'metric' ? elevations[wpRawIdx] : elevations[wpRawIdx] * 3.28084;
                }
                if (wpY === null) {
                    let minDiff = Infinity;
                    for (const pt of chartData) {
                        if (pt.y === null) continue;
                        const d = Math.abs(pt.x - displayWpDist);
                        if (d < minDiff) { minDiff = d; wpY = pt.y; }
                    }
                }
                const offset = 0;
                wpData.push({ x: displayWpDist, y: (wpY ?? 0) + offset });
                wpStyles.push(getWpIconImage(i, waypoints.length));
            }
        }

        elevationChart.data.datasets[0].data = chartData;
        elevationChart.data.datasets[0].grades = smoothedGrades;
        const isLight = document.body.classList.contains('light-mode');
        const fillAlpha = isLight ? 0.45 : 0.15;
        elevationChart.data.datasets[0].borderColor = isHighPerformance ? '#2563eb' : borderColors;
        elevationChart.data.datasets[0].backgroundColor = isHighPerformance ? `rgba(37, 99, 235, ${fillAlpha})` : `rgba(100, 120, 160, ${fillAlpha})`;

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
        routeScreenPtsDirty = true;

        if (!initialBasemapCycled) {
            initialBasemapCycled = true;
            removeInitialCover();
        }

        elevationChart.update('none');
        elevationChart.options.scales.x.max = getDisplayDistance(currentDistanceMeters || distMeters);

        if (maxElev === -Infinity) maxElev = 100;
        if (minElev === Infinity) minElev = 0;
        const elevRange = maxElev - minElev;
        const padding = elevRange === 0 ? 10 : elevRange * 0.35; // Extra padding for taller pins

        elevationChart.options.scales.y.suggestedMax = maxElev + padding;
        elevationChart.options.scales.y.suggestedMin = Math.max(0, minElev - padding);

        try {
            elevationChart.update('none');
        } catch (e) { }

        let maxUpGrade = -Infinity;
        let maxDownGrade = Infinity;
        let maxUpIdx = 0;
        let maxDownIdx = 0;

        for (let i = 0; i < smoothedSegmentGrades.length; i++) {
            if (isTransitPoint(i)) continue;
            const grade = smoothedSegmentGrades[i];
            if (grade == null || isNaN(grade)) continue;
            if (grade > maxUpGrade) {
                maxUpGrade = grade;
                maxUpIdx = i;
            }
            if (grade < maxDownGrade) {
                maxDownGrade = grade;
                maxDownIdx = i;
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
        updateDistanceMarkers();
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
    const hasGPX = segmentModes.some(m => m === 'gpx');
    if (waypoints.length > 0 && !hasGPX) {
        const wpStr = waypoints.map(wp => `${wp[0].toFixed(5)},${wp[1].toFixed(5)}`).join(';');
        params.set('route', wpStr);
        if (segmentModes.length > 0) params.set('modes', segmentModes.join(','));
        else params.delete('modes');
        try {
            localStorage.setItem('cached_active_route', JSON.stringify({
                route: wpStr,
                modes: segmentModes.join(','),
                force: forceMode ? '1' : '0'
            }));
        } catch (_) {}
    } else {
        params.delete('route');
        params.delete('modes');
        try {
            localStorage.removeItem('cached_active_route');
        } catch (_) {}
    }
    if (forceMode) params.set('force', '1'); else params.delete('force');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

function loadUrlState(customUrl) {
    let params;
    if (customUrl) {
        try {
            const parsed = new URL(customUrl);
            params = new URLSearchParams(parsed.search || parsed.hash.replace(/^#\/?/, ''));
        } catch (_) {
            params = new URLSearchParams(window.location.search);
        }
    } else {
        params = new URLSearchParams(window.location.search);
    }

    // If no route in URL, check cached route in localStorage
    if (!params.get('route')) {
        try {
            const cachedRoute = JSON.parse(localStorage.getItem('cached_active_route') || 'null');
            if (cachedRoute && cachedRoute.route) {
                params.set('route', cachedRoute.route);
                if (cachedRoute.modes) params.set('modes', cachedRoute.modes);
                if (cachedRoute.force === '1') params.set('force', '1');
            }
        } catch (_) {}
    }

    // Restore force mode before building the route
    if (params.get('force') === '1') {
        forceMode = true;
        updateForceModeBtn();
    }
    const routeStr = params.get('route');
    const modeStr = params.get('modes');
    const modes = modeStr ? modeStr.split(',') : [];

    if (modes.includes('gpx')) {
        params.delete('route');
        params.delete('modes');
        window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
        removeInitialCover();
        return;
    }

    if (routeStr) {
        // Clear any existing markers if reloading from deep link or new route provided
        if (customUrl || waypoints.length > 0) {
            clearRoute(false);
        }

        if (modes.length > 0) {
            const lastMode = modes[modes.length - 1];
            const fallbackMode = lastMode === 'gpx' ? 'bike' : lastMode;
            if (['bike', 'direct', 'hike', 'transit'].includes(fallbackMode)) {
                currentRoutingMode = fallbackMode;
                localStorage.setItem('route_routing_mode', fallbackMode);
                document.getElementById('mode-bike')?.classList.toggle('active', fallbackMode === 'bike');
                document.getElementById('mode-direct')?.classList.toggle('active', fallbackMode === 'direct');
                document.getElementById('mode-hike')?.classList.toggle('active', fallbackMode === 'hike');
                document.getElementById('mode-transit')?.classList.toggle('active', fallbackMode === 'transit');
            }
        }
        const points = routeStr.split(';');
        points.forEach((pt, i) => {
            const [lng, lat] = pt.split(',').map(Number);
            if (!isNaN(lng) && !isNaN(lat)) {
                const mode = i > 0 ? modes[i - 1] : undefined;
                createMarker({ lng, lat }, undefined, mode === 'gpx' ? 'bike' : mode);
            }
        });

        updateRoute();

        if (waypoints.length > 1) {
            const bounds = new maplibregl.LngLatBounds();
            for (const wp of waypoints) {
                bounds.extend(wp);
            }
            fitBoundsSmart(bounds, { duration: customUrl ? 500 : 0 });
            removeInitialCover();
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

// Helper to handle base64 route files passed from Android "Open with" intent
async function handleNativeIncomingRouteFile(fileDetail) {
    if (!fileDetail || !fileDetail.base64) return;
    try {
        const raw = atob(fileDetail.base64);
        const u8 = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
            u8[i] = raw.charCodeAt(i);
        }
        const fileName = fileDetail.name || 'imported_route.gpx';
        const file = new File([u8], fileName, { type: 'application/octet-stream' });
        console.log('Importing route file opened from system:', fileName);
        await importRouteFile(file);
        removeInitialCover();
    } catch (err) {
        console.error('Failed to import native route file:', err);
    }
}

// Listen for incoming route file event dispatched from native Android MainActivity
window.addEventListener('incomingRouteFile', (e) => {
    if (e.detail) {
        handleNativeIncomingRouteFile(e.detail);
    }
});

// Check if a route file was passed on app cold launch via AndroidMaterialTheme bridge
function checkPendingNativeRouteFile() {
    if (window.AndroidMaterialTheme && typeof window.AndroidMaterialTheme.getPendingRouteFile === 'function') {
        try {
            const raw = window.AndroidMaterialTheme.getPendingRouteFile();
            if (raw) {
                window.AndroidMaterialTheme.clearPendingRouteFile();
                const fileDetail = JSON.parse(raw);
                if (fileDetail && fileDetail.base64) {
                    handleNativeIncomingRouteFile(fileDetail);
                    return true;
                }
            }
        } catch (e) {
            console.error('Error checking pending native route file:', e);
        }
    }
    return false;
}

// Helper to handle coordinates/query passed from Android "Open with" location / geo dialog
async function handleIncomingLocation(detail) {
    if (!detail) return;
    try {
        let lng = detail.lng;
        let lat = detail.lat;

        // If no coordinates provided directly but a search query exists, try geocoding it
        if ((lng == null || lat == null) && detail.query) {
            try {
                const resp = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(detail.query)}&limit=1`);
                if (resp.ok) {
                    const geojson = await resp.json();
                    if (geojson.features && geojson.features.length > 0) {
                        const coords = geojson.features[0].geometry.coordinates;
                        lng = coords[0];
                        lat = coords[1];
                    }
                }
            } catch (err) {
                console.warn('Could not geocode incoming location query:', err);
            }
        }

        if (lng != null && lat != null && !isNaN(lng) && !isNaN(lat)) {
            removeInitialCover();
            map.flyTo({ center: [lng, lat], zoom: 15, duration: 800 });
            // Show right-click / weather popup at target location
            showWeatherPopup({ lng, lat });
        }
    } catch (err) {
        console.error('Failed to handle incoming location intent:', err);
    }
}

// Listen for incoming location intent event dispatched from native Android MainActivity
window.addEventListener('incomingLocationIntent', (e) => {
    if (e.detail) {
        handleIncomingLocation(e.detail);
    }
});

// Check if a location was passed on app cold launch via AndroidMaterialTheme bridge
function checkPendingNativeLocation() {
    if (window.AndroidMaterialTheme && typeof window.AndroidMaterialTheme.getPendingLocation === 'function') {
        try {
            const raw = window.AndroidMaterialTheme.getPendingLocation();
            if (raw) {
                window.AndroidMaterialTheme.clearPendingLocation();
                const detail = JSON.parse(raw);
                if (detail) {
                    handleIncomingLocation(detail);
                    return true;
                }
            }
        } catch (e) {
            console.error('Error checking pending native location:', e);
        }
    }
    return false;
}

// Deep linking support via Capacitor App plugin
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appUrlOpen', (data) => {
        if (data && data.url) {
            console.log('App opened with URL:', data.url);
            if (data.url.startsWith('file://') || data.url.startsWith('content://')) {
                // If Capacitor passes content/file URI, let Android bridge or checkPending handle or inspect
                checkPendingNativeRouteFile();
            } else if (data.url.startsWith('geo:')) {
                // Parse geo: scheme if received via Capacitor
                try {
                    const raw = data.url.replace(/^geo:/, '');
                    const qIdx = raw.indexOf('?');
                    let lat = null, lng = null, query = null;
                    if (qIdx !== -1) {
                        const qStr = raw.substring(qIdx + 1);
                        const params = new URLSearchParams(qStr);
                        query = params.get('q');
                    }
                    const coordsPart = qIdx !== -1 ? raw.substring(0, qIdx) : raw;
                    const parts = coordsPart.split(',');
                    if (parts.length >= 2) {
                        lat = parseFloat(parts[0]);
                        lng = parseFloat(parts[1]);
                    }
                    handleIncomingLocation({ lat, lng, query });
                } catch (e) {
                    console.error('Failed to parse Capacitor geo url:', e);
                }
            } else if (data.url.includes('maps.google') || data.url.includes('google.com/maps') || data.url.includes('goo.gl')) {
                // Handled natively by MainActivity or parsed directly
                checkPendingNativeLocation();
            } else {
                loadUrlState(data.url);
            }
        }
    });
}

function removeInitialCover() {
    const cover = document.getElementById('initial-map-cover');
    if (cover) {
        cover.style.pointerEvents = 'none';
        cover.style.opacity = '0';
        setTimeout(() => {
            if (cover.parentNode) cover.remove();
        }, 500);
        clearStatus();
    }
}
function requestLocation(fly = false) {
    if (userLocationMarker) {
        const lngLat = userLocationMarker.getLngLat();
        const options = {
            center: [lngLat.lng, lngLat.lat],
            zoom: 13,
            speed: 2.8,
            curve: 1.4
        };
        if (fly) {
            map.flyTo(options);
        } else {
            map.jumpTo({ center: options.center, zoom: options.zoom });
        }
    }

    if (!("geolocation" in navigator)) {
        console.warn("Geolocation not supported by this browser.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const freshLng = pos.coords.longitude;
            const freshLat = pos.coords.latitude;
            currentUserCoords = [freshLng, freshLat];
            const currentCenter = map.getCenter();

            const options = {
                center: [freshLng, freshLat],
                zoom: 13,
                speed: 2.8,
                curve: 1.4
            };

            if (!userLocationMarker) {
                if (fly) {
                    map.flyTo(options);
                } else {
                    const diffLng = Math.abs(currentCenter.lng - freshLng);
                    const diffLat = Math.abs(currentCenter.lat - freshLat);
                    if (diffLng > 0.005 || diffLat > 0.005) {
                        map.jumpTo({ center: options.center, zoom: options.zoom });
                    }
                }
            }
        },
        (err) => {
            console.warn("Geolocation failed or denied:", err);
        },
        { timeout: 5000, enableHighAccuracy: true, maximumAge: 10000 }
    );
}


const elPanel = document.getElementById('elevation-panel');
const elHeader = document.getElementById('elevation-header');
const elMinBtn = document.getElementById('elevation-min-btn');

const statsPanel = document.getElementById('stats-panel');
const statsHeader = statsPanel?.querySelector('.stats-header') || statsPanel;
const closeStatsBtn = document.getElementById('close-stats-btn');

let isDraggingWindow = false;
let startX, startY, initialLeft, initialTop;

let isDraggingStats = false;
let isPotentialStatsDrag = false;
let statsStartX, statsStartY, statsInitialLeft, statsInitialTop;

elHeader.addEventListener('mousedown', (e) => {
    if (window.innerWidth <= 768) return; // Disable dragging on mobile
    if (e.target === elMinBtn) return;
    isDraggingWindow = true;
    document.body.classList.add('is-dragging-window');
    hideHoverMarker();
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

statsPanel?.addEventListener('mousedown', (e) => {
    if (window.innerWidth <= 768) return; // Disable dragging on mobile
    if (e.target === closeStatsBtn || e.target.closest('#close-stats-btn')) return;

    isPotentialStatsDrag = true;
    isDraggingStats = false;
    statsStartX = e.clientX;
    statsStartY = e.clientY;

    const rect = statsPanel.getBoundingClientRect();
    statsInitialLeft = rect.left;
    statsInitialTop = rect.top;
});

document.addEventListener('mousemove', (e) => {
    if (isPotentialStatsDrag && !isDraggingStats) {
        const dist = Math.hypot(e.clientX - statsStartX, e.clientY - statsStartY);
        if (dist > 4) {
            isDraggingStats = true;
            document.body.classList.add('is-dragging-window');
            hideHoverMarker();
            statsPanel.style.position = 'absolute';
            statsPanel.style.left = statsInitialLeft + 'px';
            statsPanel.style.top = statsInitialTop + 'px';
            statsPanel.style.right = 'auto';
            statsPanel.style.bottom = 'auto';
        }
    }

    if (isDraggingWindow) {
        hideHoverMarker();
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
        hideHoverMarker();
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
    isPotentialStatsDrag = false;
    document.body.classList.remove('is-dragging-window');
    if (isDraggingWindow) {
        isDraggingWindow = false;
        saveWindowState();
    }
    if (isDraggingStats) {
        isDraggingStats = false;
        saveStatsPosition();
    }
    if (isResizing) {
        isResizing = false;
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
    isResizing = true;
    document.body.classList.add('is-dragging-window');
    hideHoverMarker();

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

if (elMinBtn) {
    elMinBtn.addEventListener('click', () => {
        elPanel.style.display = 'none';
        localStorage.setItem('elevation_panel_visible', 'false');
        updateElevationToggleBtn();
    });
}

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
            return;
        } catch (e) { }
    }
    elPanel.style.left = '20px';
    elPanel.style.bottom = '20px';
    elPanel.style.top = 'auto';
    elPanel.style.right = 'auto';
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
    toggleMode: 'Toggle Routing Mode (Bike/Direct/Hike/Transit)',
    fitRoute: 'Fit Map to Route',
    toggleSettings: 'Open/Close Settings',
    search: 'Focus Search Bar',
    toggleStats: 'Toggle Route Statistics',
    reverse: 'Reverse Entire Route',
    deleteLast: 'Delete Last Point / Clear Route (Ctrl)',
    resetOrientation: 'Reset Map Orientation',
    centerLocation: 'Center on Current Location'
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
        let displayKey = currentKeybindings[action] ? currentKeybindings[action].toUpperCase() : 'NONE';
        if (displayKey === ' ') displayKey = 'SPACE';
        keyBtn.textContent = displayKey;
        keyBtn.style.cssText = 'min-width:85px; background:var(--btn-bg); border:1px solid var(--border); color:var(--primary); padding:8px 12px; border-radius:var(--radius-sm, 2px); font-size:0.75rem; font-family:monospace; font-weight:600; cursor:pointer; transition: all 0.2s;';
        if (!currentKeybindings[action]) {
            keyBtn.style.color = 'var(--text-muted)';
            keyBtn.style.opacity = '0.6';
        }

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
    updateAllButtonTooltips();
};

document.getElementById('reset-keybindings').onclick = () => {
    currentKeybindings = { ...DEFAULT_KEYBINDINGS };
    renderKeybindings();
    updateAllButtonTooltips();
};

function initCustomTooltips() {
    const tooltip = document.createElement('div');
    tooltip.className = 'custom-tooltip';
    document.body.appendChild(tooltip);

    let activeEl = null;

    // On mobile, strip native title attributes so native OS system tooltips never pop up on tap
    if (window.innerWidth <= 768) {
        document.querySelectorAll('[title]').forEach(el => {
            el.setAttribute('data-tooltip', el.getAttribute('title'));
            el.removeAttribute('title');
        });
    }

    function showTooltipForElement(el) {
        if (!el) return;
        const isMobile = window.innerWidth <= 768;
        // On mobile, tooltips are allowed for .help-interactive elements (e.g. Speed, Simple Mode)
        if (isMobile && !el.closest('.help-interactive')) {
            return;
        }

        const text = el.getAttribute('title') || el.getAttribute('data-tooltip');
        if (!text) return;

        if (el.getAttribute('title')) {
            el.setAttribute('data-tooltip', text);
            el.removeAttribute('title');
        }

        activeEl = el;
        tooltip.textContent = text;
        tooltip.classList.add('show');

        const rect = el.getBoundingClientRect();
        const tooltipWidth = tooltip.offsetWidth || 200;
        const leftPos = Math.max(8, Math.min(window.innerWidth - tooltipWidth - 8, rect.left + rect.width / 2 - tooltipWidth / 2));
        tooltip.style.left = leftPos + 'px';

        if (rect.top - tooltip.offsetHeight - 8 > 0) {
            tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
        } else {
            tooltip.style.top = (rect.bottom + 8) + 'px';
        }
    }

    function hideTooltip() {
        tooltip.classList.remove('show');
        if (activeEl && activeEl.getAttribute('data-tooltip')) {
            activeEl.setAttribute('title', activeEl.getAttribute('data-tooltip'));
            activeEl.removeAttribute('data-tooltip');
            activeEl = null;
        }
    }

    let holdTimer = null;

    // Desktop hover handling
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest('[title], [data-tooltip]');
        if (!el) return;
        showTooltipForElement(el);
    });

    document.addEventListener('mouseout', (e) => {
        if (activeEl && !activeEl.contains(e.relatedTarget)) {
            hideTooltip();
        }
    });

    // Touch tap / hold handling for .help-interactive hints on mobile
    document.addEventListener('touchstart', (e) => {
        const helpEl = e.target.closest('.help-interactive');
        if (!helpEl) return;
        showTooltipForElement(helpEl);
        if (navigator.vibrate) try { navigator.vibrate(20); } catch (_) { }
    }, { passive: true });

    const cancelHold = () => {
        if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        hideTooltip();
    };

    document.addEventListener('touchend', cancelHold);
    document.addEventListener('touchcancel', cancelHold);
    document.addEventListener('touchmove', cancelHold, { passive: true });
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
        const calculatedH = mobileStartH + dy;
        if (calculatedH < 50) {
            elPanel.style.display = 'none';
            localStorage.setItem('elevation_panel_visible', 'false');
            updateElevationToggleBtn();
            stopMobileResize();
            return;
        }
        const newH = Math.max(60, Math.min(window.innerHeight * 0.7, calculatedH));
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

function createUserLocationMarkerElement() {
    const root = document.createElement('div');
    root.className = 'user-location-marker-root';

    const coneWrapper = document.createElement('div');
    coneWrapper.className = 'user-location-cone-wrapper';

    const coneSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    coneSvg.setAttribute('viewBox', '0 0 80 80');
    coneSvg.setAttribute('class', 'user-location-cone-svg');
    coneSvg.innerHTML = `
        <defs>
            <radialGradient id="loc-cone-grad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="currentColor" stop-opacity="0.65"/>
                <stop offset="55%" stop-color="currentColor" stop-opacity="0.25"/>
                <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <path d="M 40 40 L 19.9 7.8 A 38 38 0 0 1 60.1 7.8 Z" fill="url(#loc-cone-grad)"/>
    `;
    coneWrapper.appendChild(coneSvg);
    root.appendChild(coneWrapper);

    const pulse = document.createElement('div');
    pulse.className = 'user-location-pulse';
    root.appendChild(pulse);

    const dot = document.createElement('div');
    dot.className = 'user-location-dot';
    root.appendChild(dot);

    return root;
}

function ensureUserLocationMarker(lngLat) {
    if (!userLocationMarker) {
        userLocationMarker = new maplibregl.Marker({
            element: createUserLocationMarkerElement(),
            anchor: 'center',
            rotationAlignment: 'map',
            pitchAlignment: 'viewport'
        }).setLngLat(lngLat).addTo(map);

        const el = userLocationMarker.getElement();
        if (el) {
            el.style.pointerEvents = 'none';
        }
    }
}

function updateUserLocationPin() {
    const showCheck = document.getElementById('show-location-check');
    const isEnabled = showCheck ? showCheck.checked : false;
    localStorage.setItem('route_show_location_check', isEnabled);

    const isDebugActive = localStorage.getItem('debug_gps_joystick_enabled') === 'true';

    if (!isEnabled && !isDebugActive && !isLiveNavActive) {
        if (userLocationWatchId !== null) {
            navigator.geolocation.clearWatch(userLocationWatchId);
            userLocationWatchId = null;
        }
        if (userLocationMarker) {
            userLocationMarker.remove();
            userLocationMarker = null;
        }
        return;
    }

    if (!("geolocation" in navigator)) return;

    if (userLocationWatchId === null) {
        userLocationWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                if (localStorage.getItem('debug_gps_joystick_enabled') === 'true') return;
                const lngLat = [pos.coords.longitude, pos.coords.latitude];
                currentUserCoords = lngLat;
                ensureUserLocationMarker(lngLat);
                userLocationMarker.setLngLat(lngLat);
                if (pos.coords.heading != null && !isNaN(pos.coords.heading)) {
                    userLocationMarker.setRotation(pos.coords.heading);
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

function getCoordinateAtDistance(meters) {
    if (!currentRouteGeoJSON || !routePathDistances || routePathDistances.length === 0) return null;
    const coords = currentRouteGeoJSON.coordinates;
    if (meters <= 0) return coords[0];
    if (meters >= routeTotalDist) return coords[coords.length - 1];

    // Binary search to find segment
    let lo = 0, hi = routePathDistances.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (routePathDistances[mid] < meters) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    const idx = lo;
    if (idx === 0) return coords[0];

    const d0 = routePathDistances[idx - 1];
    const d1 = routePathDistances[idx];
    const p0 = coords[idx - 1];
    const p1 = coords[idx];

    const ratio = (d1 > d0) ? (meters - d0) / (d1 - d0) : 0;
    const lng = p0[0] + ratio * (p1[0] - p0[0]);
    const lat = p0[1] + ratio * (p1[1] - p0[1]);
    const baseCoord = [lng, lat];

    // Offset perpendicular to segment bearing to match the rendered route line's lane offset
    const zoom = map ? map.getZoom() : 0;
    const mult = isRouteLeftHandDriving ? -1 : 1;
    const pxOffset = getPixelOffset(zoom) * mult;
    if (Math.abs(pxOffset) > 0.1) {
        let prevIdx = idx - 1;
        while (prevIdx > 0 && haversineDistance(coords[prevIdx], p1) < 0.5) {
            prevIdx--;
        }
        const bearing = getBearing(coords[prevIdx], p1);
        const latRad = lat * Math.PI / 180;
        const metersPerPixel = 78271.51696 * Math.cos(latRad) / Math.pow(2, zoom);
        const offsetDist = Math.abs(pxOffset) * metersPerPixel;
        return offsetLatLng(baseCoord, offsetDist, bearing + 90 * mult);
    }

    return baseCoord;
}

function updateDistanceMarkers() {
    const showCheck = document.getElementById('show-distance-markers-check');
    const isEnabled = showCheck ? showCheck.checked : false;
    localStorage.setItem('route_show_distance_markers', isEnabled ? 'true' : 'false');

    if (!map.getSource('distance-markers-source')) return;

    if (!isEnabled || !currentRouteGeoJSON || !routePathDistances || routePathDistances.length < 2) {
        map.getSource('distance-markers-source').setData({ type: 'FeatureCollection', features: [] });
        return;
    }

    const zoom = map.getZoom();
    const isImperial = currentUnits === 'imperial';

    // Choose interval dynamically based on zoom and units
    let interval = 1.0;
    if (isImperial) {
        if (zoom >= 15.5) interval = 0.1;
        else if (zoom >= 14) interval = 0.25;
        else if (zoom >= 12.5) interval = 0.5;
        else if (zoom >= 10.5) interval = 1.0;
        else interval = 5.0;
    } else {
        if (zoom >= 15.5) interval = 0.1;
        else if (zoom >= 14) interval = 0.25;
        else if (zoom >= 12.5) interval = 0.5;
        else if (zoom >= 10.5) interval = 1.0;
        else interval = 5.0;
    }

    const unitInMeters = isImperial ? 1609.344 : 1000;
    const totalDistUnits = routeTotalDist / unitInMeters;
    const maxK = Math.floor(totalDistUnits / interval);

    // Compute visible viewport bounds with a small buffer so we don't generate
    // thousands of off-screen markers at high zoom levels during live zoom gestures
    let minLng = -180, maxLng = 180, minLat = -90, maxLat = 90;
    if (maxK > 150 && map.getBounds) {
        try {
            const bounds = map.getBounds();
            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();
            const padLng = Math.max(0.01, (ne.lng - sw.lng) * 0.35);
            const padLat = Math.max(0.01, (ne.lat - sw.lat) * 0.35);
            minLng = sw.lng - padLng;
            maxLng = ne.lng + padLng;
            minLat = sw.lat - padLat;
            maxLat = ne.lat + padLat;
        } catch (_) {}
    }

    const features = [];
    for (let k = 1; k <= maxK; k++) {
        const distUnits = k * interval;
        const distMeters = distUnits * unitInMeters;
        const coord = getCoordinateAtDistance(distMeters);
        if (coord) {
            if (coord[0] < minLng || coord[0] > maxLng || coord[1] < minLat || coord[1] > maxLat) {
                continue;
            }
            let text = distUnits.toString();
            if (distUnits % 1 !== 0) {
                text = parseFloat(distUnits.toFixed(2)).toString();
            }

            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: coord },
                properties: { text }
            });
        }
    }

    map.getSource('distance-markers-source').setData({
        type: 'FeatureCollection',
        features
    });
}

// ==========================================
// LIVE NAVIGATION & TELEMETRY ENGINE
// ==========================================
let navWatchId = null;
let lastKnownGpsPos = null;

function calculateBearing(c1, c2) {
    const lat1 = c1[1] * Math.PI / 180;
    const lat2 = c2[1] * Math.PI / 180;
    const dLng = (c2[0] - c1[0]) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function getBearingName(deg) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(deg / 45) % 8;
    return directions[idx];
}

// Distance in meters from point P to line segment AB
function distToSegment(p, a, b) {
    const l2 = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);
    if (l2 === 0) return haversineDistance(p, a);
    let t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2;
    t = Math.max(0, Math.min(1, t));
    const proj = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    return {
        distMeters: haversineDistance(p, proj),
        projectedPoint: proj,
        t: t
    };
}

function findClosestPointOnRoute(gpsLngLat, ignoreTransit = false) {
    if (!currentRouteGeoJSON || !currentRouteGeoJSON.coordinates || currentRouteGeoJSON.coordinates.length < 2) {
        return null;
    }
    const coords = currentRouteGeoJSON.coordinates;
    let minDistance = Infinity;
    let closestIndex = 0;
    let bestProj = coords[0];
    let bestT = 0;

    for (let i = 0; i < coords.length - 1; i++) {
        if (ignoreTransit && isTransitSegment(i)) continue;
        const seg = distToSegment(gpsLngLat, coords[i], coords[i + 1]);
        if (seg.distMeters < minDistance) {
            minDistance = seg.distMeters;
            closestIndex = i;
            bestProj = seg.projectedPoint;
            bestT = seg.t;
        }
    }

    // Calculate approximate distance along route from start to this projected point
    let distAlongRoute = 0;
    if (routePathDistances && routePathDistances.length > closestIndex) {
        const d0 = routePathDistances[closestIndex] || 0;
        const d1 = routePathDistances[closestIndex + 1] || d0;
        distAlongRoute = d0 + bestT * (d1 - d0);
    }

    return {
        distMeters: minDistance,
        index: closestIndex,
        point: bestProj,
        distAlongRoute: distAlongRoute,
        isTransit: isTransitSegment(closestIndex)
    };
}

// Calculate forward geodetic point given origin, bearing in degrees, and distance in meters
function offsetLngLat(lngLat, bearingDeg, distMeters) {
    const R = 6371000;
    const d = distMeters / R;
    const brng = bearingDeg * Math.PI / 180;
    const lat1 = lngLat[1] * Math.PI / 180;
    const lon1 = lngLat[0] * Math.PI / 180;

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

    return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

// Determine upcoming turn instruction ahead along route (alerting only at real intersection turns)
function getUpcomingTurn(coords, fromIndex, maxLookaheadMeters = 500) {
    if (!coords || fromIndex >= coords.length - 2) {
        return {
            type: 'arrive',
            text: 'Arriving at destination',
            distMeters: 0,
            icon: 'flag'
        };
    }

    // Check if within 30m of destination
    let totalDistToEnd = 0;
    for (let j = fromIndex; j < coords.length - 1; j++) {
        totalDistToEnd += haversineDistance(coords[j], coords[j + 1]);
    }
    if (totalDistToEnd < 30) {
        return {
            type: 'arrive',
            text: 'Arriving at destination',
            distMeters: totalDistToEnd,
            icon: 'flag'
        };
    }

    // Check if approaching a transit / gap segment
    let nextTransitStartIdx = null;
    let nextTransitSegIdx = null;
    if (waypointPathIndices && waypointPathIndices.length >= 2) {
        for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
            if (segmentModes[segI] === 'transit') {
                const sStart = waypointPathIndices[segI];
                if (sStart > fromIndex) {
                    if (nextTransitStartIdx === null || sStart < nextTransitStartIdx) {
                        nextTransitStartIdx = sStart;
                        nextTransitSegIdx = segI;
                    }
                }
            }
        }
    }

    let distToTransitStart = Infinity;
    if (nextTransitStartIdx !== null) {
        distToTransitStart = 0;
        for (let j = fromIndex; j < nextTransitStartIdx; j++) {
            distToTransitStart += haversineDistance(coords[j], coords[j + 1]);
        }
        if (distToTransitStart < 30) {
            return {
                type: 'arrive-segment',
                text: 'Reached end of segment',
                distMeters: distToTransitStart,
                icon: 'transit',
                transitSegIdx: nextTransitSegIdx
            };
        }
    }

    // Prioritize verified turn instructions from routing engine (BRouter voicehints / intersections)
    if (routeTurnInstructions && routeTurnInstructions.length > 0) {
        for (const inst of routeTurnInstructions) {
            if (inst.rawIdx > fromIndex) {
                // Check if approaching a transit segment before this turn
                if (nextTransitStartIdx !== null && inst.rawIdx >= nextTransitStartIdx && distToTransitStart <= maxLookaheadMeters) {
                    return {
                        type: 'arrive-segment',
                        text: 'End of segment ahead',
                        distMeters: distToTransitStart,
                        icon: 'transit',
                        transitSegIdx: nextTransitSegIdx
                    };
                }

                let distToTurn = 0;
                for (let j = fromIndex; j < inst.rawIdx; j++) {
                    distToTurn += haversineDistance(coords[j], coords[j + 1]);
                }
                if (distToTurn <= maxLookaheadMeters) {
                    return {
                        type: inst.type,
                        text: inst.text,
                        distMeters: distToTurn,
                        icon: inst.icon,
                        turnIndex: inst.rawIdx,
                        isIntersection: true
                    };
                }
                break;
            }
        }
        return {
            type: 'straight',
            text: 'Continue on current route',
            distMeters: 0,
            icon: 'straight',
            turnIndex: -1,
            isIntersection: false
        };
    }

    let accumDist = 0;
    // Fallback geometric detection for imported GPX without routing metadata:
    // Only detect sharp, localized corner deflections (>= 55 degrees) to completely ignore winding curved roads.
    for (let i = fromIndex + 1; i < coords.length - 1; i++) {
        const segDist = haversineDistance(coords[i - 1], coords[i]);
        accumDist += segDist;
        if (accumDist > maxLookaheadMeters) break;

        if (nextTransitStartIdx !== null && i >= nextTransitStartIdx) {
            return {
                type: 'arrive-segment',
                text: 'End of segment ahead',
                distMeters: distToTransitStart,
                icon: 'transit',
                transitSegIdx: nextTransitSegIdx
            };
        }

        let preIdx = i;
        let preDist = 0;
        while (preIdx > fromIndex && preDist < 18) {
            preDist += haversineDistance(coords[preIdx - 1], coords[preIdx]);
            preIdx--;
        }

        let postIdx = i;
        let postDist = 0;
        while (postIdx < coords.length - 1 && postDist < 18) {
            postDist += haversineDistance(coords[postIdx], coords[postIdx + 1]);
            postIdx++;
        }

        if (preDist < 10 || postDist < 10) continue;

        const inBearing = calculateBearing(coords[preIdx], coords[i]);
        const outBearing = calculateBearing(coords[i], coords[postIdx]);
        const diff = (outBearing - inBearing + 540) % 360 - 180;

        // Ignore all bends < 55 degrees (winding roads, gentle curves)
        if (Math.abs(diff) >= 55) {
            let apexIdx = i;
            let maxDiff = Math.abs(diff);
            let checkDist = 0;
            for (let k = i + 1; k < coords.length - 1; k++) {
                checkDist += haversineDistance(coords[k - 1], coords[k]);
                if (checkDist > 20) break;

                let pPre = k, dPre = 0;
                while (pPre > fromIndex && dPre < 18) {
                    dPre += haversineDistance(coords[pPre - 1], coords[pPre]);
                    pPre--;
                }
                let pPost = k, dPost = 0;
                while (pPost < coords.length - 1 && dPost < 18) {
                    dPost += haversineDistance(coords[pPost], coords[pPost + 1]);
                    pPost++;
                }
                if (dPre >= 10 && dPost >= 10) {
                    const bIn = calculateBearing(coords[pPre], coords[k]);
                    const bOut = calculateBearing(coords[k], coords[pPost]);
                    const d = (bOut - bIn + 540) % 360 - 180;
                    if (Math.abs(d) > maxDiff) {
                        maxDiff = Math.abs(d);
                        apexIdx = k;
                    }
                }
            }

            let apexPre = apexIdx, aPreD = 0;
            while (apexPre > fromIndex && aPreD < 18) {
                aPreD += haversineDistance(coords[apexPre - 1], coords[apexPre]);
                apexPre--;
            }
            let apexPost = apexIdx, aPostD = 0;
            while (apexPost < coords.length - 1 && aPostD < 18) {
                aPostD += haversineDistance(coords[apexPost], coords[apexPost + 1]);
                apexPost++;
            }
            const finalDiff = (calculateBearing(coords[apexIdx], coords[apexPost]) - calculateBearing(coords[apexPre], coords[apexIdx]) + 540) % 360 - 180;

            if (Math.abs(finalDiff) < 55) continue;

            let type = 'turn-right';
            let icon = 'right';
            let text = 'Turn right';

            if (finalDiff >= 140) {
                type = 'u-turn-right';
                icon = 'uturn-right';
                text = 'Make a U-turn to the right';
            } else if (finalDiff <= -140) {
                type = 'u-turn-left';
                icon = 'uturn-left';
                text = 'Make a U-turn to the left';
            } else if (finalDiff >= 105) {
                type = 'sharp-right';
                icon = 'sharp-right';
                text = 'Turn sharp right';
            } else if (finalDiff <= -105) {
                type = 'sharp-left';
                icon = 'sharp-left';
                text = 'Turn sharp left';
            } else if (finalDiff > 0) {
                type = 'turn-right';
                icon = 'right';
                text = 'Turn right';
            } else {
                type = 'turn-left';
                icon = 'left';
                text = 'Turn left';
            }

            let distToApex = 0;
            for (let m = fromIndex; m < apexIdx; m++) {
                distToApex += haversineDistance(coords[m], coords[m + 1]);
            }

            return {
                type: type,
                text: text,
                distMeters: distToApex,
                icon: icon,
                turnIndex: apexIdx,
                isIntersection: false // Unverified intersection, so do not vibrate
            };
        }
    }

    return {
        type: 'straight',
        text: 'Continue on current route',
        distMeters: accumDist,
        icon: 'straight',
        turnIndex: -1,
        isIntersection: false
    };
}

function getTurnSvg(icon) {
    switch (icon) {
        case 'transit':
        case 'gap':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="15" rx="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
                <circle cx="7" cy="14" r="1.5"></circle>
                <circle cx="17" cy="14" r="1.5"></circle>
                <line x1="8" y1="18" x2="6" y2="21"></line>
                <line x1="16" y1="18" x2="18" y2="21"></line>
            </svg>`;
        case 'left':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="20" x2="18" y2="12"></line>
                <path d="M18 12a4 4 0 0 0-4-4H5"></path>
                <polyline points="9 4 5 8 9 12"></polyline>
            </svg>`;
        case 'right':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="6" y1="20" x2="6" y2="12"></line>
                <path d="M6 12a4 4 0 0 1 4-4h9"></path>
                <polyline points="15 4 19 8 15 12"></polyline>
            </svg>`;
        case 'slight-left':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="15" y1="20" x2="15" y2="13"></line>
                <path d="M15 13L8 6"></path>
                <polyline points="14 6 8 6 8 12"></polyline>
            </svg>`;
        case 'slight-right':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="9" y1="20" x2="9" y2="13"></line>
                <path d="M9 13L16 6"></path>
                <polyline points="10 6 16 6 16 12"></polyline>
            </svg>`;
        case 'sharp-left':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 21V9a3 3 0 0 0-5.2-2.1L6 14"></path>
                <polyline points="11 14 6 14 6 9"></polyline>
            </svg>`;
        case 'sharp-right':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M7 21V9a3 3 0 0 1 5.2-2.1L18 14"></path>
                <polyline points="13 14 18 14 18 9"></polyline>
            </svg>`;
        case 'uturn':
        case 'uturn-left':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="17" y1="20" x2="17" y2="10"></line>
                <path d="M17 10a5 5 0 0 0-10 0v9"></path>
                <polyline points="3 15 7 19 11 15"></polyline>
            </svg>`;
        case 'uturn-right':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="7" y1="20" x2="7" y2="10"></line>
                <path d="M7 10a5 5 0 0 1 10 0v9"></path>
                <polyline points="21 15 17 19 13 15"></polyline>
            </svg>`;
        case 'flag':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
                <line x1="4" y1="22" x2="4" y2="15"></line>
            </svg>`;
        case 'alert':
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 2 22 22 22 12 2"></polygon>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>`;
        case 'straight':
        default:
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="19" x2="12" y2="5"></line>
                <polyline points="5 12 12 5 19 12"></polyline>
            </svg>`;
    }
}

let liveNavStartDistAlongRoute = null;
let liveNavLastDistAlongRoute = null;
let liveNavTotalTraveledMeters = 0;
let liveNavLastElevationMeters = null;
let liveNavLastRouteIndex = null;
let liveNavAccumGainMeters = 0;
let liveNavAccumLossMeters = 0;
let wasNavOffRoute = false;
let cumulativeRouteGain = null;
let liveNavTransitSegIndex = null;

function getCumulativeRouteGain() {
    if (!currentStats?.elevations || currentStats.elevations.length === 0) return null;
    if (cumulativeRouteGain && cumulativeRouteGain.length === currentStats.elevations.length) {
        return cumulativeRouteGain;
    }
    const elevs = currentStats.elevations;
    const cum = new Float32Array(elevs.length);
    let g = 0;
    for (let i = 1; i < elevs.length; i++) {
        const d = elevs[i] - elevs[i - 1];
        if (d > 0) g += d;
        cum[i] = g;
    }
    cumulativeRouteGain = cum;
    return cumulativeRouteGain;
}

function formatNavRemain(meters) {
    if (meters == null || isNaN(meters)) return '--';
    const isImperial = currentUnits === 'imperial';
    if (isImperial) {
        const miles = meters / 1609.344;
        return `${miles.toFixed(2)} mi`;
    } else {
        const km = meters / 1000;
        return `${km.toFixed(2)} km`;
    }
}

function formatNavRemainTime(minutes) {
    if (minutes == null || isNaN(minutes) || minutes <= 0) return '';
    if (minutes < 1) return '• <1 min';
    if (minutes < 60) return `• ${Math.round(minutes)} min`;
    const hrs = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return `• ${hrs}h ${mins}m`;
}

function formatNavEta(minutes) {
    if (minutes == null || isNaN(minutes) || minutes < 0) return '';
    const etaDate = new Date(Date.now() + Math.round(minutes * 60000));
    try {
        const timeStr = etaDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return `Arrive at ${timeStr}`;
    } catch (e) {
        let h = etaDate.getHours();
        const m = String(etaDate.getMinutes()).padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `Arrive at ${h}:${m} ${ampm}`;
    }
}

function formatNavDistance(meters) {
    if (meters == null || isNaN(meters)) return '--';
    const isImperial = currentUnits === 'imperial';
    if (isImperial) {
        const feet = meters * 3.28084;
        if (feet < 900) {
            return `${Math.round(feet / 10) * 10} ft`;
        }
        const miles = meters / 1609.344;
        return `${miles.toFixed(1)} mi`;
    } else {
        if (meters < 900) {
            return `${Math.round(meters / 10) * 10} m`;
        }
        const km = meters / 1000;
        return `${km.toFixed(1)} km`;
    }
}

function updateNavigationHUD(pos) {
    if (!isLiveNavActive) return;
    lastKnownGpsPos = pos;
    const hud = document.getElementById('live-nav-hud');
    if (!hud) return;

    const coords = currentRouteGeoJSON?.coordinates;
    if (!coords || coords.length < 2) {
        document.getElementById('live-nav-instruction').textContent = 'Please plot a route first';
        document.getElementById('live-nav-distance').textContent = 'No route active';
        return;
    }

    const gpsLngLat = [pos.coords.longitude, pos.coords.latitude];
    ensureUserLocationMarker(gpsLngLat);
    userLocationMarker.setLngLat(gpsLngLat);

    const closest = findClosestPointOnRoute(gpsLngLat);
    if (!closest) return;

    // Track cumulative distance and elevation gain/loss during this navigation session
    if (liveNavLastDistAlongRoute === null) {
        liveNavStartDistAlongRoute = closest.distAlongRoute;
        liveNavLastDistAlongRoute = closest.distAlongRoute;
    } else {
        const deltaDist = closest.distAlongRoute - liveNavLastDistAlongRoute;
        // Rider progressing forward along route
        if (deltaDist > 0 && deltaDist < 200) {
            liveNavTotalTraveledMeters += deltaDist;
            liveNavLastDistAlongRoute = closest.distAlongRoute;
        } else if (deltaDist < -10) {
            // Rider moved or recalculated
            liveNavLastDistAlongRoute = closest.distAlongRoute;
        }
    }

    // Calculate heading (direction of travel)
    let heading = pos.coords.heading;
    if (heading == null || isNaN(heading) || heading === 0) {
        if (lastGpsLngLat && (Math.abs(gpsLngLat[0] - lastGpsLngLat[0]) > 0.000015 || Math.abs(gpsLngLat[1] - lastGpsLngLat[1]) > 0.000015)) {
            heading = calculateBearing(lastGpsLngLat, gpsLngLat);
        } else if (closest && coords && coords.length > closest.index + 1) {
            heading = calculateBearing(coords[closest.index], coords[closest.index + 1]);
        } else {
            heading = currentHeading || 0;
        }
    }
    currentHeading = heading;
    lastGpsLngLat = [gpsLngLat[0], gpsLngLat[1]];

    userLocationMarker.setRotation(heading);

    // Third-person perspective camera behind the dot:
    // Initialize from saved localStorage zoom/tilt (default 17.5 zoom, 58 pitch)
    let targetZoom = Math.max(10, map.getZoom());
    let targetPitch = map.getPitch();

    if (!isInitialNavCameraSet) {
        const savedZoom = parseFloat(localStorage.getItem('nav_user_zoom'));
        const savedPitch = parseFloat(localStorage.getItem('nav_user_pitch'));
        targetZoom = (!isNaN(savedZoom) && savedZoom >= 10 && savedZoom <= 22) ? savedZoom : 17.5;
        targetPitch = (!isNaN(savedPitch) && savedPitch >= 0 && savedPitch <= 85) ? savedPitch : 58;
        isInitialNavCameraSet = true;
    }

    // Check if user is actively touching, dragging, pitching, or zooming the map
    const isUserInteracting = (
        isUserTouchingMap ||
        (map.touchPitch && typeof map.touchPitch.isActive === 'function' && map.touchPitch.isActive()) ||
        (map.touchZoomRotate && typeof map.touchZoomRotate.isActive === 'function' && map.touchZoomRotate.isActive()) ||
        (map.scrollZoom && typeof map.scrollZoom.isActive === 'function' && map.scrollZoom.isActive()) ||
        (typeof map.isZooming === 'function' && map.isZooming()) ||
        (typeof map.isRotating === 'function' && map.isRotating())
    );

    // Only ease camera if user is not actively touching or adjusting zoom/pitch
    if (!isUserInteracting) {
        const latRad = gpsLngLat[1] * Math.PI / 180;
        const metersPerPixel = (156543.03392 * Math.cos(latRad)) / Math.pow(2, targetZoom);
        // Lookahead forward along heading so rider sits ~1/3 of the way up from screen bottom
        const lookaheadMeters = metersPerPixel * 105;
        const cameraTarget = offsetLngLat(gpsLngLat, heading, lookaheadMeters);

        map.easeTo({
            center: cameraTarget,
            zoom: targetZoom,
            pitch: targetPitch,
            bearing: heading,
            padding: { top: 0, bottom: 0, left: 0, right: 0 },
            duration: 350,
            easing: (t) => t
        });
    }

    const isImperial = currentUnits === 'imperial';

    // Handle transit / gap segments during navigation
    const hasTransit = waypointPathIndices && waypointPathIndices.length >= 2 && segmentModes.some(m => m === 'transit');

    if (hasTransit) {
        if (liveNavTransitSegIndex !== null) {
            const endIdx = waypointPathIndices[liveNavTransitSegIndex + 1];
            const endCoord = coords[endIdx];
            const distToResume = haversineDistance(gpsLngLat, endCoord);
            const nonTransit = findClosestPointOnRoute(gpsLngLat, true);
            const hasResumedOnRoute = distToResume <= 40 || (nonTransit && nonTransit.index >= endIdx && nonTransit.distMeters <= 40);
            if (hasResumedOnRoute) {
                liveNavTransitSegIndex = null;
                if (nonTransit) liveNavLastRouteIndex = nonTransit.index;
            }
        } else {
            for (let segI = 0; segI < waypointPathIndices.length - 1; segI++) {
                if (segmentModes[segI] === 'transit') {
                    const sStart = waypointPathIndices[segI];
                    const sEnd = waypointPathIndices[segI + 1];
                    const distToStart = haversineDistance(gpsLngLat, coords[sStart]);
                    const distToEnd = haversineDistance(gpsLngLat, coords[sEnd]);
                    if ((distToStart <= 40 && liveNavLastRouteIndex != null && liveNavLastRouteIndex >= sStart - 2) ||
                        (closest.index >= sStart && closest.index < sEnd && distToEnd > 40)) {
                        liveNavTransitSegIndex = segI;
                        break;
                    }
                }
            }
        }
    } else {
        liveNavTransitSegIndex = null;
    }

    if (liveNavTransitSegIndex !== null) {
        const sEnd = waypointPathIndices[liveNavTransitSegIndex + 1];
        const endCoord = coords[sEnd];
        const distToResume = haversineDistance(gpsLngLat, endCoord);

        isNavOnRoute = true;
        wasNavOffRoute = false;
        currentNavDispDist = null;

        hud.classList.remove('off-route-banner');
        hud.classList.remove('arrive-banner');

        const arrowSource = map.getSource('nav-offroute-arrow-source');
        if (arrowSource) {
            arrowSource.setData({ type: 'FeatureCollection', features: [] });
        }

        const instructionEl = document.getElementById('live-nav-instruction');
        const distEl = document.getElementById('live-nav-distance');
        const iconContainer = document.getElementById('live-nav-turn-icon');

        if (iconContainer) iconContainer.innerHTML = getTurnSvg('transit');
        if (instructionEl) instructionEl.textContent = "Reached end of segment";
        if (distEl) distEl.textContent = `${formatNavDistance(distToResume)} to next segment`;

        // Keep grade telemetry neutral
        const gradeEl = document.getElementById('nav-stat-grade');
        if (gradeEl) {
            gradeEl.textContent = "0.00%";
            gradeEl.style.color = '';
        }
        const gradeCard = document.getElementById('nav-stat-grade-card') || (gradeEl ? gradeEl.closest('.live-nav-stat-card') : null);
        if (gradeCard) {
            gradeCard.style.removeProperty('background-color');
            gradeCard.style.removeProperty('border-color');
        }

        // Trip stats
        const tripDistEl = document.getElementById('nav-stat-trip-dist');
        const tripDistUnitEl = document.getElementById('nav-stat-trip-dist-unit');
        if (tripDistEl) {
            const distDisp = isImperial ? (liveNavTotalTraveledMeters / 1609.344) : (liveNavTotalTraveledMeters / 1000);
            tripDistEl.textContent = distDisp.toFixed(2);
        }
        if (tripDistUnitEl) tripDistUnitEl.textContent = isImperial ? 'MI DIST' : 'KM DIST';

        const tripElevEl = document.getElementById('nav-stat-trip-elev');
        const tripElevUnitEl = document.getElementById('nav-stat-trip-elev-unit');
        if (tripElevEl) {
            const gainDisp = isImperial ? Math.round(liveNavAccumGainMeters * 3.28084) : Math.round(liveNavAccumGainMeters);
            tripElevEl.textContent = `+${gainDisp.toLocaleString()}`;
        }
        if (tripElevUnitEl) tripElevUnitEl.textContent = isImperial ? 'FT GAIN' : 'M GAIN';

        // Remaining distance & ETA to destination from next segment
        const totalDist = routeTotalDist || 0;
        const resumeDistAlong = (routePathDistances && routePathDistances[sEnd]) ? routePathDistances[sEnd] : 0;
        const remainingMeters = Math.max(0, totalDist - resumeDistAlong);
        const topRemainValEl = document.getElementById('nav-top-remain-val');
        const topRemainTimeEl = document.getElementById('nav-top-remain-time');
        const topEtaEl = document.getElementById('nav-top-eta');
        if (topRemainValEl) topRemainValEl.textContent = formatNavRemain(remainingMeters);
        if (topRemainTimeEl || topEtaEl) {
            const cumGainArr = getCumulativeRouteGain();
            const remainGainMeters = (cumGainArr && sEnd < cumGainArr.length)
                ? Math.max(0, cumGainArr[cumGainArr.length - 1] - cumGainArr[sEnd])
                : 0;
            const remainMin = getEstimatedTime(remainingMeters, remainGainMeters, currentRoutingMode);
            if (topRemainTimeEl) topRemainTimeEl.textContent = formatNavRemainTime(remainMin);
            if (topEtaEl) topEtaEl.textContent = formatNavEta(remainMin);
        }

        window.AndroidMaterialTheme?.updateNavNotification?.("Reached end of segment", `${formatNavDistance(distToResume)} to next segment`);
        return;
    }

    // 1. SPEED TELEMETRY
    const speedRaw = pos.coords.speed; // meters per second
    let displaySpeed = 0;
    if (speedRaw != null && !isNaN(speedRaw) && speedRaw > 0.3) {
        displaySpeed = isImperial ? (speedRaw * 2.23694) : (speedRaw * 3.6);
    }
    const speedEl = document.getElementById('nav-stat-speed');
    const speedUnitEl = document.getElementById('nav-stat-speed-unit');
    if (speedEl) speedEl.textContent = displaySpeed.toFixed(1);
    if (speedUnitEl) speedUnitEl.textContent = isImperial ? 'MPH' : 'KM/H';

    // 2. ELEVATION & GAIN/LOSS TELEMETRY
    let elevationMeters = pos.coords.altitude;
    if (elevationMeters == null && currentStats?.elevations?.length > closest.index) {
        elevationMeters = currentStats.elevations[closest.index];
    }

    // Accumulate elevation gain using high-resolution DEM route profile
    const cumGainArr = getCumulativeRouteGain();
    if (cumGainArr && closest.index != null && closest.index < cumGainArr.length) {
        if (liveNavLastRouteIndex === null) {
            liveNavLastRouteIndex = closest.index;
        } else if (closest.index > liveNavLastRouteIndex) {
            const gainDelta = cumGainArr[closest.index] - cumGainArr[liveNavLastRouteIndex];
            if (gainDelta > 0 && gainDelta < 500) {
                liveNavAccumGainMeters += gainDelta;
            }
            liveNavLastRouteIndex = closest.index;
        } else if (closest.index < liveNavLastRouteIndex - 10) {
            liveNavLastRouteIndex = closest.index;
        }
    } else if (elevationMeters != null) {
        if (liveNavLastElevationMeters !== null) {
            const diffElev = elevationMeters - liveNavLastElevationMeters;
            if (Math.abs(diffElev) < 50) {
                if (diffElev > 0.1) liveNavAccumGainMeters += diffElev;
                else if (diffElev < -0.1) liveNavAccumLossMeters += Math.abs(diffElev);
            }
        }
        liveNavLastElevationMeters = elevationMeters;
    }

    // 3. GRADE TELEMETRY (Hundredths precision)
    let gradeVal = 0;
    if (currentStats?.grades?.length > closest.index) {
        gradeVal = Number(currentStats.grades[closest.index] || 0);
    }
    const gradeStr = (gradeVal >= 0 ? '+' : '') + gradeVal.toFixed(2) + '%';
    const gradeEl = document.getElementById('nav-stat-grade');
    if (gradeEl) {
        gradeEl.textContent = gradeStr;
        if (gradeVal >= 5) {
            gradeEl.style.color = '#ef4444';
        } else if (gradeVal <= -5) {
            gradeEl.style.color = '#3b82f6';
        } else {
            gradeEl.style.color = '';
        }
        // Color the background of the grade swatch card with the grade color (desaturated/translucent 0.25 alpha)
        const gradeCard = document.getElementById('nav-stat-grade-card') || gradeEl.closest('.live-nav-stat-card');
        if (gradeCard) {
            const gradeColor = getColorForGrade(gradeVal);
            const desaturatedBg = gradeColor.replace('rgb(', 'rgba(').replace(')', ', 0.25)');
            const desaturatedBorder = gradeColor.replace('rgb(', 'rgba(').replace(')', ', 0.5)');
            gradeCard.style.setProperty('background-color', desaturatedBg, 'important');
            gradeCard.style.setProperty('border-color', desaturatedBorder, 'important');
        }
    }

    // 4. FIRST LINE STATS: TOTAL DISTANCE TRAVELED & ELEVATION GAIN
    const tripDistEl = document.getElementById('nav-stat-trip-dist');
    const tripDistUnitEl = document.getElementById('nav-stat-trip-dist-unit');
    if (tripDistEl) {
        const distDisp = isImperial ? (liveNavTotalTraveledMeters / 1609.344) : (liveNavTotalTraveledMeters / 1000);
        tripDistEl.textContent = distDisp.toFixed(2);
    }
    if (tripDistUnitEl) tripDistUnitEl.textContent = isImperial ? 'MI DIST' : 'KM DIST';

    const tripElevEl = document.getElementById('nav-stat-trip-elev');
    const tripElevUnitEl = document.getElementById('nav-stat-trip-elev-unit');
    if (tripElevEl) {
        const gainDisp = isImperial ? Math.round(liveNavAccumGainMeters * 3.28084) : Math.round(liveNavAccumGainMeters);
        tripElevEl.textContent = `+${gainDisp.toLocaleString()}`;
    }
    if (tripElevUnitEl) tripElevUnitEl.textContent = isImperial ? 'FT GAIN' : 'M GAIN';

    // 5. TOP REMAINING DISTANCE WITH MONOCHROME FLAG, TIME & ETA
    const totalDist = routeTotalDist || 0;
    const remainingMeters = Math.max(0, totalDist - closest.distAlongRoute);
    const topRemainValEl = document.getElementById('nav-top-remain-val');
    const topRemainTimeEl = document.getElementById('nav-top-remain-time');
    const topEtaEl = document.getElementById('nav-top-eta');

    if (topRemainValEl) {
        topRemainValEl.textContent = formatNavRemain(remainingMeters);
    }

    if (topRemainTimeEl || topEtaEl) {
        const remainGainMeters = (cumGainArr && closest.index != null && closest.index < cumGainArr.length)
            ? Math.max(0, cumGainArr[cumGainArr.length - 1] - cumGainArr[closest.index])
            : 0;
        const remainMin = getEstimatedTime(remainingMeters, remainGainMeters, currentRoutingMode);

        if (topRemainTimeEl) {
            topRemainTimeEl.textContent = formatNavRemainTime(remainMin);
        }
        if (topEtaEl) {
            topEtaEl.textContent = formatNavEta(remainMin);
        }
    }

    // 6. OFF ROUTE vs ON ROUTE & ELEVATION GRAPH TRACKING
    const OFF_ROUTE_THRESHOLD_METERS = 60; // 60 meters off track
    const instructionEl = document.getElementById('live-nav-instruction');
    const distEl = document.getElementById('live-nav-distance');
    const iconContainer = document.getElementById('live-nav-turn-icon');

    if (closest.distMeters > OFF_ROUTE_THRESHOLD_METERS) {
        // Off route: Hide elevation line marker
        isNavOnRoute = false;
        currentNavDispDist = null;

        const distBackStr = formatNavDistance(closest.distMeters);

        hud.classList.remove('arrive-banner');
        hud.classList.add('off-route-banner');
        if (iconContainer) iconContainer.innerHTML = getTurnSvg('alert');
        if (instructionEl) instructionEl.textContent = "Off route";
        if (distEl) distEl.textContent = `${distBackStr} to route`;

        // Long buzz vibration once upon transitioning to off-route
        if (!wasNavOffRoute) {
            wasNavOffRoute = true;
            const vibrationCheck = document.getElementById('nav-vibration-check');
            const isVibrationEnabled = vibrationCheck ? vibrationCheck.checked : true;
            if (isVibrationEnabled) {
                if (window.AndroidMaterialTheme?.vibratePhone) {
                    window.AndroidMaterialTheme.vibratePhone(1000); // 1000ms distinct long buzz
                } else if (navigator.vibrate) {
                    navigator.vibrate(1000);
                }
            }
        }

        // Draw solid trajectory line from dot to closest route point
        const arrowSource = map.getSource('nav-offroute-arrow-source');
        if (arrowSource) {
            arrowSource.setData({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [gpsLngLat, closest.point]
                }
            });
        }

        // Background ongoing notification
        window.AndroidMaterialTheme?.updateNavNotification?.("Off route", `${distBackStr} to route`);
    } else {
        // On route: Show position on elevation graph
        isNavOnRoute = true;
        wasNavOffRoute = false;
        currentNavDispDist = isImperial ? (closest.distAlongRoute / 1609.344) : (closest.distAlongRoute / 1000);

        hud.classList.remove('off-route-banner');

        // Clear off-route trajectory line
        const arrowSource = map.getSource('nav-offroute-arrow-source');
        if (arrowSource) {
            arrowSource.setData({ type: 'FeatureCollection', features: [] });
        }

        const turn = getUpcomingTurn(coords, closest.index);
        if (turn.type === 'arrive' || turn.type === 'arrive-segment') {
            hud.classList.add('arrive-banner');
        } else {
            hud.classList.remove('arrive-banner');
        }

        if (iconContainer) iconContainer.innerHTML = getTurnSvg(turn.icon);
        if (instructionEl) instructionEl.textContent = turn.text;
        let notifDistText = "";
        if (distEl) {
            if (turn.type === 'arrive') {
                distEl.textContent = `${formatNavDistance(remainingMeters)} remaining`;
                notifDistText = `${formatNavDistance(remainingMeters)} remaining`;
            } else {
                distEl.textContent = `In ${formatNavDistance(turn.distMeters)}`;
                notifDistText = `In ${formatNavDistance(turn.distMeters)}`;
            }
        }

        // Turn Vibration: Vibrate ONLY when approaching an actual intersection turn (< 40m) if toggle is on
        const vibrationCheck = document.getElementById('nav-vibration-check');
        const isVibrationEnabled = vibrationCheck ? vibrationCheck.checked : true;
        const isRealIntersectionTurn = turn.isIntersection && ['turn-right', 'turn-left', 'sharp-right', 'sharp-left', 'u-turn-right', 'u-turn-left', 'roundabout'].includes(turn.type);
        if (isVibrationEnabled && turn.distMeters <= 40 && lastVibratedTurnIndex !== turn.turnIndex && isRealIntersectionTurn) {
            lastVibratedTurnIndex = turn.turnIndex;
            if (window.AndroidMaterialTheme?.vibratePhone) {
                window.AndroidMaterialTheme.vibratePhone(400);
            } else if (navigator.vibrate) {
                navigator.vibrate([200, 100, 200]);
            }
        }

        // Persistent background notification
        window.AndroidMaterialTheme?.updateNavNotification?.(turn.text, notifDistText);
    }

    // While routing, display live rider telemetry in top-right of elevation profile header (dist, elev, grade)
    if (currentHoverDispDist === null) {
        const statsDiv = document.getElementById('hover-stats');
        const hoverDistEl = document.getElementById('hover-dist');
        const hoverElevEl = document.getElementById('hover-elev');
        const hoverGradeEl = document.getElementById('hover-grade');
        if (statsDiv && hoverDistEl && hoverElevEl && hoverGradeEl) {
            const curDistDisp = isImperial ? (closest.distAlongRoute / 1609.344) : (closest.distAlongRoute / 1000);
            const distLabel = curDistDisp.toFixed(2) + (isImperial ? ' mi' : ' km');
            let elevLabel = '--';
            if (elevationMeters != null) {
                const dispE = isImperial ? Math.round(elevationMeters * 3.28084) : Math.round(elevationMeters);
                elevLabel = `${dispE.toLocaleString()} ${isImperial ? 'ft' : 'm'}`;
            }
            const gradeLabel = (gradeVal >= 0 ? '+' : '') + gradeVal.toFixed(2) + '%';

            hoverDistEl.textContent = distLabel;
            hoverElevEl.textContent = elevLabel;
            hoverGradeEl.textContent = gradeLabel;
            statsDiv.style.opacity = '1';
        }

        if (elevationChart) {
            elevationChart.update('none');
        }
    }
}

function startLiveNavigation() {
    if (!currentRouteGeoJSON || !currentRouteGeoJSON.coordinates || currentRouteGeoJSON.coordinates.length < 2) {
        showToast("Please plot a route before starting navigation.", "warning");
        stopLiveNavigation();
        return;
    }

    isLiveNavActive = true;
    isInitialNavCameraSet = false;
    liveNavStartDistAlongRoute = null;
    liveNavLastDistAlongRoute = null;
    liveNavTotalTraveledMeters = 0;
    liveNavLastElevationMeters = null;
    liveNavLastRouteIndex = null;
    liveNavAccumGainMeters = 0;
    liveNavAccumLossMeters = 0;
    wasNavOffRoute = false;
    document.body.classList.add('routing-active');

    // Enable zooming and tilting up/down, but prevent moving around (pan) or manual rotation
    // Zooming and tilting are centered directly on the user dot (screen center)
    map.scrollZoom.enable({ around: 'center' });
    map.doubleClickZoom.enable({ around: 'center' });
    map.boxZoom.enable();
    map.touchPitch.enable(); // Two-finger vertical drag tilts up and down
    map.touchZoomRotate.enable({ around: 'center' }); // Pinch to zoom centered on rider
    map.touchZoomRotate.disableRotation(); // Crucial: disables rotating the map manually
    map.dragPan.disable(); // Keeps camera centered on rider
    map.dragRotate.disable(); // Disables manual desktop rotate/pan
    map.keyboard.disable();

    // Prevent dragging or clicking waypoints during live routing
    markers.forEach(m => {
        m.setDraggable(false);
        if (m.getElement()) m.getElement().style.pointerEvents = 'none';
    });

    // Disable action buttons
    const clearBtn = document.getElementById('clear-route');
    if (clearBtn) clearBtn.disabled = true;
    const searchToggle = document.getElementById('search-toggle');
    if (searchToggle) searchToggle.disabled = true;
    const mobileSearchToggle = document.getElementById('mobile-search-toggle');
    if (mobileSearchToggle) mobileSearchToggle.setAttribute('disabled', 'true');
    const mapSearch = document.getElementById('map-search');
    if (mapSearch) mapSearch.disabled = true;
    document.querySelectorAll('.mode-btn').forEach(b => b.disabled = true);

    // Hide and block stats panel
    const statsPanel = document.getElementById('stats-panel');
    if (statsPanel) statsPanel.classList.remove('show');

    const navBtn = document.getElementById('start-nav-btn');
    if (navBtn) {
        const parentGroup = navBtn.closest('.icon-btn-group');
        if (parentGroup) parentGroup.classList.add('nav-active');
        navBtn.title = "Stop live navigation";
        navBtn.blur();
    }

    const hud = document.getElementById('live-nav-hud');
    if (hud) hud.style.display = 'flex';

    const isDebugSpoof = localStorage.getItem('debug_gps_joystick_enabled') === 'true';
    if (isDebugSpoof && virtualGpsCoords) {
        updateNavigationHUD({
            coords: {
                longitude: virtualGpsCoords[0],
                latitude: virtualGpsCoords[1],
                speed: 0,
                heading: currentHeading || 0,
                altitude: 50
            }
        });
    }

    if ("geolocation" in navigator) {
        navWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                if (localStorage.getItem('debug_gps_joystick_enabled') === 'true') return;
                updateNavigationHUD(pos);
            },
            (err) => {
                if (localStorage.getItem('debug_gps_joystick_enabled') === 'true') return;
                console.warn("Navigation geolocation error:", err);
                const instructionEl = document.getElementById('live-nav-instruction');
                if (instructionEl) instructionEl.textContent = "Waiting for GPS signal...";
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    } else if (!isDebugSpoof) {
        showToast("Geolocation is not supported by your device.", "error");
        stopLiveNavigation();
    }
}

function stopLiveNavigation() {
    isLiveNavActive = false;
    isInitialNavCameraSet = false;
    liveNavTransitSegIndex = null;
    document.body.classList.remove('routing-active');

    if (navWatchId !== null) {
        navigator.geolocation.clearWatch(navWatchId);
        navWatchId = null;
    }

    // Re-enable all map interactions and rotation
    map.scrollZoom.enable();
    map.boxZoom.enable();
    map.dragRotate.enable();
    map.dragPan.enable();
    map.keyboard.enable();
    map.doubleClickZoom.enable();
    map.touchZoomRotate.enable();
    if (typeof map.touchZoomRotate.enableRotation === 'function') {
        map.touchZoomRotate.enableRotation();
    }
    map.touchPitch.enable();

    // Re-enable dragging waypoint markers and pointer events
    markers.forEach(m => {
        m.setDraggable(true);
        if (m.getElement()) m.getElement().style.pointerEvents = '';
    });

    // Reset camera pitch and bearing smoothly back to top-down flat view
    map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 800 });

    // Re-enable action buttons
    const clearBtn = document.getElementById('clear-route');
    if (clearBtn) clearBtn.disabled = false;
    const searchToggle = document.getElementById('search-toggle');
    if (searchToggle) searchToggle.disabled = false;
    const mobileSearchToggle = document.getElementById('mobile-search-toggle');
    if (mobileSearchToggle) mobileSearchToggle.removeAttribute('disabled');
    const mapSearch = document.getElementById('map-search');
    if (mapSearch) mapSearch.disabled = false;
    document.querySelectorAll('.mode-btn').forEach(b => b.disabled = false);

    // Clear elevation graph nav marker
    isNavOnRoute = false;
    currentNavDispDist = null;
    if (elevationChart) elevationChart.update('none');

    const navBtn = document.getElementById('start-nav-btn');
    if (navBtn) {
        const parentGroup = navBtn.closest('.icon-btn-group');
        if (parentGroup) parentGroup.classList.remove('nav-active');
        navBtn.title = "Start live turn-by-turn navigation";
        navBtn.blur();
    }

    const hud = document.getElementById('live-nav-hud');
    if (hud) {
        hud.style.display = 'none';
        hud.classList.remove('off-route-banner');
        hud.classList.remove('arrive-banner');
    }

    const topRemainValEl = document.getElementById('nav-top-remain-val');
    if (topRemainValEl) topRemainValEl.textContent = '--';
    const topRemainTimeEl = document.getElementById('nav-top-remain-time');
    if (topRemainTimeEl) topRemainTimeEl.textContent = '';
    const topEtaEl = document.getElementById('nav-top-eta');
    if (topEtaEl) topEtaEl.textContent = '';

    // Reset grade stat card styles
    const gradeCard = document.getElementById('nav-stat-grade-card') || document.getElementById('nav-stat-grade')?.closest('.live-nav-stat-card');
    if (gradeCard) {
        gradeCard.style.removeProperty('background-color');
        gradeCard.style.removeProperty('border-color');
    }

    // Reset off-route trajectory line
    const arrowSource = map.getSource('nav-offroute-arrow-source');
    if (arrowSource) {
        arrowSource.setData({ type: 'FeatureCollection', features: [] });
    }

    // Hide elevation header hover stats if not actively hovering
    if (currentHoverDispDist === null) {
        const statsDiv = document.getElementById('hover-stats');
        if (statsDiv) statsDiv.style.opacity = '0';
    }

    // Cancel persistent background navigation notification
    window.AndroidMaterialTheme?.stopNavNotification?.();
    lastVibratedTurnIndex = -1;
    liveNavStartDistAlongRoute = null;
    liveNavLastDistAlongRoute = null;
    liveNavTotalTraveledMeters = 0;
    liveNavLastElevationMeters = null;
    liveNavLastRouteIndex = null;
    liveNavAccumGainMeters = 0;
    liveNavAccumLossMeters = 0;
    wasNavOffRoute = false;
}

function toggleLiveNavigation() {
    const navBtn = document.getElementById('start-nav-btn');
    if (navBtn) navBtn.blur();

    if (isLiveNavActive) {
        stopLiveNavigation();
    } else {
        startLiveNavigation();
    }
}

// Wire up live navigation event listeners
const startNavBtn = document.getElementById('start-nav-btn');
if (startNavBtn) {
    startNavBtn.addEventListener('click', (e) => {
        e.currentTarget.blur();
        toggleLiveNavigation();
    });
}
const stopNavBtn = document.getElementById('live-nav-stop-btn');
if (stopNavBtn) {
    stopNavBtn.addEventListener('click', stopLiveNavigation);
}

// User camera interaction tracker to prevent programmatic camera updates from fighting user gestures
let isUserTouchingMap = false;
let userTouchTimeout = null;

const mapCanvas = map.getCanvas();
if (mapCanvas) {
    const onTouchStart = () => {
        isUserTouchingMap = true;
        if (userTouchTimeout) clearTimeout(userTouchTimeout);
    };
    const onTouchEnd = () => {
        if (userTouchTimeout) clearTimeout(userTouchTimeout);
        userTouchTimeout = setTimeout(() => {
            isUserTouchingMap = false;
        }, 300);
    };
    mapCanvas.addEventListener('touchstart', onTouchStart, { passive: true });
    mapCanvas.addEventListener('touchend', onTouchEnd, { passive: true });
    mapCanvas.addEventListener('touchcancel', onTouchEnd, { passive: true });
    mapCanvas.addEventListener('mousedown', onTouchStart, { passive: true });
    window.addEventListener('mouseup', onTouchEnd, { passive: true });
}

// Synchronize map pitch with CSS for user location direction cone tilting
function updateMapPitchCss() {
    const pitch = map.getPitch() || 0;
    document.documentElement.style.setProperty('--map-pitch', `${pitch}deg`);
}
map.on('pitch', updateMapPitchCss);
updateMapPitchCss();

// Save user zoom & pitch preferences during live navigation
map.on('zoomend', () => {
    if (isLiveNavActive) {
        try {
            localStorage.setItem('nav_user_zoom', map.getZoom().toString());
        } catch (_) {}
    }
});
map.on('pitchend', () => {
    updateMapPitchCss();
    if (isLiveNavActive) {
        try {
            localStorage.setItem('nav_user_pitch', map.getPitch().toString());
        } catch (_) {}
    }
});

// --- Debug GPS Location Throttle / Brake / Steer Spoofing ---
let virtualGpsCoords = null;
let isThrottlePressed = false;
let isBrakePressed = false;
let isSteerLeftPressed = false;
let isSteerRightPressed = false;
let debugSimSpeed = 0; // Current simulated speed in m/s (0 to ~8.94 m/s = 20.0 mph)
let debugLoopId = null;
let lastDebugTimestamp = null;

function initDebugJoystick() {
    const debugToggle = document.getElementById('debug-joystick-check');
    const debugContainer = document.getElementById('debug-joystick-container');
    const resetBtn = document.getElementById('debug-joystick-reset-btn');
    const throttleBtn = document.getElementById('debug-ctrl-throttle');
    const brakeBtn = document.getElementById('debug-ctrl-brake');
    const steerLeftBtn = document.getElementById('debug-ctrl-steer-left');
    const steerRightBtn = document.getElementById('debug-ctrl-steer-right');

    if (!debugToggle || !debugContainer) return;

    const savedState = localStorage.getItem('debug_gps_joystick_enabled') === 'true';
    debugToggle.checked = savedState;
    debugContainer.style.display = savedState ? 'flex' : 'none';

    if (resetBtn) {
        resetBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            debugSimSpeed = 0;
            if ("geolocation" in navigator) {
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        virtualGpsCoords = [pos.coords.longitude, pos.coords.latitude];
                        currentHeading = pos.coords.heading || 0;
                        ensureUserLocationMarker(virtualGpsCoords);
                        if (userLocationMarker) {
                            userLocationMarker.setLngLat(virtualGpsCoords);
                            userLocationMarker.setRotation(currentHeading);
                        }
                        if (isLiveNavActive) {
                            updateNavigationHUD({
                                coords: {
                                    longitude: virtualGpsCoords[0],
                                    latitude: virtualGpsCoords[1],
                                    speed: 0,
                                    heading: currentHeading,
                                    altitude: pos.coords.altitude || 50
                                }
                            });
                        } else {
                            map.easeTo({ center: virtualGpsCoords, duration: 400 });
                        }
                        showToast("GPS reset to current location", "info");
                    },
                    () => {
                        if (currentRouteGeoJSON?.coordinates?.length) {
                            virtualGpsCoords = [currentRouteGeoJSON.coordinates[0][0], currentRouteGeoJSON.coordinates[0][1]];
                            ensureUserLocationMarker(virtualGpsCoords);
                            if (userLocationMarker) userLocationMarker.setLngLat(virtualGpsCoords);
                            if (isLiveNavActive) {
                                updateNavigationHUD({
                                    coords: {
                                        longitude: virtualGpsCoords[0],
                                        latitude: virtualGpsCoords[1],
                                        speed: 0,
                                        heading: 0,
                                        altitude: 50
                                    }
                                });
                            } else {
                                map.easeTo({ center: virtualGpsCoords, duration: 400 });
                            }
                            showToast("Reset to start of route", "info");
                        } else {
                            showToast("Could not determine current location", "warning");
                        }
                    },
                    { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
                );
            } else if (currentRouteGeoJSON?.coordinates?.length) {
                virtualGpsCoords = [currentRouteGeoJSON.coordinates[0][0], currentRouteGeoJSON.coordinates[0][1]];
                ensureUserLocationMarker(virtualGpsCoords);
                if (userLocationMarker) userLocationMarker.setLngLat(virtualGpsCoords);
                map.easeTo({ center: virtualGpsCoords, duration: 400 });
                showToast("Reset to start of route", "info");
            }
        });
    }

    // Helper to wire up press/hold events for touch and pointer
    function bindButtonPress(btn, onDown, onUp) {
        if (!btn) return;
        const downHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            try { btn.setPointerCapture(e.pointerId); } catch (_) {}
            btn.classList.add('active');
            onDown();
        };
        const upHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
            btn.classList.remove('active');
            onUp();
        };
        btn.addEventListener('pointerdown', downHandler);
        btn.addEventListener('pointerup', upHandler);
        btn.addEventListener('pointercancel', upHandler);
    }

    bindButtonPress(throttleBtn, () => { isThrottlePressed = true; }, () => { isThrottlePressed = false; });
    bindButtonPress(brakeBtn, () => { isBrakePressed = true; }, () => { isBrakePressed = false; });
    bindButtonPress(steerLeftBtn, () => { isSteerLeftPressed = true; }, () => { isSteerLeftPressed = false; });
    bindButtonPress(steerRightBtn, () => { isSteerRightPressed = true; }, () => { isSteerRightPressed = false; });

    debugToggle.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        localStorage.setItem('debug_gps_joystick_enabled', enabled);
        debugContainer.style.display = enabled ? 'flex' : 'none';
        if (enabled) {
            setupInitialVirtualGps();
            startDebugLoop();
        } else {
            stopDebugLoop();
        }
    });

    if (savedState) {
        setupInitialVirtualGps();
        startDebugLoop();
    }

    function setupInitialVirtualGps() {
        if (!virtualGpsCoords) {
            if (currentRouteGeoJSON?.coordinates?.length) {
                virtualGpsCoords = [currentRouteGeoJSON.coordinates[0][0], currentRouteGeoJSON.coordinates[0][1]];
                if (currentRouteGeoJSON.coordinates.length > 1) {
                    currentHeading = calculateBearing(currentRouteGeoJSON.coordinates[0], currentRouteGeoJSON.coordinates[1]);
                }
            } else if (userLocationMarker) {
                const ll = userLocationMarker.getLngLat();
                virtualGpsCoords = [ll.lng, ll.lat];
            } else {
                const c = map.getCenter();
                virtualGpsCoords = [c.lng, c.lat];
            }
        }
        ensureUserLocationMarker(virtualGpsCoords);
        if (userLocationMarker) {
            userLocationMarker.setLngLat(virtualGpsCoords);
            userLocationMarker.setRotation(currentHeading || 0);
        }
    }
}

function startDebugLoop() {
    if (debugLoopId) return;
    lastDebugTimestamp = performance.now();

    function step(timestamp) {
        const dt = Math.min(0.1, (timestamp - lastDebugTimestamp) / 1000);
        lastDebugTimestamp = timestamp;

        if (isBrakePressed) {
            // Braking deceleration
            debugSimSpeed = Math.max(0, debugSimSpeed - 6.0 * dt);
        } else if (isThrottlePressed) {
            // Uncapped acceleration
            debugSimSpeed += 2.8 * dt;
        } else {
            // Zero friction - keeps constant velocity when neither throttle nor brake is held
        }

        // Steering: rotate heading left or right
        if (isSteerLeftPressed) {
            currentHeading = ((currentHeading || 0) - 80 * dt + 360) % 360;
        }
        if (isSteerRightPressed) {
            currentHeading = ((currentHeading || 0) + 80 * dt) % 360;
        }

        if (virtualGpsCoords) {
            const heading = currentHeading || 0;
            const headingRad = heading * Math.PI / 180;
            const dMeters = debugSimSpeed * dt;

            if (dMeters > 0) {
                const dLat = (dMeters * Math.cos(headingRad)) / 111139;
                const dLng = (dMeters * Math.sin(headingRad)) / (111139 * Math.cos(virtualGpsCoords[1] * Math.PI / 180));
                virtualGpsCoords[0] += dLng;
                virtualGpsCoords[1] += dLat;
            }

            const spoofedPos = {
                coords: {
                    longitude: virtualGpsCoords[0],
                    latitude: virtualGpsCoords[1],
                    speed: debugSimSpeed,
                    heading: heading,
                    altitude: 50
                }
            };

            if (isLiveNavActive) {
                updateNavigationHUD(spoofedPos);
            } else {
                ensureUserLocationMarker(virtualGpsCoords);
                if (userLocationMarker) {
                    userLocationMarker.setLngLat(virtualGpsCoords);
                    userLocationMarker.setRotation(heading);
                }
                // In normal mode, do NOT center or move the camera as location changes
            }
        }
        debugLoopId = requestAnimationFrame(step);
    }
    debugLoopId = requestAnimationFrame(step);
}

function stopDebugLoop() {
    if (debugLoopId) {
        cancelAnimationFrame(debugLoopId);
        debugLoopId = null;
    }
}

// Initialize debug controls
initDebugJoystick();

// Only enable live navigation and navigation HUD UI on the native app version (e.g. Capacitor Android)
(function enforceNativeOnlyLiveNavigation() {
    const isNative = Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    if (!isNative) {
        const navBtnGroup = document.querySelector('.icon-btn-group-success:has(#start-nav-btn)') || document.getElementById('start-nav-btn')?.closest('.icon-btn-group');
        if (navBtnGroup) navBtnGroup.style.display = 'none';
        const startBtn = document.getElementById('start-nav-btn');
        if (startBtn) startBtn.style.display = 'none';
        const hud = document.getElementById('live-nav-hud');
        if (hud) hud.style.display = 'none';
        const debugJoystick = document.getElementById('debug-joystick-container');
        if (debugJoystick) debugJoystick.style.display = 'none';
        const debugCheckRow = document.getElementById('debug-joystick-check')?.closest('.setting-row');
        if (debugCheckRow) debugCheckRow.style.display = 'none';
        const hapticsRow = document.getElementById('nav-vibration-check')?.closest('.setting-row');
        if (hapticsRow) hapticsRow.style.display = 'none';
    }
})();

