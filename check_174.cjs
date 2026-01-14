
const fs = require('fs');
const path = require('path');

const schedulesPath = path.join(process.cwd(), 'public/data/tbilisi_schedules.json');

try {
    const schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
    const routeId = '1:R239274_1_01'; // Try generic first suffix
    // Loop to find any key starting with 1:R239274
    const relevantKey = Object.keys(schedules).find(k => k.startsWith('1:R239274'));

    if (relevantKey) {
        console.log(`Found schedule for ${relevantKey}`);
        const schedule = schedules[relevantKey];
        const mondays = schedule.find(s => s.fromDay === 'MONDAY') || schedule[0];
        if (mondays && mondays.stops.length > 0) {
            console.log('Arrival Times:', mondays.stops[0].arrivalTimes);
        } else {
            console.log('No stops found in schedule.');
        }
    } else {
        console.log('Route 174 not found in schedules.');
    }

} catch (err) {
    console.error(err);
}
