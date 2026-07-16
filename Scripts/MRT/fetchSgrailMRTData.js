const fs = require('fs/promises');

const SGRAILDATA_URL = 'https://raw.githubusercontent.com/cheeaun/sgraildata/master/data/raw/master-plan-2019-rail-station-layer-geojson.geojson';
const OUTPUT_FILE = './Data/Raw/mrt/sgraildata_mrt_data.json';

async function fetchSgrailMRTData() {
    console.log(`[Sgraildata] Fetching Master Plan 2019 station boundaries...`);
    try {
        const response = await fetch(SGRAILDATA_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const boundaries = {};
        
        for (const feature of data.features) {
            if (feature.properties && feature.properties.NAME) {
                const name = feature.properties.NAME.toLowerCase();
                let polygons = [];
                if (feature.geometry && feature.geometry.type === 'Polygon') {
                    polygons = [feature.geometry.coordinates];
                } else if (feature.geometry && feature.geometry.type === 'MultiPolygon') {
                    polygons = feature.geometry.coordinates;
                }

                if (polygons.length > 0) {
                    boundaries[name] = [];
                    for (const poly of polygons) {
                        // Extract exterior ring (first element) and flip to [lat, lon]
                        const extRing = poly[0].map(coord => [coord[1], coord[0]]);
                        boundaries[name].push(extRing);
                    }
                }
            }
        }

        await fs.writeFile(OUTPUT_FILE, JSON.stringify(boundaries, null, 2), 'utf-8');
        console.log(`[Sgraildata] Successfully cached boundaries for ${Object.keys(boundaries).length} stations.`);
    } catch (error) {
        console.error('[Sgraildata] Error fetching data:', error.message);
    }
}

module.exports = {
    fetchSgrailMRTData
};

if (require.main === module) {
    fetchSgrailMRTData();
}
