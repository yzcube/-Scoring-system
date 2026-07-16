# 回归审计记录

日期：2026-07-07

## 本次口径

用户已确认：这是大赛现场评分模块，评委就在台下；浏览器本地分数可被手工篡改不作为本次阻塞项。本次重点复核：

- 每个角色都能退出。
- 评委退出入口是否清晰可见。
- 退出后是否清理页面内会话状态。
- 登录跳转、评分流程、提交流程、管理员综合分是否仍完整。
- 页面完整性和主要可访问性风险是否还有未处理项。

## 运行与证据

- 本地服务：`http://127.0.0.1:5177/`
- 构建校验：`npm run build` 通过。
- 截图与结果目录：`qa-artifacts/regression-audit-2026-07-07/`
- 截图来源：本会话内置浏览器与 Chrome 扩展控制通道不可用，使用独立临时 profile 的本机 Chrome headless + DevTools Protocol 复测。

截图清单：

- `01-login-clean.png`：干净登录页。
- `02-judge01-home.png`：评委 01 评分首页。
- `03-after-judge01-logout.png`：评委 01 退出后回到登录页。
- `04-admin-home.png`：管理员工作台。
- `05-after-admin-logout.png`：管理员退出后回到登录页。
- `06-keypad-entry.png`：数字键盘录入。
- `07-missing-submit.png`：缺项提交提示。
- `08-complete-submit-top.png`：完整提交后回到顶部。
- `09-admin-three-judges.png`：三位评委提交后的管理员综合分。
- `10-narrow-logout-visible.png`：窄屏下评委退出入口可见。
- `11-session-reset-verified.png`：退出后队伍和重置确认状态已重置。
- `12-default-judge-logout-visible.png`：默认评委页常驻退出按钮可见。
- `13-default-judge-logout-visible-narrow.png`：窄屏默认评委页常驻退出按钮可见。
- `14-accessibility-regression.png`：可访问性回归状态。

## 复核结论

### 已处理并通过

- 7 个评委账号均可登录并退出，退出后回到登录页。
- 管理员账号可登录并退出，退出后回到登录页。
- 评委端退出入口位于队伍列表顶部，不需要滚过 20 支队伍。
- 评委默认评分页现在也有固定可见的 `退出登录`，不需要先打开队伍列表。
- 评委退出按钮高度为 48px，窄屏 `390 x 844` 下可见。
- 缺分提交后，实际 DOM 焦点会进入评分键盘容器，读屏/键盘用户能感知当前评分上下文。
- 队伍列表不再使用未完整实现的 `listbox/option` 语义，当前队伍用 `aria-current` 标记。
- 管理员评委状态点已增加逐评委可访问名称。
- 退出会清理会话键 `campus-final-tablet-session-v1`。
- 退出后重新登录会回到 A01，不再保留上一个角色选中的队伍。
- “重置二次确认”不会跨退出保留：重新登录后第一次点击重置仍只显示确认提示，不会直接清空。
- 缺项提交仍会显示纯文本提示并保持评分键盘打开。
- 完整提交后仍会关闭键盘并回到顶部。
- 管理员端 3 位评委提交后，A01 显示综合分 `90.00`；最高 `100.00` 和最低 `80.00` 被剔除。

### 关键实测数据

来自 `regression-results.json`：

- `judge01` 到 `judge07`：`returnedToLogin: true`
- 评委退出按钮：`text: 退出登录`，`height: 48`
- 窄屏退出入口：`visible: true`，`height: 48`
- 管理员退出：`returnedToLogin: true`
- 缺项提交：`missingSubmit: true`
- 完整提交：`completeSubmit: true`

来自 `session-reset-results.json`：

- 退出前选中 A05：`跨境智能营销创想队`
- 重新登录后回到 A01：`东盟好物 AI 营销小组`
- 退出前第一次重置提示：`再次点击重置，清空当前队伍评分`
- 重新登录后第一次重置仍为确认提示：`再次点击重置，清空当前队伍评分`
- 专项结果：`passed: true`

来自 `direct-logout-results.json`：

- 默认页常驻退出：`visible: true`
- 退出按钮在 compact hero 外部：`outsideHero: true`
- 点击常驻退出后回到登录页：`returnedToLogin: true`
- 窄屏常驻退出：`visible: true`

来自 `accessibility-regression-results.json`：

- 队伍列表 `role`：`null`
- 当前队伍标记数量：`currentCount: 1`
- 旧 `role="option"` 数量：`optionCount: 0`
- 打开键盘后焦点在 `.score-pad`：`isScorePad: true`
- 缺分提交后焦点仍在 `.score-pad`：`isScorePad: true`
- 管理员 7 个状态点均有 `role="img"` 和 `aria-label`

## 仍需注意

这些不是当前大赛现场原型的阻塞项，但如果后续要进入正式联网系统，仍建议处理：

- 已新增共享评分服务器；决赛现场必须使用 `npm run contest` 和同一个 `LAN access` 地址，不要使用本机开发服务。
- 窄屏提交栏仍需继续观察极端宽度下的文字挤压。

## 当前建议

当前版本可继续作为大赛现场评分原型使用。优先级最高的问题是“每个角色都能退出”“退出后状态不串角色”“缺分跳转后焦点可感知”，本次已经修复并通过回归验证。
