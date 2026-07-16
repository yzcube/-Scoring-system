# 决赛评分架构重构记录

日期：2026-07-13

## 目标与证据

本轮先盘点了评分规则、派发控制、MySQL 写入和现有回归脚本，再做模块化调整。盘点发现同一套评分项、两位小数归一化、总分和综合分计算曾分别存在于浏览器、服务端和状态迁移/回归工具中；派发、展示发布和评分写入的业务判断则与 HTTP、审计和存储代码交织在服务端。

重构后的边界如下：

| 模块 | 负责 | 不负责 | 主要调用方 |
| --- | --- | --- | --- |
| [`shared/scoringRules.js`](../shared/scoringRules.js) | 固定评分细则、0.01 归一化、条目清洗、分单位总分、去高去低综合分、格式化 | 身份、队伍选择、持久化、UI 状态 | 浏览器、服务端、迁移工具、回归工具 |
| [`shared/contestData.js`](../shared/contestData.js) | 固定比赛分组、初始队伍与默认出场顺序 | HTTP、存储、UI 状态 | 浏览器、服务端、迁移工具、回归工具 |
| [`domain/contestControl.js`](../domain/contestControl.js) | 派发、名册快照、展示发布、评分写入、版本冲突和最小 MySQL 变更描述 | HTTP 解析、会话查询、审计落盘、文件或 MySQL I/O | 服务端路由 |
| [`server/auth-session.mjs`](../server/auth-session.mjs) | 密码 KDF、限流、令牌、会话校验 | 比赛状态和路由业务 | API 入口与状态队列 |
| [`server/state-store.mjs`](../server/state-store.mjs) | 单一写队列、排队后二次会话校验、状态清洗和一次持久化 | 文件/MySQL 的具体实现 | 服务端路由 |
| [`server/http-routes.mjs`](../server/http-routes.mjs) | JSON 输入、错误响应和静态路由 | 鉴权、比赛规则和审计策略 | API 入口 |
| [`server/session-api-routes.mjs`](../server/session-api-routes.mjs) | 健康检查、登录、会话、登出、受控状态与投屏读取端点 | 比赛写入和存储事务 | API 入口 |
| [`server/contest-api-routes.mjs`](../server/contest-api-routes.mjs) | 队伍、账号、名册、派发、展示、评分写端点；评分写入审计快照 | 会话实现、写队列和存储 I/O | 服务端入口 |
| [`server/storage/contest-storage.mjs`](../server/storage/contest-storage.mjs) | 文件迁移与原子写、MySQL schema/初始化、一致性读取、精确 mutation 写入、健康检查与关闭 | HTTP、会话判定、写队列和领域操作 | 服务端入口、会话模块 |
| [`contest-server.mjs`](../contest-server.mjs) | 依赖组合、状态编解码、展示投影、审计、进程生命周期 | 路由业务、存储实现、评分计算和会话实现 | 启动入口 |

`contestControl` 有意保持为无 I/O 的领域操作模块：每个操作直接修改传入的比赛状态，并返回供存储层使用的 `mutation` 描述。这样业务规则可由 Node 内置测试直接验证，而服务端仍保留一次排队、一次会话复核和一次事务写入的现场并发语义。

## 已落实的不变量

- 评分项和满分只在 `scoringRules` 定义；所有分数统一用 100 分单位计算和格式化。
- 固定比赛分组、初始队伍和默认出场顺序只在 `shared/contestData.js` 定义；服务端不再导入 `src/`。
- 未填写完全部评分项的条目不能以已提交状态保存；恢复的数据会清除未知项并限制到各项满分。
- 评委只能写入自己、当前派发、当前名册和匹配派发版本的评分条目；评分条目版本仍防止同账号多设备静默覆盖。
- 首次派发锁定有效评分名册并为队伍保存快照；最终综合分以该快照为准。
- 已发布结果被管理员撤回或修正时，展示状态转为 `review_required`，不能继续显示过期最终分。
- MySQL 模式下评分写入始终只 upsert 对应的评委/队伍条目；只有当前派发状态或展示状态实际变化时，才额外持久化相应控制对象。

## 刻意未做的拆分

