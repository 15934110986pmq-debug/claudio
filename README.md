# Claudio 🎙️

> 个人 AI 电台 DJ — Claude / Gemini + 网易云 + Fish Audio + 飞书 + UPnP

Claudio 是一个有"DJ 人设"的私人 AI 电台。它会读你的音乐口味档案、看时间和天气、扫今天的日程，然后选一首合适的歌，写一句串场词，合成成语音，再把音乐推到你的 DLNA 音箱上。

不是 Spotify 算法。是一个**懂你**的电台。

---

## ✨ 功能

- 🧠 **AI 选曲** — 基于 LLM（默认 Claude CLI，可切 Gemini），根据情境写理由、出歌单
- 🎤 **DJ 串场** — 自动生成中文 DJ 台词 + Fish Audio TTS 合成（支持音色克隆）
- 🎵 **真实音源** — 接网易云音乐 API，拿真实 mp3 + 高清专辑封面
- 🕐 **整点开播 / 早晨叫醒** — node-cron 定时触发（07:00 + 每整点 7–23）
- 🌤 **环境感知** — 天气（OpenWeatherMap）+ 日程（飞书日历）
- 🔊 **DLNA 推送** — UPnP SOAP 推到家中音箱（Naim、Sonos 等）
- 📱 **PWA 前端** — WebSocket 实时同步，手机/电脑浏览器都能用
- 💾 **状态记忆** — SQLite 存对话、播放历史、每日计划，避免重复推荐

---

## 🚀 快速开始

```bash
git clone https://github.com/15934110986pmq-debug/claudio.git
cd claudio/claudio       # 注意是嵌套的 claudio/claudio
npm install
cp .env.example .env     # 然后填入需要的 key
npm start
```

打开 `http://localhost:8080` 即可。

### 必要 / 可选环境变量

| 变量 | 必要？ | 说明 |
| --- | --- | --- |
| `PORT` | 可选 | 默认 8080 |
| `FISH_API_KEY` | 可选 | 不配置则不出 TTS 串场，只播音乐 |
| `FISH_REFERENCE_ID` | 可选 | Fish Audio 音色克隆 ID |
| `OPENWEATHER_KEY` | 可选 | 不配置则天气显示"未知" |
| `WEATHER_CITY` | 可选 | 默认 Beijing |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 可选 | 飞书日历，不配置则日程显示"未配置" |
| `UPNP_DEVICE_URL` | 可选 | DLNA 控制 URL，不配置则只在浏览器播 |
| `PROXY_URL` | 可选 | 代理（如调用 Gemini 等需要） |

所有外部服务都做了"未配置不崩溃"的优雅降级——可以先跑起来，再按需接入。

### LLM 大脑

默认调用本机 `claude` CLI（Anthropic Claude Code），用 `--print --output json` 拿结构化输出。需要先安装并登录 Claude CLI。

不想用 Claude CLI 也可以——`src/layers/local-brain/gemini.js` 已经写好备用，只要在 `router.js` 里替换 `require('./claude')` 为 `require('./gemini')` 并配置 `GEMINI_API_KEY`。

---

## 🏗 架构

```
触发 (HTTP / WS / cron)
     ↓
router.handle()
     ↓
context.assemble()  ──→  6 段 prompt
     ↓               ┌── DJ 人设 (prompts/dj-persona.md)
LLM (claude / gemini)├── 用户档案 (user/taste.md, routines.md, mood-rules.md)
     ↓               ├── 环境注入 (时间 / 天气 / 飞书日程)
JSON {say, play[]…}  ├── 已播记忆 (SQLite 最近 8 首)
     ↓               └── 用户输入
┌─── TTS (Fish Audio) → cache/tts/*.mp3
├─── 搜歌 (网易云)    → audioUrl + coverUrl
├─── UPnP 推送        → DLNA 音箱
└─── WebSocket 广播   → 前端 PWA
```

**分层原则**：
- `src/layers/local-brain/` — 决策与状态（核心）
- `src/layers/external/` — 第三方适配器（可插拔）

详见 [`CLAUDE.md`](./CLAUDE.md)。

---

## 📁 目录结构

```
.
├── server.js                       # HTTP + WS 入口
├── prompts/dj-persona.md           # DJ 系统提示词
├── user/                           # 你的个人偏好（编辑这里来调教 DJ）
│   ├── taste.md                    # 一句话总结你的口味
│   ├── routines.md                 # 每日时段偏好
│   ├── mood-rules.md               # 情绪 / 天气 / 时间联动规则
│   └── playlists.json              # 收藏歌单（开发中）
├── src/layers/
│   ├── local-brain/                # 路由 / context / LLM 适配 / state / TTS / scheduler
│   └── external/                   # netease / fish-audio / weather / feishu / upnp
├── public/                         # PWA 前端
├── data/                           # SQLite (运行时)
├── cache/tts/                      # TTS 音频缓存 (运行时)
├── CLAUDE.md                       # 给 Claude Code 看的项目背景
└── .claude/                        # 项目级 Claude Code 配置
```

---

## 🎨 个性化

电台的"灵魂"全在 `user/` 三个 md 和 `prompts/dj-persona.md` 里——直接改文本，重启服务就生效，不用碰代码。

例：
- 改 DJ 风格 → `prompts/dj-persona.md`
- 增加时段偏好 → `user/routines.md`
- 加硬性禁止 → `user/mood-rules.md`

---

## 🛣 路线图

见 [`CLAUDE.md`](./CLAUDE.md#已知缺口按可见优先级排序) 中的"已知缺口"清单。当前优先级靠前的有：

- [ ] 接入 `gemini.js` 作为 Claude CLI 不可用时的 fallback
- [ ] `user/playlists.json` schema 设计 + 编辑 UI
- [ ] 前端 👍/👎 反馈按钮 → 写入 SQLite 反馈表
- [ ] WebSocket 加上 token 鉴权
- [ ] 删除 / 重写陈旧的 `test-brain.js`
- [ ] 单元测试 + E2E

---

## 📜 License

私人项目。
