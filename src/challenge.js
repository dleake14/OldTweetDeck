// x-client-transaction-id: X refuses some requests without this header. It's computed here the same way
// x.com's ondemand.s computes it, from the site verification key and the loading animation on x.com's
// homepage, without running any of X's code. The algorithm is ported from x-client-transaction-id by Lami
// (https://github.com/Lqm1/x-client-transaction-id, MIT, see LICENSE).

function uuidV4() {
    const uuid = new Array(36);
    for (let i = 0; i < 36; i++) {
      uuid[i] = Math.floor(Math.random() * 16);
    }
    uuid[14] = 4; // set bits 12-15 of time-high-and-version to 0100
    uuid[19] = uuid[19] &= ~(1 << 2); // set bit 6 of clock-seq-and-reserved to zero
    uuid[19] = uuid[19] |= (1 << 3); // set bit 7 of clock-seq-and-reserved to one
    uuid[8] = uuid[13] = uuid[18] = uuid[23] = '-';
    return uuid.map((x) => x.toString(16)).join('');
}

async function readCryptoKey() {
    return new Promise((resolve, reject) => {
        let request = indexedDB.open("localforage");

        request.onerror = function(event) {
            reject(event);
        };

        request.onsuccess = function(event) {
            const db = event.target.result;

            // Open a transaction to access the keyvaluepairs object store
            if (db.objectStoreNames.contains('keyvaluepairs')) {
                const transaction = db.transaction(['keyvaluepairs'], 'readonly');
                const objectStore = transaction.objectStore('keyvaluepairs');

                objectStore.openCursor().onsuccess = function(event) {
                    const cursor = event.target.result;
                    if (cursor) {
                        // Check if the key matches the pattern
                        const key = cursor.key;
                        if (key.startsWith('device:rweb.dmCryptoKeys')) {
                            resolve(cursor.value);
                        }

                        // Move to the next entry
                        cursor.continue();
                    } else {
                        // No more entries, reject the promise
                        reject("No key found");
                    }
                };
            } else {
                reject("No key found");
            }
        };
    });
}

(async () => {
    try {
        let cryptoKey = await readCryptoKey();
        if(cryptoKey) {
            localStorage.device_id = cryptoKey.deviceId;
        } else if(!localStorage.device_id) {
            localStorage.device_id = uuidV4();
        }
    } catch(e) {
        console.warn(`Error during device id generation:`, e);
        if(!localStorage.device_id) {
            localStorage.device_id = uuidV4();
        }
    }
})();

// Cubic bezier easing of the loading animation, with the curve's control points
function cubicValue(curves, time) {
    let calculate = (a, b, m) => 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
    if(time <= 0) {
        let startGradient = 0;
        if(curves[0] > 0) startGradient = curves[1] / curves[0];
        else if(curves[1] === 0 && curves[2] > 0) startGradient = curves[3] / curves[2];
        return startGradient * time;
    }
    if(time >= 1) {
        let endGradient = 0;
        if(curves[2] < 1) endGradient = (curves[3] - 1) / (curves[2] - 1);
        else if(curves[2] === 1 && curves[0] < 1) endGradient = (curves[1] - 1) / (curves[0] - 1);
        return 1 + endGradient * (time - 1);
    }
    let start = 0, end = 1, mid = 0;
    while(start < end) {
        mid = (start + end) / 2;
        let xEstimate = calculate(curves[0], curves[2], mid);
        if(Math.abs(time - xEstimate) < 0.00001) return calculate(curves[1], curves[3], mid);
        if(xEstimate < time) start = mid;
        else end = mid;
    }
    return calculate(curves[1], curves[3], mid);
}

// Hex form of a number with its fraction, the way X writes it (uppercase digits, "1.8" for 1.5)
function floatToHex(x) {
    let result = [];
    let quotient = Math.floor(x);
    let fraction = x - quotient;
    while(quotient > 0) {
        quotient = Math.floor(x / 16);
        let remainder = Math.floor(x - quotient * 16);
        result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : remainder.toString());
        x = quotient;
    }
    if(fraction === 0) return result.join('');
    result.push('.');
    while(fraction > 0) {
        fraction *= 16;
        let integer = Math.floor(fraction);
        fraction -= integer;
        result.push(integer > 9 ? String.fromCharCode(integer + 55) : integer.toString());
    }
    return result.join('');
}

