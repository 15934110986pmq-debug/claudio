const brain = require('./brain');
const context = require('./context');

class IntentRouter {
    async handle(input, extras = {}) {
        if (typeof input === 'string' && input.toLowerCase().trim() === 'stop') {
            return { action: 'STOP' };
        }

        const prompt = await context.assemble(input, extras);
        const brainResponse = await brain.generateResponse(prompt);

        return {
            action: 'BROADCAST',
            ...brainResponse
        };
    }
}

module.exports = new IntentRouter();
