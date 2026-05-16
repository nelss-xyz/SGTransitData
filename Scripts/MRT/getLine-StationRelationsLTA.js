const fs = require('fs');

const XML_URL = 'https://www.lta.gov.sg/map/mrt/index.xml';
const HTML_URL = 'https://www.lta.gov.sg/map/mrt/line_list.html';


function getParentLines(stationCode) {
    const prefix = stationCode.replace(/[0-9]/g, ''); // Strip numbers to get letters
    const mapping = {
        'EW': ['EWL'], 'CG': ['EWL'],                  // East-West Line + Changi Branch
        'NS': ['NSL'],                                 // North-South Line
        'NE': ['NEL'],                                 // North East Line
        'CC': ['CCL'], 'CE': ['CCL'],                  // Circle Line + Marina Bay Branch
        'DT': ['DTL'],                                 // Downtown Line
        'TE': ['TEL'],                                 // Thomson-East Coast Line
        'BP': ['BPL'],                                 // Bukit Panjang LRT
        'ST': ['SEL', 'SWL'],                          // Sengkang Town Centre -> belongs to both loops
        'SE': ['SEL'],                                 // Sengkang East Loop
        'SW': ['SWL'],                                 // Sengkang West Loop
        'PT': ['PEL', 'PWL'],                          // Punggol Town Centre -> belongs to both loops
        'PE': ['PEL'],                                 // Punggol East Loop
        'PW': ['PWL']                                  // Punggol West Loop
    };
    return mapping[prefix] || [];
}

async function formStationLineRelations() {
    try {
        console.log('Fetching live data from LTA servers...');

        const [xmlResponse, htmlResponse] = await Promise.all([
            fetch(XML_URL),
            fetch(HTML_URL)
        ]);

        if (!xmlResponse.ok || !htmlResponse.ok) {
            throw new Error(`Failed to fetch data. XML Status: ${xmlResponse.status}, HTML Status: ${htmlResponse.status}`);
        }

        let xmlContent = await xmlResponse.text();
        const htmlContent = await htmlResponse.text();

        console.log('Data fetched successfully. Parsing...');

        // EDGE CASE: Strip out commented future stations in the XML
        xmlContent = xmlContent.replace(`//g`, '');

        // 1. Extract the base Lines from the HTML snippet
        const linesMap = {};
        const lineRegex = /data-id="([A-Z]{3})"[^>]*>[\s\S]*?&nbsp;([^<\n\r]+)/g;
        let match;

        while ((match = lineRegex.exec(htmlContent)) !== null) {
            const lineCode = match[1];
            const lineName = match[2].trim();
            linesMap[lineCode] = {
                lineCode: lineCode,
                lineName: lineName,
                stations: []
            };
        }

        // 2. Custom LRT Split Logic
        // Remove the generic STL and PTL lines parsed from HTML
        delete linesMap['STL'];
        delete linesMap['PTL'];

        // Inject our new explicit East/West loops
        const customLRTs = {
            'SEL': 'Sengkang LRT (East Loop)',
            'SWL': 'Sengkang LRT (West Loop)',
            'PEL': 'Punggol LRT (East Loop)',
            'PWL': 'Punggol LRT (West Loop)'
        };

        for (const [code, name] of Object.entries(customLRTs)) {
            linesMap[code] = {
                lineCode: code,
                lineName: name,
                stations: []
            };
        }

        // 3. Extract Stations from XML
        const stationRegex = /<station id="([^"]+)" name="([^"]+)">\s*<code>([^<]+)<\/code>\s*<coordinates>([^<]*)<\/coordinates>/g;

        while ((match = stationRegex.exec(xmlContent)) !== null) {
            const rawName = match[2];
            const rawCode = match[3];
            const rawCoords = match[4].trim();

            // Split Interchange codes (e.g., "NS24-NE6-CC1" -> ["NS24", "NE6", "CC1"])
            const individualCodes = rawCode.split('-');

            individualCodes.forEach(code => {
                const parentLines = getParentLines(code);

                // Push the station to all assigned parent lines
                parentLines.forEach(parentLine => {
                    if (linesMap[parentLine]) {
                        linesMap[parentLine].stations.push({
                            code: code,
                            name: rawName,
                        });
                    }
                });
            });
        }

        // 4. Convert mapping to final JSON array and save
        const finalJSON = Object.values(linesMap);
        fs.writeFileSync('./Data/Raw/mrt/mrt_lines_station_relation_data.json', JSON.stringify(finalJSON, null, 2));

        console.log('✅ Successfully extracted data and saved to mrt_lines_data.json');

    } catch (error) {
        console.error('❌ An error occurred:', error.message);
    }
}

module.exports = {
    formStationLineRelations
}