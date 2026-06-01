const fs = require("fs");
const { fetchOSMMRTData } = require('./fetchOSMMRTData');
const { retrieveLTAMRTData } = require('./fetchLTAMRTData');
const { parseLTASpatialData } = require('./parseLTASpatialData');
var polyline = require('@mapbox/polyline');
const { formStationLineRelations } = require('./MRT/getLine-StationRelationsLTA');
require('dotenv').config();

const testingMode = process.env.TESTING_MODE;

// Entry point is after all module-level declarations (see bottom of constants block)


// ─── Official LTA hex colour codes for each line ────────────────────────────

const officialLineColors = {
    'NSL': '#D42E12',
    'EWL': '#009645',
    'NEL': '#9900AA',
    'CCL': '#FA9E0D',
    'DTL': '#005EC4',
    'TEL': '#9D5B25',
    'BPL': '#748477',
    'STL': '#748477',
    'PTL': '#748477',
};

// Map from station code prefix → line code
const prefixToLineCode = {
    'EW': 'EWL', 'CG': 'EWL',
    'NS': 'NSL',
    'NE': 'NEL',
    'CC': 'CCL', 'CE': 'CCL',
    'DT': 'DTL',
    'TE': 'TEL',
    'BP': 'BPL',
    'ST': 'STL', 'SE': 'STL', 'SW': 'STL', 'STC': 'STL',
    'PT': 'PTL', 'PE': 'PTL', 'PW': 'PTL', 'PTC': 'PTL', 'CP': 'PTL',
};

const lineCodeToName = {
    'EWL': 'East West Line',
    'NSL': 'North South Line',
    'NEL': 'North East Line',
    'CCL': 'Circle Line',
    'DTL': 'Downtown Line',
    'TEL': 'Thomson-East Coast Line',
    'BPL': 'Bukit Panjang LRT',
    'STL': 'Sengkang LRT',
    'PTL': 'Punggol LRT',
};

function getLineCodeForStationCode(code) {
    const prefix = code.replace(/[0-9]/g, '');
    return prefixToLineCode[prefix] || null;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

(async () => {
    if (!testingMode) {
        await fetchOSMMRTData();
        await retrieveLTAMRTData();
        await parseLTASpatialData();
        await formStationLineRelations();
        await parseMRTData();
    } else {
        await parseMRTData();
    }
})();


// ─── Main Parser ─────────────────────────────────────────────────────────────

async function parseMRTData() {
    console.log('\n[Parser] Loading data files...');

    const osmData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/osm_mrt_data.json", "utf8"));
    const ltaMrtData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/lta_mrt_data.json", "utf8"));
    const ltaSpatialData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/lta_spatial_data.json", "utf8"));
    const lineRelationsData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/mrt_lines_station_relation_data.json", "utf8"));

    const osmStations = osmData.stations;
    const osmRoutes = osmData.routes;

    const outputStations = [];

    for (const ltaStation of ltaSpatialData.stations) {
        // Find OSM node to patch Tamil name
        let nameTa = '';
        const osmMatch = osmStations.find(s => {
            const refMatch = s.ref && s.ref.split(';').map(r => r.trim()).some(r => ltaStation.codes.includes(r));
            const exactNameMatch = s.name && s.name.toLowerCase() === ltaStation.nameEn.toLowerCase();
            return refMatch || exactNameMatch;
        });
        if (osmMatch && osmMatch.nameTa) {
            nameTa = osmMatch.nameTa;
        }

        // Find LTA scraped data for train times and landmarks
        const relevantLTAData = findLTAData(ltaMrtData, ltaStation.codes);

        // Map and merge exits
        const mergedExits = [];
        const scrapedExits = relevantLTAData.exits || [];

        // Add exits from spatial data
        for (const spatialExit of ltaStation.exits) {
            const scrapedExit = scrapedExits.find(e => e.exit.toLowerCase() === spatialExit.exitCode.toLowerCase() || e.exit.toLowerCase() === spatialExit.exitCode.replace('Exit ', '').toLowerCase());
            mergedExits.push({
                exitName: spatialExit.exitCode,
                coordinates: spatialExit.coordinates,
                landmarks: scrapedExit ? scrapedExit.landmarks : []
            });
        }

        // Add exits that are in scraped data but missing from spatial data
        for (const scrapedExit of scrapedExits) {
            const exists = mergedExits.some(e => e.exitName.toLowerCase() === scrapedExit.exit.toLowerCase() || e.exitName.toLowerCase() === `exit ${scrapedExit.exit}`.toLowerCase());
            if (!exists) {
                mergedExits.push({
                    exitName: scrapedExit.exit.length === 1 ? `Exit ${scrapedExit.exit}` : scrapedExit.exit,
                    coordinates: [],
                    landmarks: scrapedExit.landmarks
                });
            }
        }

        mergedExits.sort((a, b) => a.exitName.localeCompare(b.exitName, undefined, { numeric: true }));

        // Encode boundaries
        const boundaries = ltaStation.boundaries.map(poly => polyline.encode(poly));

        const station = {
            name: ltaStation.nameEn,
            "name-chinese": ltaStation.nameZh,
            "name-tamil": nameTa,
            codes: ltaStation.codes.sort(),
            latitude: ltaStation.latitude || (osmMatch ? osmMatch.lat : 0),
            longitude: ltaStation.longitude || (osmMatch ? osmMatch.lon : 0),
            trainFirstLastData: relevantLTAData.trainFirstLastData || [],
            exits: mergedExits,
            boundaries: boundaries
        };

        if (ltaStation.hasDuplicateExits) {
            station.exitDataApproximate = true;
        }

        outputStations.push(station);
    }

    // Sort stations alphabetically
    outputStations.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`[Parser] Built ${outputStations.length} station objects`);

    // ── Step 6: Build line objects ──────────────────────────────────────────
    const outputLines = buildLines(osmRoutes, lineRelationsData);

    console.log(`[Parser] Built ${outputLines.length} line objects`);

    // ── Step 7: Write output ────────────────────────────────────────────────
    const mrtData = {
        stations: outputStations,
        lines: outputLines,
    };

    fs.writeFile('./Data/Output/mrt/mrt.json', JSON.stringify(mrtData), (err) => {
        if (err) {
            console.error("Error saving MRT data:", err);
        } else {
            console.log("\n[Parser] MRT data generated and saved successfully!");
        }
    });
}


