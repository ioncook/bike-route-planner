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

// Split way into segments under 80 meters to accurately catch steep climbs without averaging them out
function splitWayIntoSegments(coords, wayId, maxLen = 80.0) {
    const segments = [];
    if (coords.length < 2) return segments;

    let currentSegment = [coords[0]];
    let currentDist = 0;
    let segIdx = 0;

    for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i + 1];
        const d = getDistance(p1, p2);

        let rem = d;
        let prevPoint = p1;

        while (currentDist + rem > maxLen) {
            const needed = maxLen - currentDist;
            const t = needed / rem;

            // Interpolate point
            const lng = prevPoint[0] + t * (p2[0] - prevPoint[0]);
            const lat = prevPoint[1] + t * (p2[1] - prevPoint[1]);
            const splitPoint = [lng, lat];

            currentSegment.push(splitPoint);
            segments.push({
                id: `${wayId}_${segIdx++}`,
                coordinates: currentSegment,
                distance: maxLen
            });

            currentSegment = [splitPoint];
            currentDist = 0;

            prevPoint = splitPoint;
            rem = rem - needed;
        }

        currentSegment.push(p2);
        currentDist += rem;
    }

    if (currentSegment.length >= 2 && currentDist > 0.1) {
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

// Fetch ways and process grades
async function fetchAndProcessViewport() {
    const zoom = map.getZoom();
    const warning = document.getElementById('zoom-warning');
    const loading = document.getElementById('loading-indicator');

    if (zoom < 11) {
        warning.classList.remove('hidden');
        return;
    } else {
        warning.classList.add('hidden');
    }

    if (isFetching) return;
    isFetching = true;
    loading.style.display = 'flex';

    try {
        const bounds = map.getBounds();
        let s = bounds.getSouth();
        let w = bounds.getWest();
        let n = bounds.getNorth();
        let e = bounds.getEast();

        // Clamp bounding box when zoomed out to avoid overloading Overpass API
        if (zoom < 13) {
            const mapCenter = map.getCenter();
            const maxRadius = 0.08; // ~11 miles max span centered on camera
            s = Math.max(s, mapCenter.lat - maxRadius);
            w = Math.max(w, mapCenter.lng - maxRadius);
            n = Math.min(n, mapCenter.lat + maxRadius);
            e = Math.min(e, mapCenter.lng + maxRadius);
        }

        const bbox = `${s},${w},${n},${e}`;

        // Exclude footways, pedestrian paths, steps, service roads/driveways, tracks, paths, bridleways (keep cycleways)
        const query = `[out:json][timeout:25];way[highway]["highway"!~"footway|pedestrian|steps|construction|proposed|abandoned|service|track|corridor|elevator|platform|path|bridleway"](${bbox});out geom;`;
        const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);

        if (!res.ok) throw new Error('Overpass query failed');

        const data = await res.json();
        const ways = data.elements || [];

        // Identify new ways to process
        const newSegmentsToResolve = [];
        for (const way of ways) {
            if (way.type === 'way' && way.geometry && !wayCache.has(way.id)) {
                const geomCoords = way.geometry.map(p => [p.lon, p.lat]);
                const segments = splitWayIntoSegments(geomCoords, way.id);

                // Initialize cache entry
                wayCache.set(way.id, segments);

                for (const seg of segments) {
                    newSegmentsToResolve.push({
                        wayId: way.id,
                        segment: seg
                    });
                }
            }
        }

        if (newSegmentsToResolve.length > 0) {
            // Deduplicate coordinates to minimize worker payload and speed up decoding
            const uniqueCoordsMap = new Map();
            const uniqueCoordsArray = [];

            const getCoordKey = (coord) => `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;

            for (const item of newSegmentsToResolve) {
                const segCoords = item.segment.coordinates;
                const start = segCoords[0];
                const end = segCoords[segCoords.length - 1];

                const startKey = getCoordKey(start);
                if (!uniqueCoordsMap.has(startKey)) {
                    uniqueCoordsMap.set(startKey, uniqueCoordsArray.length);
                    uniqueCoordsArray.push(start);
                }

                const endKey = getCoordKey(end);
                if (!uniqueCoordsMap.has(endKey)) {
                    uniqueCoordsMap.set(endKey, uniqueCoordsArray.length);
                    uniqueCoordsArray.push(end);
                }
            }

            const uniqueElevations = await getHighResElevation(uniqueCoordsArray);

            // Assign elevations and compute grades
            for (const item of newSegmentsToResolve) {
                const segCoords = item.segment.coordinates;
                const start = segCoords[0];
                const end = segCoords[segCoords.length - 1];

                const startKey = getCoordKey(start);
                const endKey = getCoordKey(end);

                const elevStart = uniqueElevations[uniqueCoordsMap.get(startKey)];
                const elevEnd = uniqueElevations[uniqueCoordsMap.get(endKey)];

                if (elevStart !== null && elevEnd !== null) {
                    const rise = Math.abs(elevEnd - elevStart);
                    const run = item.segment.distance;
                    const gradeVal = run > 0 ? (rise / run) * 100 : 0;

                    item.segment.gradePercent = gradeVal;
                    item.segment.grade = Math.min(gradeVal, 20); // Clamp to 20% for coloring interpolation

                    // Reverse coordinate order if downhill so that LineString geometry always points uphill
                    if (elevStart > elevEnd) {
                        item.segment.coordinates.reverse();
                    }
                } else {
                    item.segment.gradePercent = 0;
                    item.segment.grade = 0;
                }
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

