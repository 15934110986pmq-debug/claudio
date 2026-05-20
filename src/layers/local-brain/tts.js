const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');

// Pick TTS provider via env. Default = Edge (free, no API key, high quality).
// Set TTS_PROVIDER=fish to use Fish Audio with voice cloning (requires FISH_API_KEY).
const provider = (process.env.TTS_PROVIDER || 'edge').toLowerCase();
const adapterPath = provider === 'fish' ? '../external/fish-audio' : '../external/edge-tts';
const { synthesize } = require(adapterPath);
console.log(`[TTS] provider=${provider}`);

const CACHE_DIR = path.join(__dirname, '../../../cache/tts');
fs.ensureDirSync(CACHE_DIR);

// Converts text to speech. Returns the public URL path "/tts/<hash>.mp3",
// or null if TTS is unavailable.
async function textToSpeech(text) {
    if (!text) return null;

    // Include the active voice in the cache key so swapping TTS_VOICE doesn't
    // serve the old voice's audio for matching text.
    const voiceTag = process.env.TTS_VOICE || provider;
    const hash = crypto.createHash('md5').update(voiceTag + '|' + text).digest('hex');
    const filePath = path.join(CACHE_DIR, `${hash}.mp3`);

    // Return cached file if exists
    if (await fs.pathExists(filePath)) {
        return `/tts/${hash}.mp3`;
    }

    const buffer = await synthesize(text);
    // Treat empty buffer as failure — Edge TTS returns 0 bytes when the voice
    // can't handle the text (e.g., English voice asked to read Chinese).
    if (!buffer || !buffer.length) return null;

    await fs.writeFile(filePath, buffer);
    return `/tts/${hash}.mp3`;
}

module.exports = { textToSpeech };
