/**
 * BusDataParser.js
 * ================
 * Entry point for the Bus Data pipeline.
 *
 * Usage:
 *   node Scripts/Bus/BusDataScraper/BusDataParser.js
 *   npm run bus
 *
 * Behaviour:
 *   - If TESTING_MODE=true in .env, skips fetching and reads from cached
 *     raw JSON files in ./Data/Raw/bus/.
 *   - Otherwise, fetches fresh data from DataMall and LTA website first.
 *
 * Reads (raw):
 *   ./Data/Raw/bus/datamall_stops.json    — DataMall /BusStops
 *   ./Data/Raw/bus/datamall_services.json — DataMall /BusServices
 *   ./Data/Raw/bus/datamall_routes.json   — DataMall /BusRoutes
 *   ./Data/Raw/bus/lta_stops.json         — LTA website bus_stops.xml
 *   ./Data/Raw/bus/lta_services.json      — LTA website bus_services.xml list
 *   ./Data/Raw/bus/lta_routes.json        — LTA website route XMLs (special svcs only)
 *
 * Writes (output):
 *   ./Data/Output/bus/output_stops.json
 *   ./Data/Output/bus/output_services.json
 *
 * Output formats:
 *   Stops:
 *     [{ id, Name, Road, cords: [lng, lat], Services: string[] }]
 *
 *   Services:
 *     { [serviceNo]: { name: "Origin ⇄/⟲ Destination", routes: string[][] } }
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { fetchDatamallBusData } = require('./fetchDatamallBusData');
const { fetchLTABusData } = require('./fetchLTABusData');

const TESTING_MODE = process.env.TESTING_MODE === 'true';

const RAW_DIR = path.resolve(__dirname, '../../../Data/Raw/bus');
const OUTPUT_DIR = path.resolve(__dirname, '../../../Data/Output/bus');

const RAW = {
    dmStops: path.join(RAW_DIR, 'datamall_stops.json'),
    dmServices: path.join(RAW_DIR, 'datamall_services.json'),
    dmRoutes: path.join(RAW_DIR, 'datamall_routes.json'),
    ltaStops: path.join(RAW_DIR, 'lta_stops.json'),
    ltaServices: path.join(RAW_DIR, 'lta_services.json'),
    ltaRoutes: path.join(RAW_DIR, 'lta_routes.json'),
};

const OUT = {
    stops: path.join(OUTPUT_DIR, 'stops.json'),
    services: path.join(OUTPUT_DIR, 'services.json'),
    firstLastTimings: path.join(OUTPUT_DIR, 'first_last_timings.json'),
    firstLastTimingsDir: path.join(OUTPUT_DIR, 'first-last-timings'),
};

// ─── Entry Point ──────────────────────────────────────────────────────────────

(async () => {
    console.log('====================================');
    console.log('  SG Bus Data Parser');
    console.log(TESTING_MODE ? '  [TESTING MODE — using cached data]' : '  [LIVE MODE — fetching fresh data]');
    console.log('====================================\n');

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    if (!TESTING_MODE) {
        await fetchDatamallBusData();
        await fetchLTABusData();
    }

    await parseBusData();
})();

// ─── Parser ───────────────────────────────────────────────────────────────────

async function parseBusData() {
    console.log('[Parser] Loading raw data files...');

    // Load all raw data
    const dmStopsRaw = JSON.parse(fs.readFileSync(RAW.dmStops, 'utf8'));
    const dmServicesRaw = JSON.parse(fs.readFileSync(RAW.dmServices, 'utf8'));
    const dmRoutesRaw = JSON.parse(fs.readFileSync(RAW.dmRoutes, 'utf8'));
    const ltaStopsRaw = JSON.parse(fs.readFileSync(RAW.ltaStops, 'utf8'));
    // const ltaServicesRaw= JSON.parse(fs.readFileSync(RAW.ltaServices,'utf8')); // not needed in parser
    const ltaRoutesRaw = JSON.parse(fs.readFileSync(RAW.ltaRoutes, 'utf8'));

    console.log(`  DataMall: ${dmStopsRaw.length} stops, ${dmServicesRaw.length} service records, ${dmRoutesRaw.length} route-stop records`);
    console.log(`  LTA XML:  ${ltaStopsRaw.length} stops, ${Object.keys(ltaRoutesRaw).length} special service routes`);

    // ── 1. Build stop lookup maps ────────────────────────────────────────────

    // LTA website stops (for special service stop codes like -P110, -S23, etc.)
    // keyed by code
    const ltaStopMap = {};
    for (const s of ltaStopsRaw) {
        ltaStopMap[s.code] = s;
    }

    // ── 1a. Build non-standard → standard stop code remapping ────────────────
    //
    // Deduplicate non-standard LTA stop codes (which always start with "-") by
    // first matching the stop name, and then finding the closest match that is
    // within a 100m radius.
    const ltaNonStandard = ltaStopsRaw.filter(s => s.code.startsWith('-'));
    const dmStandard = dmStopsRaw; // all DataMall stops are standard 5-digit codes

    const nonStandardToStandard = {};

    function haversineDistance(lat1, lon1, lat2, lon2) {
        const toRad = value => (value * Math.PI) / 180;
        const R = 6371e3;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    for (const ns of ltaNonStandard) {
        const nsName = ns.name.trim().toLowerCase();

        // 1. First match by stop name
        const nameMatches = dmStandard.filter(std =>
            std.Description.trim().toLowerCase() === nsName
        );

        // 2. Filter matches to those within 100m, and compute distance
        const validMatches = [];
        for (const std of nameMatches) {
            const dist = haversineDistance(ns.lat, ns.lng, std.Latitude, std.Longitude);
            if (dist <= 100) {
                validMatches.push({ std, dist });
            }
        }

        // 3. If multiple are observed, match to the nearest one
        if (validMatches.length > 0) {
            validMatches.sort((a, b) => a.dist - b.dist);
            nonStandardToStandard[ns.code] = validMatches[0].std.BusStopCode;
        }
    }
    console.log(`  Stop dedup table: ${Object.keys(nonStandardToStandard).length} non-standard codes will be remapped (name + <=100m)`);

    /** Resolve a stop code: replace non-standard with its canonical standard ID if known. */
    const resolveCode = code => nonStandardToStandard[code] || code;

    // DataMall stops (authoritative for public stops, 5-digit codes)
    // keyed by BusStopCode
    const dmStopMap = {};
    for (const s of dmStopsRaw) {
        dmStopMap[s.BusStopCode] = s;
    }

    // Merged stop map: DataMall takes priority for overlapping codes
    // LTA website fills in special stops (Premium/Shuttle etc.)
    const allStops = {}; // code → { id, Name, Road, cords, Services: Set }

    for (const [code, s] of Object.entries(ltaStopMap)) {
        // Skip non-standard codes that will be replaced by a standard one
        if (nonStandardToStandard[code]) continue;
        allStops[code] = {
            id: code,
            Name: s.name,
            Road: '',            // LTA website XML doesn't provide road names
            cords: [s.lng, s.lat],
            Services: new Set(),
        };
    }
    for (const [code, s] of Object.entries(dmStopMap)) {
        allStops[code] = {
            id: s.BusStopCode,
            Name: s.Description,
            Road: s.RoadName,
            cords: [s.Longitude, s.Latitude],
            Services: new Set(),
        };
    }

    // Quick lookup: stop code → stop name (for service name derivation)
    const stopNameMap = {};
    for (const [code, s] of Object.entries(allStops)) {
        stopNameMap[code] = s.Name;
    }

    // ── 2. Build DataMall service → directions metadata ──────────────────────

    // Group DataMall services by ServiceNo
    const dmServicesByNo = {}; // serviceNo → [ { Direction, OriginCode, DestinationCode, LoopDesc, Category }, ... ]
    for (const s of dmServicesRaw) {
        if (!dmServicesByNo[s.ServiceNo]) dmServicesByNo[s.ServiceNo] = [];
        dmServicesByNo[s.ServiceNo].push(s);
    }

    // ── 3. Build DataMall route stop sequences ───────────────────────────────

    // Group route records by ServiceNo + Direction, sorted by StopSequence
    const dmRoutesByNo = {}; // serviceNo → { 1: string[], 2: string[] }
    for (const r of dmRoutesRaw) {
        const svc = r.ServiceNo;
        const dir = r.Direction;
        if (!dmRoutesByNo[svc]) dmRoutesByNo[svc] = {};
        if (!dmRoutesByNo[svc][dir]) dmRoutesByNo[svc][dir] = [];
        dmRoutesByNo[svc][dir].push({ seq: r.StopSequence, code: r.BusStopCode });
    }
    // Sort and flatten each direction to an array of stop codes
    for (const svc of Object.keys(dmRoutesByNo)) {
        for (const dir of Object.keys(dmRoutesByNo[svc])) {
            dmRoutesByNo[svc][dir].sort((a, b) => a.seq - b.seq);
            dmRoutesByNo[svc][dir] = dmRoutesByNo[svc][dir].map(r => r.code);
        }
    }

    // ── 4. Build services output ─────────────────────────────────────────────

    console.log('[Parser] Building services...');
    const servicesOutput = {}; // { serviceNo → { name, routes } }

    // 4a. DataMall services (Trunk, Feeder, Express, City-Link, etc.)
    for (const [svcNo, dirs] of Object.entries(dmServicesByNo)) {
        const routeDirs = dmRoutesByNo[svcNo] || {};
        const routes = [];
        for (const dir of [1, 2]) {
            if (routeDirs[dir] && routeDirs[dir].length > 0) {
                routes.push(routeDirs[dir]);
            }
        }
        if (routes.length === 0) continue;

        const name = buildServiceName(svcNo, dirs, stopNameMap);
        const type = mapBusType(dirs[0].Category);
        servicesOutput[svcNo] = { name, type, routes };
    }

    // 4b. LTA-only special services (Premium, City Direct, Shuttle)
    // Note: shuttle services (SHUTTLEATTRACTIONS/SHUTTLEHOSPITALS) use their
    // description as the key in ltaRoutesRaw; for those, the key IS the name.
    for (const [key, info] of Object.entries(ltaRoutesRaw)) {
        // Use the key exactly as provided by ltaRoutesRaw for the final output.
        // This means shuttles will be keyed by their description string.
        if (servicesOutput[key]) continue;
        if (!info.directions || info.directions.length === 0) continue;

        // Apply stop code deduplication to each direction's stop list
        const routes = info.directions
            .map(d => (d.stops || []).map(resolveCode))
            .filter(s => s.length > 0);

        if (routes.length === 0) continue;

        // If the key differs from the original LTA number, it means the fetcher 
        // correctly mapped this service to use its description as the key.
        const isDescriptionKey = key !== info.number;
        const name = isDescriptionKey
            ? key
            : (info.description || buildSpecialServiceName(key, info.directions));

        servicesOutput[key] = {
            name,
            type: mapBusType(info.category),
            routes
        };

        if (info.fare) servicesOutput[key].fare = info.fare;
        if (info.schedule) servicesOutput[key].schedule = info.schedule;
    }

    console.log(`  Built ${Object.keys(servicesOutput).length} services`);

    // ── 5. Build stop → services mapping ─────────────────────────────────────

    console.log('[Parser] Mapping stops to services...');
    for (const [svcNo, svc] of Object.entries(servicesOutput)) {
        for (const route of svc.routes) {
            for (const stopCode of route) {
                if (allStops[stopCode]) {
                    allStops[stopCode].Services.add(svcNo);
                } else {
                    // Stop not in our maps yet — create a placeholder
                    allStops[stopCode] = {
                        id: stopCode,
                        Name: stopCode,
                        Road: '',
                        cords: [],
                        Services: new Set([svcNo]),
                    };
                }
            }
        }
    }

    // ── 6. Build stops output ─────────────────────────────────────────────────

    console.log('[Parser] Building stops...');

    // Output all DataMall stops + any special stops that appear in service routes
    const stopsOutput = Object.values(allStops)
        .filter(s => dmStopMap[s.id] || s.Services.size > 0) // only stops with data or used by a service
        .map(s => ({
            id: s.id,
            Name: s.Name,
            Road: s.Road,
            cords: s.cords,
            Services: [...s.Services].sort(sortServiceNumbers),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    console.log(`  Built ${stopsOutput.length} stops`);

    // ── 7. Build first and last timings by stop ─────────────────────────────

    console.log('[Parser] Building first & last bus timings by stop...');
    const firstLastTimingsOutput = {};
    const timingsByStopAndService = {};

    for (const r of dmRoutesRaw) {
        const stopCode = r.BusStopCode;
        if (!stopCode) continue;

        if (!timingsByStopAndService[stopCode]) {
            timingsByStopAndService[stopCode] = {};
        }
        if (!timingsByStopAndService[stopCode][r.ServiceNo]) {
            timingsByStopAndService[stopCode][r.ServiceNo] = [];
        }

        timingsByStopAndService[stopCode][r.ServiceNo].push({
            rawDir: r.Direction,
            seq: r.StopSequence,
            WD: {
                First: r.WD_FirstBus || '-',
                Last: r.WD_LastBus || '-',
            },
            SAT: {
                First: r.SAT_FirstBus || '-',
                Last: r.SAT_LastBus || '-',
            },
            'SUN / PH': {
                First: r.SUN_FirstBus || '-',
                Last: r.SUN_LastBus || '-',
            },
        });
    }

    for (const [stopCode, serviceMap] of Object.entries(timingsByStopAndService)) {
        firstLastTimingsOutput[stopCode] = [];
        const sortedServices = Object.keys(serviceMap).sort(sortServiceNumbers);

        for (const svcNo of sortedServices) {
            const items = serviceMap[svcNo];
            items.sort((a, b) => (a.rawDir - b.rawDir) || (a.seq - b.seq));

            items.forEach((item, index) => {
                firstLastTimingsOutput[stopCode].push({
                    serviceNo: svcNo,
                    direction: index + 1,
                    WD: item.WD,
                    SAT: item.SAT,
                    'SUN / PH': item['SUN / PH'],
                });
            });
        }
    }

    // ── 8. Write output ───────────────────────────────────────────────────────

    console.log('[Parser] Writing output files...');
    fs.writeFileSync(OUT.stops, JSON.stringify(stopsOutput), 'utf8');
    fs.writeFileSync(OUT.services, JSON.stringify(servicesOutput), 'utf8');
    fs.writeFileSync(OUT.firstLastTimings, JSON.stringify(firstLastTimingsOutput), 'utf8');

    if (!fs.existsSync(OUT.firstLastTimingsDir)) {
        fs.mkdirSync(OUT.firstLastTimingsDir, { recursive: true });
    }

    for (const [stopCode, timings] of Object.entries(firstLastTimingsOutput)) {
        fs.writeFileSync(path.join(OUT.firstLastTimingsDir, `${stopCode}.json`), JSON.stringify(timings), 'utf8');
    }

    console.log(`  ✓ Stops              → ${OUT.stops}`);
    console.log(`  ✓ Services           → ${OUT.services}`);
    console.log(`  ✓ First/Last Timings → ${OUT.firstLastTimings}`);
    console.log(`  ✓ Per-Stop Timings   → ${OUT.firstLastTimingsDir}`);
    console.log('\n✅ Done!');
    console.log(`   ${stopsOutput.length} stops, ${Object.keys(servicesOutput).length} services, ${Object.keys(firstLastTimingsOutput).length} stop timing entries`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build service name from DataMall service metadata.
 * Format:
 *   "Origin ⇄ Destination"  for two-directional services
 *   "Origin ⟲ Loop Point"   for loop/one-directional services
 */
function buildServiceName(svcNo, dirs, stopNameMap) {
    const dir1 = dirs.find(d => d.Direction === 1);
    const dir2 = dirs.find(d => d.Direction === 2);

    if (!dir1) return svcNo;

    const originName = stopNameMap[dir1.OriginCode] || dir1.OriginCode;
    const destCode = dir1.DestinationCode;
    const isLoop = !dir2 || dir1.OriginCode === destCode;

    if (isLoop) {
        const loopName = dir1.LoopDesc || stopNameMap[destCode] || destCode;
        return `${originName} ⟲ ${loopName}`;
    } else {
        const destName = stopNameMap[destCode] || destCode;
        return `${originName} ⇄ ${destName}`;
    }
}

/**
 * Build a name for special services from direction name strings.
 * LTA direction names are like "From Buangkok Crescent to Marina Boulevard"
 * or "(Morning Peak) Tampines Avenue 9 to Airline Road"
 */
function buildSpecialServiceName(svcNo, directions) {
    if (!directions || directions.length === 0) return svcNo;
    // Use first direction's name if available
    const firstName = directions[0].name;
    if (firstName) return firstName;
    return svcNo;
}

/**
 * Map raw category string from DataMall/LTA into user-friendly bus type string.
 */
function mapBusType(category) {
    if (!category) return 'Public Bus';
    const catUpper = category.trim().toUpperCase();
    switch (catUpper) {
        case 'TRUNK':
        case 'FEEDER':
        case 'EXPRESS':
        case 'INDUSTRIAL':
        case 'CITY_LINK':
        case 'CITY-LINK':
            return 'Public Bus';
        case 'PREMIUM':
            return 'Premium Bus (Private)';
        case 'SHUTTLEATTRACTIONS':
            return 'Shuttle to attractions';
        case 'SHUTTLEHOSPITALS':
            return 'Shuttle to hospitals';
        default:
            return category;
    }
}

/**
 * Sort service numbers naturally:
 * Numeric services first (2, 7, 10, 65, 107...),
 * then alphanumeric (2e, 12e, 145A...),
 * then special services (-P11, -S23...).
 */
function sortServiceNumbers(a, b) {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    if (!isNaN(numA)) return -1;
    if (!isNaN(numB)) return 1;
    return a.localeCompare(b);
}

module.exports = { parseBusData, mapBusType };
