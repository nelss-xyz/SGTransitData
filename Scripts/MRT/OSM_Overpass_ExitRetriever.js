require('dotenv').config();

async function getMRTExits(stationCode) {
    console.log("Fetching exits for " + stationCode + "...");

    if (!stationCode) {
        throw new Error("No station code provided.");
    }

    if (!process.env.CONTACT_EMAIL) {
        throw new Error("No CONTACT_EMAIL found in .env");
    }

    const overpassUrl = 'https://overpass-api.de/api/interpreter';

    // Overpass QL Query logic:
    // 1. Match the station code using regex to handle interchange stations (e.g., "NE1;CC29")
    // 2. Find parent relations (the stop_area group)
    // 3. Extract the nodes within that relation tagged as subway entrances
    const query = `
    [out:json][timeout:25];

    area["ISO3166-1"="SG"]["admin_level"="2"]->.searchArea;
    nwr(area.searchArea)["railway"="station"]["ref"~"(^|;)${stationCode}(;|$)"]->.station;
    
    (
      rel(bn.station)["type"="public_transport"];
      rel(bw.station)["type"="public_transport"];
    )->.station_relations;
    
    node(r.station_relations)["railway"="subway_entrance"];
    out body;
  `;

    try {
        // Make the POST request to Overpass API
        const response = await fetch(overpassUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'User-Agent': `SGTransitDataScript ${process.env.CONTACT_EMAIL}`
            },
            body: `data=${encodeURIComponent(query)}`
        });

        if (!response.ok) {
            throw new Error(`Overpass API error! Status: ${response.status}`);
        }

        const data = await response.json();

        const exits = data.elements.map(element => {
            return {
                exitName: element.tags.ref || element.tags.name || 'Unlabeled',
                latitude: element.lat,
                longitude: element.lon
            };
        });



        console.log(`Found ${exits.length} exits:`);

        return exits.sort((a, b) =>
            a.exitName.localeCompare(b.exitName, undefined, { numeric: true })
        );

    } catch (error) {
        console.error(`Failed to fetch exits for ${stationCode}:`, error);
        return [];
    }
}
module.exports = { getMRTExits };