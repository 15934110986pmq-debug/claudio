const fs = require('fs-extra');
const path = require('path');
const state = require('./state');
const { getCurrentWeather } = require('../external/weather');
const { getTodayEvents } = require('../external/feishu');

const ROOT = path.join(__dirname, '../../..');

const PERSONA_FILES = {
    default:      'dj-persona.md',
    morning:      'personas/morning.md',
    'late-night': 'personas/late-night.md',
    'deep-cuts':  'personas/deep-cuts.md'
};

async function loadPersona(name, userId) {
    // Custom persona: id format "custom:<int>"
    if (typeof name === 'string' && name.startsWith('custom:')) {
        const id = parseInt(name.slice(7), 10);
        if (id && userId) {
            const row = await state.getCustomPersona(userId, id).catch(() => null);
            if (row?.prompt_md) return row.prompt_md;
        }
        // Fall through to default if custom missing / not owned
        name = 'default';
    }
    const file = PERSONA_FILES[name] || PERSONA_FILES.default;
    const fullPath = path.join(ROOT, 'prompts', file);
    try {
        return await fs.readFile(fullPath, 'utf8');
    } catch (e) {
        console.warn('[context] persona file missing:', file, '— falling back to default');
        return fs.readFile(path.join(ROOT, 'prompts/dj-persona.md'), 'utf8').catch(() => '');
    }
}

