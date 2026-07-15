const fs = require('fs/promises');

const CITYMAPPER_URL = 'https://citymapper.com/api/2/routeinfo?route_ids=SingaporeMRTCircleLine%2CSingaporeMRTDowntownLine%2CSingaporeMRTEastwestLine%2CSingaporeMRTNortheastLine%2CSingaporeMRTNorthsouthLine%2CCM_SingaporeMRT_tel%2CSingaporeLRTBukitPanjangLine%2CSingaporeLRTPunggolLineEastLoop%2CSingaporeLRTPunggolLineWestLoop%2CSingaporeLRTSengkangLineEastLoop%2CSingaporeLRTSengkangLineWestLoop&region_id=sg-singapore&weekend=1&status_format=rich';
const OUTPUT_FILE = './Data/Raw/mrt/citymapper_mrt_data.json';

async function fetchCitymapperMRTData() {
    console.log(`[Citymapper] Fetching data from Citymapper...`);
    try {
        const response = await fetch(CITYMAPPER_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        
        // Extract stops and structure them by name for easy lookup
        const stationCoords = {};
        if (data.stops) {
            for (const [id, stop] of Object.entries(data.stops)) {
                if (stop.name && stop.coords && stop.coords.length === 2) {
                    stationCoords[stop.name.toLowerCase()] = {
                        lat: stop.coords[0],
                        lon: stop.coords[1]
                    };
                }
            }
        }

        await fs.writeFile(OUTPUT_FILE, JSON.stringify(stationCoords, null, 2), 'utf-8');
        console.log(`[Citymapper] Successfully fetched and cached coordinates for ${Object.keys(stationCoords).length} stations.`);
    } catch (error) {
        console.error('[Citymapper] Error fetching data:', error.message);
    }
}

module.exports = {
    fetchCitymapperMRTData
};

if (require.main === module) {
    fetchCitymapperMRTData();
}
