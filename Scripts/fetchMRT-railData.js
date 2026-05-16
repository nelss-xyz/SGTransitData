const fs = require("fs");
const { getMRTExits } = require('./MRT/OSM_Overpass_ExitRetriever');

const MRTDataURL = "https://cdn.jsdelivr.net/gh/cheeaun/sgraildata@master/data/v1/sg-rail.geojson";

async function downloadMRTData() {
    console.log(`Fetching MRT data from ${MRTDataURL}...`);
    try {
        const response = await fetch(MRTDataURL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const mrtData = await response.json();

        // Inject missing exit data from OSM into the GeoJSON before saving
        const features = mrtData.features;
        for (const feature of features) {
            if (feature.properties.stop_type !== "station") continue;

            const stationCodes = feature.properties.station_codes;
            const hasExits = features.some(
                (f) => f.properties.stop_type === "entrance" && f.properties.station_codes === stationCodes
            );

            if (!hasExits) {
                const firstCode = stationCodes.split("-")[0];
                console.log("Missing exit data for " + firstCode + ". Fetching from OSM...");
                const osmExits = await getMRTExits(firstCode);
                for (const exit of osmExits) {
                    mrtData.features.push({
                        type: "Feature",
                        properties: {
                            stop_type: "entrance",
                            station_codes: stationCodes,
                            name: exit.exitName,
                        },
                        geometry: {
                            type: "Point",
                            coordinates: [exit.longitude, exit.latitude],
                        },
                    });
                }
            }
        }

        fs.writeFileSync("./Data/Raw/mrt/mrt.json", JSON.stringify(mrtData, null, 2));
        console.log("\n\n MRT data saved successfully to ./Data/Raw/mrt/mrt.json\n\n");
    } catch (error) {
        console.error("Error saving MRT data:", error);
        process.exit(1);
    }
}

module.exports = {
    downloadMRTData,
}

