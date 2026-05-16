const cheerio = require('cheerio');
const fs = require('fs/promises');

const BASE_URL = 'https://www.lta.gov.sg';
const INDEX_URL = `${BASE_URL}/map/mrt/index.xml`;
const OUTPUT_FILE = './Data/Raw/mrt/lta_mrt_data.json';
const DELAY_MS = 25;

// Helper function for rate limiting
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getMasterStationList() {
    console.log(`Fetching master station list from ${INDEX_URL}...`);
    try {
        const response = await fetch(INDEX_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Use .text() instead of .data when working with native fetch
        const textData = await response.text();
        const $ = cheerio.load(textData, { xmlMode: true });
        const stations = [];

        $('station').each((i, el) => {
            const node = $(el);
            stations.push({
                id: node.attr('id'),
                name: node.attr('name'),
                line: node.find('line').text(),
                fileUrl: `${BASE_URL}/map/${node.find('file').text()}`
            });
            // Intentionally omitting <coordinates>
        });

        console.log(`Found ${stations.length} stations in index.`);
        return stations;
    } catch (error) {
        console.error('Failed to fetch index.xml:', error.message);
        process.exit(1);
    }
}

async function getStationDetails(station) {
    try {
        const response = await fetch(station.fileUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const textData = await response.text();
        const $ = cheerio.load(textData);

        const details = {
            id: station.id,
            name: station.name,
            line: station.line,
            directions: [],
            exits: []
        };

        // 1. Extract Train Timings & Directions
        const directions = [];
        $('.direction-picker label').each((i, el) => {
            directions.push($(el).text().trim());
        });

        directions.forEach((dirName, index) => {
            const tabSelector = `.tab${index + 1}`;
            const $tab = $(tabSelector);

            if ($tab.length === 0) return;

            const dirData = {
                towards: dirName,
                firstTrain: [],
                lastTrain: []
            };

            // Parse First Train table
            $tab.find('.first-train tbody tr').each((i, el) => {
                const day = $(el).find('td').eq(0).text().trim();
                const time = $(el).find('td').eq(1).text().trim();
                if (day && time) dirData.firstTrain.push({ day, time });
            });

            // Parse Last Train table
            $tab.find('.last-train tbody tr').each((i, el) => {
                const day = $(el).find('td').eq(0).text().trim();
                const time = $(el).find('td').eq(1).text().trim();
                if (day && time) dirData.lastTrain.push({ day, time });
            });

            details.directions.push(dirData);
        });

        // 2. Extract Exit Information
        $('h5').filter((i, el) => $(el).text().trim() === 'Exit Information')
            .next('table')
            .find('tbody tr')
            .each((i, el) => {
                const exitName = $(el).find('td').eq(0).text().trim();

                const landmarksHtml = $(el).find('td').eq(1).html() || '';
                const landmarks = landmarksHtml
                    .replace(/<br\s*\/?>/gi, '\n')
                    .split('\n')
                    .map(str => cheerio.load('<span>' + str + '</span>').text().trim())
                    .filter(str => str.length > 0 && str !== 'No place of interest');

                details.exits.push({ exit: exitName, landmarks });
            });

        return details;
    } catch (error) {
        console.error(`\n[!] Error fetching details for ${station.name} (${station.id}): ${error.message}`);
        return null;
    }
}

async function retrieveLTAMRTData() {
    const stations = await getMasterStationList();
    const allData = [];

    console.log(`Starting data extraction. A ${DELAY_MS}ms delay is applied between requests to respect the server.`);

    for (let i = 0; i < stations.length; i++) {
        const station = stations[i];
        process.stdout.write(`Scraping [${i + 1}/${stations.length}]: ${station.name} (${station.id})... `);

        const details = await getStationDetails(station);
        if (details) {
            allData.push(details);
            console.log('Done.');
        }

        // Rate limiting
        if (i < stations.length - 1) {
            await sleep(DELAY_MS);
        }
    }

    // Write to JSON
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(allData, null, 2), 'utf-8');
    console.log(`\nExtraction complete! Data saved to ${OUTPUT_FILE}`);
}

module.exports = {
    retrieveLTAMRTData
}