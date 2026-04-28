const fs = require('fs-extra');
const path = require('path');
const state = require('./state');
const { getCurrentWeather } = require('../external/weather');
const { getTodayEvents } = require('../external/feishu');

const ROOT = path.join(__dirname, '../../..');

class ContextAggregator {
    // Assembles the 6-fragment prompt for Claude.
    async assemble(userInput, extras = {}) {
        // Fragment 1: System prompt (DJ persona)
        const persona = await fs.readFile(path.join(ROOT, 'prompts/dj-persona.md'), 'utf8').catch(() => '');

        // Fragment 2: User profile
        const [taste, routines, mood, playlists] = await Promise.all([
            fs.readFile(path.join(ROOT, 'user/taste.md'), 'utf8').catch(() => ''),
            fs.readFile(path.join(ROOT, 'user/routines.md'), 'utf8').catch(() => ''),
            fs.readFile(path.join(ROOT, 'user/mood-rules.md'), 'utf8').catch(() => ''),
            fs.readJson(path.join(ROOT, 'user/playlists.json'), { throws: false }).catch(() => ({}))
        ]);

        // Fragment 3: Environment injection (weather + calendar + now)
        const now = new Date();
        const [weather, events] = await Promise.all([
            getCurrentWeather().catch(() => '天气未知'),
            getTodayEvents().catch(() => ['日程未知'])
        ]);
        const env = {
            now: now.toLocaleString('zh-CN', { hour12: false }),
            weekday: ['周日','周一','周二','周三','周四','周五','周六'][now.getDay()],
            weather,
            todayEvents: events,
            ...extras
        };

        // Fragment 4: Already-indexed memory (recent plays)
        const recentPlays = await state.getRecentPlays(8).catch(() => []);
        const playHistory = recentPlays.length
            ? recentPlays.map(p => `${p.song_name} — ${p.artist}`).join(', ')
            : '无';

        // Fragment 5 + 6: User input / fast track handled by caller
        return `${persona}

---
## 用户品味档案
### 音乐口味
${taste}

### 每日规律
${routines}

### 情绪规则
${mood}

---
## 环境注入
- 当前时间：${env.now}（${env.weekday}）
- 天气：${env.weather}
- 今日日程：${env.todayEvents.join(' | ')}

---
## 已播记忆（请不要重复推荐这些）
${playHistory}

---
## 用户输入 / 触发指令
${userInput}

---
记住：只输出 JSON，不加任何说明文字。`;
    }
}

module.exports = new ContextAggregator();
