const fs = require("fs");
const { fetchOSMMRTData } = require('./fetchOSMMRTData');
const { retrieveLTAMRTData } = require('./fetchLTAMRTData');
const { fetchOperatorMRTData } = require('./fetchOperatorMRTData');
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
        await fetchOperatorMRTData();
        await parseLTASpatialData();
        await formStationLineRelations();
        await parseMRTData();
    } else {
        await parseMRTData();
    }
})();


// ─── Main Parser ─────────────────────────────────────────────────────────────

/**
 * Calculate distance between two coordinates in meters.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (value) => (value * Math.PI) / 180;
    const R = 6371e3; // Earth radius in meters
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function parseMRTData() {
    console.log('\n[Parser] Loading data files...');

    const osmData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/osm_mrt_data.json", "utf8"));
    const ltaMrtData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/lta_mrt_data.json", "utf8"));
    let operatorMrtData = [];
    try {
        operatorMrtData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/operator_mrt_data.json", "utf8"));
    } catch(e) { console.warn("[Parser] operator_mrt_data.json not found, proceeding without it."); }
    const ltaSpatialData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/lta_spatial_data.json", "utf8"));
    const lineRelationsData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/mrt_lines_station_relation_data.json", "utf8"));

    const osmStations = osmData.stations;
    const osmEntrances = osmData.entrances || [];
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

        // Find Operator scraped data (SMRT/SBST) for train times, exits, and amenities
        const relevantOperatorData = findOperatorData(ltaMrtData, operatorMrtData, ltaStation.codes);

        // Map and merge exits
        const mergedExits = [];
        const scrapedExits = relevantOperatorData.exits || [];

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

        const stationLat = ltaStation.latitude || (osmMatch ? osmMatch.lat : 0);
        const stationLon = ltaStation.longitude || (osmMatch ? osmMatch.lon : 0);

        // Patch empty exits with OSM entrances
        for (const exit of mergedExits) {
            if (!exit.coordinates || exit.coordinates.length === 0) {
                const nearbyOsmEntrances = osmEntrances.filter(e => haversineDistance(e.lat, e.lon, stationLat, stationLon) < 400);
                const match = nearbyOsmEntrances.find(e => e.name.toLowerCase() === exit.exitName.toLowerCase() || `exit ${e.name}`.toLowerCase() === exit.exitName.toLowerCase());
                if (match) {
                    exit.coordinates = [match.lat, match.lon];
                }
            }
        }
        
        // If there are still no exits or we missed some from OSM, we can add all nearby OSM entrances that aren't already in mergedExits
        if (stationLat && stationLon) {
            const nearbyOsmEntrances = osmEntrances.filter(e => haversineDistance(e.lat, e.lon, stationLat, stationLon) < 400);
            for (const osmExit of nearbyOsmEntrances) {
                const exitName = osmExit.name.length <= 3 ? `Exit ${osmExit.name}` : osmExit.name;
                if (!mergedExits.some(e => e.exitName.toLowerCase() === exitName.toLowerCase())) {
                    mergedExits.push({
                        exitName: exitName,
                        coordinates: [osmExit.lat, osmExit.lon],
                        landmarks: []
                    });
                }
            }
        }

        // Clean, standardise, and filter exit names
        for (const e of mergedExits) {
            let name = e.exitName.trim();
            if (/^[A-Za-z0-9]{1,3}$/.test(name) || /^[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(name)) {
                name = "Exit " + name;
            }
            if (name.toLowerCase().startsWith('lrt exit ')) {
                name = name.substring(4).trim();
            }
            if (name.toLowerCase().startsWith('exit ')) {
                name = "Exit " + name.substring(5).trim();
            }
            e.exitName = name;
        }

        // Only keep exits that start with "Exit "
        const finalExits = mergedExits.filter(e => e.exitName.toLowerCase().startsWith('exit '));

        finalExits.sort((a, b) => a.exitName.localeCompare(b.exitName, undefined, { numeric: true }));

        // Encode boundaries
        const boundaries = ltaStation.boundaries.map(poly => polyline.encode(poly));

        const station = {
            name: ltaStation.nameEn,
            "name-chinese": ltaStation.nameZh,
            "name-tamil": nameTa,
            codes: ltaStation.codes.sort(),
            latitude: stationLat,
            longitude: stationLon,
            trainFirstLastData: relevantOperatorData.trainFirstLastData || [],
            exits: finalExits,
            amenities: relevantOperatorData.amenities || [],
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
 * Finds Operator station data (exits, landmarks, train times, amenities) matching the codes.
 * Falls back to LTA data if not found.
 */
function findOperatorData(ltaData, operatorData, stationCodes) {
    const sortedCodes = [...stationCodes].sort();
    const result = {
        trainFirstLastData: [],
        exits: [],
        amenities: []
    };

    let hasOperatorExits = false;

    // 1. Get Exits and Amenities from Operator Data
    for (const entry of operatorData) {
        const hasCodeMatch = stationCodes.some(c => entry.codes.includes(c));
        if (hasCodeMatch) {
            if (entry.exits && entry.exits.length > 0) {
                result.exits.push(...entry.exits);
                hasOperatorExits = true;
            }
            if (entry.amenities && entry.amenities.length > 0) {
                for (const am of entry.amenities) {
                    if (am.name.startsWith('ATM: ')) {
                        result.amenities.push({ name: am.name.substring(5), type: 'ATM' });
                    } else if (am.name.toLowerCase().startsWith('bicycle racks: ')) {
                        const val = am.name.split(':')[1].trim().toLowerCase();
                        if (val === 'yes' || val === 'true') {
                            result.amenities.push({ name: 'Bicycle Racks', type: 'Bicycle Racks' });
                        }
                    } else if (am.name.toLowerCase().startsWith('bicycle: ')) {
                        // Ignore
                    } else if (am.name.startsWith('TransitLink Ticket Office')) {
                        const match = am.name.match(/^TransitLink Ticket Office(?:\s*:\s*(.*))?$/i);
                        const desc = match && match[1] ? match[1].trim() : '';
                        const obj = { name: 'TransitLink Ticket Office', type: 'ticket_office' };
                        if (desc) obj.description = desc;
                        result.amenities.push(obj);
                    } else {
                        result.amenities.push(am);
                    }
                }
            }
        }
    }

    // Deduplicate exits from operator data
    const uniqueExitsMap = new Map();
    for (const exit of result.exits) {
        let normName = exit.exit.toLowerCase();
        if(normName.startsWith('exit ')) normName = normName.replace('exit ', '');
        
        if (!uniqueExitsMap.has(normName)) {
            uniqueExitsMap.set(normName, exit);
        } else {
            const existing = uniqueExitsMap.get(normName);
            existing.landmarks = [...new Set([...existing.landmarks, ...(exit.landmarks || [])])];
        }
    }
    result.exits = Array.from(uniqueExitsMap.values());

    // 2. Get Train Timings from LTA Data (and fallback for exits)
    for (const entry of ltaData) {
        const ltaCodes = entry.id.split('-').sort();
        if (sortedCodes.join('-') === ltaCodes.join('-') || stationCodes.some(c => c === entry.id)) {
            result.trainFirstLastData = entry.directions || [];
            if (!hasOperatorExits) result.exits = entry.exits || [];
            break;
        }
    }

    return result;
}


module.exports = {
    parseMRTData
};