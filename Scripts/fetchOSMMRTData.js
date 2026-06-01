const fs = require('fs');
require('dotenv').config();

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OUTPUT_FILE = './Data/Raw/mrt/osm_mrt_data.json';

/**
 * Fetches all Singapore MRT/LRT data from OpenStreetMap via the Overpass API.
 * 
 * Makes 2 requests:
 *   1. Stations, entrances, stop_area relations, and station buildings
 *   2. Rail line route geometries
 * 
 * Parses the raw OSM data into a structured intermediate JSON format
 * that MRTDataParser.js can consume.
 */

async function queryOverpass(query, description) {
    console.log(`[OSM] Fetching ${description}...`);

    if (!process.env.CONTACT_EMAIL) {
        throw new Error('No CONTACT_EMAIL found in .env — required for OSM User-Agent');
    }

    const response = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': `SGTransitDataScript ${process.env.CONTACT_EMAIL}`
        },
        body: `data=${encodeURIComponent(query)}`
    });

    if (!response.ok) {
        throw new Error(`Overpass API error (${description})! Status: ${response.status}`);
    }

    const data = await response.json();
    console.log(`[OSM] Got ${data.elements.length} elements for ${description}`);
    return data;
}


// ─── Query 1: Stations, Entrances, Stop Areas, Buildings ─────────────────────

const QUERY_STATIONS = `
[out:json][timeout:120];
area["ISO3166-1"="SG"]["admin_level"="2"]->.sg;

// All MRT/LRT station nodes and ways
// Includes subway, light_rail, and monorail (BP/PE/PW LRT are tagged as monorail)
(
  node(area.sg)["railway"="station"]["station"~"subway|light_rail|monorail"];
  way(area.sg)["railway"="station"]["station"~"subway|light_rail|monorail"];
  node(area.sg)["railway"="station"]["public_transport"="station"]["ref"~"^(BP|PE|PW|SE|SW|STC|PTC)"];
  way(area.sg)["railway"="station"]["public_transport"="station"]["ref"~"^(BP|PE|PW|SE|SW|STC|PTC)"];
)->.stations;

// Output stations only for Tamil names
(.stations;);
out body;
>;
out skel qt;
`;


// ─── Query 2: Rail Line Routes ───────────────────────────────────────────────

const QUERY_ROUTES = `
[out:json][timeout:120];
area["ISO3166-1"="SG"]["admin_level"="2"]->.sg;
rel(area.sg)["route"~"subway|light_rail|monorail"];
out geom;
`;


// ─── Data Processing ─────────────────────────────────────────────────────────

/**
 * Processes the raw Overpass response for Query 1 into structured data.
 * 
 * Returns an object with:
 *   - stations: array of { osmId, name, nameZh, nameTa, ref, lat, lon, network, ... }
 *   - entrances: array of { osmId, name/ref, lat, lon }
 *   - stopAreas: array of { osmId, name, members: [...] }
 *   - buildings: array of { osmId, coordinates: [[lat,lon], ...] }
 *   - stationEntranceMap: { stationOsmId -> [entranceOsmId, ...] }
 */
function processStationsData(data) {
    const nodes = {};    // id -> node element (for resolving way node refs)
    const stations = [];

    // First pass: index all nodes by ID (needed to resolve way geometries)
    for (const el of data.elements) {
        if (el.type === 'node') {
            nodes[el.id] = el;
        }
    }

    // Second pass: categorize elements
    for (const el of data.elements) {
        if (el.type === 'node' && el.tags) {
            if (el.tags.railway === 'station' && (/subway|light_rail|monorail/.test(el.tags.station) || (el.tags.public_transport === 'station' && el.tags.ref))) {
                stations.push({
                    osmId: el.id,
                    osmType: 'node',
                    name: el.tags.name || '',
                    nameZh: el.tags['name:zh'] || '',
                    nameTa: el.tags['name:ta'] || '',
                    ref: el.tags.ref || '',
                    lat: el.lat,
                    lon: el.lon,
                    network: el.tags.network || '',
                    station: el.tags.station || '',
                });
            }
        }
    }

    return {
        stations,
    };
}


/**
 * Processes the raw Overpass response for Query 2 (rail routes).
 * 
 * Returns an array of route objects:
 *   { name, ref, colour, network, routeType, geometry: [[lat,lon], ...segments] }
 */
function processRoutesData(data) {
    const routes = [];

    for (const el of data.elements) {
        if (el.type !== 'relation') continue;
        if (!el.tags || !el.tags.route) continue;

        // Extract the line geometry from the relation's way members
        const segments = [];
        for (const member of (el.members || [])) {
            if (member.type === 'way' && member.geometry && member.geometry.length > 0) {
                const coords = member.geometry.map(p => [p.lat, p.lon]);
                segments.push(coords);
            }
        }

        if (segments.length > 0) {
            routes.push({
                name: el.tags.name || '',
                ref: el.tags.ref || '',
                colour: el.tags.colour || '',
                network: el.tags.network || '',
                routeType: el.tags.route,
                osmId: el.id,
                segments,
            });
        }
    }

    return routes;
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeCentroid(points) {
    const sum = points.reduce(
        (acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }),
        { lat: 0, lon: 0 }
    );
    return {
        lat: sum.lat / points.length,
        lon: sum.lon / points.length,
    };
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // metres
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// ─── Main ────────────────────────────────────────────────────────────────────

async function fetchOSMMRTData() {
    try {
        // Query 1: Stations, entrances, stop areas, buildings
        const stationsRaw = await queryOverpass(QUERY_STATIONS, 'stations/entrances/buildings');

        // Brief delay to be respectful to the Overpass server
        console.log('[OSM] Waiting 5s before next query...');
        await new Promise(r => setTimeout(r, 5000));

        // Query 2: Rail line routes
        const routesRaw = await queryOverpass(QUERY_ROUTES, 'rail line routes');

        // Process both datasets
        const stationsData = processStationsData(stationsRaw);
        const routesData = processRoutesData(routesRaw);

        const output = {
            ...stationsData,
            routes: routesData,
            fetchedAt: new Date().toISOString(),
        };

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
        console.log(`\n[OSM] All MRT data saved to ${OUTPUT_FILE}`);
        console.log(`[OSM] Summary: ${stationsData.stations.length} stations, ${routesData.length} routes`);

    } catch (error) {
        console.error('[OSM] Fatal error fetching MRT data:', error);
        process.exit(1);
    }
}

module.exports = { fetchOSMMRTData };