// ─── Line Builder ────────────────────────────────────────────────────────────

/**
 * Builds the line objects from OSM route data + LTA relations.
 *
 * OSM has individual route relations per direction. We merge them by line.
 * LRT loops (Sengkang/Punggol) are unified into STL/PTL.
 */
function buildLines(osmRoutes, lineRelationsData) {
    const lines = [];

    // LRT line classification
    const lrtLineMap = {
        'BPL': { type: 'lrt' },
        'STL': { type: 'lrt' },
        'PTL': { type: 'lrt' },
    };

    // Map OSM route names/refs to our line codes
    // OSM route relations may have `ref` like "NSL", "EWL", etc.
    // or names like "North South Line", etc.
    const routesByLineCode = {};

    for (const route of osmRoutes) {
        let lineCode = null;

        // Try matching by ref first
        if (route.ref && lineCodeToName[route.ref]) {
            lineCode = route.ref;
        }

        // Try matching by name
        if (!lineCode) {
            for (const [code, name] of Object.entries(lineCodeToName)) {
                if (route.name.includes(name) || route.name.replace(/-/g, ' ').includes(name.replace(/-/g, ' '))) {
                    lineCode = code;
                    break;
                }
            }
        }

        // Try matching LRT loops
        if (!lineCode) {
            if (/sengkang/i.test(route.name)) lineCode = 'STL';
            else if (/punggol/i.test(route.name)) lineCode = 'PTL';
            else if (/bukit\s*panjang/i.test(route.name)) lineCode = 'BPL';
        }

        if (lineCode) {
            if (!routesByLineCode[lineCode]) {
                routesByLineCode[lineCode] = [];
            }
            routesByLineCode[lineCode].push(route);
        } else {
            console.warn(`[Parser] Could not classify OSM route: "${route.name}" (ref: ${route.ref})`);
        }
    }

    // Build line objects
    for (const lineRelation of lineRelationsData) {
        const lineCode = lineRelation.lineCode;
        const lineName = lineRelation.lineName;
        const osmLineRoutes = routesByLineCode[lineCode] || [];

        // Collect all polyline segments from all OSM route relations for this line
        const linePolylines = [];

        // Deduplicate segments: OSM has forward/backward route relations
        // We want unique geometry, so we take segments from the first route that has them,
        // or merge if they have different geometry
        const seenSegments = new Set();

        for (const route of osmLineRoutes) {
            for (const segment of route.segments) {
                // Create a simple hash of the segment for deduplication
                const hash = segment.map(p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join('|');
                if (!seenSegments.has(hash)) {
                    seenSegments.add(hash);
                    linePolylines.push(polyline.encode(segment));
                }
            }
        }

        const isLrt = !!lrtLineMap[lineCode];

        lines.push({
            name: lineName,
            lineColor: officialLineColors[lineCode] || '#888888',
            code: lineCode,
            type: isLrt ? 'lrt' : 'mrt',
            stations: lineRelation.stations,
            polyline: linePolylines,
        });
    }

    return lines;
}


// ─── LTA Data Lookup ─────────────────────────────────────────────────────────

/**
 * Finds LTA station data (exit landmarks + first/last train) matching the given codes.
 */
function findLTAData(ltaData, stationCodes) {
    const sortedCodes = [...stationCodes].sort();
    const result = {
        trainFirstLastData: [],
        exits: []
    };

    for (const entry of ltaData) {
        const ltaCodes = entry.id.split('-').sort();
        if (sortedCodes.join('-') === ltaCodes.join('-') || stationCodes.some(c => c === entry.id)) {
            result.trainFirstLastData = entry.directions || [];
            result.exits = entry.exits || [];
            break;
        }
    }

    return result;
}


module.exports = {
    parseMRTData
};