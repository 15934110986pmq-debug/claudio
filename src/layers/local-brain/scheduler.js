const cron = require('node-cron');
const tasteEvolver = require('./taste-evolver');

const TZ = 'Asia/Taipei';

// Returns the current hour as observed in Taipei, regardless of host TZ.
function taipeiHour() {
    return parseInt(new Date().toLocaleString('en-US', {
        timeZone: TZ,
        hour: '2-digit',
        hour12: false
    }), 10);
}

class RadioScheduler {
    constructor() {
        this._broadcaster = null;
    }

    setBroadcaster(fn) {
        this._broadcaster = fn;
    }

    init() {
        // 07:00 (Taipei) — morning routine
        cron.schedule('0 7 * * *', () => this._trigger(
            '早上好！帮我开启今天的电台，根据我的早晨规律推荐第一首歌。'
        ), { timezone: TZ });

        // Every hour on the hour (Taipei) — mood check, 07–23 only
        cron.schedule('0 * * * *', () => {
            const h = taipeiHour();
            if (h >= 7 && h <= 23) {
                this._trigger('整点了，根据现在的时间和情绪规则推荐一首歌。');
            }
        }, { timezone: TZ });

        // Weekly taste auto-evolution — Sunday 03:00 (Taipei)
        cron.schedule('0 3 * * 0', async () => {
            console.log('[Evolver] weekly run starting');
            try {
                const results = await tasteEvolver.runForAll();
                console.log('[Evolver] complete:', JSON.stringify(results));
            } catch (e) {
                console.error('[Evolver] crashed:', e.message);
            }
        }, { timezone: TZ });

        console.log(`[Scheduler] 已注册定时任务 (timezone=${TZ}, now=${taipeiHour()}:00)`);
    }

    _trigger(input, extras = {}) {
        if (!this._broadcaster) return;
        this._broadcaster(input, extras).catch((err) => {
            console.error('[Scheduler] broadcast error:', err.message);
        });
    }
}

module.exports = new RadioScheduler();
