# 管理员队伍信息编辑稳定性检查 2026-07-07

## 检查对象

- 表单 XPath：`//*[@id="root"]/main/section[2]/div/form`
- 对应页面区域：管理员工作台「队伍信息与应急处理」里的 `admin-edit-form`
- 目标：确保管理员可以稳定编辑队伍名称、项目名称，并处理保存、切换、轮询、权限和异常请求边界。

## 发现的问题

1. 快速连续保存同一队伍信息时，请求没有按队伍做 in-flight 保护，旧保存响应有机会覆盖本地最新编辑。
2. 队伍信息离线暂存后，服务器恢复连接时不会自动重试同步。
3. 表单有未保存草稿时，通过综合评分列表里的「管理」按钮切换队伍，会绕过 `selectAdminCandidate`，可能造成当前队伍 ID 和草稿内容错位。
4. 管理员编辑 API 缺少可重复的隔离回归脚本，之前验证容易污染 `data/contest-state.json`。

## 已处理

- 管理员编辑表单移除组织来源身份字段，只保留「选择队伍」「队伍名称」「项目名称」。
- 评委队伍列表、管理员综合评分列表、大屏队伍选择器不再展示组织来源身份，改为展示项目/产品信息。
- 前端默认队伍数据不再携带组织来源身份；服务端 `candidateOverrides` 清洗时也会丢弃旧的 `name` 字段。
- 增加队伍信息草稿比较和草稿缓存，未保存草稿切换队伍后不会丢失，切回后仍能继续编辑。
- 「管理」按钮统一走 `selectAdminCandidate`，不再直接设置 `adminCandidateId`。
- 队伍信息保存增加 per-candidate in-flight 保护：同一队伍一次只允许一个保存请求在路上；新草稿保留在 pending 中，旧响应返回时不会覆盖最新本地值。
- 服务器状态轮询成功后，会自动 flush 未同步的队伍信息 pending 改动。
- `contest-server.mjs` 支持 `CONTEST_DATA_DIR`，用于隔离测试数据目录，不改变默认正式数据目录。
- 新增 `scripts/admin-edit-regression.mjs`，覆盖管理员编辑接口成功路径和关键异常边界。

## 自动化覆盖

命令：

```bash
npm run check:admin-edit
```

覆盖项：

- 管理员保存 A01 队伍信息后，`/api/state` 和 `/api/scoreboard` 都能读取到新值。
- `/api/state` 和 `/api/scoreboard` 的队伍覆盖信息不返回旧的 `name` 字段。
- 评委账号编辑队伍信息返回 `403`。
- 未知队伍返回 `404`。
- 非法 JSON 返回 `400`。
- 超过服务端请求体上限返回 `413`。
- 恢复默认会删除该队伍 override。
- 测试服务器使用临时 `CONTEST_DATA_DIR`，结束后自动删除临时数据。

## 本轮验证结果

- `npm run build`：通过。
- `node --check contest-server.mjs`：通过。
- `node --check scripts/admin-edit-regression.mjs`：通过。
- `npm run check:admin-edit`：通过，输出 `admin edit regression passed`。
- 最新预览服务器已在 `http://127.0.0.1:5188/` 启动，健康检查 `/api/health` 正常。

## 限制

- 本轮尝试连接 in-app browser，但浏览器插件返回可用浏览器列表为空，无法实际打开内置预览页面截图。
- 已用构建、服务端健康检查、隔离 API 回归和代码路径核查覆盖核心编辑稳定性；仍建议在 in-app browser 可用时补一次真实点击表单回归。
