const axios = require('axios');
require('dotenv').config();

const FISH_API_URL = 'https://api.fish.audio/v1/tts';

// Calls Fish Audio TTS API, returns a Buffer of MP3 audio.
// reference_id is optional — set FISH_REFERENCE_ID in .env to use a cloned voice.
async function synthesize(text) {
    const apiKey = process.env.FISH_API_KEY;
    if (!apiKey) {
        console.warn('[FishAudio] FISH_API_KEY not set, skipping TTS');
        return null;
    }

    const body = {
        text,
        format: 'mp3',
        latency: 'normal',
        streaming: false
    };

    if (process.env.FISH_REFERENCE_ID) {
        body.reference_id = process.env.FISH_REFERENCE_ID;
    }

    try {
        const response = await axios.post(FISH_API_URL, body, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer',
            timeout: 30000
        });
        return Buffer.from(response.data);
    } catch (err) {
        console.error('[FishAudio] TTS error:', err.response?.status, err.message);
        return null;
    }
}

module.exports = { synthesize };
