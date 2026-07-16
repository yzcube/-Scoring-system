# 第一轮全量巡检记录

日期：2026-07-07

## 审计范围

- 评委端：登录、队伍选择、评分键盘、缺项提交、完整提交、退出。
- 管理员端：提交进度、队伍信息编辑、撤回提交、清空重评。
- 成绩展示页：单队 16:9 展示、匿名分数、高低分、外部资源依赖。
- 服务端：登录会话、角色权限、评分写入、队伍资料同步、请求体限制、启动检查、云部署约束。

## 本轮修复

- 服务端新增 `/api/login`、`/api/session`、`/api/logout`，写接口改为 Bearer token 会话校验。
- `/api/state` 需要登录；评委只能看到并写入自己的评分，管理员才能看到全量状态。
- `/api/candidates/*` 仅管理员可写；`/api/entries/:judgeId/:candidateId` 中评委不能写其他评委。
- 成绩展示页改用公开只读 `/api/scoreboard` 摘要接口，只返回匿名总分、综合分、高低分和队伍展示信息。
- 管理员页和 `/scoreboard` 不再把本机缓存加入补交队列；只有当前登录评委页会补交自己的 pending 评分。
- 登录页账号卡不再显示或填入密码。
- 管理员“撤回提交”保持单击生效。
- 成绩展示页移除 Cloudinary 视频和 Google Fonts 外链，仅使用同源静态深蓝背景和系统字体。
- 成绩展示页所有屏幕保持 16:9 stage，竖屏使用上下留黑/留空，不拉伸成长页。
- 请求体增加 64KB 默认限制，超限返回 413。
- 服务端增加 `SIGINT`/`SIGTERM` 关停处理，关停期间 `/api/health` 返回 503。
- 启动时检测已有提交/写入状态；`npm run contest:fresh` 在正式清场不干净时拒绝启动。
- 增加 Node 版本约束和 `.nvmrc`，增加 PM2 单实例配置 `ecosystem.config.cjs`。

## 验证证据

证据目录：

```text
qa-artifacts/full-round-audit-2026-07-07/
```

截图清单：

- `01-login-no-passwords.png`：登录页账号卡不显示密码。
- `02-judge-a04-selected.png`：评委选择 A04。
- `03-keypad-backspace-decimal.png`：数字键盘两位小数与退格。
- `04-missing-submit-jump.png`：缺项提交提示并定位。
- `05-judge-submitted-top.png`：完整提交后关闭键盘并回到顶部。
- `06-admin-a04-after-judge-submit.png`：管理员看到评委提交。
- `07-admin-reopen-two-tap.png`：历史截图文件名保留，当前行为为单击撤回提交。
- `08-scoreboard-1920x1080.png`：16:9 单队成绩展示。
- `09-scoreboard-portrait-letterbox.png`：竖屏仍保持 16:9 stage。
- `browser-flow-results.json`：浏览器断言结果，`allPass: true`。

API 边界复测通过：

- 未登录访问 `/api/state` 返回 401。
- 未登录写 `/api/entries/*` 返回 401。
- 评委登录成功，管理员登录成功。
- 评委写其他评委评分返回 403。
- 评委可写自己的评分。
- 评委不能编辑队伍信息，管理员可以编辑队伍信息。
- `/api/scoreboard` 返回匿名只读成绩摘要。
- 超大请求体返回 413。

构建与语法检查：

- `npm run build` 通过。
- `node --check contest-server.mjs` 通过。

## 当前状态

- `data/contest-state.json` 仍保留前三队全量测试提交：`submitted: 21`，用于复核展示页和管理员综合分。
- 本轮浏览器和 API 测试均在命令内备份并恢复状态文件；测试后 A04 未提交、无队伍覆盖信息。
- 正式比赛前必须按 runbook 备份并删除 `data/contest-state.json`，再使用 `npm run contest:fresh` 启动。

## 剩余风险

- 当前持久化仍是单 JSON 文件，只适合单进程单实例。中国云服务器生产部署必须禁用 PM2 cluster 和多实例负载均衡。
- 还没有数据库级操作日志、成绩导出、只读锁定和管理员操作审计。
- 管理员和评委账号允许多台设备同时登录；同账号并发录入同一队伍时仍依赖服务端版本冲突保护和现场操作纪律。
- 如果要对公网开放，除 HTTPS、访问控制、安全组/VPN 外，还需要按中国大陆云服务商和工信部要求完成备案/接入备案。
