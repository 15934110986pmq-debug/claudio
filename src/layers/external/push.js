// WebPush adapter. Auto-generates + persists VAPID keys on first boot.
// Env vars VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY override the on-disk file.
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

const VAPID_FILE = path.join(__dirname, '../../../data/vapid.json');

let keys = null;

function loadOrGenerateKeys() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return {
            publicKey:  process.env.VAPID_PUBLIC_KEY,
            privateKey: process.env.VAPID_PRIVATE_KEY,
            subject:    process.env.VAPID_SUBJECT || 'mailto:noreply@claudio.local'
        };
    }
    try {
        if (fs.existsSync(VAPID_FILE)) {
            return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8'));
        }
    } catch (e) {
        console.warn('[push] vapid file read failed:', e.message);
    }
    // Generate and persist
    const generated = webpush.generateVAPIDKeys();
    const out = {
        publicKey:  generated.publicKey,
        privateKey: generated.privateKey,
        subject:    'mailto:noreply@claudio.local'
    };
    try {
        fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
        fs.writeFileSync(VAPID_FILE, JSON.stringify(out, null, 2));
        console.log('[push] generated new VAPID keypair → data/vapid.json');
    } catch (e) {
        console.warn('[push] could not persist vapid keys:', e.message);
    }
    return out;
}

function init() {
    if (keys) return keys;
    keys = loadOrGenerateKeys();
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    return keys;
}

async function send(subscription, payloadObj) {
    init();
    try {
        await webpush.sendNotification(subscription, JSON.stringify(payloadObj));
        return { ok: true };
    } catch (err) {
        // 410 / 404 → subscription gone; caller should delete it
        const expired = err.statusCode === 410 || err.statusCode === 404;
        return { ok: false, expired, status: err.statusCode, message: err.body || err.message };
    }
}

function publicKey() {
    return init().publicKey;
}

module.exports = { send, publicKey, init };