class ContextAggregator {
    // Assembles the 6-fragment prompt for Claude.
    async assemble(userInput, extras = {}) {
        // Fragment 2: User profile (loaded first so we can pick the right persona)
        const userId = extras?.userId ?? state.DEFAULT_USER_ID;
        const [taste, routines, mood, playlists, dbTaste] = await Promise.all([
            fs.readFile(path.join(ROOT, 'user/taste.md'), 'utf8').catch(() => ''),
            fs.readFile(path.join(ROOT, 'user/routines.md'), 'utf8').catch(() => ''),
            fs.readFile(path.join(ROOT, 'user/mood-rules.md'), 'utf8').catch(() => ''),
            fs.readJson(path.join(ROOT, 'user/playlists.json'), { throws: false }).catch(() => ({})),
            (userId && userId !== state.DEFAULT_USER_ID)
                ? state.getUserTaste(userId).catch(() => null)
                : Promise.resolve(null)
        ]);

        // Build a per-user taste block from the DB row when available.
        // This takes priority over the static taste.md for authenticated users.
        let userTasteBlock = '';
        if (dbTaste) {
            const parts = [];
            if (dbTaste.artistsLove?.length)  parts.push(`喜爱艺人：${dbTaste.artistsLove.join(', ')}`);
            if (dbTaste.artistsAvoid?.length) parts.push(`想避开：${dbTaste.artistsAvoid.join(', ')}`);
            if (dbTaste.moodSeeds?.length)    parts.push(`喜欢的氛围：${dbTaste.moodSeeds.join(', ')}`);
            if (dbTaste.timePrefs) {
                const t = dbTaste.timePrefs;
                const segs = [];
                if (t.morning)   segs.push(`早晨 → ${t.morning}`);
                if (t.afternoon) segs.push(`下午 → ${t.afternoon}`);
                if (t.evening)   segs.push(`傍晚 → ${t.evening}`);
                if (t.night)     segs.push(`深夜 → ${t.night}`);
                if (segs.length) parts.push(`时段偏好：${segs.join(' | ')}`);
            }
            if (dbTaste.weatherCity) parts.push(`所在城市：${dbTaste.weatherCity}`);
            if (parts.length) {
                userTasteBlock = `## 用户个人口味（来自 onboarding，比静态档案更新）\n\n${parts.join('\n')}\n\n`;
            }
        }

        // Fragment 1: System prompt (DJ persona) — resolved after dbTaste is available
        // so we can use the user's stored choice.
        let personaName = dbTaste?.persona || 'default';
        // Auto-pick by time of day when user has not explicitly chosen one.
        if (personaName === 'default') {
            const h = new Date().getHours();
            if (h >= 22 || h < 5)       personaName = 'late-night';
            else if (h >= 5 && h < 11)  personaName = 'morning';
            // 11-22: stays 'default'
        }
        const persona = await loadPersona(personaName, userId);

        // Fragment 3: Environment injection (weather + calendar + now).
        // Always render time in Asia/Taipei regardless of host TZ —
        // the user lives in Taiwan, so the DJ should think in Taipei time.
        const TZ = 'Asia/Taipei';
        const now = new Date();
        const [weather, events] = await Promise.all([
            getCurrentWeather().catch(() => '天气未知'),
            getTodayEvents().catch(() => ['日程未知'])
        ]);
        const env = {
            now: now.toLocaleString('zh-CN', { hour12: false, timeZone: TZ }),
            weekday: now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: TZ })
                       .replace('星期', '周'),  // "星期一" → "周一" (project convention)
            weather,
            todayEvents: events,
            ...extras
        };

        // Fragment 4: Already-indexed memory (recent plays)
        const recentPlays = await state.getRecentPlays(8, userId).catch(() => []);
        const playHistory = recentPlays.length
            ? recentPlays.map(p => `${p.song_name} — ${p.artist}`).join(', ')
            : '无';

        // Fragment 5: Anti-bubble hard constraint (30-day artist block list)
        const recentArtists = await state.getRecentArtists(30, 100, userId).catch(() => []);
        let antiBubbleSection = '';
        if (recentArtists.length > 0) {
            const displayArtists = recentArtists.slice(0, 80);
            antiBubbleSection = `
---
## 反信息茧房硬约束（务必遵守）

这位用户在过去 30 天已经播过以下艺人/乐队（共 ${recentArtists.length} 位）。**今天的推荐不能再选这个名单里的任何一位**，除非用户当下明确要求（"再听一遍 X"、"我想听 Y"）：

${displayArtists.join(', ')}

如果以上名单超过 50 位，仍然只列出最近的；上下文已经足够你避开。`;
        }

        // Fragment 6: Feedback signals (loves + dislikes)
        const [recentLoves, recentDislikes] = await Promise.all([
            state.getRecentLoves(10, userId).catch(() => []),
            state.getRecentDislikes(15, userId).catch(() => [])
        ]);
        let feedbackSection = '';
        if (recentLoves.length > 0 || recentDislikes.length > 0) {
            const loveLines = recentLoves.length > 0
                ? recentLoves.map(r => `- ${r.song_name} — ${r.artist}`).join('\n')
                : '（暂无）';
            const dislikeLines = recentDislikes.length > 0
                ? recentDislikes.map(r => {
                    const pct = r.position_pct != null
                        ? `${Math.round(r.position_pct * 100)}%`
                        : 'unknown position';
                    return `- ${r.song_name} — ${r.artist} (skipped at ${pct})`;
                }).join('\n')
                : '（暂无）';
            feedbackSection = `
---
## 用户近期反馈信号

❤️ 最近爱过（往这个方向找邻接但更新的）：
${loveLines}

⏭ 最近跳过 / 不喜欢（不要再推类似的，position_pct < 0.3 = 强负向）：
${dislikeLines}`;
        }

        // Fragment 7: Novelty knob — how adventurous should each pick be?
        const novelty = typeof extras?.novelty === 'number' ? extras.novelty : 50;
        const noveltyBlock = `
---
## 新颖度旋钮（用户当前设置）

用户把"探索欲"滑杆调到了 **${novelty}/100**。请按以下解释来选歌：

${novelty <= 30 ? '- **SAFE 档**：OK 重听这位用户最近喜欢的艺人；选保险、舒服、熟悉感的歌；可以从"过去 30 天已播艺人"里选。' : ''}
${novelty > 30 && novelty <= 70 ? '- **BALANCED 档**：严格遵守反信息茧房硬约束；正常推荐。' : ''}
${novelty > 70 ? '- **ADVENTUROUS 档**：必须选这位用户从没听过的艺人；鼓励跨流派；可以推他平常不会主动找的小众艺人，但仍要在他的口味范围内（不要为了新而新）。' : ''}
`.trim();

        // Fragment 8: User input / fast track handled by caller
        return `${persona}

---
## 用户品味档案
${userTasteBlock}### 音乐口味（静态档案，供参考）
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
${antiBubbleSection}
${feedbackSection}
${noveltyBlock}

---
## 用户输入 / 触发指令
${userInput}

---
记住：只输出 JSON，不加任何说明文字。`;
    }
}

module.exports = new ContextAggregator();
