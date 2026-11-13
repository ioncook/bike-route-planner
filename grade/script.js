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
    aroundCenter: false,
    transformRequest: (url, resourceType) => {
        // No custom headers to avoid CORS preflight failures on tile servers
    }
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
        if (e.data.type === 'build-grade-tile') {
            cb({ buffer: e.data.buffer, error: e.data.error });
        } else if (e.data.type === 'process-grade-ways') {
            cb(e.data.processedWays);
        } else {
            cb(e.data.elevations);
        }
    }
};

elevationWorker.onerror = (err) => {
    console.error('Elevation Worker Error in Grade Map:', err);
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

function buildGradeTileInWorker(z, x, y) {
    return new Promise(resolve => {
        const id = _nextWorkerId++;
        _workerCallbacks.set(id, resolve);
        elevationWorker.postMessage({ type: 'build-grade-tile', id, z, x, y });
    });
}

let isMapMoving = false;
let _activeGradeTiles = 0;

function setGradeLoadingState(delta) {
    _activeGradeTiles = Math.max(0, _activeGradeTiles + delta);
    const loadingEl = document.getElementById('loading-indicator');
    const favMobile = document.getElementById('favicon-mobile');
    if (_activeGradeTiles > 0) {
        if (loadingEl) loadingEl.style.display = 'flex';
        if (favMobile) favMobile.classList.add('loading');
    } else {
        if (loadingEl) loadingEl.style.display = 'none';
        if (favMobile) favMobile.classList.remove('loading');
    }
}

const GRADE_MVT_CACHE_NAME = 'grade-mvt-v1';
const GRADE_MVT_MAX_TILES = 250;

async function readGradeTileCache(cacheKeyUrl) {
    if (typeof caches === 'undefined') return null;
    try {
        const cache = await caches.open(GRADE_MVT_CACHE_NAME);
        const match = await cache.match(cacheKeyUrl);
        if (!match) return null;
        return await match.arrayBuffer();
    } catch (_) {
        return null;
    }
}

async function writeGradeTileCache(cacheKeyUrl, buffer) {
    if (typeof caches === 'undefined' || !buffer || buffer.byteLength === 0) return;
    try {
        const cache = await caches.open(GRADE_MVT_CACHE_NAME);
        const keys = await cache.keys();
        if (keys.length >= GRADE_MVT_MAX_TILES) {
            const overflow = keys.length - GRADE_MVT_MAX_TILES + 1;
            for (let i = 0; i < overflow; i++) {
                await cache.delete(keys[i]);
            }
        }
        await cache.put(cacheKeyUrl, new Response(buffer.slice(0), {
            headers: { 'Content-Type': 'application/x-protobuf' }
        }));
    } catch (_) { }
}

maplibregl.addProtocol('grade', async (params, abortController) => {
    const match = params.url.match(/grade:\/\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) return { data: new ArrayBuffer(0) };
    const z = parseInt(match[1], 10);
    const x = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);
    const cacheKeyUrl = `https://grade-cache.local/${z}/${x}/${y}.pbf`;

    const cachedBuffer = await readGradeTileCache(cacheKeyUrl);
    if (cachedBuffer) {
        return { data: cachedBuffer };
    }
    if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    setGradeLoadingState(1);
    try {
        const result = await buildGradeTileInWorker(z, x, y);
        if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!result || result.error || !result.buffer) {
            return { data: new ArrayBuffer(0) };
        }
        if (result.buffer.byteLength > 0) {
            writeGradeTileCache(cacheKeyUrl, result.buffer);
        }
        return { data: result.buffer };
    } finally {
        setGradeLoadingState(-1);
    }
});

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

