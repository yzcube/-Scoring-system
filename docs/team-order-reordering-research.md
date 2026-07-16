# 管理员端队伍出场顺序调整方案调研

日期：2026-07-09

## 结论

推荐在管理员端新增“出场顺序”编辑区，使用 `@dnd-kit/core` + `@dnd-kit/sortable` 实现拖拽排序，并把排序结果作为服务器状态持久化。队伍 `candidate.id` 保持不变，评分记录仍绑定固定队伍 ID；抽签后改变的只是每个组内的展示/导航顺序。

不建议只在前端重排数组或只保存在 localStorage。最终比赛是多台平板接入同一 LAN 服务器，评委端上一队/下一队、管理员综合评分列表、成绩展示页选择器都必须读同一个后端顺序。

## 资料来源

- dnd-kit legacy sortable preset 官方文档说明 `SortableContext` 要作为 `DndContext` 的后代使用，并支持列表排序场景：https://dndkit.com/legacy/presets/sortable/sortable-context
- dnd-kit sortable overview 官方文档说明 sortable preset 提供键盘传感器专用坐标 getter，可用于可键盘操作的排序：https://dndkit.com/legacy/presets/sortable/overview
- dnd-kit `useSortable` 官方文档说明可把拖拽监听挂到独立 drag handle 上，避免整行内按钮/链接误触发拖拽：https://dndkit.com/legacy/presets/sortable/use-sortable
- npm 当前包信息显示 `@dnd-kit/core` 是面向 React 的轻量拖拽库，`@dnd-kit/sortable` 是官方 sortable preset：https://www.npmjs.com/package/@dnd-kit/core ，https://www.npmjs.com/package/@dnd-kit/sortable
- `react-sortablejs` 官方 README 明确提示它仍“不适合生产使用”，不适合决赛现场关键流程：https://github.com/SortableJS/react-sortablejs
- React Aria 的 drag and drop 文档支持鼠标、触控、键盘和读屏，并提供 collection 组件内重排能力；但接入它通常意味着引入 React Aria collection/ListBox/GridList 体系，改动比本项目需要的单列表排序更大：https://react-aria.adobe.com/dnd ，https://react-aria.adobe.com/ListBox

## 方案比较

### 推荐：dnd-kit sortable

适合本项目的原因：

- 当前项目是 Vite + React 19 单页应用，没有现成组件库约束，dnd-kit 可以局部接入到管理员队伍列表。
- 队伍列表每组 20 支，排序数据很小，`SortableContext` + `arrayMove` 就能覆盖核心交互。
- 可以使用 drag handle，只让“拖动手柄”触发拖拽，避免影响“展示”“管理”等现有按钮。
- 可配置 `PointerSensor` 和 `KeyboardSensor`，兼顾鼠标、触控和平板外接键盘场景。

### 备选：React Aria drag and drop

优点是可访问性非常强，官方 collection 组件支持鼠标、触控、键盘和读屏重排。缺点是本项目现在不是 React Aria 组件体系，若只为一个管理员排序列表引入它，成本偏高，并且会带来更多 UI 结构迁移。

### 不推荐：react-sortablejs

它的 API 简单，但官方 README 仍标注不适合生产。比赛现场排序会影响所有评委端和展示页，不能把核心流程放在这个风险上。

## 数据模型建议

新增服务器状态字段：

```json
{
  "version": 2,
  "entriesByJudge": {},
  "candidateOverrides": {},
  "candidateOrderByGroup": {
    "gaozhi": ["GZ01", "GZ08", "GZ03"],
    "zhongzhi": ["ZZ01", "ZZ02"],
    "benke": ["BK01", "BK02"],
    "shehui": ["SH01", "SH02"]
  },
  "candidateOrderRevision": 1
}
```

关键规则：

- `candidateOrderByGroup[groupId]` 必须包含该组所有已知 `candidate.id`，不能包含其他组或未知 ID。
- 读旧状态时自动补齐默认顺序，保证老的 `data/contest-state.json` 和 MySQL 数据可无痛升级。
- UI 中的 `candidate.order` 不再来自初始化时的固定字符串，而应根据当前组内排序动态计算，例如 `3 / 20`。
- 队伍 ID 不变，所以已有评分、提交、撤回、清空重评都不需要迁移。

