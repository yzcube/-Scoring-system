# 管理员控制改造：安全与并发实施依据

日期：2026-07-13

本文补充 [管理员统一控制与后台化方案边界研究](./admin-control-boundary-research-2026-07-13.md) 中账号、会话、登录保护和 MySQL 一致性部分。只记录实施决策；不改变评分规则或前端交互。

## 已核实的项目约束

- [package.json](../package.json) 声明 Node `>=22.12.0 <25`，且 [.nvmrc](../.nvmrc) 锁定 `22.12.0`。因此实现不能依赖仅在 Node 24 才有的内置 API。
- 调研开始时，[contest-server.mjs](../contest-server.mjs) 将初始化账号密码保留在进程常量中，会话只保存在 `sessionsByToken` 内存 Map。现已改为持久化账号密码哈希；MySQL 模式将 token 哈希保存到 `account_sessions`，文件模式仅作为本地开发/回退使用内存会话。
- MySQL 现有的 `entries`、`candidate_overrides`、`candidate_order` 和 `control_state` 表没有账号、队伍实体、名册、派发或展示选择的外键关系。`entries` 的 `ON DUPLICATE KEY UPDATE` 没有把期望 revision 放进 SQL 条件，因此不能作为新后台并发正确性的边界。
- 正式环境应继续使用现有宿主机 MySQL 8.0 和单个 Node 进程；这不替代数据库事务、外键和版本校验。

## 决策 1：密码哈希采用 Node 22 内置 scrypt

**采用 `crypto.scrypt()`，不采用 `scryptSync()`，不在本次改造依赖内置 Argon2。** Node 22 已提供异步 `scrypt`；它明确将该算法描述为为抗暴力破解而设计的、计算和内存都昂贵的 KDF，并建议随机且至少 16 字节的 salt。[Node 22 `crypto.scrypt`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)

