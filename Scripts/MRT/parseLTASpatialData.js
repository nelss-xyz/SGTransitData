const fs = require('fs');
const xlsx = require('xlsx');
const shapefile = require('shapefile');
const proj4 = require('proj4');
const https = require('https');
const AdmZip = require('adm-zip');
const path = require('path');

const RAW_DIR = './Data/Raw/LTA';
const OUTPUT_FILE = './Data/Raw/mrt/lta_spatial_data.json';

const LTA_URLS = {
    boundaries: 'https://datamall.lta.gov.sg/content/dam/datamall/datasets/Geospatial/TrainStation_Mar2026.zip',
    exits: 'https://datamall.lta.gov.sg/content/dam/datamall/datasets/Geospatial/TrainStationExit.zip',
    codes: 'https://datamall.lta.gov.sg/content/dam/datamall/datasets/Geospatial/Train%20Station%20Codes%20and%20Chinese%20Names.zip'
};

async function downloadAndExtract(url, destFolder) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
            }
            const data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(data);
                const zip = new AdmZip(buffer);
                zip.extractAllTo(destFolder, true);
                resolve();
            });
        }).on('error', reject);
    });
}

function findFileExt(dir, ext) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            const found = findFileExt(fullPath, ext);
            if (found) return found;
        } else if (file.name.endsWith(ext)) {
            return fullPath;
        }
    }
    return null;
}

function cleanStationName(name) {
    if (!name) return '';
    return name.replace(/\s+(MRT|LRT)\s+STATION$/i, '')
               .replace(/\s+STATION$/i, '')
               .trim();
}

// Convert SVY21 (EPSG:3414) to WGS84 (EPSG:4326)
// Since the geometry from LTA shapefiles might be in SVY21 format, let's check if we need to project it.
// Actually, shapefile.read() reads the raw coordinates. We need to check if the coordinates are already lat/lon or SVY21 meters.
// Let's assume we might need to convert. 
// Wait, looking at the inspect output from earlier:
// The SHAPE_AREA is ~1054, SHAPE_LEN is ~170. This implies SVY21 (meters).
// But let's check coordinate values directly. We can use a simple SVY21 to WGS84 converter.

// SVY21 Projection Definition
proj4.defs('EPSG:3414', '+proj=tmerc +lat_0=1.366666666666667 +lon_0=103.8333333333333 +k=1 +x_0=28001.642 +y_0=38744.572 +ellps=WGS84 +units=m +no_defs');

function convertCoordinates(coords) {
    // Check if coords are already lat/lon
    if (coords[0] >= 103 && coords[0] <= 104) {
        return [coords[1], coords[0]]; // Return [lat, lon]
    }
    // Convert from SVY21 [Easting, Northing] to WGS84 [lon, lat]
    const wgs = proj4('EPSG:3414', 'EPSG:4326', coords);
    return [wgs[1], wgs[0]]; // Return [lat, lon]
}

