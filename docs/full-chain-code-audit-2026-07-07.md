# 全链路代码审计 2026-07-07

## 审计范围

- 前端入口：`src/main.jsx`、`src/App.jsx`、`src/styles.css`
- 服务端入口：`contest-server.mjs`
- 运行入口：`package.json`、`vite.config.mjs`
- 状态文件：`data/contest-state.json`
- 测试证据：`qa-artifacts/full-chain-code-audit-2026-07-07/`

## 数据流转

1. 评委登录后从 `/api/state` 拉取服务端评分状态和队伍资料覆盖信息。
2. 评委数字键盘每次改分都会更新本机内存和 `localStorage`，再按队伍/评委维度排队同步到 `/api/entries/:judgeId/:candidateId`。
3. 服务端校验分数、钳制上下限、用 `serverRevision` 防止旧数据覆盖新数据，并原子写入 `data/contest-state.json`。
4. 管理员端每 2 秒刷新 `/api/state`，汇总 7 位评委提交进度，按去最高和最低后的 5 位评委平均分计算综合分。
5. 管理员修改队伍名称、项目名称后，写入 `/api/candidates/:candidateId`，其他平板刷新后同步显示。

## 本轮修复

- 队伍资料同步：管理员修改队伍资料原先只保存在本机，现已进入服务端 `candidateOverrides`，能跨评委平板同步。
- 服务端冲突规则：评分写入现在要求客户端 `serverRevision` 与服务端当前版本完全一致，避免旧平板或异常缓存回滚成绩。
- 写入队列韧性：服务端单次写入异常后，后续写入队列会继续尝试，不会永久卡死。
- 小数精度：前端总分、维度分、综合分按百分位整数汇总，服务端分数清洗也按百分位整数处理。

## 已验证边界

- `/api/health` 健康检查正常。
- `/api/state` 返回评分状态和队伍资料覆盖信息。
- 管理员保存队伍资料后，服务端状态能读到；恢复默认后服务端覆盖信息被移除。
- 未知队伍资料写入被拒绝。
- 超分、负分、非法分数会被服务端清洗，未完整评分不能被标记为已提交。
- 旧 `serverRevision` 写入会返回冲突，不覆盖服务端现有数据。
- 前 3 队、7 位评委、21 份提交仍保持综合分正确：A01 `91.27`，A02 `80.19`，A03 `93.33`。

## 证据文件

- `api-boundary-results.json`：修复前第一轮 API 边界测试。
- `api-boundary-results-after-fixes.json`：修复后复测，`allPass: true`。
- `state-before.json`：本轮审计前状态备份。

## 仍需赛前人工确认

- 正式入口应统一使用 `http://127.0.0.1:5177/` 或服务端打印的 LAN 地址，不要让评委使用 `5173` 开发端口。
- 正式比赛前应清空或恢复 `data/contest-state.json`，当前文件保留了测试提交数据。
- 当前账号和密码仍是前端明文演示账号，适合封闭赛场原型，不适合公网暴露。
- 操作日志和成绩导出尚未产品化；如用于正式决赛，建议增加赛后导出和管理员操作记录。
