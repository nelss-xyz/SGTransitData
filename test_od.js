const fs = require('fs');
const readline = require('readline');

const services = JSON.parse(fs.readFileSync('./Raw/bus/services.json', 'utf8'));
const odMap = new Set();
for (const [serviceNo, serviceData] of Object.entries(services)) {
    serviceData.routes.forEach((route) => {
        for (let i = 0; i < route.length; i++) {
            for (let j = i + 1; j < route.length; j++) {
                odMap.add(`${route[i]}_${route[j]}`);
            }
        }
    });
}

const fileStream = fs.createReadStream('./Raw/bus/ridership.csv');
const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

let missing = 0;
let found = 0;
let lines = 0;

rl.on('line', (line) => {
    lines++;
    if (lines === 1 || lines > 100000) {
        if (lines === 100001) {
            console.log(`Found: ${found}, Missing: ${missing}`);
            process.exit(0);
        }
        return;
    }
    const parts = line.split(',');
    const origin = parts[4];
    const dest = parts[5];
    if (odMap.has(`${origin}_${dest}`)) {
        found++;
    } else {
        missing++;
    }
});