async function parseLTASpatialData() {
    console.log('[LTA] Fetching Datasets...');
    fs.mkdirSync(path.join(RAW_DIR, 'Boundaries'), { recursive: true });
    fs.mkdirSync(path.join(RAW_DIR, 'Exits'), { recursive: true });
    fs.mkdirSync(path.join(RAW_DIR, 'Codes'), { recursive: true });

    await Promise.all([
        downloadAndExtract(LTA_URLS.boundaries, path.join(RAW_DIR, 'Boundaries')),
        downloadAndExtract(LTA_URLS.exits, path.join(RAW_DIR, 'Exits')),
        downloadAndExtract(LTA_URLS.codes, path.join(RAW_DIR, 'Codes'))
    ]);

    const CODES_FILE = findFileExt(path.join(RAW_DIR, 'Codes'), '.xls') || findFileExt(path.join(RAW_DIR, 'Codes'), '.xlsx');
    const BOUNDARIES_FILE = findFileExt(path.join(RAW_DIR, 'Boundaries'), '.shp');
    const EXITS_FILE = findFileExt(path.join(RAW_DIR, 'Exits'), '.shp');

    if (!CODES_FILE || !BOUNDARIES_FILE || !EXITS_FILE) {
        throw new Error('Failed to locate one or more required dataset files after extraction.');
    }

    console.log(`[LTA] Parsing Excel Codes (${CODES_FILE})...`);
    const workbook = xlsx.readFile(CODES_FILE);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const excelData = xlsx.utils.sheet_to_json(sheet);

    const stationsByName = {};

    for (const row of excelData) {
        const nameEn = row.mrt_station_english.trim();
        if (!stationsByName[nameEn]) {
            stationsByName[nameEn] = {
                nameEn: nameEn,
                nameZh: row.mrt_station_chinese ? row.mrt_station_chinese.trim() : '',
                codes: [],
                lines: [],
                boundaries: [],
                exits: []
            };
        }
        
        let code = row.stn_code.trim();
        let lineEn = row.mrt_line_english ? row.mrt_line_english.trim() : '';
        let lineZh = row.mrt_line_chinese ? row.mrt_line_chinese.trim() : '';

        // Normalize Circle Line Extension branch codes to Circle Line CC codes
        if (code === 'CE1') {
            code = 'CC34';
            lineEn = 'Circle Line';
            lineZh = '环线';
        } else if (code === 'CE2') {
            code = 'CC33';
            lineEn = 'Circle Line';
            lineZh = '环线';
        }

        if (!stationsByName[nameEn].codes.includes(code)) {
            stationsByName[nameEn].codes.push(code);
        }
        if (!stationsByName[nameEn].lines.some(l => l.code === code)) {
            stationsByName[nameEn].lines.push({
                code: code,
                lineEn: lineEn,
                lineZh: lineZh
            });
        }
    }

    console.log('[LTA] Parsing Boundaries Shapefile...');
    const boundariesGeo = await shapefile.read(BOUNDARIES_FILE);
    for (const feature of boundariesGeo.features) {
        const nameRaw = feature.properties.STN_NAM_DE || feature.properties.STN_NAM;
        if (!nameRaw) continue;
        
        const cleanName = cleanStationName(nameRaw);
        
        // Find matching station (case-insensitive)
        const matchKey = Object.keys(stationsByName).find(k => k.toLowerCase() === cleanName.toLowerCase());
        
        if (matchKey) {
            let polygons = [];
            if (feature.geometry.type === 'Polygon') {
                polygons = [feature.geometry.coordinates];
            } else if (feature.geometry.type === 'MultiPolygon') {
                polygons = feature.geometry.coordinates;
            }
            
            for (const poly of polygons) {
                // A polygon is an array of linear rings. The first is exterior.
                const extRing = poly[0].map(convertCoordinates);
                stationsByName[matchKey].boundaries.push(extRing);
            }
        }
    }

    console.log('[LTA] Parsing Exits Shapefile...');
    const exitsGeo = await shapefile.read(EXITS_FILE);
    for (const feature of exitsGeo.features) {
        const nameRaw = feature.properties.stn_name;
        const exitCode = feature.properties.exit_code;
        if (!nameRaw || !exitCode) continue;

        const cleanName = cleanStationName(nameRaw);
        const matchKey = Object.keys(stationsByName).find(k => k.toLowerCase() === cleanName.toLowerCase());

        if (matchKey && feature.geometry.type === 'Point') {
            let finalExitCode = exitCode;
            // Prefix LRT exits if they belong to an LRT station to avoid collisions with MRT exits
            if (/LRT/i.test(nameRaw) && !/^LRT\s/i.test(finalExitCode)) {
                finalExitCode = `LRT ${finalExitCode}`;
            }

            const existingExit = stationsByName[matchKey].exits.find(e => e.exitCode.toLowerCase() === finalExitCode.toLowerCase());
            
            // Deduplicate: If an exit with this exact name already exists, skip it (take the first one)
            if (!existingExit) {
                const coords = convertCoordinates(feature.geometry.coordinates);
                stationsByName[matchKey].exits.push({
                    exitCode: finalExitCode,
                    coordinates: coords
                });
            } else {
                stationsByName[matchKey].hasDuplicateExits = true;
            }
        }
    }

    const outputStations = Object.values(stationsByName);

    // Compute a centroid for each station to use as its main latitude/longitude
    for (const stn of outputStations) {
        if (stn.boundaries.length > 0) {
            let latSum = 0, lonSum = 0, count = 0;
            for (const pt of stn.boundaries[0]) { // use first boundary
                latSum += pt[0];
                lonSum += pt[1];
                count++;
            }
            stn.latitude = latSum / count;
            stn.longitude = lonSum / count;
        } else if (stn.exits.length > 0) {
            let latSum = 0, lonSum = 0;
            for (const exit of stn.exits) {
                latSum += exit.coordinates[0];
                lonSum += exit.coordinates[1];
            }
            stn.latitude = latSum / stn.exits.length;
            stn.longitude = lonSum / stn.exits.length;
        }
    }

    const outputData = {
        stations: outputStations,
        fetchedAt: new Date().toISOString()
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    console.log(`[LTA] Saved spatial data to ${OUTPUT_FILE}`);
}

if (require.main === module) {
    parseLTASpatialData().catch(console.error);
}

module.exports = { parseLTASpatialData };