## API 建议

新增管理员接口：

```http
PUT /api/candidate-order/:groupId
Content-Type: application/json

{
  "orderedCandidateIds": ["GZ08", "GZ01", "GZ03"],
  "revision": 1
}
```

服务端行为：

- 仅 admin 可调用。
- 校验 `groupId` 存在。
- 校验传入 ID 集合与该组默认队伍 ID 集合完全一致。
- 使用 `candidateOrderRevision` 做乐观冲突检测，防止多个管理员页面互相覆盖。
- 保存成功后返回完整 `candidateOrderByGroup` 和新 revision。
- 审计日志新增 `candidate_order_write`，记录 actor、groupId、previousOrder、nextOrder、changedPositions，不记录无关评分 payload。

现有接口也要扩展：

- `GET /api/state` 返回 `candidateOrderByGroup` 和 `candidateOrderRevision`，供管理员和评委端使用。
- `GET /api/scoreboard` 返回 `candidateOrderByGroup`，供展示页按抽签顺序切换。

## MySQL 与文件存储

文件存储直接写入 `data/contest-state.json` 的新增字段即可。

MySQL 建议新增一张轻量表，不新增 Docker 容器，继续使用现有 host MySQL：

```sql
CREATE TABLE IF NOT EXISTS contest_final_candidate_order (
  group_id VARCHAR(32) NOT NULL,
  candidate_id VARCHAR(16) NOT NULL,
  sort_order INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, candidate_id),
  INDEX idx_group_order (group_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

每次保存某组顺序时，在事务里删除该组旧顺序再批量插入新顺序。也可以用单行 JSON settings 表，但按行存更容易检查和修复。

## 前端交互建议

- 在管理员“队伍结果”区域上方或旁边新增“出场顺序”编辑区。
- 默认显示当前顺序，左侧序号，主体显示队伍 ID、队伍名、项目名、提交进度，右侧显示拖动手柄。
- 拖拽只绑定到手柄；整行点击仍可选择该队进入现有编辑/应急面板。
- 提供上移/下移按钮作为无拖拽备用操作，尤其适合触控不稳或外接键盘场景。
- 使用“编辑顺序/保存顺序/取消修改/恢复默认顺序”这种显式编辑模式，避免误拖后立即影响评委端。
- 保存成功后 plain-text toast，例如“出场顺序已保存”；冲突时提示“出场顺序已被其他管理员更新，请核对后重试”。
- 后台轮询拿到新顺序时，如果管理员正在编辑草稿，不覆盖草稿；仅更新旁边的服务器版本状态。

## 影响范围

需要改动的代码区域预计是：

- `shared/contestData.js`：新增按组生成默认顺序、按排序重排候选队伍的工具函数。
- `src/App.jsx`：新增 order state、本地缓存、API 调用、管理员排序 UI，并让评委端/展示页使用排序后的 `groupCandidates`。
- `contest-server.mjs`：新增状态字段、sanitize、MySQL 表、读写逻辑、`PUT /api/candidate-order/:groupId`、审计日志。
- `src/styles.css`：新增管理员排序列表样式。
- `AGENTS.md`：实现后记录新的 durable prototype decision，例如“管理员端队伍出场顺序可拖拽调整，并持久化到共享服务器”。

## 验证清单

- 管理员拖动高职组顺序并保存后，刷新页面顺序保持不变。
- 评委端队伍选择器、上一队/下一队按新顺序走。
- 成绩展示页顶部选择器和键盘上一队/下一队按新顺序走。
- 队伍 ID 对应评分不变，重排后不会把 A 队分数显示到 B 队。
- 两个管理员页面同时改顺序时能检测冲突。
- 文件存储和 MySQL 存储都能读写顺序。
- 旧状态文件或旧数据库没有顺序数据时自动使用默认顺序。
