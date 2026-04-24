const cron = require('node-cron');
const router = require('./router');

class RadioScheduler {
    init() {
        // Morning Routine at 07:00
        cron.schedule('0 7 * * *', async () => {
            console.log('[Scheduler] Triggering Morning Routine...');
            const result = await router.handle("Start my morning routine. Plan my audio for today.");
            this.broadcast(result);
        });

        // Hourly Mood Check
        cron.schedule('0 * * * *', async () => {
            console.log('[Scheduler] Triggering Hourly Mood Check...');
            const result = await router.handle("Check my mood rules and suggest a track for the top of the hour.");
            this.broadcast(result);
        });
    }

    broadcast(payload) {
        // Emit via EventBus or WebSocket for Layer 4 to pick up
        console.log('[Broadcasting]', payload.say);
    }
}

module.exports = new RadioScheduler();
