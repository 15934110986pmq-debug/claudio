const claude = require('./claude');
const context = require('./context');

class IntentRouter {
    async handle(input, extras = {}) {
        if (typeof input === 'string' && input.toLowerCase().trim() === 'stop') {
            return { action: 'STOP' };
        }

        const prompt = await context.assemble(input, extras);

        let brainResponse;
        if (extras.onDelta && claude.supportsStreaming && claude.generateResponseStreaming) {
            brainResponse = await claude.generateResponseStreaming(prompt, extras.onDelta);
        } else {
            brainResponse = await claude.generateResponse(prompt);
        }

        return {
            action: 'BROADCAST',
            ...brainResponse
        };
    }
}

module.exports = new IntentRouter();
