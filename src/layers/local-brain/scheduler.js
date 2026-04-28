const cron = require('node-cron');

class RadioScheduler {
    constructor() {
        this._broadcaster = null;
    }

    // Called by server.js after wiring is complete.
    setBroadcaster(fn) {
        this._broadcaster = fn;
    }

    init() {
        // 07:00 — Morning routine
        cron.schedule('0 7 * * *', () => this._trigger(
            '早上好！帮我开启今天的电台，根据我的早晨规律推荐第一首歌。'
        ));

        // Every hour on the hour — mood check
        cron.schedule('0 * * * *', () => {
            const h = new Date().getHours();
            if (h >= 7 && h <= 23) {
                this._trigger('整点了，根据现在的时间和情绪规则推荐一首歌。');
            }
        });

        console.log('[Scheduler] 已注册定时任务');
    }

    _trigger(input, extras = {}) {
        if (!this._broadcaster) return;
        this._broadcaster(input, extras).catch((err) => {
            console.error('[Scheduler] broadcast error:', err.message);
        });
    }
}

module.exports = new RadioScheduler();
