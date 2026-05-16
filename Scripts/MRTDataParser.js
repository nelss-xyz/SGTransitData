const axios = require('axios')
const fs = require("fs");
const { downloadMRTData } = require('./fetchMRT-railData');
const { retrieveLTAMRTData } = require('./fetchLTAMRTData');
var polyline = require('@mapbox/polyline');
const { formStationLineRelations } = require('./MRT/getLine-StationRelationsLTA');
require('dotenv').config();



let RawMRTData;
let LTAMRTData;
let stationLineRelationsDat;

const testingMode = process.env.TESTING_MODE;

(async () => {
    if (!testingMode) {
        await downloadMRTData()
        await retrieveLTAMRTData()
        await formStationLineRelations()
        await parseMRTData()
    }
    else {
        await parseMRTData()
    }
})()

async function parseMRTData() {
    RawMRTData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/mrt.json", "utf8"));
    LTAMRTData = JSON.parse(fs.readFileSync("./Data/Raw/mrt/lta_mrt_data.json", "utf8"));
    stationLineRelationsDat = JSON.parse(fs.readFileSync("./Data/Raw/mrt/mrt_lines_station_relation_data.json", "utf8"));

    const features = RawMRTData.features;
    const LTAData = LTAMRTData;
    const stations = [];
    const lines = [];

    for (const feature of features) {
        const relavantExits = []
        let relavantBoundary;
        let relavantBoundaries = [];
        let relevantLTAData = {
            exitLandmarkData: [],
            trainFirstLastData: [],
        };

        if (feature.properties.stop_type === "station") {
            for (const a of features) {
                if (a.properties.stop_type === "entrance" && a.properties.station_codes === feature.properties.station_codes) {
                    const exitData = {
                        exitName: a.properties.name,
                        coordinates: [
                            a.geometry.coordinates[1],
                            a.geometry.coordinates[0]
                        ]
                    }
                    relavantExits.push(exitData)
                }
                if (a.geometry.type == "Polygon" && a.properties.station_codes === feature.properties.station_codes) {
                    relavantBoundaries.push(polyline.encode(a.geometry.coordinates[0].map((coords) => [coords[1], coords[0]])));
                }
                if (a.geometry.type == "MultiPolygon" && a.properties.station_codes === feature.properties.station_codes) {
                    a.geometry.coordinates.forEach((element) => {
                        relavantBoundaries.push(polyline.encode(element[0].map((coords) => [coords[1], coords[0]])));
                    })
                }
            }


            const stationCodes = feature.properties.station_codes.split("-").sort();
            for (const b of LTAData) {
                const ltaCodes = b.id.split("-").sort();
                if (stationCodes.join("-") === ltaCodes.join("-") || stationCodes.includes(b.id)) {
                    relevantLTAData.trainFirstLastData = b.directions;
                    const updatedExitData = [];
                    for (const exit of b.exits) {
                        for (const e of relavantExits) {
                            if (e.exitName == exit.exit) {
                                updatedExitData.push({
                                    "exitName": e.exitName,
                                    "coordinates": e.coordinates,
                                    "landmarks": exit.landmarks,
                                });
                            }
                        }
                    }
                    relevantLTAData.exitLandmarkData = updatedExitData;
                    break;
                }
            }

            const station = {
                "name": feature.properties.name,
                "name-chinese": feature.properties["name_zh-Hans"],
                "name-tamil": feature.properties.name_ta,
                "codes": feature.properties.station_codes.split("-"),
                "latitude": feature.geometry.coordinates[1],
                "longitude": feature.geometry.coordinates[0],
                "trainFirstLastData": relevantLTAData.trainFirstLastData,
                "exits": relevantLTAData.exitLandmarkData.length > 0 ? relevantLTAData.exitLandmarkData : relavantExits,
                "boundaries": relavantBoundaries,
            }
            stations.push(station);
        }

        if (feature.properties.line_color) {
            let stationsOnLine = [];
            let linePolylines = [];

            for (const line of stationLineRelationsDat) {
                if (line.lineName.replace("-", " ") == feature.properties.name.replace("-", " ")) {
                    stationsOnLine = line.stations
                }
            }

            if (feature.geometry.type == "LineString") {
                linePolylines.push(polyline.encode(feature.geometry.coordinates.map((coords) => [coords[1], coords[0]])))
            }

            if (feature.geometry.type == "MultiLineString") {
                feature.geometry.coordinates.forEach((line) => {
                    linePolylines.push(polyline.encode(line.map((coords) => [coords[1], coords[0]])))
                })
            }

            const line = {
                "name": feature.properties.name,
                "lineColor": feature.properties.line_color,
                "type": feature.geometry.network == "singapore-lrt" ? "lrt" : "mrt",
                "stations": stationsOnLine,
                "polyline": linePolylines
            }

            lines.push(line);
        }

    }


    const mrtData = {
        stations, lines
    }

    fs.writeFile('./Data/Output/mrt/mrtData.json', JSON.stringify(mrtData), (err) => {
        if (err) {
            console.error("Error saving MRT data:", err)
        } else {
            console.log("MRT data generated and saved successfully!")
        }
    })
}

module.exports = {
    parseMRTData
}