// Match a road's geometry against in-memory street name lines using midpoint distance & local directional alignment
function matchStreetNameInMemory(roadCoords, nameEntries) {
    if (!roadCoords || roadCoords.length < 2 || !nameEntries || nameEntries.length === 0) return '';

    const midIdx = Math.floor((roadCoords.length - 1) * 0.5);
    const mid = roadCoords[midIdx];
    if (!mid) return '';
    const midLon = mid[0], midLat = mid[1];

    // Local tangent at midpoint (handles curved roads accurately)
    const tA = roadCoords[Math.max(0, midIdx - 1)];
    const tB = roadCoords[Math.min(roadCoords.length - 1, midIdx + 1)];
    const rdx = tB[0] - tA[0];
    const rdy = (tB[1] - tA[1]) * 1.27;
    const rlen = Math.hypot(rdx, rdy);

    // Search bounding box padding in degrees (~65 meters)
    const pad = 0.00065;

    let bestScore = Infinity;
    let bestName = '';

    for (const entry of nameEntries) {
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
                distMeters = Math.hypot((midLon - a[0]) * 85000, (midLat - a[1]) * 111000);
            } else {
                let t = ((midLon - a[0]) * cdx + (midLat - a[1]) * 1.27 * cdy) / l2;
                t = Math.max(0, Math.min(1, t));
                const projLon = a[0] + t * (b[0] - a[0]);
                const projLat = a[1] + t * (b[1] - a[1]);
                distMeters = Math.hypot((midLon - projLon) * 85000, (midLat - projLat) * 111000);
            }

            if (distMeters > 40) continue;

            let alignmentPenalty = 0;
            if (rlen > 0.00002 && clen > 0.00002) {
                const cosTheta = Math.abs(rdx * cdx + rdy * cdy) / (rlen * clen);
                if (cosTheta < 0.35) {
                    alignmentPenalty = 14;
                } else if (cosTheta > 0.75) {
                    alignmentPenalty = -5;
                }
            }

            const score = distMeters + alignmentPenalty;
            if (score < bestScore) {
                bestScore = score;
                bestName = entry.name;
            }
        }
    }

    return (bestScore < 34) ? bestName : '';
}

