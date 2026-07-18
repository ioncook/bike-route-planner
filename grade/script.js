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
    trackResize: true,
    clickTolerance: 8,
    aroundCenter: false
});

map.dragRotate.enable();
map.touchZoomRotate.enable();
map.scrollZoom.enable({ around: 'center' }); // Zoom around center to bypass expensive 3D terrain raycast intersections on scroll

map.on('rotateend', () => {
    isRightClickDragging = false;
    document.body.classList.remove('right-click-dragging');
});
map.on('pitchend', () => {
    isRightClickDragging = false;
    document.body.classList.remove('right-click-dragging');
});

// Double right-click capture to reset orientation and right-click drag cursor (grabbing hand)
let lastRightClickTime = 0;
let isRightClickDragging = false;

map.getCanvasContainer().addEventListener('mousedown', (e) => {
    if (e.button === 2) { // Right mouse button
        isRightClickDragging = true;
        document.body.classList.add('right-click-dragging');

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

window.addEventListener('mouseup', (e) => {
    if (isRightClickDragging) {
        isRightClickDragging = false;
        document.body.classList.remove('right-click-dragging');
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
        if (e.data.type === 'process-grade-ways') {
            cb(e.data.processedWays);
        } else {
            cb(e.data.elevations);
        }
    }
};

function getHighResElevation(coords) {
    return new Promise(resolve => {
        const id = _nextWorkerId++;
        _workerCallbacks.set(id, resolve);
        elevationWorker.postMessage({ id, coords });
    });
}

function getProcessedSegmentsFromWorker(ways) {
    return new Promise(resolve => {
        const id = _nextWorkerId++;
        _workerCallbacks.set(id, resolve);
        elevationWorker.postMessage({ type: 'process-grade-ways', id, ways });
    });
}



// Cache for processed ways: wayId -> Array of Segment objects
const wayCache = new Map();
let isFetching = false;

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
            maxzoom: 11
        });
    }

    if (!map.getSource('hillshade-source')) {
        map.addSource('hillshade-source', {
            type: 'raster-dem',
            tiles: terrainTiles,
            tileSize: 256,
            encoding: terrainEncoding,
            maxzoom: 11
        });
    }

    if (!map.getLayer('hillshade-layer')) {
        map.addLayer({
            id: 'hillshade-layer',
            type: 'hillshade',
            source: 'hillshade-source',
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

    if (!map.getSource('carto-streets')) {
        map.addSource('carto-streets', {
            type: 'vector',
            tiles: ['https://tiles.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt'],
            maxzoom: 14
        });
    }

    if (!map.getLayer('carto-roads-hidden')) {
        map.addLayer({
            id: 'carto-roads-hidden',
            type: 'line',
            source: 'carto-streets',
            'source-layer': 'transportation',
            paint: {
                'line-opacity': 0
            },
            filter: [
                'all',
                ['==', '$type', 'LineString'],
                ['!in', 'class', 'footway', 'pedestrian', 'steps', 'construction', 'service', 'track', 'path', 'bridleway']
            ]
        });
    }

    if (!map.getSource('grade-roads')) {
        map.addSource('grade-roads', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    // Get current line opacity setting
    const opacityVal = 1.0;

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

        let lastHoverTime = 0;
        map.on('mousemove', 'grade-roads-hover-sensor', (e) => {
            if (stickySegmentId) return; // Ignore hover updates when locked

            const now = performance.now();
            if (now - lastHoverTime < 30) return; // Throttle to ~30fps to avoid blocking main thread
            lastHoverTime = now;

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
    fetchAndProcessViewport();
});

// Update the map line layer with cached features
function updateMapData() {
    if (!map.getSource('grade-roads')) return;

    const features = [];
    const seenSegments = new Set();

    for (const [_, segments] of wayCache.entries()) {
        for (const seg of segments) {
            if (seg.grade !== undefined) {
                const coords = seg.coordinates;
                if (!coords || coords.length < 2) continue;

                // Deduplicate segments by rounded start/end endpoints (approx 11m precision)
                const p1 = coords[0];
                const p2 = coords[coords.length - 1];
                const lon1 = Math.min(p1[0], p2[0]).toFixed(4);
                const lat1 = Math.min(p1[1], p2[1]).toFixed(4);
                const lon2 = Math.max(p1[0], p2[0]).toFixed(4);
                const lat2 = Math.max(p1[1], p2[1]).toFixed(4);
                const key = `${lon1},${lat1}_${lon2},${lat2}`;

                if (seenSegments.has(key)) continue;
                seenSegments.add(key);

                features.push({
                    type: 'Feature',
                    id: seg.id,
                    geometry: {
                        type: 'LineString',
                        coordinates: coords
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

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];

async function fetchFromOverpassWithFailover(query, signal) {
    let lastError = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, { signal });
            if (res.ok) return res;
            if (res.status === 429) {
                console.warn(`[overpass] 429 from ${endpoint}, trying fallback...`);
            } else {
                console.warn(`[overpass] Error ${res.status} from ${endpoint}, trying fallback...`);
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            lastError = err;
            console.warn(`[overpass] Failed to connect to ${endpoint}:`, err);
        }
    }
    throw lastError || new Error('All Overpass servers failed');
}

// Fetch ways and process grades
async function fetchAndProcessViewport() {
    const zoom = map.getZoom();
    const warning = document.getElementById('zoom-warning');
    const loading = document.getElementById('loading-indicator');

    // Allow loading major roads zoomed further out (zoom 12+)
    if (zoom < 12.0) {
        warning.classList.remove('hidden');
        loading.style.display = 'none';
        isFetching = false;
        return;
    } else {
        warning.classList.add('hidden');
    }

    isFetching = true;
    loading.style.display = 'flex';

    try {
        let features = [];
        try {
            features = map.queryRenderedFeatures(null, { layers: ['carto-roads-hidden'] }) || [];
        } catch (e) {
            // Layer might not be loaded yet
            return;
        }

        // Deduplicate features and skip very short tile boundary slivers/fragments (< 15 meters)
        const uniqueRoads = new Map();

        function getApproxLength(coords) {
            let dist = 0;
            for (let i = 0; i < coords.length - 1; i++) {
                const dx = (coords[i + 1][0] - coords[i][0]) * 85000;
                const dy = (coords[i + 1][1] - coords[i][1]) * 111000;
                dist += Math.sqrt(dx * dx + dy * dy);
            }
            return dist;
        }

        for (const f of features) {
            if (f.geometry.type === 'LineString') {
                const coords = f.geometry.coordinates;
                if (!coords || coords.length < 2) continue;
                if (getApproxLength(coords) < 15.0) continue;

                const key = `${coords[0][0].toFixed(5)},${coords[0][1].toFixed(5)}_${coords[coords.length - 1][0].toFixed(5)},${coords[coords.length - 1][1].toFixed(5)}`;
                if (!uniqueRoads.has(key)) {
                    uniqueRoads.set(key, { coords, id: f.id });
                }
            } else if (f.geometry.type === 'MultiLineString') {
                const parts = f.geometry.coordinates;
                for (let pIdx = 0; pIdx < parts.length; pIdx++) {
                    const coords = parts[pIdx];
                    if (!coords || coords.length < 2) continue;
                    if (getApproxLength(coords) < 15.0) continue;

                    const key = `${coords[0][0].toFixed(5)},${coords[0][1].toFixed(5)}_${coords[coords.length - 1][0].toFixed(5)},${coords[coords.length - 1][1].toFixed(5)}`;
                    if (!uniqueRoads.has(key)) {
                        uniqueRoads.set(key, { coords, id: f.id ? `${f.id}_p${pIdx}` : `${key}_p${pIdx}` });
                    }
                }
            }
        }

        // Identify new ways to process
        const waysToResolve = [];
        for (const [key, road] of uniqueRoads.entries()) {
            const cacheKey = road.id || key;
            if (!wayCache.has(cacheKey)) {
                waysToResolve.push({
                    wayId: cacheKey,
                    geomCoords: road.coords
                });
            }
        }

        if (waysToResolve.length > 0) {
            const processedWays = await getProcessedSegmentsFromWorker(waysToResolve);
            for (const item of processedWays) {
                wayCache.set(item.wayId, item.segments);
            }
            updateMapData();
        }
    } catch (err) {
        console.error('Error fetching viewport data:', err);
    } finally {
        isFetching = false;
        loading.style.display = 'none';
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

map.on('zoomend', () => {
    clearTimeout(moveendDebounceTimer);
    moveendDebounceTimer = setTimeout(() => {
        fetchAndProcessViewport();
    }, 300);
});

map.on('idle', () => {
    clearTimeout(moveendDebounceTimer);
    moveendDebounceTimer = setTimeout(() => {
        fetchAndProcessViewport();
    }, 150);
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
        // Keep hillshade visible along with 3D terrain using separate sources to prevent warnings
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



// Sync terrain settings on load
const storedHillshade = localStorage.getItem('route_hillshade') || 'off';
if (document.getElementById('hillshade-select')) {
    document.getElementById('hillshade-select').value = storedHillshade;
}
const storedExaggeration = localStorage.getItem('route_exaggeration') || '2.0';
if (document.getElementById('terrain-exaggeration')) {
    document.getElementById('terrain-exaggeration').value = storedExaggeration;
}