// The color and rotation of one row of the loading animation at targetTime, as a string
function animate(frameRow, targetTime) {
    let scale = (value, min, max, rounding) => {
        let result = value * (max - min) / 255 + min;
        return rounding ? Math.floor(result) : Math.round(result * 100) / 100;
    };
    let interpolate = (from, to, f) => from * (1 - f) + to * f;
    let fromColor = frameRow.slice(0, 3).concat(1).map(Number);
    let toColor = frameRow.slice(3, 6).concat(1).map(Number);
    let toRotation = scale(frameRow[6], 60, 360, true);
    let curves = frameRow.slice(7).map((value, i) => scale(value, i % 2 ? -1 : 0, 1, false));
    let value = cubicValue(curves, targetTime);

    let color = fromColor.map((from, i) => interpolate(from, toColor[i], value)).map(c => c > 0 ? c : 0);
    let radians = interpolate(0, toRotation, value) * Math.PI / 180;
    let matrix = [Math.cos(radians), -Math.sin(radians), Math.sin(radians), Math.cos(radians)];

    let parts = color.slice(0, -1).map(c => Math.round(c).toString(16));
    for(let m of matrix) {
        let rounded = Math.round(m * 100) / 100;
        if(rounded < 0) rounded = -rounded;
        let hex = floatToHex(rounded);
        parts.push(hex.startsWith('.') ? `0${hex}`.toLowerCase() : hex || '0');
    }
    parts.push('0', '0');
    return parts.join('').replace(/[.-]/g, '');
}

function getAnimationKey(keyBytes, indices, frames) {
    let rowIndex = keyBytes[indices[0]] % 16;
    let frameTime = indices.slice(1).reduce((time, index) => time * (keyBytes[index] % 16), 1);
    frameTime = Math.round(frameTime / 10) * 10;

    let path = frames[keyBytes[5] % 4]?.children[0]?.children[1]?.getAttribute('d');
    if(!path) throw new Error(`no loading animation frame ${keyBytes[5] % 4} on x.com's homepage`);
    let rows = path.substring(9).split('C').map(item => {
        let cleaned = item.replace(/[^\d]+/g, ' ').trim();
        return cleaned === '' ? [] : cleaned.split(/\s+/).map(n => parseInt(n, 10));
    });
    if(!rows[rowIndex]) throw new Error(`no row ${rowIndex} in the loading animation`);
    return animate(rows[rowIndex], frameTime / 4096);
}

function findOndemandUrl(html) {
    let hash = html.match(/(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/)?.[2];
    if(!hash) {
        // the chunk maps without the code between them
        let id = html.match(/(\d+):\s*["']ondemand\.s["']/)?.[1];
        if(id) hash = html.match(new RegExp(`\\b${id}:\\s*["']([a-zA-Z0-9_-]+)["']`))?.[1];
    }
    if(!hash) throw new Error("ondemand.s is not in x.com's chunk map");
    return `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${hash}a.js`;
}

async function initSolver() {
    // A logged out homepage can be X's newer app without these; /i/jf/ is still the old one
    let html;
    for(let path of ['/', '/i/jf/']) {
        html = await fetch(`https://${location.hostname}${path}`).then(res => res.text());
        if(html.includes('twitter-site-verification') && html.includes('ondemand.s')) break;
    }
    let dom = new DOMParser().parseFromString(html, 'text/html');
    let key = dom.querySelector('meta[name="twitter-site-verification"]')?.getAttribute('content');
    if(!key) throw new Error("no twitter-site-verification key on x.com's homepage");
    let keyBytes = Array.from(atob(key), c => c.charCodeAt(0));

    let ondemandUrl = findOndemandUrl(html);
    let res = await fetch(ondemandUrl);
    if(!res.ok) throw new Error(`${ondemandUrl}: HTTP ${res.status}`);
    let ondemand = await res.text();
    let indices = Array.from(ondemand.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g), m => parseInt(m[1], 10));
    if(!indices.length) throw new Error('no key byte indices in ondemand.s');

    let frames = dom.querySelectorAll('[id^="loading-x-anim"]');
    let animationKey = getAnimationKey(keyBytes, indices, frames);
    console.log(`Transaction id solver is ready (${ondemandUrl.split('/').pop()})`);
    reportSolver(true, ondemandUrl.split('/').pop());
    return { keyBytes, animationKey };
}

// for the load watchdog (watchdog.js)
function reportSolver(ok, text) {
    document.dispatchEvent(new CustomEvent('otd-diagnostic', { detail: JSON.stringify({ kind: 'solver', ok, text }) }));
}

let solverInit = initSolver();
solverInit.catch(e => {
    console.error('Solver init error:', e);
    reportSolver(false, String(e));
});

async function solveChallenge(path, method) {
    let solver, timeout;
    try {
        solver = await Promise.race([
            solverInit,
            new Promise((resolve, reject) => timeout = setTimeout(reject, 20000, 'Solver timed out')),
        ]);
    } catch(e) {
        throw typeof e === 'string' ? e : 'Solver errored';
    } finally {
        clearTimeout(timeout);
    }

    let time = Math.floor((Date.now() - 1682924400 * 1000) / 1000);
    let timeBytes = [time & 0xff, (time >> 8) & 0xff, (time >> 16) & 0xff, (time >> 24) & 0xff];
    let data = new TextEncoder().encode(`${method}!${path}!${time}obfiowerehiring${solver.animationKey}`);
    let hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    let random = Math.floor(Math.random() * 256);
    let bytes = [random, ...[...solver.keyBytes, ...timeBytes, ...hash.slice(0, 16), 3].map(b => b ^ random)];
    return btoa(String.fromCharCode(...bytes)).replace(/=/g, '');
}
