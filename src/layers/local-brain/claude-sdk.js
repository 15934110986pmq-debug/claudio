const Anthropic = require('@anthropic-ai/sdk');

class ClaudeSdkBrain {
    constructor() {
        this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        this.model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    }

    async generateResponse(prompt) {
        try {
            const resp = await this.client.messages.create({
                model: this.model,
                max_tokens: 1024,
                messages: [{ role: 'user', content: prompt }]
            });
            const text = resp.content?.[0]?.text || '';
            // Reuse the same fence-stripping logic as the CLI adapter
            const raw = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
            try {
                return JSON.parse(raw);
            } catch {
                return this._fallback('SDK response not JSON: ' + text.slice(0, 80));
            }
        } catch (err) {
            console.error('[Claude SDK] error:', err.message);
            return this._fallback(err.message);
        }
    }

    async generateResponseStreaming(prompt, onDelta) {
        try {
            const stream = this.client.messages.stream({
                model: this.model,
                max_tokens: 1024,
                messages: [{ role: 'user', content: prompt }]
            });

            // Emit each text delta to the caller (server.js → WS broadcast).
            stream.on('text', (text) => {
                try { onDelta?.(text); } catch (e) { /* swallow callback errors */ }
            });

            const finalMsg = await stream.finalMessage();
            const text = finalMsg.content?.[0]?.text || '';
            const raw = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
            try {
                return JSON.parse(raw);
            } catch {
                return this._fallback('streaming response not JSON: ' + text.slice(0, 80));
            }
        } catch (err) {
            console.error('[Claude SDK stream] error:', err.message);
            return this._fallback(err.message);
        }
    }

    _fallback(reason) {
        console.warn('[Claude SDK] fallback triggered:', reason);
        return {
            say: 'My thoughts drifted for a moment — the music keeps going.',
            play: [],
            reason: reason,
            segue: 'direct'
        };
    }
}

module.exports = new ClaudeSdkBrain();
