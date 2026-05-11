# Claudio — 项目背景 (for Claude Code)

> 这份文档是给 Claude Code 看的项目级背景资料。任何在本仓库工作的 Claude 会话都应先读完这份文档再动手。

## 是什么

**Claudio** v2.0.0 — 个人 AI 电台 DJ。一个有"DJ 人设"的 AI 电台，根据用户的音乐口味档案（taste / routines / mood-rules）+ 实时环境（时间 / 天气 / 日程）+ 已播记忆，自动选歌、写串场词、合成语音、推送到音箱。

技术栈：Node.js + Express + WebSocket + SQLite + Claude CLI + Fish Audio TTS + 网易云 + 飞书日历 + UPnP/DLNA。

## 一次完整广播流程

1. **触发**：HTTP `POST /api/chat` / WS `play|next` / cron 整点
2. `router.handle()` → `context.assemble()` 拼出 6 段 prompt
3. `claude.js` spawn `claude --print --output json` 调用本机 Claude CLI 拿 JSON `{say, play[], reason, segue}`
4. `fish-audio` 合成 TTS（带 md5 缓存到 `cache/tts/`）
5. `netease` 搜歌拿 audioUrl + coverUrl
6. `upnp` 推到 DLNA 音箱（可选）
7. WS 广播 `now-playing` 给前端 PWA

## 目录结构

```
src/layers/
  local-brain/        ← 决策与状态（项目核心）
    router.js         入口路由（目前只有 BROADCAST / STOP）
    context.js        6 段 prompt 拼装
    claude.js         调用本机 claude CLI（默认大脑）
    gemini.js         备用大脑（axios 调 Gemini API，未在 router 接入）
    scheduler.js      node-cron：07:00 + 每整点 7-23
    state.js          SQLite (messages / plays / plan)
    tts.js            TTS 入口 + 文件缓存
  external/           ← 第三方适配器
    netease.js        NeteaseCloudMusicApi
    fish-audio.js     Fish Audio TTS（带 reference_id 音色克隆）
    weather.js        OpenWeatherMap
    feishu.js         飞书日历（tenant token 自动续期）
    upnp.js           DLNA SOAP 推送
prompts/dj-persona.md DJ 人设系统提示
user/                 用户档案（taste / routines / mood-rules / playlists）
public/               前端 PWA（vanilla JS + Audio API + WS）
data/                 SQLite db（运行时创建）
cache/tts/            TTS 音频缓存（运行时创建）
```

## 架构原则

1. **双层解耦**：`local-brain` 管决策，`external` 管外设。换 LLM 只改 local-brain；换音乐源只改 external。
2. **优雅降级**：所有外部服务（FISH / OPENWEATHER / FEISHU / UPNP / PROXY_URL）都通过 env 配置；**未配置时绝不崩溃**，要返回合理 fallback。
3. **状态持久化**：所有播放历史、对话、每日 plan 进 SQLite，便于"已播记忆"和回溯。
4. **TTS 缓存**：相同文本不重复合成，按 md5 缓存。

## 扩展指引

- **新增 LLM 提供商** → 在 `src/layers/local-brain/` 新建 `{provider}.js`，实现 `generateResponse(prompt)` 返回 `{say, play[], reason, segue}`，在 `router.js` 中切换。
- **新增音乐源** → 在 `src/layers/external/` 新建适配器，实现 `fetchRealMusic(name, artist) → {id, name, artist, coverUrl, audioUrl}`。
- **新增触发方式** → 在 `scheduler.js` 加 cron 或在 `server.js` 加 HTTP/WS handler，最终调用 `router.handle()`。
- **改变输出 schema** → 同时更新 `prompts/dj-persona.md` 中的 JSON 规约和前端 `public/app.js` 的消费逻辑。

## 已知缺口（按可见优先级排序）

1. **`user/playlists.json` 为空** — context.js 会读但内容是 `{}`。
2. **`gemini.js` 已写但未接入 router** — 若 claude CLI 不可用应能切换。
3. **`test-brain.js` 已陈旧** — 早期版本，写死代理、调用不存在的模型，与当前 src/ 不一致。建议删除或重写。
4. **无 README.md**。
5. **无测试**（无 jest/vitest，无 test script）。
6. **前端只有 play/pause/next** — 缺音量、历史、用户主动输入心情/请求、👍/👎 反馈按钮。
7. **WebSocket 无鉴权** — 局域网内任何人可控电台。
8. **`/api/plan/today` 路由存在但前端未调用**。
9. **`reason` / `segue` 字段已生成但未利用** — 可以驱动渐变/淡入淡出。
10. **next 时未记录负反馈** — 用户跳过的歌应该入"不喜欢"档。

## 编码约定

- **Immutability**：返回新对象，不原地修改。
- **错误处理显式**：每个外部调用都要 try/catch，写明 `[模块] xxx` 前缀的 console.error。
- **小文件优于大文件**：保持每个模块 200-400 行，~800 上限。
- **不要硬编码 secret**：所有 key 走 `.env` + `process.env`。
- **不要破坏"未配置不崩溃"的约定**：新增外部依赖时仿照 `weather.js` / `feishu.js` 的写法。

## Repo

- Remote: `https://github.com/15934110986pmq-debug/claudio`
- 主分支: `main`
