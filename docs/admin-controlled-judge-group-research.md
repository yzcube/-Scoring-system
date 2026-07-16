# 管理员统一控制评委端组别方案

## 背景

评委端当前在评分页顶部直接渲染组别选择：

- `src/App.jsx` 中评委分支渲染 `<GroupSelector value={selectedGroup.id} onChange={selectContestGroup} className="judge-group-selector" />`。
- 管理员分支也渲染同一个 `GroupSelector`，但当前只是修改管理员本机 React 状态 `selectedGroupId`。
- `selectedGroupId` 目前初始化为 `defaultGroupId`，没有服务端持久化字段；`GET /api/state` 只返回评分、队伍展示信息、队伍排序等状态。

因此，如果只删除评委端 `GroupSelector`，评委端不会自动跟随管理员端，仍会停留在本机默认组别或旧状态。真正需求是“管理员端选择当前比赛组别，所有评委端只读并跟随”。

## 外部资料结论

React 官方文档建议：当多个组件需要同步变化时，应移除各自本地状态，把状态提升到共同拥有者并作为单一事实源传下去。跨多台评委平板时，共同拥有者不是某个浏览器组件，而是共享 LAN 服务端。来源：React “Sharing State Between Components” 文档说明 shared state 应 lift up 到 closest common parent，并强调 single source of truth。<https://react.dev/learn/sharing-state-between-components>

MDN Fetch API 文档说明 `fetch()` 是发起 HTTP 请求并处理响应的标准接口，适合现有 `GET /api/state` 轮询读取共享状态。来源：<https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch>

MDN `localStorage` 文档说明它访问的是当前 document origin 的本地 Storage，数据跨浏览器会话保存；这说明它适合本机缓存，不适合作为多台设备共享控制状态的事实源。来源：<https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage>

MDN Server-sent events 文档说明 SSE 可以由服务器向网页推送消息；如果以后要求管理员切组后毫秒级同步，可以在当前轮询基础上升级 SSE。来源：<https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events>

MDN WebSocket 文档说明 WebSocket 用于创建和管理浏览器到服务器的连接并双向收发数据；当前需求主要是管理员写入、评委只读跟随，WebSocket 不是首选。来源：<https://developer.mozilla.org/en-US/docs/Web/API/WebSocket>

## 推荐方案

采用“服务端持久化当前组别 + 管理员写入 + 评委轮询只读跟随”的方案。

不建议第一版引入 SSE/WebSocket。原因：

- 当前系统已经有 `GET /api/state` 轮询：管理员 2 秒、评委 5 秒。
- 组别切换是低频现场控制，不是高频协同编辑。
- 文件存储和 MySQL 存储路径已有 `updateState`、审计日志和日检覆盖，新增字段成本低。
- SSE/WebSocket 会引入长连接、断线重连、代理兼容和更多现场运维变量，可以作为第二阶段优化。

## 状态模型

在服务端比赛状态中新增控制字段：

```json
{
  "activeGroupId": "gaozhi",
  "activeGroupRevision": 0,
  "activeGroupUpdatedAt": ""
}
```

字段含义：

- `activeGroupId`：管理员当前控制的比赛组别，默认 `defaultGroupId`。
- `activeGroupRevision`：组别切换版本号，用于前端显示和后续冲突/审计。
- `activeGroupUpdatedAt`：最近一次切组时间，便于审计和现场排查。

文件存储：

- 加到 `contest-state.json` 顶层。
- `sanitizeState()` 对旧状态兼容：缺失时补 `defaultGroupId`、`0`、空时间。

MySQL 存储：

- 推荐新增一张小表，例如 `contest_final_control_state`：

```sql
CREATE TABLE IF NOT EXISTS contest_final_control_state (
  control_key VARCHAR(64) NOT NULL,
  control_value VARCHAR(255) NOT NULL DEFAULT '',
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at VARCHAR(64) NOT NULL DEFAULT '',
  PRIMARY KEY (control_key)
);
```

- 使用 `control_key = 'active_group'` 存当前组别。
- 导入、导出、smoke test 都要纳入这张表。

## API 方案

保守做法：直接扩展现有接口。

`GET /api/state` 返回：

```json
{
  "activeGroupId": "gaozhi",
  "activeGroupRevision": 0,
  "activeGroupUpdatedAt": ""
}
```

`GET /api/scoreboard` 可以一起返回这些字段，便于成绩展示页以后也跟随控制组别；当前成绩展示页仍保留 URL query 和键盘导航，不强制改动。

