// CartoDB vector tile styles — same visual look as the old raster dark/light tiles
// but rendered by GPU (smaller downloads, crisper at all zoom levels)
const VECTOR_STYLES = {
    dark:     'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    light:    'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    positron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
};

// Raster-only basemaps (no vector equivalent)
const RASTER_BASEMAPS = {
    topo:      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    cyclosm:   'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    osm:       'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
};

let currentBasemap = localStorage.getItem('route_basemap') || 'dark';

const map = new maplibregl.Map({
    container: 'map',
    style: VECTOR_STYLES[currentBasemap] || buildRasterStyle(RASTER_BASEMAPS[currentBasemap]),
    center: [-122.4194, 37.7749],
    zoom: 13,
    maxZoom: 20,
    projection: 'mercator',
    antialias: false,
    fadeDuration: 0,
    trackResize: true
});

function buildRasterStyle(tileUrl) {
    return {
        version: 8,
        sources: { basemap: { type: 'raster', tiles: [tileUrl], tileSize: 256, maxzoom: 19 } },
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
let routeCumDistances = null;
let routeTotalDist = 0;
let routeScreenPts = null;

// Performance settings — display only. Backend elevation always uses max resolution.
let PERF_MAP_POINTS = 100;    // vertices pushed to MapLibre source for rendering
let PERF_GRAD_STOPS = 30;     // gradient colour segments on the map
const BACKEND_ELEV_POINTS = 1000; // elevation data density — always max

// Chart and elevation update state — declared here to avoid TDZ errors when
// map.on('load') fires and immediately triggers updateElevationProfile
let elevationChart = null;
let isUpdatingElevation = false;

// Segments are static once built — no need to rebuild them on every pan/zoom.
// Only rebuild routeScreenPts (for hover hit-testing) when map view changes.
function rebuildRouteScreenPts() {
    if (!currentRouteGeoJSON) { routeScreenPts = null; return; }
    routeScreenPts = currentRouteGeoJSON.coordinates.map(c => map.project(c));
}

// Build colored GeoJSON segments and upload to the map.
// Called once after elevation data loads (grade colors) and also immediately
// after route load with flat green so the line is always visible.
function rebuildMapGradient() {
    if (!currentRouteGeoJSON) return;
    const coords = currentRouteGeoJSON.coordinates;
    const grades = routeGrades; // may be null before elevation loads
    const N = PERF_GRAD_STOPS;
    const step = Math.max(1, Math.floor(coords.length / N));
    const features = [];
    for (let i = 0; i < coords.length - 1; i += step) {
        const end = Math.min(i + step, coords.length - 1);
        const grade = grades ? grades[Math.min(i, grades.length - 1)] : 0;
        features.push({
            type: 'Feature',
            properties: { color: getColorForGrade(grade) },
            geometry: { type: 'LineString', coordinates: coords.slice(i, end + 1) }
        });
    }
    const src = map.getSource('route-segments');
    if (src) src.setData({ type: 'FeatureCollection', features });
}

const pinSvg = `<svg width="24" height="34" viewBox="0 -1 24 33" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,0.4));"><path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 20 12 20s12-11 12-20c0-6.63-5.37-12-12-12zm0 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z" fill="#4b5563" fill-rule="evenodd" /></svg>`;
const wpImage = new Image();
wpImage.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg width="12" height="34" viewBox="0 -1 24 66" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 20 12 20s12-11 12-20c0-6.63-5.37-12-12-12zm0 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z" fill="#4b5563" fill-rule="evenodd" /></svg>`);

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
    hoverInfoEl.style.display = 'none';
}

function getDisplayDistance(meters) {
    return currentUnits === 'metric' ? meters / 1000 : meters * 0.000621371;
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
const elevationWorker = new Worker('elevation-worker.js');
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

    // Colored grade segments — gradient, no grey outline
    if (!map.getLayer('route-segments-layer'))
        map.addLayer({ id: 'route-segments-layer', type: 'line', source: 'route-segments', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': 0.97 } });

    // Transparent interaction layer (hit target for drag, zero visual impact)
    if (!map.getLayer('route-line'))
        map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#888', 'line-width': 14, 'line-opacity': 0 } });

    // Hover circle (GPU-rendered, no DOM wrapper, no CSS square)
    if (!map.getSource('hover-point'))
        map.addSource('hover-point', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.getLayer('hover-circle-outer'))
        map.addLayer({ id: 'hover-circle-outer', type: 'circle', source: 'hover-point', paint: { 'circle-radius': 9, 'circle-color': 'white', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#374151' } });
    if (!map.getLayer('hover-circle-inner'))
        map.addLayer({ id: 'hover-circle-inner', type: 'circle', source: 'hover-point', paint: { 'circle-radius': 4, 'circle-color': '#374151' } });

    // Re-upload route data if already computed (e.g. after a style swap)
    if (currentRouteGeoJSON && map.getSource('route')) {
        const mapCoords = decimateLine(currentRouteGeoJSON.coordinates, PERF_MAP_POINTS);
        map.getSource('route').setData({ type: 'LineString', coordinates: mapCoords });
        rebuildMapGradient();
    }
}

map.on('load', () => {
    setupRouteLayers();

    let lastHoverIdx = -1;
    let rafPending = false;

    // Only rebuild screen pts when view changes — gradient is static
    map.on('moveend', rebuildRouteScreenPts);
    map.on('zoomend', rebuildRouteScreenPts);
    // Also hide info label on pan start so it doesn't lag behind
    map.on('movestart', () => { hoverInfoEl.style.display = 'none'; });

    // Change cursor when hovering the route — use the transparent interaction layer
    map.on('mouseenter', 'route-line', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'route-line', () => { if (!isDraggingLine) map.getCanvas().style.cursor = ''; });

    map.on('mousemove', (e) => {
        if (!currentRouteGeoJSON || !routeScreenPts) return;
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            const coords = currentRouteGeoJSON.coordinates;
            const mousePt = e.point;
            let minD = Infinity;
            let minIdx = -1;
            for (let i = 0; i < routeScreenPts.length; i++) {
                const p = routeScreenPts[i];
                const d = (p.x - mousePt.x)**2 + (p.y - mousePt.y)**2;
                if (d < minD) { minD = d; minIdx = i; }
            }

            if (minIdx !== -1 && minD < 1600) { // 40px threshold
                // Build info string for the floating label
                const ds = elevationChart?.data?.datasets?.[0];
                const pt = ds?.data?.[minIdx];
                const grade = ds?.grades?.[minIdx];
                const distLabel = pt ? pt.x.toFixed(2) + (currentUnits === 'metric' ? ' km' : ' mi') : '';
                const elevLabel = pt ? pt.y.toFixed(0) + (currentUnits === 'metric' ? ' m' : ' ft') : '';
                const gradeLabel = grade !== undefined ? (grade >= 0 ? '+' : '') + grade.toFixed(1) + '%' : '';
                const info = `${distLabel} &nbsp;|&nbsp; ${elevLabel} &nbsp;|&nbsp; ${gradeLabel}`;
                showHoverMarker(coords[minIdx], info);
                if (minIdx !== lastHoverIdx) {
                    lastHoverIdx = minIdx;
                    if (elevationChart) {
                        elevationChart.setActiveElements([{ datasetIndex: 0, index: minIdx }]);
                        elevationChart.tooltip.setActiveElements([{ datasetIndex: 0, index: minIdx }]);
                        elevationChart.update('none');
                    }
                }
            } else {
                if (lastHoverIdx !== -1) {
                    lastHoverIdx = -1;
                    hideHoverMarker();
                    if (elevationChart) {
                        elevationChart.setActiveElements([]);
                        elevationChart.tooltip.setActiveElements([]);
                        elevationChart.update('none');
                    }
                }
            }
        });
    });

    map.on('mouseleave', () => {
        if (lastHoverIdx !== -1) {
            lastHoverIdx = -1;
            hideHoverMarker();
            if (elevationChart) {
                elevationChart.setActiveElements([]);
                elevationChart.tooltip.setActiveElements([]);
                elevationChart.update('none');
            }
        }
    });

    loadStoredSettings();
    loadUrlState();
});

function createMarker(lngLat, index) {
    const el = document.createElement('div');
    el.style.width = '24px';
    el.style.height = '34px';
    el.style.cursor = 'pointer';
    el.innerHTML = pinSvg;

    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', draggable: true })
        .setLngLat(lngLat)
        .addTo(map);

    marker.getElement().addEventListener('mousedown', (evt) => {
        if (evt.button === 1) { // middle click
            evt.preventDefault();
            evt.stopPropagation();
            const idx = markers.indexOf(marker);
            if (idx > -1) {
                markers.splice(idx, 1);
                waypoints.splice(idx, 1);
                marker.remove();
                updateRoute();
            }
        }
    });

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
    } else {
        markers.push(marker);
        waypoints.push([lngLat.lng, lngLat.lat]);
    }
    
    return marker;
}

let wasDraggingLine = false;
let isDraggingLine = false;
let draggedWaypointIndex = -1;

function distance(p1, p2) {
    const dx = p1[0] - p2[0];
    const dy = p1[1] - p2[1];
    return Math.sqrt(dx*dx + dy*dy);
}

function getInsertIndex(clickedLngLat) {
    if (waypoints.length < 2) return waypoints.length;
    let bestIndex = 1;
    let minIncrease = Infinity;
    for (let i = 0; i < waypoints.length - 1; i++) {
        const p1 = waypoints[i];
        const p2 = waypoints[i+1];
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
    isDraggingLine = true;
    wasDraggingLine = true;
    map.dragPan.disable();
    
    const insertIdx = getInsertIndex(e.lngLat);
    createMarker(e.lngLat, insertIdx);
    draggedWaypointIndex = insertIdx;
});

map.on('mouseenter', 'route-line', () => {
    map.getCanvas().style.cursor = 'pointer';
});

map.on('mouseleave', 'route-line', () => {
    if (!isDraggingLine) {
        map.getCanvas().style.cursor = '';
    }
});

map.on('mousemove', (e) => {
    if (isDraggingLine && draggedWaypointIndex > -1) {
        markers[draggedWaypointIndex].setLngLat(e.lngLat);
        waypoints[draggedWaypointIndex] = [e.lngLat.lng, e.lngLat.lat];
    }
});

map.on('mouseup', () => {
    if (isDraggingLine) {
        isDraggingLine = false;
        draggedWaypointIndex = -1;
        map.dragPan.enable();
        updateRoute();
        setTimeout(() => wasDraggingLine = false, 50);
    }
});

map.on('click', (e) => {
    if (wasDraggingLine) return;
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

function updateRoute() {
    if (waypoints.length === 0 || waypoints.length === 1) {
        if (map.getSource('route')) {
            map.getSource('route').setData({ type: 'LineString', coordinates: [] });
        }
        if (map.getSource('route-segments')) {
            map.getSource('route-segments').setData({ type: 'FeatureCollection', features: [] });
        }
        currentDistanceMeters = 0;
        currentRouteGeoJSON = null;
        updateDistanceUI();
        updateElevationProfile();
        syncUrl();
        return;
    }

    // Fetch routing from OSRM
    const coords = waypoints.map(wp => `${wp[0]},${wp[1]}`).join(';');
    fetch(`https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coords}?overview=full&geometries=geojson`)
        .then(res => res.json())
        .then(data => {
            if (data.code === 'Ok' && data.routes.length > 0) {
                const route = data.routes[0];
                currentDistanceMeters = route.distance;
                
                waypointDistances = [0];
                let d = 0;
                if (route.legs) {
                    for (const leg of route.legs) {
                        d += leg.distance;
                        waypointDistances.push(d);
                    }
                }
                
                updateDistanceUI();
                
                currentRouteGeoJSON = route.geometry;
                currentRouteGeoJSON.coordinates = resampleLine(currentRouteGeoJSON.coordinates, BACKEND_ELEV_POINTS);

                // Push a decimated version to the route source (used for hover)
                const mapCoords = decimateLine(currentRouteGeoJSON.coordinates, PERF_MAP_POINTS);
                if (map.getSource('route')) {
                    map.getSource('route').setData({ type: 'LineString', coordinates: mapCoords });
                }

                // Immediately show the route in flat green — grade colors come after elevation loads
                rebuildMapGradient();

                // Rebuild screen-space cache for hover
                if (typeof rebuildRouteScreenPts === 'function') rebuildRouteScreenPts();

                needsElevationUpdate = true;
                updateElevationProfile();
                syncUrl();
            }
        })
        .catch(err => console.error("Routing error:", err));
}

document.getElementById('clear-route').addEventListener('click', () => {
    waypoints = [];
    markers.forEach(m => m.remove());
    markers = [];
    updateRoute();
});

function toggleSettings(event) {
    const menu = document.getElementById('settings-menu');
    if (menu.style.display === 'none' || menu.style.display === '') {
        menu.style.display = 'block';
    } else {
        menu.style.display = 'none';
    }
    event.stopPropagation();
}

document.addEventListener('click', (event) => {
    const menu = document.getElementById('settings-menu');
    const btn = document.getElementById('settings-btn');
    if (menu && btn && menu.style.display === 'block' && !menu.contains(event.target) && !btn.contains(event.target)) {
        menu.style.display = 'none';
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
    // Re-add route/hover layers after the new style finishes loading
    map.once('style.load', () => {
        setupRouteLayers();
        applyTerrain();
    });
});

document.getElementById('units').addEventListener('change', (e) => {
    currentUnits = e.target.value;
    localStorage.setItem('route_units', currentUnits);
    updateDistanceUI();
    if (typeof updateElevationProfile === 'function') updateElevationProfile();
});

document.getElementById('projection').addEventListener('change', (e) => {
    const proj = e.target.value;
    localStorage.setItem('route_projection', proj);
    map.setProjection({ type: proj });
});

function applyPerfSetting() {
    PERF_MAP_POINTS = parseInt(document.getElementById('map-line-points').value) || 100;
    PERF_GRAD_STOPS = parseInt(document.getElementById('gradient-stops').value) || 30;
    localStorage.setItem('route_map_points', PERF_MAP_POINTS);
    localStorage.setItem('route_grad_stops', PERF_GRAD_STOPS);
    // Rebuild map display with new settings (elevation data is unchanged)
    if (currentRouteGeoJSON && map.getSource('route')) {
        const mapCoords = decimateLine(currentRouteGeoJSON.coordinates, PERF_MAP_POINTS);
        map.getSource('route').setData({ type: 'LineString', coordinates: mapCoords });
        rebuildRouteScreenPts();
        rebuildMapGradient();
    }
}

document.getElementById('map-line-points').addEventListener('change', applyPerfSetting);
document.getElementById('gradient-stops').addEventListener('change', applyPerfSetting);

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
        map.setTerrain({ source: 'terrain-source', exaggeration: exVal });
    } else {
        map.setLayoutProperty('hillshade-layer', 'visibility', 'none');
        // Only call setTerrain(null) if terrain was previously enabled
        // Calling setTerrain with any source triggers MapLibre's terrain init pipeline
        if (map.getTerrain()) map.setTerrain(null);
    }

    needsElevationUpdate = true;
    if (typeof updateElevationProfile === 'function') updateElevationProfile();
}

document.getElementById('hillshade-check').addEventListener('change', applyTerrain);
document.getElementById('terrain-exaggeration').addEventListener('change', applyTerrain);

function loadStoredSettings() {
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

    // Projection — calls map.setProjection, safe after load
    const proj = localStorage.getItem('route_projection');
    if (proj) {
        document.getElementById('projection').value = proj;
        map.setProjection({ type: proj });
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

    // Performance settings
    const mapPoints = localStorage.getItem('route_map_points');
    if (mapPoints) { PERF_MAP_POINTS = parseInt(mapPoints); document.getElementById('map-line-points').value = PERF_MAP_POINTS; }
    const gradStops = localStorage.getItem('route_grad_stops');
    if (gradStops) { PERF_GRAD_STOPS = parseInt(gradStops); document.getElementById('gradient-stops').value = PERF_GRAD_STOPS; }

    // Apply terrain after all values are set (layers exist by now)
    applyTerrain();
}

Chart.Interaction.modes.routeHover = function(chart, e, options, useFinalPosition) {
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
    const phi1 = c1[1] * Math.PI/180;
    const phi2 = c2[1] * Math.PI/180;
    const dPhi = (c2[1]-c1[1]) * Math.PI/180;
    const dLambda = (c2[0]-c1[0]) * Math.PI/180;
    const a = Math.sin(dPhi/2) * Math.sin(dPhi/2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(dLambda/2) * Math.sin(dLambda/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function resampleLine(coords, maxPoints = 500) {
    if (coords.length <= 1) return coords;
    
    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
        totalDist += haversineDistance(coords[i-1], coords[i]);
    }
    
    let segmentLength = totalDist / maxPoints;
    if (segmentLength < 30) segmentLength = 30; // Minimum 30m resolution to prevent point explosion
    
    const resampled = [];
    resampled.push(coords[0]);
    for (let i = 1; i < coords.length; i++) {
        const p1 = coords[i-1];
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
    if (grade <= -15) {
        return 'rgb(138, 43, 226)';
    } else if (grade < -7.5) {
        const t = (grade + 15) / 7.5;
        r = 138 + t * (59 - 138);
        g = 43 + t * (130 - 43);
        b = 226 + t * (246 - 226);
    } else if (grade < 0) {
        const t = (grade + 7.5) / 7.5;
        r = 59 + t * (34 - 59);
        g = 130 + t * (197 - 130);
        b = 246 + t * (94 - 246);
    } else if (grade < 7.5) {
        const t = grade / 7.5;
        r = 34 + t * (234 - 34);
        g = 197 + t * (179 - 197);
        b = 94 + t * (8 - 94);
    } else if (grade < 15) {
        const t = (grade - 7.5) / 7.5;
        r = 234 + t * (239 - 234);
        g = 179 + t * (68 - 179);
        b = 8 + t * (68 - 8);
    } else {
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
                // borderColor and backgroundColor are both canvas gradients built in
                // updateElevationProfile() — no per-segment callbacks, zero per-frame cost
                borderColor: 'rgba(100,120,160,0.8)',
                backgroundColor: 'rgba(100,120,160,0.15)',
                borderWidth: 4,
                fill: 'start',
                pointRadius: 0,
                pointHoverBackgroundColor: '#4b5563',
                pointHoverBorderColor: '#ffffff',
                pointHoverRadius: 6,
                tension: 0.1,
                spanGaps: true
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
                if (!currentRouteGeoJSON || !currentRouteGeoJSON.coordinates) return;
                
                const xValue = chart.scales.x.getValueForPixel(event.x);
                const data = chart.data.datasets[0].data;
                const coords = currentRouteGeoJSON.coordinates;
                
                if (!data || data.length < 2) {
                    if (activeElements.length > 0) {
                        const el = activeElements.find(e => e.datasetIndex === 0);
                        if (el) showHoverMarker(coords[el.index]);
                    } else {
                        hideHoverMarker();
                    }
                    return;
                }

                let low = 0;
                let high = data.length - 2;
                let i = 0;
                while (low <= high) {
                    let mid = Math.floor((low + high) / 2);
                    if (data[mid].x <= xValue) {
                        i = mid;
                        low = mid + 1;
                    } else {
                        high = mid - 1;
                    }
                }

                const nextIdx = i + 1;
                const t = (data[nextIdx].x === data[i].x) ? 0 : 
                          Math.max(0, Math.min(1, (xValue - data[i].x) / (data[nextIdx].x - data[i].x)));
                
                const lng = coords[i][0] + t * (coords[nextIdx][0] - coords[i][0]);
                const lat = coords[i][1] + t * (coords[nextIdx][1] - coords[i][1]);
                // Build the same info string used by the map hover
                const ds = chart.data.datasets[0];
                const grade = ds.grades?.[i];
                const distLabel = data[i].x.toFixed(2) + (currentUnits === 'metric' ? ' km' : ' mi');
                const elevLabel = (currentUnits === 'metric' ? data[i].y.toFixed(0) + ' m' : data[i].y.toFixed(0) + ' ft');
                const gradeLabel = grade !== undefined ? (grade >= 0 ? '+' : '') + grade.toFixed(1) + '%' : '';
                const info = `${distLabel} &nbsp;|&nbsp; ${elevLabel} &nbsp;|&nbsp; ${gradeLabel}`;
                showHoverMarker([lng, lat], info);
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
                    const STOPS = 50;
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
            elevationChart.data.labels = [];
            elevationChart.data.datasets[0].data = [];
            elevationChart.data.datasets[0].grades = [];
            elevationChart.update();
        }
        return;
    }

    isUpdatingElevation = true;
    
    try {
        const coords = currentRouteGeoJSON.coordinates;
        const chartData = [];
        const cumDistances = [0];
        let distMeters = 0;
        let maxElev = -Infinity;
        let minElev = Infinity;

        // Directly fetch the highest res mapzen terrarium data
        const elevations = await getHighResElevation(coords);

        // Build cumDistances for map gradient (elevation/grade rebuilt below via median filter)
        for (let i = 1; i < coords.length; i++) {
            distMeters += haversineDistance(coords[i-1], coords[i]);
            cumDistances.push(distMeters);
        }

        // Step 1: Median filter on raw elevations to kill single-point spikes
        // A spike is a point that is far from both its neighbours
        const medianElevations = elevations.map((v, i) => {
            if (v === null || v === undefined) return v;
            const window = [];
            for (let j = Math.max(0, i - 4); j <= Math.min(elevations.length - 1, i + 4); j++) {
                if (elevations[j] !== null && elevations[j] !== undefined) window.push(elevations[j]);
            }
            window.sort((a, b) => a - b);
            return window[Math.floor(window.length / 2)];
        });

        // Step 2: Rebuild chart data and grades from the median-filtered elevations
        const filteredChartData = [];
        const filteredGrades = [0];
        let filteredDist = 0;
        let filteredMax = -Infinity, filteredMin = Infinity;
        for (let i = 0; i < coords.length; i++) {
            const val = medianElevations[i];
            if (i > 0) filteredDist += haversineDistance(coords[i-1], coords[i]);
            const displayElev = currentUnits === 'metric' ? val : val * 3.28084;
            filteredChartData.push({ x: getDisplayDistance(filteredDist), y: displayElev ?? null });
            if (displayElev != null) {
                if (displayElev > filteredMax) filteredMax = displayElev;
                if (displayElev < filteredMin) filteredMin = displayElev;
            }
            if (i > 0 && medianElevations[i] != null && medianElevations[i-1] != null) {
                const rise = medianElevations[i] - medianElevations[i-1];
                const run = haversineDistance(coords[i-1], coords[i]);
                filteredGrades.push(run > 0 ? (rise / run) * 100 : 0);
            } else {
                filteredGrades.push(0);
            }
        }
        // Replace original data with filtered
        chartData.length = 0; filteredChartData.forEach(p => chartData.push(p));
        maxElev = filteredMax; minElev = filteredMin;
        const grades = filteredGrades;

        // Step 3: Clamp physically impossible grades
        const clampedGrades = grades.map(g => Math.max(-40, Math.min(40, g)));

        // Step 4: Wide rolling average to smooth out remaining noise
        // windowSize=8 means a 17-point window — aggressive but still shows real terrain shape
        const smoothedGrades = [];
        const windowSize = 8;
        for (let i = 0; i < clampedGrades.length; i++) {
            let sum = 0, count = 0;
            for (let j = i - windowSize; j <= i + windowSize; j++) {
                if (j >= 0 && j < clampedGrades.length) { sum += clampedGrades[j]; count++; }
            }
            smoothedGrades.push(sum / count);
        }

        // Pre-build color arrays once so Chart.js has zero work per frame
        const borderColors = smoothedGrades.map(g => getColorForGrade(g));
    const wpData = [];
    for (let i = 1; i < waypointDistances.length - 1; i++) {
        const wpMeters = waypointDistances[i];
        const displayWpMeters = getDisplayDistance(wpMeters);
        let closestPt = chartData[0];
        let minDiff = Infinity;
        for (const pt of chartData) {
            if (pt.y === null) continue;
            const diff = Math.abs(pt.x - displayWpMeters);
            if (diff < minDiff) {
                minDiff = diff;
                closestPt = pt;
            }
        }
        if (closestPt) wpData.push({ x: displayWpMeters, y: closestPt.y });
    }

    elevationChart.data.datasets[0].data = chartData;
    elevationChart.data.datasets[0].grades = smoothedGrades;
    elevationChart.data.datasets[0].borderColor = borderColors;
    
    if (elevationChart.data.datasets.length > 1) {
        elevationChart.data.datasets[1].data = wpData;
    } else {
        elevationChart.data.datasets.push({
            label: 'Waypoints',
            data: wpData,
            type: 'scatter',
            pointStyle: wpImage,
        });
    }

    // Store grades/distances for viewport-aware map gradient rebuilds
    routeGrades = smoothedGrades;
    routeCumDistances = cumDistances;
    routeTotalDist = distMeters;

    // Trigger map gradient build — map outline shows until segments are ready
    rebuildMapGradient();
    rebuildRouteScreenPts();

    elevationChart.options.scales.x.max = getDisplayDistance(distMeters);
    elevationChart.options.scales.x.title.text = `Distance (${currentUnits === 'metric' ? 'km' : 'mi'})`;
    elevationChart.options.scales.y.title.text = `Elevation (${currentUnits === 'metric' ? 'm' : 'ft'})`;
    
    if (maxElev === -Infinity) maxElev = 100;
    if (minElev === Infinity) minElev = 0;
    const elevRange = maxElev - minElev;
    const padding = elevRange === 0 ? 10 : elevRange * 0.15;
    
    elevationChart.options.scales.y.suggestedMax = maxElev + padding;
    elevationChart.options.scales.y.suggestedMin = Math.max(0, minElev - padding);

    elevationChart.update();
    needsElevationUpdate = false;
    } finally {
        isUpdatingElevation = false;
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
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

function loadUrlState() {
    const params = new URLSearchParams(window.location.search);
    const routeStr = params.get('route');
    if (routeStr) {
        const points = routeStr.split(';');
        for (const pt of points) {
            const [lng, lat] = pt.split(',').map(Number);
            if (!isNaN(lng) && !isNaN(lat)) {
                createMarker({lng, lat});
            }
        }
        updateRoute();
        
        if (waypoints.length > 1) {
            const bounds = new maplibregl.LngLatBounds();
            for (const wp of waypoints) {
                bounds.extend(wp);
            }
            map.fitBounds(bounds, { padding: 50 });
            // After camera settles and tiles load, force an elevation refresh
            map.once('idle', () => {
                needsElevationUpdate = true;
                updateElevationProfile();
            });
        } else if (waypoints.length === 1) {
            map.jumpTo({ center: waypoints[0], zoom: 13 });
        }
    }
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
    const newLeft = Math.min(Math.max(initialLeft + dx, container.left), container.right  - panelW);
    const newTop  = Math.min(Math.max(initialTop  + dy, container.top),  container.bottom - panelH);
    elPanel.style.left = newLeft + 'px';
    elPanel.style.top  = newTop  + 'px';
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
let startW, startH, startLeft, startTop;

function initResize(e) {
    if (elPanel.classList.contains('minimized')) return;
    isResizing = true;
    currentResizer = e.target.className.replace('resizer ', '');
    startX = e.clientX; startY = e.clientY;
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
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const container = document.getElementById('map').getBoundingClientRect();
    const MIN_W = 200, MIN_H = 100;

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
        elPanel.style.left  = clampedLeft + 'px';
    }
    if (currentResizer.includes('n')) {
        // top edge: clamp so panel's top doesn't go past container's top
        const rawH = Math.max(MIN_H, startH - dy);
        const rawTop = startTop + startH - rawH;
        const clampedTop = Math.max(container.top, rawTop);
        const clampedH = startTop + startH - clampedTop;
        elPanel.style.height = Math.max(MIN_H, clampedH) + 'px';
        elPanel.style.top    = clampedTop + 'px';
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
        } catch (e) {}
    }
}

loadWindowState();

// Restore elevation panel visibility
const savedVisible = localStorage.getItem('elevation_panel_visible');
if (savedVisible === 'false') {
    elPanel.style.display = 'none';
}
updateElevationToggleBtn();
