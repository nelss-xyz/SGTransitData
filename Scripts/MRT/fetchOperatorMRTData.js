const cheerio = require('cheerio');
const fs = require('fs/promises');

const SMRT_API_URL = 'https://connect.smrt.wwprojects.com/smrt/api/station_info/?name=';
const SBST_INFO_URL = 'https://www.sbstransit.com.sg/Service/TrainInformation';
const SBST_TIMING_URL = 'https://www.sbstransit.com.sg/first-train-last-train';

const LTA_SPATIAL_DATA_PATH = './Data/Raw/mrt/lta_spatial_data.json';
const OUTPUT_FILE = './Data/Raw/mrt/operator_mrt_data.json';
const DELAY_MS = 200;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchOperatorMRTData() {
    console.log("Loading spatial data to identify stations...");
    const spatialDataRaw = await fs.readFile(LTA_SPATIAL_DATA_PATH, 'utf8');
    const spatialData = JSON.parse(spatialDataRaw);
    
    const smrtStations = [];
    const sbstStations = [];

    const smrtPrefixes = ['NS', 'EW', 'CG', 'CC', 'CE', 'TE', 'BP'];
    const sbstPrefixes = ['NE', 'DT', 'ST', 'SE', 'SW', 'PT', 'PE', 'PW'];

    for (const station of spatialData.stations) {
        let isSmrt = false;
        let isSbst = false;
        for (const code of station.codes) {
            const prefix = code.replace(/[0-9]/g, '');
            if (smrtPrefixes.includes(prefix)) isSmrt = true;
            if (sbstPrefixes.includes(prefix)) isSbst = true;
        }
        if (isSmrt) smrtStations.push(station);
        if (isSbst) sbstStations.push(station);
    }

    const allData = [];

    // 1. SMRT
    console.log(`\n--- Fetching SMRT data (${smrtStations.length} stations) ---`);
    for (let i = 0; i < smrtStations.length; i++) {
        const station = smrtStations[i];
        process.stdout.write(`SMRT [${i + 1}/${smrtStations.length}]: ${station.nameEn}... `);
        try {
            const res = await fetch(`${SMRT_API_URL}${encodeURIComponent(station.nameEn)}`, {
                headers: {
                    'Origin': 'https://journey.smrt.com.sg',
                    'Referer': 'https://journey.smrt.com.sg/',
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            
            if (data.results && data.results.length > 0) {
                const sData = data.results[0];
                
                // Normalise train timings
                const trainFirstLastData = [];
                if (sData.train_times) {
                    for (const tt of sData.train_times) {
                        const dirData = {
                            towards: tt.description,
                            firstTrain: [],
                            lastTrain: []
                        };
                        if (tt.first_trains) {
                            if (tt.first_trains.weekday) dirData.firstTrain.push({ day: "Mondays to Fridays", time: tt.first_trains.weekday });
                            if (tt.first_trains.sat) dirData.firstTrain.push({ day: "Saturdays", time: tt.first_trains.sat });
                            if (tt.first_trains.sun_public_holiday) dirData.firstTrain.push({ day: "Sundays & Public Holidays", time: tt.first_trains.sun_public_holiday });
                        }
                        if (tt.last_trains) {
                            if (tt.last_trains.weekday) dirData.lastTrain.push({ day: "Mondays to Fridays", time: tt.last_trains.weekday });
                            if (tt.last_trains.sat) dirData.lastTrain.push({ day: "Saturdays", time: tt.last_trains.sat });
                            if (tt.last_trains.sun_public_holiday) dirData.lastTrain.push({ day: "Sundays & Public Holidays", time: tt.last_trains.sun_public_holiday });
                        }
                        trainFirstLastData.push(dirData);
                    }
                }

                // Normalise amenities
                const amenities = [];
                if (sData.amenities) {
                    for (const [key, val] of Object.entries(sData.amenities)) {
                        if (key === 'atm') {
                            if (Array.isArray(val)) {
                                val.forEach(atm => amenities.push({ name: `ATM: ${atm.name}`, type: 'amenity' }));
                            }
                        } else {
                            amenities.push({ name: `${key}: ${val}`, type: 'amenity' });
                        }
                    }
                }
                if (sData.shop) {
                    sData.shop.forEach(sh => amenities.push({ name: sh.shop, unit: sh.unit, type: 'shop' }));
                }

                allData.push({
                    operator: 'SMRT',
                    source_name: station.nameEn,
                    codes: station.codes,
                    exits: sData.exit ? sData.exit.map(e => ({
                        exit: e.station_exit,
                        landmarks: e.description ? e.description.split(',').map(l => l.trim().replace(/^\d+\.\s*/, '')).filter(l => l) : []
                    })) : [],
                    amenities: amenities,
                    trainFirstLastData: trainFirstLastData,
                    alt_travel: sData.alt_travel
                });
                console.log('Done.');
            } else {
                console.log('No data found.');
            }
        } catch (err) {
            console.log('Error:', err.message);
        }
        await sleep(DELAY_MS);
    }

    // 2. SBST
    console.log(`\n--- Fetching SBS Transit data (${sbstStations.length} stations) ---`);
    console.log("Fetching SBST master station list...");
    const sbstDropdownOptions = [];
    const lines = ['NEL', 'DTL', 'SKG LRT', 'PGL LRT'];
    for (const line of lines) {
        const sbstRes = await fetch('https://www.sbstransit.com.sg/Ajax/StationDropdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
            body: `TrainLine=${encodeURIComponent(line)}`
        });
        const sbstHtml = await sbstRes.text();
        const $sbst = cheerio.load(sbstHtml);
        $sbst('option').each((i, el) => {
            const val = $sbst(el).attr('value');
            if (val && !sbstDropdownOptions.some(o => o.code === val)) {
                sbstDropdownOptions.push({ code: val, name: $sbst(el).text().trim() });
            }
        });
    }

    for (let i = 0; i < sbstStations.length; i++) {
        const station = sbstStations[i];
        process.stdout.write(`SBST [${i + 1}/${sbstStations.length}]: ${station.nameEn}... `);
        
        let sbstCode = '';
        for(let op of sbstDropdownOptions) {
            if(op.name.toLowerCase() === station.nameEn.toLowerCase() || 
               op.name.toLowerCase() === station.nameEn.toLowerCase() + " ") {
                sbstCode = op.code;
                break;
            }
        }

        if (!sbstCode) {
            console.log('Skipped (no SBST code match).');
            continue;
        }

        let trainLine = 'DTL';
        if (station.codes.some(c => c.startsWith('NE'))) trainLine = 'NEL';
        else if (station.codes.some(c => c.startsWith('DT'))) trainLine = 'DTL';
        else if (station.codes.some(c => c.startsWith('ST') || c.startsWith('SE') || c.startsWith('SW'))) trainLine = 'SKG+LRT';
        else if (station.codes.some(c => c.startsWith('PT') || c.startsWith('PE') || c.startsWith('PW'))) trainLine = 'PGL+LRT';

        try {
            // Fetch info page
            const infoUrl = `${SBST_INFO_URL}?TrainLine=${trainLine}&Station=${sbstCode}`;
            const infoRes = await fetch(infoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const infoHtml = await infoRes.text();
            const $info = cheerio.load(infoHtml);

            // Parse exits
            const exits = [];
            $info('h4').each((i, el) => {
                const title = $info(el).text().trim();
                if (title === 'Exits') {
                    const content = $info(el).nextAll('p').first().html();
                    if (content) {
                        const parts = content.split(/<b.*?>/i).filter(p => p.trim() !== '');
                        parts.forEach(p => {
                            const closeTagIdx = p.indexOf('</b>');
                            if(closeTagIdx !== -1) {
                                const exitLetter = p.substring(0, closeTagIdx).trim();
                                const landmarksHtml = p.substring(closeTagIdx + 4);
                                const landmarks = landmarksHtml.split(/<br\s*\/?>/i)
                                    .map(str => cheerio.load('<span>' + str + '</span>').text().trim())
                                    .filter(str => str.length > 0 && str !== 'No place of interest');
                                exits.push({ exit: `Exit ${exitLetter}`, landmarks: landmarks });
                            }
                        });
                    }
                }
            });

            // Parse facilities
            const amenities = [];
            $info('h4').each((i, el) => {
                const title = $info(el).text().trim();
                if (title.includes('Facilities Found') || title.includes('Common Facilities')) {
                    const content = $info(el).nextAll('p').first().html();
                    if (content) {
                        const parts = content.split(/<b.*?>/i).filter(p => p.trim() !== '');
                        parts.forEach(p => {
                            const closeTagIdx = p.indexOf('</b>');
                            if(closeTagIdx !== -1) {
                                const facName = p.substring(0, closeTagIdx).trim();
                                amenities.push({ name: facName, type: 'facility' });
                            }
                        });
                    }
                }
            });

            // Fetch timing page
            const timeUrl = `${SBST_TIMING_URL}?TrainLine=${trainLine}&Station=${sbstCode}`;
            const timeRes = await fetch(timeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const timeHtml = await timeRes.text();
            const $time = cheerio.load(timeHtml);

            const trainFirstLastData = [];
            
            // For SBST, tables have directions in TH or preceding elements
            // The table structure varies slightly but typically:
            // Table 0 might be "Towards Expo", then first train last train headers...
            $time('.table-responsive').each((i, div) => {
                const $table = $time(div).find('table');
                if($table.length === 0) return;
                
                // Usually the heading is right before the table, or inside a th
                let towards = '';
                const prev = $time(div).prev();
                if (prev.is('h4')) towards = prev.text().trim();
                else towards = `Direction ${i+1}`;

                const dirData = {
                    towards: towards.replace('Towards ', ''),
                    firstTrain: [],
                    lastTrain: []
                };

                // The first data rows contain Mon-Sat, Sun/PH etc.
                // Assuming standard 3 columns format: 
                // First Train: Mon-Sat, Sun/PH
                // Last Train: Mon-Sun
                const headers = [];
                $table.find('thead th').each((j, th) => {
                    headers.push($time(th).text().trim());
                });

                $table.find('tbody tr').each((j, tr) => {
                    // Extract times. This is highly dependent on table layout.
                    const tds = $time(tr).find('td');
                    if(tds.length >= 3) {
                        // Normally row 1 is First Train, row 2 is Last Train
                        const type = $time(tds[0]).text().trim();
                        if (type.includes('First Train')) {
                            dirData.firstTrain.push({day: "Mondays to Saturdays", time: $time(tds[1]).text().trim()});
                            dirData.firstTrain.push({day: "Sundays/Public Holidays", time: $time(tds[2]).text().trim()});
                        } else if (type.includes('Last Train')) {
                            dirData.lastTrain.push({day: "Mondays to Sundays", time: $time(tds[1]).text().trim()}); // Often just 1 col for last train
                            if($time(tds[2]).text().trim()) {
                                dirData.lastTrain.push({day: "Sundays/Public Holidays", time: $time(tds[2]).text().trim()});
                            }
                        }
                    }
                });
                
                trainFirstLastData.push(dirData);
            });

            allData.push({
                operator: 'SBST',
                source_name: station.nameEn,
                codes: station.codes,
                exits: exits,
                amenities: amenities,
                trainFirstLastData: trainFirstLastData
            });
            console.log('Done.');
        } catch (err) {
            console.log('Error:', err.message);
        }
        await sleep(DELAY_MS);
    }

    console.log(`\nSaving ${allData.length} records to ${OUTPUT_FILE}...`);
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(allData, null, 2), 'utf-8');
    console.log('Complete!');
}

module.exports = { fetchOperatorMRTData };

// If executed directly
if (require.main === module) {
    fetchOperatorMRTData();
}