新增管理员接口：

```http
PUT /api/active-group
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "groupId": "zhongzhi",
  "revision": 0
}
```

响应：

```json
{
  "ok": true,
  "activeGroupId": "zhongzhi",
  "activeGroupRevision": 1,
  "activeGroupUpdatedAt": "2026-07-09T..."
}
```

校验：

- 只有管理员可写。
- `groupId` 必须存在于 `contestGroups`。
- `revision` 不匹配时返回 `409`，避免多个管理员页面互相覆盖。
- 审计日志 action 建议为 `active_group_write`，包含 previousGroupId、nextGroupId、revision from/to、actor。

## 前端方案

### 管理员端

- 保留管理员端 `GroupSelector`。
- 管理员选择组别时，不再只调用本地 `selectContestGroup()`；应调用 `saveActiveGroupToServer(groupId, revision)`。
- 保存成功后：
  - 更新本地 `activeGroupState`。
  - 调用现有本地切组逻辑，把管理员页面切到该组。
  - 显示纯文本 toast，例如 `当前组别已切换为 中职组`。
- 保存失败：
  - `401/403` 走登录失效。
  - `409` 拉取最新状态并提示 `当前组别已被其他管理员更新，请核对后重试`。
  - 网络失败提示 `当前组别未同步，请检查评分服务器`。

### 评委端

- 删除评委端 XPath 对应的 `<GroupSelector className="judge-group-selector" />`。
- 评委端使用服务端返回的 `activeGroupId` 来设置 `selectedGroupId`。
- 评委端不提供本地切组按钮，也不把当前组别写入 localStorage。
- 当轮询发现 `activeGroupId` 改变：
  - 关闭队伍下拉、关闭评分键盘。
  - 切到新组第一支队伍，或如果当前 `candidateId` 正好属于新组则保留。
  - 保留所有已录入评分数据，因为评分数据按 `judgeId + candidateId` 存储，不依赖当前页面组别。
  - 可显示纯文本 toast：`当前比赛组别已切换为 中职组`。

### 离线降级

- 如果评委端暂时连接不上服务器，不应允许本地自由切组。
- 可继续显示最后一次成功同步的组别和队伍，并显示现有 `服务器未连接，本机暂存` 状态。
- 重新连上后以服务端 `activeGroupId` 为准。

## 影响文件

预计需要修改：

- `contest-server.mjs`
  - `createState()`、`sanitizeState()`、`createScoreboardState()`、`GET /api/state`
  - MySQL read/write 序列化
  - 新增 `PUT /api/active-group`
  - 审计日志白名单加入 `active_group_write`

- `src/App.jsx`
  - 新增 active group 加载/持久同步状态
  - `fetchContestStateFromServer()` 和 `fetchScoreboardStateFromServer()` 解析 active group
  - 管理员 `GroupSelector` 改为写服务器
  - 删除评委端 `GroupSelector`
  - 评委端轮询同步 active group 后调用本地切组副作用

- `scripts/daily-inspection.mjs`
  - 管理员可切组并持久化到 `/api/state`
  - 评委无法切组接口
  - 旧状态文件缺失 active group 时仍能启动
  - 审计日志包含 `active_group_write`，且不记录 polling 噪声

- MySQL 相关脚本
  - `scripts/mysql-schema.sql`
  - `scripts/import-state-to-mysql.mjs`
  - `scripts/export-state-to-sql.mjs`
  - `scripts/mysql-smoke.mjs`

- 文档
  - `AGENTS.md`
  - `docs/mysql-deployment.md`
  - `docs/final-competition-runbook.md`

## 测试清单

最低日检要覆盖：

1. 新状态默认 `activeGroupId === defaultGroupId`。
2. 管理员 `PUT /api/active-group` 成功后，`GET /api/state` 对管理员和评委都返回新组别。
3. 普通评委 `PUT /api/active-group` 返回 `403`。
4. stale revision 返回 `409`。
5. 审计日志记录 `active_group_write`，但继续不记录 `state_read` 轮询。
6. 旧 `contest-state.json` 没有 active group 字段时，服务端自动补默认值。
7. 前端构建通过，源码检查确认评委分支不再渲染 `judge-group-selector`。

## 结论

合适的一期实现是：新增服务端当前组别控制状态，管理员端唯一可写，评委端删除组别选择并通过现有 `/api/state` 轮询跟随。这样满足“组别由管理员端控制”的真实需求，同时保持当前 LAN 单实例 Node 服务和 MySQL/file 双存储架构稳定。

