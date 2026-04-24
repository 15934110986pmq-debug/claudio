const axios = require('axios');
require('dotenv').config();

/**
 * Gemini Adapter for Claudio
 * Enforces JSON schema: {say, play[], reason, segue}
 */
class GeminiBrain {
    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY;
        this.apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${this.apiKey}`;
    }

    async generateResponse(prompt) {
        try {
            const response = await axios.post(this.apiUrl, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 1024,
                    responseMimeType: "application/json"
                }
            });

            const text = response.data.candidates[0].content.parts[0].text;
            return JSON.parse(text);
        } catch (error) {
            console.error('Gemini Brain Error:', error.response?.data || error.message);
            return {
                say: "Sorry, I'm having a bit of a brain fog. Let's just keep the music going.",
                play: [],
                reason: "Error in Gemini API call",
                segue: "direct"
            };
        }
    }
}

module.exports = new GeminiBrain();