Node 的内置 `crypto.argon2()` 是 **v24.7.0** 才加入的 API；虽然当前开发机可能是 Node 24，声明的 Node 22.12 基线不能使用它。[Node `crypto.argon2` 版本记录](https://nodejs.org/api/crypto.html#cryptoargon2algorithm-parameters-callback) 因此第一期不要为了 Argon2 临时引入原生依赖或悄悄提高最低 Node 版本。以后若正式把运行时基线升到至少 Node 24.7，再单独评估迁移到 Argon2id。

推荐的可版本化存储格式：

```text
scrypt$v1$131072$8$1$<salt-base64url>$<derived-key-base64url>
```

- 生成每个密码独有的 `randomBytes(16)` salt；保存 32 字节派生值。Node 的默认 `N=16384`、`r=8`、`p=1` 和默认 `maxmem=32 MiB` 只是 API 默认值，不应当无意中成为正式安全参数。[Node 22 scrypt 参数](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
- 压测通过时优先采用 `N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 * 1024`（约 128 MiB）。若云主机内存不能承受该档位的受限并发，OWASP 还列出同等最低防护档位 `N: 2 ** 15, r: 8, p: 3`；为它显式设置不少于 `64 MiB` 的 `maxmem` 并在编码中存储参数。Node 对 `maxmem` 的检查近似为 `128 * N * r`，所以不能沿用默认 32 MiB。[OWASP 密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)
- 登录路径必须限制同时进行的 scrypt 数量（例如 1-2 个）并在正式云主机实测 P95 延迟和峰值内存；不能让攻击者以并发登录耗尽 libuv 线程池或内存。`crypto.scrypt()` 是异步 API，但仍是昂贵工作，不能把它当作免费操作。[Node 避免阻塞事件循环和工作池](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- 验证时解析并严格白名单 `v1/N/r/p`，用同一参数重新派生，长度一致后用 `crypto.timingSafeEqual()` 比较。该 API 只保护比较本身，周边控制流仍须避免明显时序差异。[Node `timingSafeEqual`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b)
- 登录输入若允许 Unicode，必须在建 hash 和验证时采用并长期保持同一种 Unicode 规范化策略；Node 不会替应用自动规范化组合/分解形式。[Node 加密 API 的字符串注意事项](https://nodejs.org/docs/latest-v22.x/api/crypto.html#using-strings-as-inputs-to-cryptographic-apis)
- `accounts.password_hash` 保存完整编码串；禁止向 API、JSONL 日志、异常对象或管理列表返回它。密码重置后以新 hash 替换并增加 `auth_version`。可在下一次成功登录时按旧参数渐进 rehash。

**现场风险：** `001` 至 `007` 且密码相同、`admin/admin123` 作为长期正式凭据时，慢哈希和限速都不能抵消凭据公开且可预测的风险。若这些只能作为演示/初始化凭据，首启后应由管理员重置；若比赛规则强制保留，须将其视为受控 LAN 内的低强度凭据，并采用更严格的限速、访问网络隔离和管理员审计。

## 决策 2：以持久化的会话记录和账号版本实现撤销

使用不透明的 256-bit bearer token，不使用只含账号角色的自描述 token。令客户端保留原有的 `sessionStorage` 方式，每个浏览器 tab 独立保存 token；服务端在 MySQL 模式保存会话，避免 Node 重启或两台设备之间的内存状态成为认证真相。

建议最小表结构如下，字段名可随现有命名统一：

```text
accounts
  id, username UNIQUE, role, status,
  password_hash, auth_version BIGINT UNSIGNED,
  failed_attempts, locked_until, created_at, updated_at

account_sessions
  id, account_id FK, token_hash BINARY(32) UNIQUE,
  auth_version, issued_at, idle_expires_at, absolute_expires_at,
  last_seen_at, revoked_at, device_label
```

- 登录时以 `randomBytes(32)` 生成 token，只把 `SHA-256(token)` 持久化；响应中的明文 token 只出现一次，JSONL 不记录 token、hash 或 Authorization 头。`randomBytes()` 使用加密安全熵源。[Node 22 `randomBytes`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptorandombytessize-callback)
- 每个受保护请求都以 token hash 联接 `account_sessions` 和 `accounts`，并同时检查 `revoked_at IS NULL`、两个过期时间、`accounts.status = 'active'`、`session.auth_version = account.auth_version`。不要只信任登录时缓存在 token Map 里的角色快照。
- Bearer 解析只接受一个语法完整的 `Authorization` 值；不要让重复头、逗号拼接或错误格式静默选择其中之一。原生 `node:http` 的默认 headers 对重复 `authorization` 有合并/丢弃规则，需要按其接口语义明确验证。[Node HTTP headers](https://nodejs.org/docs/latest-v22.x/api/http.html#messageheaders)
- 正常登录不改变 `auth_version`，因此同一账号可保持多设备会话。单设备退出只撤销对应 session；禁用账号、密码重置和“强制退出所有设备”在同一事务中增加 `auth_version`，旧 session 随后的每个请求都会失败。这个模型既支持多设备，又能立即全局撤销。
- 设置固定的绝对过期时间和可续期的闲置过期时间；只在接近闲置期限时更新 `last_seen_at`/`idle_expires_at`，避免 2 秒轮询导致每次读状态都写数据库。OWASP 建议会话具有明确的过期与注销机制，并在权限级别变化后更新会话标识。[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- 分数保存、提交、管理员撤回/清空等写操作在其**最终数据库事务内**再次确认会话和账号版本。这样 logout、禁用或强制退出与已在飞的写请求竞争时，旧请求不会在失效后仍然落库。
- 客户端仍需维持 `sessionGeneration`：登录、退出和 401/会话过期时递增 generation、abort 所有旧 controller，并且只接受与发起请求时 generation 相同的响应。这是服务器撤销的配套，不可用前端轮询替代。
- 对直接暴露在 LAN 的 `node:http` 服务显式设置非零 `headersTimeout` 和 `requestTimeout`；Node 将这两个服务器参数列为无反向代理时抵御慢请求型 DoS 的保护。[Node `headersTimeout`](https://nodejs.org/docs/latest-v22.x/api/http.html#serverheaderstimeout) [Node `requestTimeout`](https://nodejs.org/docs/latest-v22.x/api/http.html#serverrequesttimeout)

## 决策 3：登录限速以账号为主、持久化并保持通用错误

NIST 要求验证方限制同一账号连续失败认证次数，通常上限不应超过 100；其示例也允许随失败次数增加等待时间。[NIST SP 800-63B 3.2.2](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/#throttle) OWASP 进一步建议失败计数绑定账号而非仅绑定 IP，并提醒固定长锁定时间会造成拒绝服务风险。[OWASP 登录限速](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#login-throttling)

实施建议：

1. 对已知账号在 MySQL 中保存连续失败数和 `locked_until`；成功登录在同一事务中归零。未知用户名使用同样的通用响应和一次固定 dummy scrypt 验证，避免用户名存在与否出现明显的时间差。
2. 从第 5 次连续失败开始使用短暂指数退避（例如 5s、30s、2min、10min，上限 15min），而不是永久自动禁用评委。达到更高阈值时让管理员在后台明确解锁，并记录脱敏审计；无论如何不能超过 NIST 的 100 次上限。
3. 在账号节流外加一个有界的进程级全局/IP 粗限流，防止随机用户名和昂贵 dummy scrypt 形成资源耗尽。只有在明确配置受信任反向代理时才读取 `X-Forwarded-For`；当前服务端直接记录该头但没有可信代理边界，不能把它当作身份依据。
4. 对“用户名不存在、密码错误、账号停用、处于冷却期”使用相同 HTTP 状态和相同用户文案。OWASP 明确指出差异化错误或状态码会泄露账号存在性。[OWASP 通用认证错误](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-responses)
5. 审计记录只保存结果类别、已知账号 ID（若有）、受限来源摘要和冷却时间；不保存密码、token、Authorization、明文未知用户名或完整请求体。

## 决策 4：MySQL 将正确性放在事务和条件写入中

外键解决“引用不存在的队伍/评委”，不能自行解决“当前派发已变化”。新模型应让 `teams`、`accounts`、`assignment_roster`、`score_entries`、`active_assignment` 和 `display_selection` 成为 InnoDB 的一等记录。

- `score_entries.judge_id -> accounts.id`、`score_entries.team_id -> teams.id`、出场顺序/名册/派发/展示记录都应有对应外键。对有历史评分的队伍或账号使用 `status` 软停用；使用 `ON DELETE RESTRICT`/默认 `NO ACTION` 而不是 `CASCADE`，以免后台删除导致评分和审计历史消失。MySQL 说明 `RESTRICT` 会拒绝父记录变更，而 InnoDB 的 `NO ACTION` 等同于 `RESTRICT`。[MySQL 8.0 外键约束](https://dev.mysql.com/doc/refman/8.0/en/create-table-foreign-keys.html)
- 为 `active_assignment` 和 `display_selection` 使用各自的 singleton 主键和 `BIGINT UNSIGNED revision`。二者不能共用一条“当前队伍”字段，才能支持评委开始下一队而投影保持上一队。
- 派发事务先锁 `active_assignment` 行，再按稳定顺序读取/锁必要的名册与上一队状态，核对管理员提交的 revision，创建该次 `assignment_revision` 的固定名册和全部空 `score_entries` 行，最后更新派发状态并提交。MySQL 默认 autocommit 会让每条语句独立提交；多语句不变量必须显式 `START TRANSACTION`/`COMMIT`，且 `SELECT ... FOR UPDATE` 只在事务中有效。不要把 `CREATE/ALTER/DROP` 混入业务事务，因为部分 DDL 会隐式提交。[MySQL 8.0 事务](https://dev.mysql.com/doc/refman/8.0/en/innodb-autocommit-commit-rollback.html) [MySQL 8.0 locking reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html) [MySQL 隐式提交](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html)
- 评委写分事务先以 `SELECT ... FOR UPDATE` 锁 `active_assignment`，验证 `team_id`、`assignment_revision`、派发状态、固定名册和账号角色，再执行带期望 revision 的条件更新：

```sql
UPDATE score_entries
SET scores_json = ?, submitted = ?, row_revision = row_revision + 1, updated_at = CURRENT_TIMESTAMP
WHERE judge_id = ?
  AND team_id = ?
  AND assignment_revision = ?
  AND row_revision = ?;
```

将 `affectedRows !== 1` 统一作为 `409 Conflict`，返回权威条目/派发版本；绝不能在冲突后以新的 revision 自动重放旧草稿。上面的模式是基于 MySQL locking read 与行更新语义做出的实现推论，目的是让服务器而非客户端决定旧请求是否可写入。

现有 `mysql2` 版本的默认 client flags 包含 `FOUND_ROWS`，因此不要以 `changedRows` 或未修改字段来判断乐观锁是否成功。上例每次匹配都递增 `row_revision`，故 `affectedRows = 1` 仍可明确表示匹配，`0` 表示版本/目标不匹配；把这一点写入 MySQL smoke 回归，避免未来调整 SQL 后重新引入歧义。

- 管理员队伍编辑、出场排序、派发、展示发布和应急撤回也都使用“资源 ID + expected revision”的条件更新。`server/state-store.mjs` 中的单一写队列只能串行化这个 Node 进程，不能替代数据库中的版本条件、外键或锁。
- 统一锁顺序为 `active_assignment -> team/account -> entry`，事务内不做 scrypt、网络请求或 JSONL I/O。InnoDB 的默认隔离级别是 `REPEATABLE READ`，而锁定读用于需要精确一致性的关键操作。[MySQL 8.0 隔离级别](https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html)
- 死锁和锁等待必须可观察。只对有幂等请求 ID 的短写事务进行有限次数重试；否则返回可恢复错误并要求客户端刷新。MySQL 建议应用准备好重试因死锁回滚的事务。[MySQL 8.0 deadlock handling](https://dev.mysql.com/doc/refman/8.0/en/innodb-deadlocks-handling.html)
- 正常运行不得关闭 `foreign_key_checks`；重新开启该开关不会回头验证关闭期间写入的行，因此它不能作为迁移或应急清分的捷径。[MySQL `foreign_key_checks`](https://dev.mysql.com/doc/refman/8.0/en/server-system-variables.html#sysvar_foreign_key_checks)

## 审计与迁移顺序

1. 先建新表和索引，导入队伍/账号/名册，生成 hash，不删除旧评分表；迁移脚本必须验证 7 位评委、80 支既有队伍、出场顺序和历史评分计数。
2. 先上线只读的账户/名册/控制状态读取，再切换登录与 token 校验，最后打开后台新增、停用、派发和展示发布写入口。每一步可回滚到旧只读路径，不能把明文密码或新账号表混进旧 `accounts` 常量逻辑。
3. 每个“评分或控制状态成功写入”事务应同时落一条可重放的 audit-outbox 记录；提交后异步追加 JSONL，启动时补发未写出的记录。直接在 HTTP 响应后 `appendFile` 不能保证数据库已提交的关键操作一定有审计记录，也不能将文件写入和 MySQL 提交原子化。
4. 验收至少覆盖：两台设备同账号同条目冲突、管理员派发与旧请求竞态、禁用/重置后旧 token 拒绝、logout 与在飞保存竞态、节流跨服务重启仍有效、外键拒绝已归档实体的非法新写入、MySQL 死锁/超时后的可解释响应、JSONL 失败后的 outbox 补发。

## 必须在实施前确认的高风险结论

- **不能在 Node 22.12 基线使用内置 Argon2。** 选择 scrypt，或将运行时升级到 Node 24.7+ 并重新评估部署；二者必须明确选一个。
- **MySQL 正式部署必须使用持久化账号、会话和 auth version。** 文件模式的内存会话只适用于本地开发、临时评审或故障回退，不能当作跨设备正式认证真相。
- **当前 MySQL 条目 upsert 与进程内队列不是派发边界。** 没有“锁定派发状态 + `assignment_revision` + `row_revision` 条件写入”，延迟的旧请求仍缺少数据库级拒绝依据。
- **已知三位数/默认密码是现场账号安全的最大非代码风险。** 若不能更换，需由赛事网络隔离、严格限速和管理审计共同补偿，并在运行手册中明确接受该风险。