// Fallback street name finder for hover/click tooltips
function findStreetName(cursorPoint, segmentCoordinates, zoom) {
    if (!segmentCoordinates || segmentCoordinates.length < 2) return '';
    try {
        const bbox = cursorPoint
            ? [[cursorPoint.x - 80, cursorPoint.y - 80], [cursorPoint.x + 80, cursorPoint.y + 80]]
            : null;
        const nameFeatures = map.queryRenderedFeatures(bbox, { layers: ['carto-names-hidden'] }) || [];
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

    if (!map.getSource('grade-roads')) {
        map.addSource('grade-roads', {
            type: 'vector',
            tiles: ['grade://{z}/{x}/{y}'],
            minzoom: 11,
            maxzoom: 14
        });
    }

    // Get current line opacity setting
    const opacityVal = 1.0;

    if (!map.getLayer('grade-roads-layer')) {
        map.addLayer({
            id: 'grade-roads-layer',
            type: 'line',
            source: 'grade-roads',
            'source-layer': 'grade-roads',
            minzoom: 11.5,
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
            'source-layer': 'grade-roads',
            minzoom: 11.5,
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
                    const hoverNameId = `grade-hover-street-name-${hoveredSegmentId}`;
                    const nameHtml = `<div id="${hoverNameId}" style="font-size:0.7rem;color:var(--text-muted);margin-bottom:3px;font-weight:normal;text-transform:capitalize;${streetName ? '' : 'display:none;'}">${streetName}</div>`;
                    hoverPopup.setLngLat(midpoint)
                        .setHTML(`<div style="font-family:'Inter',sans-serif;font-size:0.82rem;font-weight:600;background:var(--bg-panel);padding:4px 6px;">
                            ${nameHtml}
                            <div>Grade: <span style="color:${getGradeColor(gradePercent)};font-weight:700;">${formatted}</span></div>
                        </div>`)
                        .addTo(map);

                    if (!streetName) {
                        const segIdSnapshot = hoveredSegmentId;
                        const lat = midpoint[1];
                        const lng = midpoint[0];
                        clearTimeout(window._gradeHoverRevTimer);
                        window._gradeHoverRevTimer = setTimeout(() => {
                            if (hoveredSegmentId !== segIdSnapshot && stickySegmentId !== segIdSnapshot) return;
                            fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17`)
                                .then(r => r.ok ? r.json() : null)
                                .then(data => {
                                    const roadName = data?.address?.road || data?.address?.pedestrian || data?.address?.cycleway || data?.address?.path || '';
                                    if (roadName) {
                                        feature.properties.name = roadName;
                                        const el = document.getElementById(hoverNameId);
                                        if (el && (hoveredSegmentId === segIdSnapshot || stickySegmentId === segIdSnapshot)) {
                                            el.textContent = roadName;
                                            el.style.display = 'block';
                                        }
                                    }
                                })
                                .catch(() => {});
                        }, 180);
                    }

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
                        let heading = 0;
                        if (geom.coordinates && geom.coordinates.length >= 2) {
                            const a = geom.coordinates[0];
                            const b = geom.coordinates[geom.coordinates.length - 1];
                            const dLng = (b[0] - a[0]) * Math.PI / 180;
                            const lat1 = a[1] * Math.PI / 180;
                            const lat2 = b[1] * Math.PI / 180;
                            const y = Math.sin(dLng) * Math.cos(lat2);
                            const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
                            const computedHeading = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
                            if (Number.isFinite(computedHeading)) {
                                heading = Math.round(computedHeading);
                            }
                        }
                        const svUrl = `https://www.google.com/maps?layer=c&cbll=${lat},${lng}&cbp=12,${heading},0,0,0`;
                        
                        let streetName = feature.properties.name || '';
                        if (!streetName) {
                            streetName = findStreetName(e.point, geom.coordinates, map.getZoom());
                            if (streetName) {
                                feature.properties.name = streetName;
                            }
                        }
                        const nameElId = `grade-street-name-${Date.now()}`;
                        const nameHtml = `<div id="${nameElId}" style="font-size:0.7rem;color:var(--text-muted);margin-bottom:3px;font-weight:normal;text-transform:capitalize;${streetName ? '' : 'display:none;'}">${streetName}</div>`;

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

                        if (!streetName) {
                            fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17`)
                                .then(r => r.ok ? r.json() : null)
                                .then(data => {
                                    const roadName = data?.address?.road || data?.address?.pedestrian || data?.address?.cycleway || data?.address?.path || '';
                                    if (roadName) {
                                        feature.properties.name = roadName;
                                        const el = document.getElementById(nameElId);
                                        if (el) {
                                            el.textContent = roadName;
                                            el.style.display = 'block';
                                        }
                                    }
                                })
                                .catch(() => {});
                        }

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
            'source-layer': 'grade-roads',
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

function updateZoomWarning() {
    const warning = document.getElementById('zoom-warning');
    if (!warning) return;
    if (map.getZoom() < 11.5) {
        warning.classList.remove('hidden');
    } else {
        warning.classList.add('hidden');
    }
}

map.on('style.load', () => {
    setupGradeLayers();
    applyTerrain();
    updateZoomWarning();
});

map.on('movestart', () => {
    isMapMoving = true;
    if (!stickySegmentId && hoverPopup) {
        hoverPopup.remove();
        hoveredSegmentId = null;
    }
});

map.on('moveend', () => {
    isMapMoving = false;
    localStorage.setItem('last_map_center', JSON.stringify(map.getCenter()));
    localStorage.setItem('last_map_zoom', map.getZoom());
    updateZoomWarning();
});

map.on('zoomend', updateZoomWarning);

map.on('load', () => {
    updateZoomWarning();
    applyTerrain();
});

// Settings syncing and interaction handlers
document.getElementById('theme').addEventListener('change', (e) => {
    const val = e.target.value;
    localStorage.setItem('route_theme', val);
    if (window.applyAppTheme) {
        window.applyAppTheme(val);
    } else if (val === 'light') {
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



// Terrain & Hillshade switcher (3D terrain automatically activates when pitch > 5 deg)
function sync3DTerrainFromPitch(forceUpdate = false) {
    if (!map || !map.getSource('terrain-source')) return;
    const exInput = document.getElementById('terrain-exaggeration');
    let exVal = parseFloat(exInput?.value);
    if (isNaN(exVal)) exVal = 1.7;

    const shouldEnable = map.getPitch() > 5;
    const hasTerrain = Boolean(map.getTerrain());
    if (shouldEnable && (!hasTerrain || forceUpdate)) {
        map.setTerrain({ source: 'terrain-source', exaggeration: exVal });
    } else if (!shouldEnable && hasTerrain) {
        map.setTerrain(null);
    }
}

function applyTerrain() {
    const hillshadeCheck = document.getElementById('hillshade-check');
    const isHillshadeOn = hillshadeCheck ? hillshadeCheck.checked : false;
    const exInput = document.getElementById('terrain-exaggeration');

    localStorage.setItem('route_hillshade', isHillshadeOn ? 'hillshade' : 'off');
    let exVal = parseFloat(exInput?.value);
    if (isNaN(exVal)) exVal = 1.7;
    localStorage.setItem('route_exaggeration', exVal);

    if (map.getLayer('hillshade-layer')) {
        if (isHillshadeOn) {
            map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
            map.setPaintProperty('hillshade-layer', 'hillshade-exaggeration', 0.5);
        } else {
            map.setLayoutProperty('hillshade-layer', 'visibility', 'none');
        }
    }

    sync3DTerrainFromPitch(true);
}

document.getElementById('hillshade-check')?.addEventListener('change', applyTerrain);
document.getElementById('terrain-exaggeration')?.addEventListener('change', applyTerrain);
map.on('pitch', () => sync3DTerrainFromPitch(false));
map.on('pitchend', () => sync3DTerrainFromPitch(false));

// Sync settings UI on load
const storedTheme = localStorage.getItem('route_theme') || 'dark';
document.getElementById('theme').value = storedTheme;
if (window.applyAppTheme) {
    window.applyAppTheme(storedTheme);
} else if (storedTheme === 'light') {
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
if (document.getElementById('hillshade-check')) {
    document.getElementById('hillshade-check').checked = (storedHillshade === 'hillshade' || storedHillshade === 'terrain' || storedHillshade === 'true');
}
const storedExaggeration = localStorage.getItem('route_exaggeration') || '1.7';
if (document.getElementById('terrain-exaggeration')) {
    document.getElementById('terrain-exaggeration').value = storedExaggeration;
}

// Compass reset & needle rotation
document.getElementById('reset-orientation-btn')?.addEventListener('click', () => {
    map.easeTo({ bearing: 0, pitch: 0, duration: 300 });
});
map.on('rotate', () => {
    const compass = document.getElementById('compass-needle-svg');
    if (compass) compass.style.transform = `rotate(${-map.getBearing()}deg)`;
});

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
        const handlePos = (pos) => {
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
        };
        navigator.geolocation.getCurrentPosition(handlePos, () => {}, { enableHighAccuracy: false, maximumAge: 30000, timeout: 5000 });
        userLocationWatchId = navigator.geolocation.watchPosition(
            handlePos,
            () => {},
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
        );
    }
}

// Sync Show My Location checkbox with main page & attach listener
const storedShowLocation = localStorage.getItem('route_show_location_check');
const showLocCheckEl = document.getElementById('show-location-check');
if (showLocCheckEl) {
    showLocCheckEl.checked = storedShowLocation !== null ? storedShowLocation === 'true' : true;
    showLocCheckEl.addEventListener('change', updateUserLocationPin);
    updateUserLocationPin();
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

// Dynamic Top Bar Height Sync (for perfect positioning of mobile overlays and warnings)
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

