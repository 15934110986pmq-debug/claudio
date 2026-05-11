# .claude/

项目级 Claude Code 配置。**进 git，跨机器共享**。

## 文件说明

- `settings.json` — 项目级权限白名单（allow 常用 Node/git 只读命令；deny 读 `.env`、`rm -rf`、`git push --force`、`git reset --hard`）。
- `settings.local.json`（如有）— 个人本地覆盖。**不进 git**（见根 `.gitignore`）。

## 新机器开发流程

1. `git clone https://github.com/15934110986pmq-debug/claudio.git`
2. `cd claudio/claudio && npm install`
3. `cp .env.example .env`（如果有），填入 `FISH_API_KEY` / `OPENWEATHER_KEY` 等
4. 启动 Claude Code：自动加载本目录 + 项目根 `CLAUDE.md`
5. `npm start` 跑服务，访问 `http://localhost:8080`

## 添加项目级资产

- 项目专属 agent → `.claude/agents/{name}.md`
- 项目级 slash command → `.claude/commands/{name}.md`
- 项目级 skill → `.claude/skills/{name}/`
- 项目 MCP server → 根目录 `.mcp.json`

所有这些都进 git。个人偏好/身份类配置请留在 `~/.claude/` 全局位置。
