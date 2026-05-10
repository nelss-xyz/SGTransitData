require('dotenv').config()
const fs = require("fs")
const path = require("path")
const AdmZip = require("adm-zip")
const readline = require("readline")

LTACrowdLevelAPIURL = "https://datamall2.mytransport.sg/ltaodataservice/PV/ODBus"

function createBusPredictedCrowdLevelData() {
    Promise.all([
        parseLTATripData(),
        getBusServicesData(),
        getBusStopData()
    ]).then(() => {
        generateCrowdIndexData()
    }).catch(err => {
        console.error("Error downloading data:", err)
    })
}

function parseLTATripData() {
    console.log("Downloading Ridership data...")
    return fetch(LTACrowdLevelAPIURL, {
        headers: {
            "AccountKey": process.env.LTA_ACCOUNT_KEY
        }
    })
        .then(response => response.json())
        .then(downloadParameters => {
            if (downloadParameters.fault) {
                console.log(downloadParameters.fault.faultstring)
            } else {
                return downloadLTARidershipData(downloadParameters.value)
            }
        })
}

function downloadLTARidershipData(downloadParameters) {
    return fetch(downloadParameters[0].Link)
        .then(response => response.arrayBuffer())
        .then(ridershipZipBuffer => {
            return new Promise((resolve, reject) => {
                const filePath = "./Data/Raw/bus/ridership.csv"
                const directory = path.dirname(filePath)

                if (!fs.existsSync(directory)) {
                    fs.mkdirSync(directory, { recursive: true })
                }

                try {
                    const zip = new AdmZip(Buffer.from(ridershipZipBuffer))
                    const zipEntries = zip.getEntries()
                    const csvEntry = zipEntries.find(entry => entry.entryName.toLowerCase().endsWith('.csv'))

                    if (!csvEntry) {
                        console.error("No CSV file found in the ZIP archive.")
                        reject("No CSV found")
                        return
                    }

                    const csvData = csvEntry.getData()
                    fs.writeFile(filePath, csvData, (err) => {
                        if (err) {
                            console.error("Error saving ridership data:", err)
                            reject(err)
                            return
                        }
                        console.log("Ridership CSV extracted and saved successfully!")
                        resolve()
                    })
                } catch (error) {
                    console.error("Error processing ZIP file:", error)
                    reject(error)
                }
            })
        })
}

function getBusServicesData() {
    console.log("Downloading Bus Service data...")
    return fetch("https://cdn.jsdelivr.net/gh/cheeaun/sgbusdata/data/v1/services.json")
        .then(response => response.json())
        .then(busServices => {
            return new Promise((resolve, reject) => {
                fs.writeFile("./Data/Raw/bus/services.json", JSON.stringify(busServices), (err) => {
                    if (err) {
                        console.error("Error saving bus services data:", err)
                        reject(err)
                        return
                    }
                    console.log("Bus services data saved successfully!")
                    resolve()
                })
            })
        })
}

function getBusStopData() {
    console.log("Downloading Bus Stop data...")
    return fetch("https://sgbus-web.vercel.app/api/data/stops")
        .then(response => response.json())
        .then(busStop => {
            return new Promise((resolve, reject) => {
                fs.writeFile("./Data/Raw/bus/stops.json", JSON.stringify(busStop), (err) => {
                    if (err) {
                        console.error("Error saving bus stops data:", err)
                        reject(err)
                        return
                    }
                    console.log("Bus stops data saved successfully!")
                    resolve()
                })
            })
        })
}

