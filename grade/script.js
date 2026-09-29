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
let isMouseDown = false;

map.getCanvasContainer().addEventListener('mousedown', (e) => {
    isMouseDown = true;
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
    isMouseDown = false;
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
const deduplicatedFeatures = [];
const seenSegmentKeys = new Set();
let isFetching = false;
let needsRefetch = false;
let isMapMoving = false;

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

// Color interpolator for tooltip grades matching map colors
// Rich deep green for <1%, lime green at 1.5-2%, yellow 2-5%, orange 5-9%, maxing out at 15% with deep red
function getGradeColor(grade) {
    const g = Math.max(parseFloat(grade) || 0, 0);

    // Color stops: [grade, [r, g, b]]
    const stops = [
        [0,   [21, 128, 61]],   // Rich deep forest green (#15803d)
        [0.8, [22, 163, 74]],   // Solid green (#16a34a)
        [1.2, [101, 163, 13]],  // Green-lime transition (#65a30d)
        [2,   [163, 230, 53]],  // Lime green (#a3e635)
        [3.5, [234, 179, 8]],   // Yellow (#eab308)
        [5,   [245, 158, 11]],  // Warm yellow / amber (#f59e0b)
        [7,   [249, 115, 22]],  // Bright orange (#f97316)
        [9,   [234, 88, 12]],   // Deep orange (#ea580c)
        [12,  [220, 38, 38]],   // Red (#dc2626)
        [15,  [153, 27, 27]]    // Deep red (#991b1b)
    ];

    if (g <= stops[0][0]) {
        const c = stops[0][1];
        return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
    if (g >= stops[stops.length - 1][0]) {
        const c = stops[stops.length - 1][1];
        return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }

    for (let i = 0; i < stops.length - 1; i++) {
        const [g0, c0] = stops[i];
        const [g1, c1] = stops[i + 1];
        if (g >= g0 && g <= g1) {
            const t = (g - g0) / (g1 - g0);
            const r = Math.round(c0[0] + t * (c1[0] - c0[0]));
            const gr = Math.round(c0[1] + t * (c1[1] - c0[1]));
            const b = Math.round(c0[2] + t * (c1[2] - c0[2]));
            return `rgb(${r}, ${gr}, ${b})`;
        }
    }
    return 'rgb(153, 27, 27)';
}

// Perpendicular distance squared from point (px, py) to line segment (x1, y1) - (x2, y2)
function distToSegmentSquared(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const nx = x1 + t * dx;
    const ny = y1 + t * dy;
    const rx = px - nx;
    const ry = py - ny;
    return rx * rx + ry * ry;
}

// Build fast in-memory spatial index of rendered street names from Carto vector tiles
function buildSpatialNameIndex(nameFeatures) {
    const entries = [];
    if (!nameFeatures || nameFeatures.length === 0) return entries;

    for (const f of nameFeatures) {
        const props = f.properties;
        if (!props) continue;
        const name = props.name || props.name_en || '';
        const ref = props.ref || '';
        if (!name && !ref) continue;

        let displayName = name;
        if (ref) {
            if (!displayName) displayName = ref;
            else if (!displayName.includes(ref)) displayName = `${displayName} (${ref})`;
        }

        const geom = f.geometry;
        if (!geom) continue;
        const parts = geom.type === 'LineString' ? [geom.coordinates] : (geom.type === 'MultiLineString' ? geom.coordinates : []);

        for (const part of parts) {
            if (part.length < 2) continue;
            let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
            for (const pt of part) {
                if (pt[0] < minLon) minLon = pt[0];
                if (pt[0] > maxLon) maxLon = pt[0];
                if (pt[1] < minLat) minLat = pt[1];
                if (pt[1] > maxLat) maxLat = pt[1];
            }
            entries.push({
                name: displayName,
                coords: part,
                minLon, minLat, maxLon, maxLat
            });
        }
    }
    return entries;
}

// Match a road's geometry against in-memory street name lines using spatial distance & directional alignment
function matchStreetNameInMemory(roadCoords, nameEntries) {
    if (!roadCoords || roadCoords.length < 2 || !nameEntries || nameEntries.length === 0) return '';
    const mid = getSegmentMidpoint(roadCoords);
    if (!mid) return '';
    const midLon = mid[0], midLat = mid[1];

    // Search bounding box padding in degrees (~45 meters)
    const pad = 0.00045;

    // Road orientation vector (scaled by latitude factor ~1.27)
    const p1 = roadCoords[0];
    const p2 = roadCoords[roadCoords.length - 1];
    const rdx = p2[0] - p1[0];
    const rdy = (p2[1] - p1[1]) * 1.27;
    const rlen = Math.hypot(rdx, rdy);

    let bestScore = Infinity;
    let bestName = '';

    for (const entry of nameEntries) {
        // Fast bounding box reject
        if (midLon < entry.minLon - pad || midLon > entry.maxLon + pad ||
            midLat < entry.minLat - pad || midLat > entry.maxLat + pad) {
            continue;
        }

        const coords = entry.coords;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i];
            const b = coords[i + 1];

            const cdx = b[0] - a[0];
            const cdy = (b[1] - a[1]) * 1.27;
            const clen = Math.hypot(cdx, cdy);
            const l2 = cdx * cdx + cdy * cdy;

            let distMeters;
            if (l2 === 0) {
                const ex = (midLon - a[0]) * 85000;
                const ey = (midLat - a[1]) * 111000;
                distMeters = Math.hypot(ex, ey);
            } else {
                let t = ((midLon - a[0]) * cdx + (midLat - a[1]) * 1.27 * cdy) / l2;
                t = Math.max(0, Math.min(1, t));
                const projLon = a[0] + t * (b[0] - a[0]);
                const projLat = a[1] + t * (b[1] - a[1]);
                const ex = (midLon - projLon) * 85000;
                const ey = (midLat - projLat) * 111000;
                distMeters = Math.hypot(ex, ey);
            }

            if (distMeters > 35) continue; // Further than 35 meters

            // Directional alignment penalty
            let alignmentPenalty = 0;
            if (rlen > 0.00003 && clen > 0.00003) {
                const cosTheta = Math.abs(rdx * cdx + rdy * cdy) / (rlen * clen);
                if (cosTheta < 0.35) {
                    alignmentPenalty = 18; // Perpendicular cross-street
                } else if (cosTheta > 0.75) {
                    alignmentPenalty = -4; // Parallel alignment bonus
                }
            }

            const score = distMeters + alignmentPenalty;
            if (score < bestScore) {
                bestScore = score;
                bestName = entry.name;
            }
        }
    }

    return (bestScore < 28) ? bestName : '';
}

// Fallback street name finder for hover/click tooltips
function findStreetName(cursorPoint, segmentCoordinates, zoom) {
    if (!segmentCoordinates || segmentCoordinates.length < 2) return '';
    try {
        const nameFeatures = map.queryRenderedFeatures(null, { layers: ['carto-names-hidden'] }) || [];
        const index = buildSpatialNameIndex(nameFeatures);
        return matchStreetNameInMemory(segmentCoordinates, index);
    } catch (_) {
        return '';
    }
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
                // Exclude rail/transit, ferry, aerialway, and raceway
                ['!in', 'class', 'rail', 'transit', 'subway', 'ferry', 'aerialway', 'raceway'],
                // Exclude pedestrian-only or foot-only ways and construction, but ALLOW cycleways/bike paths
                [
                    'any',
                    // Allow all standard rideable road classes
                    ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'residential', 'living_street', 'unclassified'],
                    // Allow designated cycleways or paths with bicycle access
                    ['==', 'subclass', 'cycleway'],
                    ['in', 'bicycle', 'yes', 'designated', 'permissive']
                ]
            ]
        });
    }

    if (!map.getLayer('carto-names-hidden')) {
        map.addLayer({
            id: 'carto-names-hidden',
            type: 'line',
            source: 'carto-streets',
            'source-layer': 'transportation_name',
            paint: {
                'line-opacity': 0.01,
                'line-width': 12
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
                    0, '#15803d',      // 0%: Rich deep forest green
                    0.8, '#16a34a',    // 0.8%: Solid green (keeps <1% strongly green)
                    1.2, '#65a30d',    // 1.2%: Green-lime transition
                    2, '#a3e635',      // 2%: Lime green
                    3.5, '#eab308',    // 3.5%: Yellow
                    5, '#f59e0b',      // 5%: Warm yellow / amber
                    7, '#f97316',      // 7%: Bright orange
                    9, '#ea580c',      // 9%: Deep orange
                    12, '#dc2626',     // 12%: Red
                    15, '#991b1b'      // 15%+: Deep red
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
            if (stickySegmentId || isRightClickDragging || isMouseDown || isMapMoving || map.isMoving()) return;

            const now = performance.now();
            if (now - lastHoverTime < 35) return; // Throttle to avoid blocking main thread
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
                    let streetName = feature.properties.name || '';
                    if (!streetName) {
                        streetName = findStreetName(e.point, geom.coordinates, map.getZoom());
                        if (streetName) {
                            feature.properties.name = streetName;
                        }
                    }
                    const nameHtml = streetName ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:3px;font-weight:normal;text-transform:capitalize;">${streetName}</div>` : '';
                    hoverPopup.setLngLat(midpoint)
                        .setHTML(`<div style="font-family:'Inter',sans-serif;font-size:0.82rem;font-weight:600;background:var(--bg-panel);padding:4px 6px;">
                            ${nameHtml}
                            <div>Grade: <span style="color:${getGradeColor(gradePercent)};font-weight:700;">${formatted}</span></div>
                        </div>`)
                        .addTo(map);

                    const el = hoverPopup.getElement();
                    if (el) el.classList.remove('locked');
                }
            }
        });

        map.on('mouseleave', 'grade-roads-hover-sensor', () => {
            map.getCanvas().style.cursor = '';
            hoveredSegmentId = null;
            if (!stickySegmentId && hoverPopup) {
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
                        
                        let streetName = feature.properties.name || '';
                        if (!streetName) {
                            streetName = findStreetName(e.point, geom.coordinates, map.getZoom());
                            if (streetName) {
                                feature.properties.name = streetName;
                            }
                        }
                        const nameHtml = streetName ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:3px;font-weight:normal;text-transform:capitalize;">${streetName}</div>` : '';

                        hoverPopup.setLngLat(midpoint)
                            .setHTML(`<div style="font-family:'Inter',sans-serif;font-size:0.82rem;font-weight:600;background:var(--bg-panel);padding:6px 8px;border-bottom:2px solid ${getGradeColor(gradePercent)};">
                                ${nameHtml}
                                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                                    <span>Grade: <span style="color:${getGradeColor(gradePercent)};font-weight:700;">${formatted}</span></span>
                                    <div style="display:flex;align-items:center;gap:6px;">
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
            minzoom: 16,
            layout: {
                'symbol-placement': 'line',
                'symbol-spacing': 130,
                'text-field': '›',
                'text-size': [
                    'interpolate', ['linear'], ['zoom'],
                    16, 15,
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

    map.getSource('grade-roads').setData({
        type: 'FeatureCollection',
        features: deduplicatedFeatures
    });
}

// Spatial tile tracking to prevent re-fetching or re-processing already loaded areas
const loadedTiles = new Set();

function lngToTileX(lng, z) {
    return Math.floor((lng + 180) / 360 * Math.pow(2, z));
}

function latToTileY(lat, z) {
    const rad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
}

function getTileKeysForBounds(bounds, z) {
    const minX = lngToTileX(bounds.getWest(), z);
    const maxX = lngToTileX(bounds.getEast(), z);
    const minY = latToTileY(bounds.getNorth(), z);
    const maxY = latToTileY(bounds.getSouth(), z);
    const keys = [];
    for (let x = Math.min(minX, maxX); x <= Math.max(minX, maxX); x++) {
        for (let y = Math.min(minY, maxY); y <= Math.max(minY, maxY); y++) {
            keys.push(`${z}/${x}/${y}`);
        }
    }
    return keys;
}

// Fetch ways and process grades
async function fetchAndProcessViewport() {
    if (isFetching) {
        needsRefetch = true;
        return;
    }

    const zoom = map.getZoom();
    const warning = document.getElementById('zoom-warning');
    const loading = document.getElementById('loading-indicator');

    // Ensure the vector street data source is loaded before we attempt queries
    if (!map.getSource('carto-streets') || !map.isSourceLoaded('carto-streets')) {
        return;
    }

    // Do not load anything if map tilt/pitch is greater than 30 degrees
    if (map.getPitch() > 30) {
        isFetching = false;
        loading.style.display = 'none';
        return;
    }

    // Allow loading road grade details further out (zoom 11.5+)
    if (zoom < 11.5) {
        warning.classList.remove('hidden');
        loading.style.display = 'none';
        isFetching = false;
        return;
    } else {
        warning.classList.add('hidden');
    }

    // Fast check: if all tiles in the current viewport bounds are already loaded, exit immediately!
    const tileZoom = Math.min(14, Math.floor(zoom));
    const bounds = map.getBounds();
    const viewportTileKeys = getTileKeysForBounds(bounds, tileZoom);

    let allTilesLoaded = true;
    for (const key of viewportTileKeys) {
        if (!loadedTiles.has(key)) {
            allTilesLoaded = false;
            break;
        }
    }

    if (allTilesLoaded) {
        // Area is already completely loaded - exit instantly with zero DOM/GPU work
        isFetching = false;
        return;
    }

    isFetching = true;

    try {
        let features = [];
        try {
            features = map.queryRenderedFeatures(null, { layers: ['carto-roads-hidden'] }) || [];
        } catch (e) {
            return;
        }

        // Deduplicate rendered features from Carto vector tiles
        const uniqueRoads = new Map();

        for (const f of features) {
            const props = f.properties || {};
            // Safety guard: reject any rail, subway, transit, or train features
            if (props.class === 'rail' || props.class === 'transit' || props.subclass === 'subway' || props.subclass === 'rail' || props.subclass === 'tram') {
                continue;
            }
            if (f.geometry.type === 'LineString') {
                const coords = f.geometry.coordinates;
                if (!coords || coords.length < 2) continue;

                const key = `${coords[0][0].toFixed(5)},${coords[0][1].toFixed(5)}_${coords[coords.length - 1][0].toFixed(5)},${coords[coords.length - 1][1].toFixed(5)}`;
                if (!uniqueRoads.has(key)) {
                    uniqueRoads.set(key, { coords, id: f.id });
                }
            } else if (f.geometry.type === 'MultiLineString') {
                const parts = f.geometry.coordinates;
                for (let pIdx = 0; pIdx < parts.length; pIdx++) {
                    const coords = parts[pIdx];
                    if (!coords || coords.length < 2) continue;

                    const key = `${coords[0][0].toFixed(5)},${coords[0][1].toFixed(5)}_${coords[coords.length - 1][0].toFixed(5)},${coords[coords.length - 1][1].toFixed(5)}`;
                    if (!uniqueRoads.has(key)) {
                        const wayId = f.id ? `${f.id}_p${pIdx}` : `${key}_p${pIdx}`;
                        uniqueRoads.set(key, { coords, id: wayId });
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
                    cacheKey,
                    coords: road.coords
                });
            }
        }

        // If all roads in this view are already in cache, mark tiles as loaded and exit cleanly
        if (waysToResolve.length === 0) {
            for (const key of viewportTileKeys) {
                loadedTiles.add(key);
            }
            return;
        }

        // Only display spinner when we actually need to resolve new roads
        loading.style.display = 'flex';

        // Query rendered street name features ONCE for the whole viewport to avoid main-thread freeze
        let nameEntries = [];
        try {
            const nameFeatures = map.queryRenderedFeatures(null, { layers: ['carto-names-hidden'] }) || [];
            nameEntries = buildSpatialNameIndex(nameFeatures);
        } catch (_) { }

        const workerWays = [];
        const roadNameMap = new Map();
        for (const item of waysToResolve) {
            const stName = matchStreetNameInMemory(item.coords, nameEntries);
            roadNameMap.set(item.cacheKey, stName);
            workerWays.push({
                wayId: item.cacheKey,
                geomCoords: item.coords
            });
        }

        let newFeaturesAdded = 0;
        const processedWays = await getProcessedSegmentsFromWorker(workerWays);
        for (const item of processedWays) {
            const stName = roadNameMap.get(item.wayId) || '';
            wayCache.set(item.wayId, item.segments);

            for (const seg of item.segments) {
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

                if (seenSegmentKeys.has(key)) continue;
                seenSegmentKeys.add(key);

                deduplicatedFeatures.push({
                    type: 'Feature',
                    id: seg.id,
                    geometry: {
                        type: 'LineString',
                        coordinates: coords
                    },
                    properties: {
                        id: seg.id,
                        grade: seg.grade,
                        gradePercent: seg.gradePercent,
                        name: stName
                    }
                });
                newFeaturesAdded++;
            }
        }

        // Mark tiles as loaded now that all their roads are processed
        for (const key of viewportTileKeys) {
            loadedTiles.add(key);
        }

        if (newFeaturesAdded > 0) {
            updateMapData();
        }
    } catch (err) {
        console.error('Error fetching viewport data:', err);
    } finally {
        isFetching = false;
        loading.style.display = 'none';
        if (needsRefetch) {
            needsRefetch = false;
            setTimeout(() => {
                fetchAndProcessViewport();
            }, 100);
        }
    }
}

// Map event listeners
let fetchDebounceTimer = null;
function scheduleViewportFetch(delay = 180) {
    if (isMapMoving || map.isMoving() || isMouseDown || isRightClickDragging) return;
    clearTimeout(fetchDebounceTimer);
    fetchDebounceTimer = setTimeout(() => {
        if (!isMapMoving && !map.isMoving() && !isMouseDown && !isRightClickDragging) {
            fetchAndProcessViewport();
        }
    }, delay);
}

map.on('movestart', () => {
    isMapMoving = true;
    if (!stickySegmentId && hoverPopup) {
        hoverPopup.remove();
        hoveredSegmentId = null;
    }
});

map.on('moveend', () => {
    isMapMoving = false;
    // Save map coordinates to match planner sync
    localStorage.setItem('last_map_center', JSON.stringify(map.getCenter()));
    localStorage.setItem('last_map_zoom', map.getZoom());

    scheduleViewportFetch(150);
});

map.on('zoomend', () => {
    scheduleViewportFetch(150);
});

map.on('idle', () => {
    if (isMapMoving || map.isMoving() || isMouseDown || isRightClickDragging || map.getZoom() < 11.5 || map.getPitch() > 30) return;
    if (!map.getSource('carto-streets') || !map.isSourceLoaded('carto-streets')) return;

    // Check if any tile in the current viewport is not yet in loadedTiles
    const tileZoom = Math.min(14, Math.floor(map.getZoom()));
    const viewportTileKeys = getTileKeysForBounds(map.getBounds(), tileZoom);
    const hasUnloaded = viewportTileKeys.some(k => !loadedTiles.has(k));
    if (hasUnloaded) {
        scheduleViewportFetch(100);
    }
});

map.on('sourcedata', (e) => {
    if (e.sourceId === 'carto-streets' && map.isSourceLoaded('carto-streets')) {
        if (isMapMoving || map.isMoving() || isMouseDown || isRightClickDragging || map.getZoom() < 11.5 || map.getPitch() > 30) return;
        const tileZoom = Math.min(14, Math.floor(map.getZoom()));
        const viewportTileKeys = getTileKeysForBounds(map.getBounds(), tileZoom);
        const hasUnloaded = viewportTileKeys.some(k => !loadedTiles.has(k));
        if (hasUnloaded) {
            scheduleViewportFetch(100);
        }
    }
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

// User location marker & tracking
let userLocationMarker = null;
let userLocationWatchId = null;

function updateUserLocationPin() {
    const showCheck = document.getElementById('show-location-check');
    const isEnabled = showCheck ? showCheck.checked : false;
    localStorage.setItem('route_show_location_check', isEnabled);

    if (!isEnabled) {
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
            () => {},
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }
}

function requestLocation(fly = true) {
    if (userLocationMarker) {
        const lngLat = userLocationMarker.getLngLat();
        const options = {
            center: [lngLat.lng, lngLat.lat],
            zoom: 14,
            speed: 2.8,
            curve: 1.4
        };
        if (fly) {
            map.flyTo(options);
        } else {
            map.jumpTo({ center: options.center, zoom: options.zoom });
        }
    }

    if (!("geolocation" in navigator)) return;

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const freshLng = pos.coords.longitude;
            const freshLat = pos.coords.latitude;
            const options = {
                center: [freshLng, freshLat],
                zoom: 14,
                speed: 2.8,
                curve: 1.4
            };

            // Ensure dot is shown when centering
            const showCheck = document.getElementById('show-location-check');
            if (showCheck && !showCheck.checked) {
                showCheck.checked = true;
                updateUserLocationPin();
            }

            if (userLocationMarker) {
                userLocationMarker.setLngLat([freshLng, freshLat]);
            }
            if (fly) {
                map.flyTo(options);
            } else {
                map.jumpTo({ center: options.center, zoom: options.zoom });
            }
        },
        (err) => {
            console.warn("Geolocation failed or denied:", err);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
    );
}

// Hook up current location button & setting
document.getElementById('current-location-btn')?.addEventListener('click', () => requestLocation(true));
const locationCheck = document.getElementById('show-location-check');
if (locationCheck) {
    const savedLoc = localStorage.getItem('route_show_location_check');
    locationCheck.checked = savedLoc !== 'false'; // default on if supported
    locationCheck.addEventListener('change', updateUserLocationPin);
    updateUserLocationPin();
}