没有仅因 `App.jsx` 文件较长而拆出会话或评分页面状态。该区域中的会话代际、取消在途请求、草稿同步和键盘焦点彼此共同维护一个正确性边界；当前拆分会扩大跨组件时序风险，却没有移除重复的领域规则。

同样没有把 MySQL 或文件存储搬进领域模块。存储事务、排队和会话复核必须留在服务端基础设施边界，才能保证延迟请求不会绕开最新的会话和版本校验。

评分细则继续是固定规则，不在管理员后台开放编辑。若未来需要变更细则，必须引入评分细则版本并把每条历史评分绑定到其版本，不能直接修改现有常量。

## 复核记录

### 第一轮：结构与重复定义

- 全仓扫描确认 `rubric`、`itemIds` 和 `itemMax` 的唯一生产定义在 `shared/scoringRules.js`，比赛基线数据的唯一生产定义在 `shared/contestData.js`。
- 浏览器、服务端、导入导出工具、MySQL 冒烟工具和管理员回归脚本均改为导入共享规则。
- 派发、发布、写分、综合分查询和展示失效的业务实现只保留在 `domain/contestControl.js`；路由只做输入规范化、鉴权、审计和响应。

### 第二轮：领域与并发契约

- `test/scoringRules.test.mjs` 覆盖小数归一化、满分截断、条目清洗、完整提交、整数分总分和去高去低。
- `test/contestControl.test.mjs` 覆盖名册锁定、当前派发限制、最终综合分、撤回后展示待复核，以及管理员修正非当前队时不触碰派发/展示控制对象。
- `test/stateStore.test.mjs` 覆盖同一写队列中的重新鉴权和有序持久化，防止拆分后出现延迟请求覆盖新状态。
- `test/contestStorage.test.mjs` 直接覆盖文件适配层初始化、迁移、读取、原子写和 file 模式不创建 MySQL pool。
- `test/appScoringImport.test.mjs` 覆盖管理员评分汇总使用的共享格式化与总分函数均已导入，防止模块迁移后保留未定义调用。
- 服务端在写队列内再次核验会话和角色，之后才执行领域操作和根据 `mutation` 持久化；旧会话和过期版本不能在队列等待后写入。

### 第三轮：构建与运行路径

- `npm test`：30 项通过。
- `npm run check:daily`：10 项检查通过，包含构建、共享模块契约、状态迁移干跑、管理员控制回归和队伍管理回归。
- `node scripts/import-state-to-mysql.mjs --dry-run`：通过，现有状态可被迁移工具读取。
- `node --check`：通过于新增模块和相关脚本。
- `npm run check:docker`：通过真实多阶段镜像构建、容器健康检查和 `/scoreboard` 静态路由验证。
- `npm audit`：生产和开发依赖均为零漏洞；`vite` 已从 `6.4.2` 升至安全补丁 `6.4.3`。

### 第四轮：拆分后调用链复核

- `contest-server.mjs` 仅将 HTTP、会话、状态队列、领域写入、路由和存储模块组合起来；业务写请求仍只经由 `state-store` 中唯一的 `writeQueue`。
- 路由顺序保持为“首次鉴权和输入校验 -> 入单队列 -> 最新状态读取和二次鉴权 -> 领域 mutation -> 状态清洗 -> 精确持久化 -> 审计 -> 响应”。
- 存储模块不含 `writeQueue`，MySQL 读取使用一致性快照，评分写入只 upsert 对应评分项；同顺序重试作为 `noop` 保留二次鉴权但不产生写入。
- 静态搜索确认 `contest-server.mjs` 和 `server/` 不再导入 `src/`；共享规则和固定赛程数据只从 `shared/` 提供。

## 尚待现场环境验证的边界

- `npm run check:mysql` 已正确停在环境校验：当前工作区没有 `CONTEST_MYSQL_DATABASE` 和 `CONTEST_MYSQL_USER`。未创建额外 Docker 数据库，符合决赛服务器使用宿主 MySQL 的约束；提供现有 MySQL 连接配置后应运行该冒烟检查。
- 当前执行环境没有可用的内置浏览器实例，因此无法在此轮生成平板/投屏截图。构建、API 回归和本地 HTTP 路由已验证；实际决赛设备仍应按运行手册完成多平板与投屏走查。