function generateCrowdIndexData() {
    console.log("Generating crowd index data...")
    const services = JSON.parse(fs.readFileSync('./Data/Raw/bus/services.json', 'utf8'))

    const odMap = new Map()
    for (const [serviceNo, serviceData] of Object.entries(services)) {
        serviceData.routes.forEach((route, dirIndex) => {
            for (let i = 0; i < route.length; i++) {
                for (let j = i + 1; j < route.length; j++) {
                    const key = `${route[i]}_${route[j]}`
                    let list = odMap.get(key)
                    if (!list) {
                        list = []
                        odMap.set(key, list)
                    }
                    list.push({ serviceNo, dirIndex, originIndex: i, destIndex: j })
                }
            }
        })
    }

    const crowdData = {}
    for (const [serviceNo, serviceData] of Object.entries(services)) {
        crowdData[serviceNo] = []
        serviceData.routes.forEach((route, dirIndex) => {
            crowdData[serviceNo][dirIndex] = {
                "WEEKDAY": {},
                "WEEKENDS/HOLIDAY": {}
            }
        })
    }

    const fileStream = fs.createReadStream('./Data/Raw/bus/ridership.csv')
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

    let isHeader = true
    rl.on('line', (line) => {
        if (isHeader) {
            isHeader = false
            return
        }

        const parts = line.split(',')
        if (parts.length < 7 || parts[3] !== "BUS") return

        const dayType = parts[1]
        const timeHour = parts[2]
        const origin = parts[4]
        const dest = parts[5]
        const tripsStr = parts[6]
        const trips = parseInt(tripsStr, 10)

        if (isNaN(trips) || trips === 0) return

        const key = `${origin}_${dest}`
        const list = odMap.get(key)

        if (list && list.length > 0) {
            const distributedTrips = trips / list.length
            list.forEach(svc => {
                const { serviceNo, dirIndex, originIndex, destIndex } = svc

                const dayTypeData = crowdData[serviceNo][dirIndex][dayType]
                if (!dayTypeData) return

                if (!dayTypeData[timeHour]) {
                    dayTypeData[timeHour] = new Float64Array(services[serviceNo].routes[dirIndex].length)
                }

                dayTypeData[timeHour][originIndex] += distributedTrips
                dayTypeData[timeHour][destIndex] -= distributedTrips
            })
        }
    })

    rl.on('close', () => {
        // Output structure: stopId -> serviceNo -> dayType -> hour -> { "Crowd Level": rawNumber, "Crowd Index": 0|1|2 }
        // Crowd Index: 0 = relatively empty, 1 = somewhat crowded, 2 = crowded
        // Thresholds are computed per service+direction+dayType using 33rd/67th percentiles
        // of all non-zero hourly crowd levels observed on that service, giving relative context.

        // Step 1: Compute raw crowd levels per service/dir/dayType/stop/hour
        const rawData = {} // serviceNo -> dirIndex -> dayType -> stopId -> hour -> crowdLevel

        for (const [serviceNo, dirs] of Object.entries(crowdData)) {
            rawData[serviceNo] = []
            dirs.forEach((dayTypes, dirIndex) => {
                rawData[serviceNo][dirIndex] = {}
                const route = services[serviceNo].routes[dirIndex]

                for (const [dayType, hours] of Object.entries(dayTypes)) {
                    rawData[serviceNo][dirIndex][dayType] = {}

                    for (const [hour, diffArray] of Object.entries(hours)) {
                        let currentCrowd = 0
                        for (let i = 0; i < diffArray.length; i++) {
                            currentCrowd += diffArray[i]
                            const crowdLevel = Math.max(0, Math.round(currentCrowd))
                            const stopId = route[i]

                            if (!rawData[serviceNo][dirIndex][dayType][stopId]) {
                                rawData[serviceNo][dirIndex][dayType][stopId] = {}
                            }
                            rawData[serviceNo][dirIndex][dayType][stopId][hour] = crowdLevel
                        }
                    }
                }
            })
        }

        // Step 2: Compute a single global threshold (p33 and p67) from all non-zero crowd
        // levels across every service, direction, stop, and hour. This ensures the Crowd Index
        // represents the same absolute passenger load regardless of which route is being viewed.
        const globalValues = []
        for (const dirs of Object.values(rawData)) {
            for (const dayTypes of Object.values(dirs)) {
                for (const stopMap of Object.values(dayTypes)) {
                    for (const hourMap of Object.values(stopMap)) {
                        for (const val of Object.values(hourMap)) {
                            if (val > 0) globalValues.push(val)
                        }
                    }
                }
            }
        }

        globalValues.sort((a, b) => a - b)
        const globalLow  = globalValues.length > 0 ? globalValues[Math.floor(globalValues.length * 0.33)] : 0
        const globalHigh = globalValues.length > 0 ? globalValues[Math.floor(globalValues.length * 0.67)] : 0
        console.log(`Global crowd thresholds — p33: ${globalLow}, p67: ${globalHigh}`)

        // Double-decker buses have ~1.5x the passenger capacity of single-deckers.
        // Scaling the thresholds up by this ratio means the same crowd level
        // maps to a lower index on a double-decker (it has more room to absorb riders).
        const DD_CAPACITY_RATIO = 1.5
        const ddLow  = Math.round(globalLow  * DD_CAPACITY_RATIO)
        const ddHigh = Math.round(globalHigh * DD_CAPACITY_RATIO)
        console.log(`Double-decker crowd thresholds — p33: ${ddLow}, p67: ${ddHigh}`)

        // Step 3: Build final output with Crowd Level + Crowd Index + Crowd Index (DD)
        const finalOutput = {}

        for (const [serviceNo, dirs] of Object.entries(rawData)) {
            dirs.forEach((dayTypes, dirIndex) => {
                for (const [dayType, stopMap] of Object.entries(dayTypes)) {
                    for (const [stopId, hourMap] of Object.entries(stopMap)) {
                        if (!finalOutput[stopId]) finalOutput[stopId] = {}
                        if (!finalOutput[stopId][serviceNo]) finalOutput[stopId][serviceNo] = {}
                        if (!finalOutput[stopId][serviceNo][dayType]) finalOutput[stopId][serviceNo][dayType] = {}

                        for (const [hour, crowdLevel] of Object.entries(hourMap)) {
                            let crowdIndex
                            if (crowdLevel === 0) {
                                crowdIndex = 0
                            } else if (crowdLevel <= globalLow) {
                                crowdIndex = 0
                            } else if (crowdLevel <= globalHigh) {
                                crowdIndex = 1
                            } else {
                                crowdIndex = 2
                            }

                            let crowdIndexDD
                            if (crowdLevel === 0) {
                                crowdIndexDD = 0
                            } else if (crowdLevel <= ddLow) {
                                crowdIndexDD = 0
                            } else if (crowdLevel <= ddHigh) {
                                crowdIndexDD = 1
                            } else {
                                crowdIndexDD = 2
                            }

                            finalOutput[stopId][serviceNo][dayType][hour] = {
                                "Crowd Level": crowdLevel,
                                "Crowd Index": crowdIndex,
                                "Crowd Index (DD)": crowdIndexDD
                            }
                        }
                    }
                }
            })
        }

        fs.writeFile('./Data/Output/bus/Crowd Levels/allStopsCrowdLevel.json', JSON.stringify(finalOutput), (err) => {
            if (err) {
                console.error("Error saving crowd levels data:", err)
            } else {
                console.log("Bus crowd levels data generated and saved successfully!")
            }
        })

        for (const [stopId, data] of Object.entries(finalOutput)) {
            fs.writeFile(`./Data/Output/bus/Crowd Levels/byStop/${stopId}.json`, JSON.stringify(data), (err) => {
                if (err) {
                    console.error(`Error saving crowd levels data for stop ${stopId}:`, err)
                } else {
                    console.log(`Bus crowd levels for ${stopId} data generated and saved successfully!`)
                }
            })
        }
    })
}


module.exports = { createBusPredictedCrowdLevelData }