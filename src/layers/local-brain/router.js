const claude = require('./claude');
const context = require('./context');

class IntentRouter {
    async handle(input, extras = {}) {
        if (typeof input === 'string' && input.toLowerCase().trim() === 'stop') {
            return { action: 'STOP' };
        }

        const prompt = await context.assemble(input, extras);
        const brainResponse = await claude.generateResponse(prompt);

        return {
            action: 'BROADCAST',
            ...brainResponse
        };
    }
}

module.exports = new IntentRouter();
