/**
 * fetchBusRouteLines.js
 * =====================
 * Fetches bus route lines (encoded in Google Polyline format) for all bus services.
 * Primary source: LTA website KML endpoints (https://www.lta.gov.sg/map/busService/bus_route_kml/<svc>-<dir>.kml)
 * Fallback source: BusRouter SG API (https://data.busrouter.sg/v1/routes.json)
 *
 * Saves raw data to:
 *   ./Data/Raw/bus/lta_route_lines.json
 */

'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const polyline = require('@mapbox/polyline');

const LTA_KML_BASE  = 'https://www.lta.gov.sg/map/busService/bus_route_kml';
const BUSROUTER_URL = 'https://data.busrouter.sg/v1/routes.json';

const CONCURRENCY = 8;
const DELAY_MS    = 50;

const RAW_DIR          = path.resolve(__dirname, '../../../Data/Raw/bus');
const ROUTE_LINES_OUT = path.join(RAW_DIR, 'lta_route_lines.json');
const DM_SERVICES_FILE = path.join(RAW_DIR, 'datamall_services.json');
const DM_ROUTES_FILE   = path.join(RAW_DIR, 'datamall_routes.json');
const LTA_SERVICES_FILE= path.join(RAW_DIR, 'lta_services.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchText(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
    });
}

/**
 * Extracts coordinates from KML string and encodes them into Google Polyline format.
 * KML coordinates format: "lng,lat,alt lng,lat,alt ..." or "lng,lat lng,lat ..."
 */
function parseKMLToPolyline(kmlText) {
    const match = kmlText.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
    if (!match || !match[1]) return null;

    const rawCoords = match[1].trim().split(/\s+/);
    const points = [];

    for (const item of rawCoords) {
        if (!item) continue;
        const parts = item.split(',');
        if (parts.length >= 2) {
            const lng = parseFloat(parts[0]);
            const lat = parseFloat(parts[1]);
            if (!isNaN(lat) && !isNaN(lng)) {
                points.push([lat, lng]);
            }
        }
    }

    if (points.length === 0) return null;
    return polyline.encode(points);
}

/**
 * Main function to fetch bus route lines.
 */
async function fetchBusRouteLines() {
    console.log('[Route Lines] Fetching bus route polylines...');

    if (!fs.existsSync(RAW_DIR)) {
        fs.mkdirSync(RAW_DIR, { recursive: true });
    }

    // 1. Collect all unique service numbers & max directions from local raw datasets
    const serviceDirs = {}; // serviceNo -> Set of direction numbers (1, 2)

    if (fs.existsSync(DM_ROUTES_FILE)) {
        const dmRoutes = JSON.parse(fs.readFileSync(DM_ROUTES_FILE, 'utf8'));
        for (const r of dmRoutes) {
            const svc = String(r.ServiceNo);
            const dir = Number(r.Direction) || 1;
            if (!serviceDirs[svc]) serviceDirs[svc] = new Set();
            serviceDirs[svc].add(dir);
        }
    }

    if (fs.existsSync(DM_SERVICES_FILE)) {
        const dmServices = JSON.parse(fs.readFileSync(DM_SERVICES_FILE, 'utf8'));
        for (const s of dmServices) {
            const svc = String(s.ServiceNo);
            if (!serviceDirs[svc]) serviceDirs[svc] = new Set([1]);
        }
    }

    if (fs.existsSync(LTA_SERVICES_FILE)) {
        const ltaServices = JSON.parse(fs.readFileSync(LTA_SERVICES_FILE, 'utf8'));
        for (const s of ltaServices) {
            const svc = String(s.number);
            if (!serviceDirs[svc]) serviceDirs[svc] = new Set([1]);
        }
    }

    const serviceList = Object.keys(serviceDirs).sort();
    console.log(`  Found ${serviceList.length} services to process`);

    const result = {}; // serviceNo -> array of polyline strings
    const missingKeys = []; // Array of { serviceNo, dirIndex (0-based), dirNum }

    // 2. Fetch LTA KML for each service & direction
    let done = 0;
    const tasks = [];

    for (const svcNo of serviceList) {
        const dirs = Array.from(serviceDirs[svcNo]).sort((a, b) => a - b);
        for (let idx = 0; idx < dirs.length; idx++) {
            const dirNum = dirs[idx];
            tasks.push({ svcNo, dirIndex: idx, dirNum });
        }
    }

    console.log(`  Fetching KMLs from LTA website (${tasks.length} total route directions)...`);

    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (t) => {
            const kmlUrl = `${LTA_KML_BASE}/${t.svcNo}-${t.dirNum}.kml`;
            let poly = null;
            try {
                const kmlText = await fetchText(kmlUrl);
                poly = parseKMLToPolyline(kmlText);
            } catch (e) {
                // Ignore LTA HTTP errors; will fall back to BusRouter SG
            }

            if (poly) {
                if (!result[t.svcNo]) result[t.svcNo] = [];
                result[t.svcNo][t.dirIndex] = poly;
            } else {
                missingKeys.push(t);
            }
            done++;
        }));

        process.stdout.write(`\r  LTA KMLs: ${done}/${tasks.length} processed...`);
        if (i + CONCURRENCY < tasks.length) await sleep(DELAY_MS);
    }
    console.log(); // newline

    // 3. Fallback: Fetch BusRouter SG routes for any missing polylines
    if (missingKeys.length > 0) {
        console.log(`  LTA missing polylines for ${missingKeys.length} route directions. Fetching fallback from ${BUSROUTER_URL}...`);
        try {
            const busRouterRaw = await fetchText(BUSROUTER_URL);
            const busRouterData = JSON.parse(busRouterRaw);

            let fallbackCount = 0;
            for (const item of missingKeys) {
                const brRoutes = busRouterData[item.svcNo];
                if (brRoutes && brRoutes[item.dirIndex]) {
                    if (!result[item.svcNo]) result[item.svcNo] = [];
                    result[item.svcNo][item.dirIndex] = brRoutes[item.dirIndex];
                    fallbackCount++;
                }
            }
            console.log(`  ✓ Successfully recovered ${fallbackCount} polylines from BusRouter SG fallback`);
        } catch (e) {
            console.warn(`  Warning: Failed to fetch BusRouter fallback data: ${e.message}`);
        }
    }

    // Clean up empty items and ensure arrays are contiguous
    for (const svc of Object.keys(result)) {
        result[svc] = result[svc].filter(Boolean);
        if (result[svc].length === 0) delete result[svc];
    }

    fs.writeFileSync(ROUTE_LINES_OUT, JSON.stringify(result), 'utf8');
    console.log(`  ✓ Saved polyline data for ${Object.keys(result).length} bus services → ${ROUTE_LINES_OUT}`);
    console.log('[Route Lines] Done.\n');

    return result;
}

module.exports = { fetchBusRouteLines };
