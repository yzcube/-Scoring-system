# 赛中临时新增评委：外部方案调研与架构建议

日期：2026-07-14  
状态：方案调研，不包含业务代码修改  
关联现状审计：[管理员端临时新增评委全链路调研](./dynamic-judge-addition-research-2026-07-14.md)

## 1. 调研结论

推荐把“临时新增评委”建模为三个相互独立的概念：

1. **账号身份**：评委能否登录。
2. **计划名册**：评委将从哪一次派发开始参与评分。
3. **队伍派发快照**：某支队伍实际由哪些评委评分；一旦产生评分，默认不可被普通名册修改追改。

普通增员的默认语义应为：**创建账号并加入计划名册，从下一支首次派发的队伍开始生效；当前队、已完成队和已发布成绩保持原样。**

当前队应急补入或替换不是普通增员的一个勾选项，而是独立的高风险流程。第一阶段建议不开放“已有草稿或提交后的当前队换人”；确有竞赛规则要求时，再用新的派发版本、明确替换关系、影响预览和完整审计实现。

## 2. 外部系统给出的共同模式

### 2.1 身份、资格与具体任务分开

Microsoft CMT 明确区分“邀请评审”和“分配论文”：获得评审角色不等于已经被分配任务；管理员可对具体论文增删评审。OpenReview 也把评审组成员与具体稿件的 assignment 分开，并允许在部署后补充某一稿件的分配。

这与本项目的关键问题直接对应：创建评委账号只解决身份，不能同时代表对所有当前和历史队伍拥有评分资格。评分权限应来自某次派发的成员快照。

来源：

