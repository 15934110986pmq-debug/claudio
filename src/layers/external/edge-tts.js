// Microsoft Edge TTS adapter — free, broadcaster-grade Chinese neural voices.
// Uses the same endpoint the Edge browser's "read aloud" feature talks to.
//
// Voices worth trying for Claudio's DJ persona (set TTS_VOICE in .env):
//   en-US-JennyNeural     (default — female, classic US radio anchor)
//   en-US-AvaNeural       (female, warm, conversational)
//   en-US-AriaNeural      (female, news anchor)
//   en-GB-SoniaNeural     (female, British)
//   zh-CN-YunjianNeural   (male, deep, news-anchor)
//   zh-CN-XiaoxiaoNeural  (female, warm)

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const VOICE = process.env.TTS_VOICE || 'en-US-JennyNeural';
const TIMEOUT_MS = 30_000;

// Returns Buffer | null. tts.js handles disk caching.
async function synthesize(text) {
    if (!text) return null;

    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

        // toStream may resolve immediately or return a promise depending on
        // version — Promise.resolve() smooths both shapes.
        const streamResult = tts.toStream(text);
        const { audioStream } = await Promise.resolve(streamResult);
        if (!audioStream) throw new Error('no audioStream from msedge-tts');

        return await new Promise((resolve, reject) => {
            const chunks = [];
            const timer = setTimeout(
                () => reject(new Error(`Edge TTS timeout after ${TIMEOUT_MS}ms`)),
                TIMEOUT_MS
            );
            audioStream.on('data', (chunk) => chunks.push(chunk));
            audioStream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
            audioStream.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
            audioStream.on('error', (err) => { clearTimeout(timer); reject(err); });
        });
    } catch (err) {
        console.error('[EdgeTTS] 合成失败:', err.message);
        return null;
    }
}

module.exports = { synthesize };
