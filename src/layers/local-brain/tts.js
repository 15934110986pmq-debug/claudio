const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const { synthesize } = require('../external/fish-audio');

const CACHE_DIR = path.join(__dirname, '../../../cache/tts');
fs.ensureDirSync(CACHE_DIR);

// Converts text to speech. Returns the public URL path "/tts/<hash>.mp3",
// or null if TTS is unavailable.
async function textToSpeech(text) {
    if (!text) return null;

    const hash = crypto.createHash('md5').update(text).digest('hex');
    const filePath = path.join(CACHE_DIR, `${hash}.mp3`);

    // Return cached file if exists
    if (await fs.pathExists(filePath)) {
        return `/tts/${hash}.mp3`;
    }

    const buffer = await synthesize(text);
    if (!buffer) return null;

    await fs.writeFile(filePath, buffer);
    return `/tts/${hash}.mp3`;
}

module.exports = { textToSpeech };
