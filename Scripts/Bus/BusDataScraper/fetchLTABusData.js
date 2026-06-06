/**
 * fetchLTABusData.js
 * ==================
 * Fetches bus stop and service data from LTA's website XML APIs.
 * This covers Premium, City Direct, and Shuttle services that are
 * NOT available on the DataMall API.
 *
 * Saves results to:
 *   ./Data/Raw/bus/lta_stops.json        — All stops from bus_stops.xml
 *   ./Data/Raw/bus/lta_services.json     — Service list from bus_services.xml
 *   ./Data/Raw/bus/lta_routes.json       — Route stop sequences for special services
 *                                          (Premium, City Direct, Shuttle only)
 *
 * Key format in lta_routes.json:
 *   CITYDIRECT / PREMIUM      → keyed by service number  (e.g. "651", "-P13")
 *   SHUTTLEATTRACTIONS        → keyed by description string (e.g. "RWS 8 - ...")
 *   SHUTTLEHOSPITALS          → keyed by description string (e.g. "Changi General Hospital...")
 *
 * Special service categories scraped (not on DataMall):
 *   CITYDIRECT, PREMIUM, SHUTTLEATTRACTIONS, SHUTTLEHOSPITALS
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const xml2js = require('xml2js');

const LTA_BASE         = 'https://www.lta.gov.sg/map/busService';
const LTA_STOPS_XML    = `${LTA_BASE}/bus_stops.xml`;
const LTA_SERVICES_XML = `${LTA_BASE}/bus_services.xml`;
const LTA_ROUTE_BASE   = `${LTA_BASE}/bus_route_xml`;

// Only fetch routes for services in these LTA-only categories
const SPECIAL_CATEGORIES = ['CITYDIRECT', 'PREMIUM', 'SHUTTLEATTRACTIONS', 'SHUTTLEHOSPITALS'];

// Concurrent route XML requests
const CONCURRENCY = 5;

// Polite delay between batches (ms)
const DELAY_MS = 100;

const RAW_DIR      = path.resolve(__dirname, '../../../Data/Raw/bus');
const STOPS_OUT    = path.join(RAW_DIR, 'lta_stops.json');
const SERVICES_OUT = path.join(RAW_DIR, 'lta_services.json');
const ROUTES_OUT   = path.join(RAW_DIR, 'lta_routes.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function parseXML(xmlString) {
    return new Promise((resolve, reject) => {
        xml2js.parseString(xmlString, { trim: true, explicitArray: false }, (err, r) => {
            if (err) reject(err); else resolve(r);
        });
    });
}

// ─── Fetch LTA stop list ──────────────────────────────────────────────────────

async function fetchLTAStops() {
    console.log(`  Fetching ${LTA_STOPS_XML}...`);
    const xml    = await fetchText(LTA_STOPS_XML);
    const parsed = await parseXML(xml);
    let rawStops = parsed.busstops.busstop;
    if (!Array.isArray(rawStops)) rawStops = [rawStops];

    const stops = rawStops.map(s => ({
        code:    s.$.name,
        name:    s.details || '',
        lat:     parseFloat(s.coordinates.lat),
        lng:     parseFloat(s.coordinates.long),
    }));

    console.log(`  Found ${stops.length} stops in LTA XML`);
    return stops;
}

// ─── Fetch LTA service list ───────────────────────────────────────────────────

async function fetchLTAServices() {
    console.log(`  Fetching ${LTA_SERVICES_XML}...`);
    const xml    = await fetchText(LTA_SERVICES_XML);
    const parsed = await parseXML(xml);
    const root   = parsed.bus_service_list;

    const services = [];

    for (const [category, section] of Object.entries(root)) {
        let svcList = section.bus_service;
        if (!svcList) continue;
        if (!Array.isArray(svcList)) svcList = [svcList];

        for (const svc of svcList) {
            let routeFiles = [];
            if (svc.routeFile && svc.routeFile.file) {
                routeFiles = Array.isArray(svc.routeFile.file)
                    ? svc.routeFile.file
                    : [svc.routeFile.file];
            }
            services.push({
                number:      svc.number,
                category,
                description: svc.description || null,
                routeFiles,
            });
        }
    }

    console.log(`  Found ${services.length} services in LTA XML`);
    return services;
}

// ─── Fetch LTA route XMLs for special services ────────────────────────────────

async function fetchLTARoutes(services) {
    const specialServices = services.filter(s => SPECIAL_CATEGORIES.includes(s.category));
    console.log(`  Fetching route XMLs for ${specialServices.length} special services...`);

    // Collect unique route files across all special services
    const fileToServices = {}; // routeFile → [serviceNo, ...]
    for (const svc of specialServices) {
        for (const file of svc.routeFiles) {
            if (!fileToServices[file]) fileToServices[file] = [];
            fileToServices[file].push(svc.number);
        }
    }
    const uniqueFiles = Object.keys(fileToServices);

    const results = {}; // serviceNo → { directions: [ { name, stops: string[] }, ... ], fare, schedule }

    let done = 0;
    const total = uniqueFiles.length;

    // Process in batches
    for (let i = 0; i < uniqueFiles.length; i += CONCURRENCY) {
        const batch = uniqueFiles.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (file) => {
            const url = `${LTA_ROUTE_BASE}/${file}`;
            try {
                const xml    = await fetchText(url);
                const parsed = await parseXML(xml);
                const route  = parsed.route;

                let directions = route.direction;
                if (!directions) return;
                if (!Array.isArray(directions)) directions = [directions];

                const dirData = directions.map(dir => {
                    let stops = dir.busstop;
                    if (!stops) return { name: dir.$.name || '', stops: [] };
                    if (!Array.isArray(stops)) stops = [stops];
                    const stopCodes = stops.map(s => (typeof s === 'string' ? s : s.$.name));
                    return { name: dir.$.name || '', stops: stopCodes };
                });

                let parsedFare = null;
                if (route.fare && typeof route.fare === 'string') {
                    parsedFare = route.fare.trim();
                }

                let parsedSchedule = null;
                if (route.schedule) {
                    if (typeof route.schedule === 'string') {
                        parsedSchedule = route.schedule.trim();
                    } else if (route.schedule.title) {
                        parsedSchedule = route.schedule.title.trim();
                    }
                }

                // Attach these directions, fare, and schedule to each service that uses this route file
                for (const svcNo of fileToServices[file]) {
                    if (!results[svcNo]) {
                        results[svcNo] = { directions: [], fare: null, schedule: null };
                    }
                    // Avoid duplicates if multiple files map to same service
                    for (const dir of dirData) {
                        results[svcNo].directions.push(dir);
                    }
                    if (parsedFare) results[svcNo].fare = parsedFare;
                    if (parsedSchedule) results[svcNo].schedule = parsedSchedule;
                }
            } catch (e) {
                console.warn(`\n  Warning: Failed to fetch ${url}: ${e.message}`);
            }
            done++;
        }));

        process.stdout.write(`\r  Route XMLs: ${done}/${total} fetched...`);
        if (i + CONCURRENCY < uniqueFiles.length) await sleep(DELAY_MS);
    }

    console.log(); // newline

    // Attach additional metadata from service list.
    // For SHUTTLEATTRACTIONS and SHUTTLEHOSPITALS, use the description as the key
    // so the parser can use it directly as the service display name.
    // For PREMIUM services whose number starts with '-', also use description as key.
    // For CITYDIRECT and numeric PREMIUMs, keep the service number as the key.
    const SHUTTLE_CATEGORIES = ['SHUTTLEATTRACTIONS', 'SHUTTLEHOSPITALS'];
    const enriched = {};
    for (const svc of specialServices) {
        const isShuttle = SHUTTLE_CATEGORIES.includes(svc.category);
        const isSpecialPremium = svc.category === 'PREMIUM' && svc.number.startsWith('-');
        const useDescriptionAsKey = (isShuttle || isSpecialPremium) && svc.description;
        
        const key = useDescriptionAsKey ? svc.description : svc.number;
        const routeData = results[svc.number] || { directions: [], fare: null, schedule: null };
        
        enriched[key] = {
            category:    svc.category,
            // For shuttle services the key IS the description; store number for reference.
            // For others, store description as a separate field.
            number:      svc.number,
            description: useDescriptionAsKey ? null : svc.description,
            directions:  routeData.directions,
            fare:        routeData.fare,
            schedule:    routeData.schedule,
        };
    }

    return enriched;
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function fetchLTABusData() {
    console.log('[LTA Website] Fetching bus data from LTA website...');

    if (!fs.existsSync(RAW_DIR)) {
        fs.mkdirSync(RAW_DIR, { recursive: true });
    }

    const stops    = await fetchLTAStops();
    const services = await fetchLTAServices();
    const routes   = await fetchLTARoutes(services);

    fs.writeFileSync(STOPS_OUT,    JSON.stringify(stops),    'utf8');
    console.log(`  ✓ Saved ${stops.length} stops → ${STOPS_OUT}`);

    fs.writeFileSync(SERVICES_OUT, JSON.stringify(services), 'utf8');
    console.log(`  ✓ Saved ${services.length} services → ${SERVICES_OUT}`);

    fs.writeFileSync(ROUTES_OUT,   JSON.stringify(routes),   'utf8');
    console.log(`  ✓ Saved ${Object.keys(routes).length} special service routes → ${ROUTES_OUT}`);

    console.log('[LTA Website] Done.\n');
}

module.exports = { fetchLTABusData };