- [Microsoft CMT：编辑评审分配](https://cmt3.research.microsoft.com/docs/help/chair/edit-reviewer-assignments.html)
- [Microsoft CMT：应急评审](https://cmt3.research.microsoft.com/docs/help/chair/emergency-reviewer.html)
- [OpenReview：部署后手工修改分配](https://docs.openreview.net/how-to-guides/paper-matching-and-assignment/how-to-do-automatic-assignments/how-to-make-manual-assignments-with-the-edge-browser-after-deployment)

### 2.2 增量补人不应覆盖已有分配

OpenReview 的多次匹配流程支持在不覆盖既有 assignment 的前提下追加分配，并警告组成员关系和 assignment 分别修改后可能不同步。Microsoft CMT 还允许重新分配误删的评审并恢复其已提交评审，说明历史结果与当前分配关系需要分开保存。

对本项目的启示是：后续名册变化只能影响未来派发，不能让系统用“最新全局名册”重算旧队伍；被替换评委的历史评分也不能物理删除或复制给新评委。

来源：

- [OpenReview：运行多次匹配](https://docs.openreview.net/how-to-guides/paper-matching-and-assignment/how-to-run-multiple-matchings)
- [OpenReview：同步手工与自动分配](https://docs.openreview.net/how-to-guides/paper-matching-and-assignment/how-to-sync-manual-and-automatic-assignments)
- [Microsoft CMT：评审相关常见问题](https://cmt3.research.microsoft.com/docs/help/faq/faq-chair-for-reviewers.html)

### 2.3 有效期版本比覆盖更新更可追溯

企业系统常用“按生效时间保存多个版本”的 date-effective 模式：过去、当前和未来版本并存，更新未来状态不会改写历史。这里不需要照搬 Oracle 数据结构，但应采用同一原则：名册是带版本的未来策略，队伍快照是已经发生的事实。

来源：[Oracle：管理日期有效对象](https://docs.oracle.com/en/cloud/saas/human-resources/farws/Manage_Date_Effective_Objects.html)

## 3. 三种方案比较

| 方案 | 做法 | 优点 | 主要风险 | 结论 |
| --- | --- | --- | --- | --- |
| A. 直接解锁全局名册 | 修改现有 `judgeRoster`，所有页面读取最新名单 | 改动最少 | 当前/历史队完成条件变化、已发布分数口径漂移、设备在飞请求错配 | 不采用 |
| B. 计划名册 + 队伍快照 | 全局名册改为未来计划；下一次首次派发复制快照 | 兼容现有模型、迁移量可控、历史稳定 | 当前队替补仍需另做 | **推荐第一阶段** |
| C. 完整名册版本 + 派发表 | 持久化 roster version、assignment、member 和替换关系 | 语义最完整，支持复杂替补与追溯 | 数据迁移和 UI/测试范围明显更大 | 第二阶段按规则需要建设 |

推荐先实施 B，但接口和存储边界按 C 的方向设计，避免再次把账号、名册和派发耦合到管理员页面。

## 4. 推荐领域模型

第一阶段可沿用当前 JSON/控制表结构，重新定义语义：

```text
accounts
  身份、登录凭据、状态、authVersion

plannedRoster
  judgeIds, revision, updatedAt, updatedBy, reason
  含义：下一支首次派发队伍使用的评委名单

activeAssignment
  teamId, assignmentRevision, rosterSnapshot, status
  含义：当前队的权威评分人员，不随 plannedRoster 改变

team.judgeRosterSnapshot
  含义：该队首次派发时确定的历史评分口径
```

关键不变量：

- 综合分、提交人数、终态判断、排名和投屏只读取队伍快照。
- 修改计划名册不修改任何已存在的队伍快照。
- 新评委在生效前可以登录，但只能看到“等待管理员派发”，不能写分。
- 切换到下一支尚无快照的队伍时，复制最新计划名册并形成不可变快照。
- 对当前队的任何成员变化都必须提升 `assignmentRevision`；旧版本的在飞保存必须被拒绝。

如果赛事明确要求复杂替补，再迁移到独立表：

```text
judge_roster_versions(roster_revision, created_by, reason, created_at)
judge_roster_members(roster_revision, account_id, sort_order, member_status)
assignments(assignment_id, team_id, assignment_revision, roster_revision, status)
assignment_members(assignment_id, account_id, status, replaced_account_id)
```

## 5. 深模块接口

管理员前端不应自行编排“创建账号 -> 保存名册 -> 写审计 -> 判断生效队伍”。服务端应提供一个完整业务操作：

```http
POST /api/admin/judge-enrollments
Idempotency-Key: <operation-id>

{
  "account": {
    "username": "008",
    "displayName": "评委 08",
    "password": "..."
  },
  "participation": "future_assignments",
  "expectedRosterRevision": 3,
  "reason": "现场临时增补"
}
```

成功响应必须说明：账号是否创建、下一版名册版本、是否影响当前队、预计从哪支队伍/哪次派发开始生效。

后续如实现当前队替补，使用另一个明确接口，例如 `POST /api/admin/assignments/:id/replacements`，不要向普通增员接口继续增加布尔开关。

这个接口是一个“深模块”：调用者只表达业务意图，账号、名册、事务、并发和审计细节由模块内部隐藏。文件存储和 MySQL 存储应是同一接口下的适配器，而不是两套业务规则。

## 6. 事务、并发与重试

MySQL 默认自动提交，组合业务操作必须显式放入同一个事务。推荐流程：

1. `BEGIN`。
2. 使用 `SELECT ... FOR UPDATE` 锁定计划名册控制行。
3. 校验 `expectedRosterRevision`、用户名唯一性和操作幂等键。
4. 创建账号及密码哈希。
5. 写入下一版名册/成员关系并增加 revision。
6. 在同一事务写入审计事件或 outbox 记录。
7. `COMMIT`；发生死锁时按 MySQL 指引重试完整事务。

`operationId`/幂等键需要唯一约束：同一键、相同请求返回首次结果；同一键、不同请求体返回冲突。现有单 Node 写队列仍可保留，但数据库事务才是故障恢复和并发正确性的权威边界。

HTTP 层继续使用现有 revision + `409 Conflict` 已足够；未来也可按 HTTP 条件请求使用 `If-Match` 防止丢失更新。不要依赖仍处于 Internet-Draft 状态的 Idempotency-Key 规范作为唯一依据，可以采用 Stripe/AWS 已验证的客户端令牌语义。

来源：

- [MySQL：InnoDB 语句锁](https://dev.mysql.com/doc/refman/8.0/en/innodb-locks-set.html)
- [MySQL：事务隔离级别](https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html)
- [MySQL：死锁处理](https://dev.mysql.com/doc/refman/8.0/en/innodb-deadlocks.html)
- [RFC 9110：条件请求与幂等方法](https://www.rfc-editor.org/rfc/rfc9110.html)
- [Stripe：幂等请求](https://docs.stripe.com/api/idempotent_requests)
- [AWS EC2：客户端令牌幂等](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html)
- [AWS：事务性 Outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

## 7. 当前队应急策略

建议按数据状态设硬边界：

| 当前队状态 | 普通增员 | 当前队应急操作 |
| --- | --- | --- |
| 尚未派发 | 新评委进入下一次派发 | 不需要应急流程 |
| 已派发、无人保存草稿 | 默认下一队生效 | 可选允许重发快照，提升 assignment revision |
| 已有草稿、无人提交 | 下一队生效 | 第一阶段禁止；后续需明确草稿作废策略 |
| 已有提交或已完成 | 下一队生效 | 默认禁止；确需替补必须保留历史、写原因并进入复核态 |
| 已发布/已投屏 | 下一队生效 | 不允许普通流程改变已发布结果 |

“新增一位额外评委”和“替换无法继续工作的原评委”必须是两种操作。替换不能复制原评委的分数，也不能删除原评委历史记录。

## 8. 管理员端交互

建议管理员看到两个主选择：

- `仅创建账号`
- `创建并从下一支队伍起加入评分`（赛中推荐默认）

界面需要明确展示 `未入册`、`下一队生效`、`当前队有效`、`仅历史有效` 状态。成功提示必须写明生效边界，不能只提示“账号创建成功”。

当前队提交矩阵必须读取 `activeAssignment.rosterSnapshot`，历史队详情读取该队自己的快照。账号状态控件只保护真实存在于锁定快照中的成员，不能因为“账号角色是评委”就把所有新账号都禁用。

## 9. 动态人数的计分与投屏

当前去高去低算法已经支持动态人数，继续以每队快照为分母即可。需要额外确认竞赛规则：并列最高/最低仍只各去掉一条，以及临时发布是否仍允许仅 3 人形成暂算分。

投屏不应固定七列。对比赛大屏，建议使用按人数分档的确定性布局，而不是完全依赖浏览器自动换行：

- 3-7 人：单行。
- 8-10 人：两行，每行最多 5 人。
- 11-12 人：两行，每行最多 6 人。

至少对 3、7、8、9、12 人进行 1920x1080、1366x768 和非 16:9 letterbox 截图验收。CSS Grid 的 `repeat()`/`minmax()` 可以作为实现基础，但舞台字号和卡片尺寸仍应使用人数分档保证投影可读性。

来源：

- [W3C CSS Grid Layout](https://www.w3.org/TR/css-grid/)
- [MDN：自适应卡片网格](https://developer.mozilla.org/en-US/docs/Web/CSS/How_to/Layout_cookbook/Card)

## 10. 备份与恢复

需要区分两类导出：

1. **完整灾备**：包含整个应用 schema，包括动态账号、密码哈希、名册版本、派发快照、评分和控制状态；不包含有效会话令牌，恢复后可统一撤销会话。
2. **脱敏运营导出**：用于核对和数据交换，不含凭据，不能再宣称可独立灾备恢复。

MySQL 决赛环境应使用一致性全量备份，并在宿主机条件允许时结合 binary log 做时间点恢复。恢复顺序为账号、队伍、名册版本与成员、派发快照、评分、控制状态/outbox。备份中的密码哈希同样属于敏感数据，必须限制访问并加密保存。

当前项目的 SQL 状态导出不含动态应用账号，因此只能作为数据迁移的一部分，不能作为完整灾备。必须增加连接目标库的真实 preflight 和定期恢复演练，不能只依赖离线 dry-run。

来源：

- [MySQL Shell：实例与 schema dump](https://dev.mysql.com/doc/mysql-shell/8.0/en/mysql-shell-utilities-dump-instance-schema.html)
- [MySQL：使用 mysqldump 备份](https://dev.mysql.com/doc/refman/8.0/en/using-mysqldump.html)
- [MySQL：时间点恢复](https://dev.mysql.com/doc/refman/8.0/en/point-in-time-recovery.html)
- [MySQL：Binary Log](https://dev.mysql.com/doc/refman/8.0/en/binary-log.html)
- [OWASP：密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

## 11. 审计与安全

新增单一业务事件 `judge_enrollment_created`，至少记录：

- actor、operationId、accountId、username，禁止记录密码。
- previous/next roster revision。
- enrollment mode、预计生效 team/assignment revision。
- 是否影响当前队。
- 替补时的 replacedAccountId、原因和草稿/提交处理结果。

日志不得记录密码、Bearer token、session ID 或不必要的完整状态。评分审计继续保留项目分的精确两位小数、总分及前后变化项。

来源：[OWASP：日志记录安全指南](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

## 12. 建议实施顺序

### P0：先形成可用闭环

1. 将现有全局名册语义改为“计划名册”，允许赛中修改但只影响未来首次派发。
2. 增加“创建账号并加入后续名册”的原子服务端操作、revision 冲突和幂等控制。
3. 保持当前队和历史队快照不可变，管理员矩阵改读当前派发快照。
4. 完整灾备纳入动态账号，并增加目标库 preflight 与真实恢复演练。
5. 增加 8 人以上投屏布局和动态人数测试。

### P1：现场处置能力

1. 增加当前队“无人保存时重新派发”的受控操作。
2. 根据正式竞赛规则决定是否实现已有草稿/提交后的替补。
3. 补充运维手册、失败回滚、密码交付和审计查询。

### 暂不做

- 不直接解锁并覆盖全局名册。
- 不追改已完成队伍的快照。
- 不把旧评委分数复制给新评委。
- 不用前端连续请求承担账号与入册的一致性。
- 不在未完成恢复演练前宣称动态账号已经可灾备。

## 13. 最低验收门槛

- 赛中创建第 8 位评委并加入后续名册，当前队人数、草稿、提交和综合分不变。
- 下一队派发快照包含第 8 位评委；8 人均可独立登录、保存和提交。
- 两位管理员并发增员时只有一个 revision 成功，超时重试不会重复创建账号。
- 事务任一步失败后不存在孤立账号或半份名册。
- 已完成/已发布队伍在增员前后结果逐字段一致。
- 3、4、7、8、9、12 人去高去低、终态、排名和投屏一致。
- MySQL 重启后账号、名册版本、队伍快照和评分全部恢复。
- 从空白恢复环境完成账号登录、下一队评分、排名与投屏，且日志不泄露密码或令牌。

## 14. 最终建议

第一阶段应交付“**赛中新增评委，从下一队稳定生效**”，这是风险、改造范围和现场价值之间最合理的边界。它复用现有不可变队伍快照和动态计分算法，只需要把永久锁册改成版本化未来策略，并补齐组合事务、灾备、管理员状态和投屏布局。

“当前队已有评分后临时换人”应在赛事规则明确后作为独立功能建设，不应通过放宽现有锁定条件顺带实现。

## 15. 2026-07-14 实施与验证结果

本轮按第一阶段建议完成“赛中新增评委，从下一支首次派发队伍稳定生效”：服务端提供账号与计划名册的原子操作，当前/历史队快照保持不变；名册编辑使用固定草稿 revision；幂等键绑定用户名、显示名、密码、原因和预期 revision；当前开放快照成员不能被停用。MySQL 增员事务同时写入账号、计划名册控制和 `audit_events` 关键审计记录。

灾备导入/导出现在包含完整账号与密码哈希、删除备份外的额外账号并撤销全部会话；正式 `mysqldump` 清单包含审计表。状态转移继续保留已退出计划名册但仍被当前或历史队快照引用的评委账号。

自动验证结果：

- `npm test`：53/53 通过。
- 管理员控制回归：7 人当前队 -> 新增第 8 人 -> 当前队仍 7 人 -> 下一队 8 人，通过。
- 管理员编辑回归、生产构建、依赖漏洞审计通过。
- Playwright：3、7、8、9、12 人投屏在 1920x1080、1366x768、1024x768 下无卡片互相遮挡，也不遮挡队伍身份、总分和极值区域；1024x768 保持 16:9 舞台留黑。
- MySQL smoke 脚本已覆盖动态账号、事务审计、下一队快照、评分和重启恢复；当前工作机未提供 `CONTEST_MYSQL_DATABASE`/`CONTEST_MYSQL_USER`，因此本轮未连接真实 MySQL 执行。
