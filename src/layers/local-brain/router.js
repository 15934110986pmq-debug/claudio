const gemini = require('./gemini');
const context = require('./context');

class IntentRouter {
    async handle(input) {
        // 1. Simple Command Routing (Heuristics)
        if (input.toLowerCase() === 'stop') {
            return { action: 'STOP' };
        }

        // 2. Natural Language Routing to Gemini
        const fullPrompt = await context.assemble(input, { 
            weather: 'sunny', // Placeholder for actual weather integration
            status: 'idle'
        });

        const brainResponse = await gemini.generateResponse(fullPrompt);
        return {
            action: 'BROADCAST',
            ...brainResponse
        };
    }
}

module.exports = new IntentRouter();
