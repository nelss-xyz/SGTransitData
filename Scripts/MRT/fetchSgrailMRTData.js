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
                if (feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
                    boundaries[name] = feature.geometry.coordinates;
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
