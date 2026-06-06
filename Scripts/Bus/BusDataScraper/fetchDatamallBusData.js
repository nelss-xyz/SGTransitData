/**
 * fetchDatamallBusData.js
 * ======================
 * Fetches raw bus stop, service, and route data from the LTA DataMall API.
 * Saves results to:
 *   ./Data/Raw/bus/datamall_stops.json
 *   ./Data/Raw/bus/datamall_services.json
 *   ./Data/Raw/bus/datamall_routes.json
 *
 * Requires LTA_ACCOUNT_KEY in .env
 */

'use strict';

require('dotenv').config();

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATAMALL_KEY      = process.env.LTA_ACCOUNT_KEY || '';
const DATAMALL_BASE     = 'https://datamall2.mytransport.sg/ltaodataservice';
const PAGE_SIZE         = 500;

const RAW_DIR   = path.resolve(__dirname, '../../../Data/Raw/bus');
const STOPS_OUT    = path.join(RAW_DIR, 'datamall_stops.json');
const SERVICES_OUT = path.join(RAW_DIR, 'datamall_services.json');
const ROUTES_OUT   = path.join(RAW_DIR, 'datamall_routes.json');

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function fetchJSON(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
    });
}

// ─── Paginated DataMall fetch ─────────────────────────────────────────────────

async function fetchAll(endpoint) {
    if (!DATAMALL_KEY) {
        throw new Error('LTA_ACCOUNT_KEY is not set in your .env file.');
    }
    const headers = { AccountKey: DATAMALL_KEY, accept: 'application/json' };
    const results = [];
    let skip = 0;
    while (true) {
        const url  = `${DATAMALL_BASE}/${endpoint}?$skip=${skip}`;
        const data = await fetchJSON(url, headers);
        const page = data.value || [];
        results.push(...page);
        process.stdout.write(`\r  ${endpoint}: fetched ${results.length} records...`);
        if (page.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
    }
    console.log(); // newline
    return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function fetchDatamallBusData() {
    console.log('[DataMall] Fetching bus data from LTA DataMall API...');

    if (!fs.existsSync(RAW_DIR)) {
        fs.mkdirSync(RAW_DIR, { recursive: true });
    }

    // Fetch all three endpoints in sequence (DataMall rate limits apply)
    const stops = await fetchAll('BusStops');
    fs.writeFileSync(STOPS_OUT, JSON.stringify(stops), 'utf8');
    console.log(`  ✓ Saved ${stops.length} stops → ${STOPS_OUT}`);

    const services = await fetchAll('BusServices');
    fs.writeFileSync(SERVICES_OUT, JSON.stringify(services), 'utf8');
    console.log(`  ✓ Saved ${services.length} service records → ${SERVICES_OUT}`);

    const routes = await fetchAll('BusRoutes');
    fs.writeFileSync(ROUTES_OUT, JSON.stringify(routes), 'utf8');
    console.log(`  ✓ Saved ${routes.length} route-stop records → ${ROUTES_OUT}`);

    console.log('[DataMall] Done.\n');
}

module.exports = { fetchDatamallBusData };
