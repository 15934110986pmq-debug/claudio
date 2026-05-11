const axios = require('axios');
require('dotenv').config();

// Gemini adapter for Claudio. Calls v1beta generateContent with JSON response.
// Contract: success → returns parsed {say, play[], reason, segue}.
//           failure → throws (so brain.js can fall back to a safe response).
//
// Model is configurable via GEMINI_MODEL env var; default is gemini-1.5-flash
// because the historical "gemini-pro" alias has been deprecated.
const DEFAULT_MODEL = 'gemini-1.5-flash';

class GeminiBrain {
    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY;
        this.model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    }

    async generateResponse(prompt) {
        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY not configured');
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

        const response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 1024,
                responseMimeType: 'application/json'
            }
        }, { timeout: 30000 });

        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            throw new Error('gemini: empty response');
        }

        try {
            return JSON.parse(text);
        } catch {
            throw new Error('gemini result not JSON: ' + text.slice(0, 80));
        }
    }
}

module.exports = new GeminiBrain();
