async function test() {
    const from = [-122.1643, 37.8115];
    const to = [-122.1550, 37.8150];

    const url = `https://routing.openstreetmap.de/routed-bike/route/v1/bicycle/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`;

    console.log("Querying OSM Bicycle Router...");
    try {
        const res = await fetch(url);
        const d = await res.json();
        console.log("OSM Status:", d.code);
        if (d.code === 'Ok') {
            console.log("Track distance:", d.routes?.[0]?.distance, "meters");
            // OSM routing doesn't return detailed messages like BRouter, but we can see the geometry length.
        }
    } catch (e) {
        console.log("OSM Error:", e.message);
    }
}

test();
