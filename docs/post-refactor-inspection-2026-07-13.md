# 本次重构后巡检

日期：2026-07-13

## 巡检结论

需要补充验证。文件模式、Docker 运行路径和所有可在当前工作区执行的调用链已通过；MySQL 实例级冒烟与真实平板/投屏浏览器走查仍需要现场连接配置和可用浏览器实例。

## 本次涉及链路

- 入口：`contest-server.mjs` 启动时校验存储模式，初始化 `createContestStorage`，再组合会话、唯一状态队列和两类 API 路由。
- 关键文件：`shared/scoringRules.js`、`shared/contestData.js`、`domain/contestControl.js`、`server/state-store.mjs`、`server/auth-session.mjs`、`server/session-api-routes.mjs`、`server/contest-api-routes.mjs`、`server/storage/contest-storage.mjs`。
- 核心处理顺序：写端点先做请求鉴权和输入准备，随后进入 `state-store` 的唯一 `writeQueue`；队列内重新读取状态和校验会话，执行领域操作，清洗状态，按 mutation 精确持久化，成功后记录审计并返回。
- 关键数据流：共享评分规则 -> 领域 mutation -> state store -> 文件原子写或 MySQL 事务；会话失效/登出同样进入该队列，阻止队列中的旧请求随后写入。

## 重点检查结果

- 功能实现：服务端已不依赖 `src/` 中的规则或赛程数据；共享规则迁至 `shared/`，领域控制迁至 `domain/`。认证/会话、存储、HTTP 会话路由和比赛写路由已分模块。
- 介入时机：写操作在队列内二次鉴权，避免请求排队期间登出、禁用账号或会话过期后继续写入；前端会话切换会中止刷新、保存和管理员写请求。
- 处理顺序：派发、展示发布和评分仍通过领域函数返回最小 mutation；`noop` 排序重试保留鉴权但跳过持久化；评分成功后才写审计结果和响应。
- 完整链路：管理员控制回归覆盖登录、名册锁定、派发、强制切换、评分、最终发布、撤回、账号停用和 JSONL 审计；队伍管理回归覆盖编辑、创建、排序、权限和评委状态投影。
- 边界与异常：覆盖重复名册快照、旧会话、评分版本冲突、无派发写入、已发布成绩撤回、非法静态路径、非法编码、存储不可用和关停健康检查。
- 回归风险：Docker 多阶段镜像已验证包含 `shared/`、`domain/` 和 `server/`；`vite` 安全补丁升级至 `6.4.3` 后，完整依赖审计为零漏洞。

## 发现的问题

- 已修复：重复评委快照曾可能伪造完整名册；状态清洗和领域读取已双层去重，并有回归测试。
- 已修复：成功写入与慢轮询竞态可能覆盖新状态；前端已通过会话代际、AbortController 和刷新代际阻止旧响应生效。
- 已修复：同顺序重试原会产生不必要持久化；现在作为 `noop` 保留队列鉴权但不写文件或 MySQL。
- 已修复：`vite@6.4.2` 存在 Windows 开发服务器路径处理通告；已升级到 `6.4.3`。
- 已修复：管理员提交矩阵在共享评分规则迁移后调用了未导入的 `formatCents`，并调用了不存在的 `getTotalCents`；现改为导入 `formatCents` 和 `getScoresTotalCents`，且有源码级回归测试。
- 待现场验证：缺少 `CONTEST_MYSQL_DATABASE` 和 `CONTEST_MYSQL_USER`，因此未运行真实 MySQL 冒烟；当前环境没有可用内置浏览器实例，未生成平板和投屏截图。

## 验证结果

- 已运行：`npm run build`、`npm test`、`npm run check:daily`、`npm run check:docker`、`npm audit`、`node --check`、迁移工具 dry-run 和静态依赖搜索。
- 结果：构建通过；30 项单测通过；日检 10 项通过；Docker 冒烟通过；生产与开发依赖审计均为零漏洞。
- 未验证项及原因：`npm run check:mysql` 在缺少现场 MySQL 环境变量时按设计失败；浏览器实例不可用，无法执行截图式平板/大屏视觉走查。
