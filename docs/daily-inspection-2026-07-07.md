# 日常全量巡检记录 2026-07-07

## 巡检范围

- 评委端：登录、队伍切换、评分键盘、提交锁定、缺项处理、两位小数、来源身份隐藏。
- 管理员端：队伍信息编辑、撤回提交、清空重评、轮询与本地 pending、来源身份隐藏。
- 服务端：会话、权限、评分写入、冲突、状态文件读写、坏数据清洗、正式启动保护。
- 成绩展示页：单队展示、匿名分数、去高去低综合分、公开摘要不泄露评委身份和来源身份。
- 运维文档：正式启动命令、清场口径、历史审计提示、PM2 单实例说明。

## 使用的技能与代理

- `diagnosing-bugs`：建立可重复的日常巡检脚本，而不是只做人工阅读。
- `research`：用官方/一手资料核对权限、会话、本地存储和构建部署基线。
- 多代理只读巡检：
  - 服务端 API、鉴权、状态文件和启动保护。
  - 评委评分主流程。
  - 管理员编辑与应急处理。
  - 成绩展示页。
  - 运维文档、脚本、状态文件。
  - 可测试性和每日巡检脚本设计。

## 已处理的问题

1. 服务端写接口路径收紧：`/api/candidates/:id/extra` 和 `/api/entries/:judge/:team/extra` 不再被写接口接受。
2. 评委不能通过 API 改写已提交评分；必须由管理员撤回后才能修改。
3. 前端评委端已提交后不再允许打开评分键盘、重置或“更新提交”。
4. 管理员退出/切换会话时会清理应急二次确认状态。
5. 管理员队伍信息保存后，较早发出的旧轮询响应不会覆盖刚保存的本地值。
6. 管理员应急写入失败后保留 pending，后续轮询恢复时会尝试补交。
7. 服务端拒绝明显坏结构状态文件，避免把 `{}` 这类文件静默当成空赛况。
8. `index.html` 标题改为中性文案。
9. 当前 `data/contest-state.json` 已删除 `candidateOverrides.*.name` 来源身份字段；未改动任何成绩分数、提交状态或 revision。
10. 启动文档改为 `npm ci` 和 `npm run contest:fresh`，历史审计文档增加“历史记录”提示。

## 新增自动化

- 新增 `scripts/daily-inspection.mjs`。
- 新增 `npm run check:daily`。

`check:daily` 使用临时数据目录和随机端口，不污染当前 `data/contest-state.json`，覆盖：

- 来源身份关键词扫描。
- `contest:fresh` 对非空状态的拒绝。
- `/api/health`、静态 SPA 路由。
- 未登录、错误登录、单账号多设备会话。
- 评委只能读取自己的状态，不能编辑队伍信息或其他评委评分。
- 写接口尾随路径拒绝。
- 队伍信息不返回旧 `name` 字段。
- 脏分数清洗、两位小数、缺项不能保持 submitted。
- 7 位评委综合分去高去低、匿名分数。
- 旧 `serverRevision` 冲突不覆盖。
- 评委不能改写已提交记录。
- 非法 JSON、超大请求、运行中坏状态文件、启动前坏结构状态文件。

## 验证结果

通过：

```bash
npm run check:daily
npm run check:admin-edit
node --check contest-server.mjs
node --check scripts/admin-edit-regression.mjs
node --check scripts/daily-inspection.mjs
```

当前实时状态：

- `data/contest-state.json` 仍有 21 份已提交和 22 条 revision，属于测试/复盘数据，不是赛前空状态。
- 当前 5177 端口仍在运行旧进程；状态文件已脱敏，所以没有来源身份文本泄露，但旧进程的 `/api/scoreboard` 仍返回空的 `name` 键。重启 `npm run contest` 后会使用新服务端逻辑并移除该键。

## 仍需人工决策

1. 正式开赛前必须备份并删除 `data/contest-state.json`，然后使用 `npm run contest:fresh` 启动。
2. 当前账号密码仍是内置演示口径，且没有登录限流。若要上真实公网或半公网环境，应增加密码外置、登录失败限速和操作日志。
3. 当前 JSON 文件持久化只适合单实例。多进程/多服务器部署需要文件锁、数据库或专用存储。
4. 评分细则曾在前端与服务端分别维护；该项已在 2026-07-13 收敛到 `shared/scoringRules.js`，并由 Node 契约测试覆盖浏览器、服务端和迁移工具共同依赖的两位小数、满分和综合评分规则。
5. in-app browser 当前不可用，本轮未做真实截图和触摸交互验证；已用 API/源码/构建回归覆盖核心稳定性。

## 外部基线

- OWASP Authorization Cheat Sheet：巡检按最小权限和服务端授权检查权限边界。
- OWASP Session Management Cheat Sheet / OWASP Top 10 A07：会话应有过期、登出失效和登录失败防护。
- MDN `localStorage`：浏览器策略可能让本地存储读写抛出 `SecurityError`，所以前端必须继续容错。
- Vite 官方文档：生产前应执行 `vite build`；`vite preview` 只是本地预览，不是生产服务器。
