# 回归断言质量与门禁研究

日期：2026-07-14

## 研究范围与结论

本研究只采用 Node.js、Playwright 和 React 的官方文档，并结合仓库当前测试与 `package.json` 作只读检查。

核心结论：调研开始时，仓库已经具备相当数量的领域与 API 行为测试，也有一条真实 Chromium 的长流程回归，但默认门禁仍存在三处结构性缺口：部分 UI 契约只是匹配源码文本；截图只被保存、不参与基线比较；`npm test`、构建、浏览器回归和运行检查没有被一个必过命令聚合。因此，当时的“测试全绿”不能等价为“用户行为、视觉结果和生产构建均已回归验证”。本轮已落地的修正见下一节。

建议将可靠门禁定义为：**严格的领域/API 行为断言 + 带阈值的覆盖率信号 + 隔离的真实浏览器关键旅程 + 可失败的视觉基线比较 + 一个顺序明确、任一步失败即失败的聚合命令**。覆盖率只用于发现未执行路径，不代替行为断言；重试只用于识别和诊断偶发失败，不用于把 flaky 测试洗成通过。

## 本轮实施结果

- 领域和直接写路由现在严格区分非法/缺失版本（400）与合法但过期版本（409），初始 revision 为 0 时不再接受缺失 CAS 令牌。
- 开赛配置归一化拒绝多个 open 组或 active 指针冲突；开启下一组前必须显式结束当前组，不能在加载或 open 操作中静默关闭赛次。
- MySQL 必需控制状态同时校验合法 JSON 和最小结构；健康检查覆盖派发、展示、评委名册和开赛配置四个控制对象。
- 运行时整数配置在启动阶段执行范围校验；请求 URL 使用固定解析基址，不再信任 Host 头。
- 评分浏览器回归新增两位小数、退格、清空、前后项、收起和展开行为断言；3、7、8、9、12 位评委的 1920x1080 投屏均加入 Playwright screenshot 基线，其余视口继续执行溢出和重叠几何断言。
- 当前长流程会改写共享服务器状态，尚不具备 per-attempt 隔离，因此 Playwright runner 明确使用 `--retries=0`，失败即阻断并保留失败 trace；完成测试级服务器 fixture 后才能安全启用 retry/flaky 分类。`npm run verify` 聚合日检、覆盖率阈值和浏览器回归，`npm run verify:finals` 进一步串联现场 MySQL smoke。
- 当前覆盖率门槛为自有 `domain/server/shared` 代码行 60%、分支 70%、函数 75%；最终连续验证实测分别为 77.94%、77.49%、83.85%，共 131 个 Node 测试全部通过。
- `npm run verify` 最终连续通过日检、覆盖率门禁、生产构建和真实 Chromium 长流程；视觉流程包含五种评委人数的 1920x1080 跨平台基线比较，并在零重试下通过。
- `@playwright/test` 已解析到 1.61.1，`npm audit --audit-level=high` 为零漏洞。

## 仓库本地证据

### 1. 调研时的默认测试门禁只包含 Node 测试

- `package.json:7` 的 `test` 为 `node --test`。
- `package.json:8` 的 `test:visual` 是独立命令；`build`、`check:admin-edit`、`check:admin-control`、`check:daily`、Docker 和 MySQL smoke 也分别独立存在（`package.json:8-19`）。
- 调研开始时没有 `check`、`verify` 或 `ci` 一类聚合脚本把静态/领域测试、构建和浏览器测试串成一个失败出口；本轮已新增 `verify` 与 `verify:finals`。
- `package.json:25` 声明 Node `>=22.12.0 <25`，因此采用 Node 22 官方 CLI 能力最贴合仓库运行约束。

仍需注意：只运行 `npm test` 不会执行 Vite 构建或真实浏览器回归；完整本地门禁应运行 `npm run verify`，现场 MySQL 验证应运行 `npm run verify:finals`。

### 2. UI 契约中存在大量源码正则断言

- `test/appSurfaceContracts.test.mjs:5-8` 直接把 `src/App.jsx`、`src/styles.css`、服务端和存储源码读取为字符串。
- 同文件 `:10-63` 通过 `assert.match()` / `assert.doesNotMatch()` 检查 hook 声明、函数名、class 名、JSX 片段、CSS 片段和服务器源码字面量。例如 `:13-21` 验证具体 state 声明和 class，`:42-48` 验证具体变量与源码表达式，`:52-63` 验证路由实现片段及环境判断文本。
- `test/deploymentContracts.test.mjs:5-18` 同样读取 Dockerfile、脚本和服务器源码并匹配特定字符串。
- 只读统计显示，当前 `test/**/*.test.mjs` 中共有 49 处 `assert.match()` / `assert.doesNotMatch()`；不能把 49 处全部视为错误，但其中涉及 UI 是否可见、交互是否受保护、流程是否可达的断言，属于行为可由浏览器观察、却被实现文本替代的高优先级迁移对象。

源码正则适合检查少量必须保持为文本的静态合规约束，例如 Dockerfile 必须声明某环境变量；它不适合证明某个组件实际渲染、控件能操作、脏编辑受到保护，或服务器端策略真的生效。重命名变量或抽取组件会产生假失败，而保留匹配字符串但破坏运行行为又可能产生假通过。

### 3. 调研时浏览器测试包含有效行为断言，但截图没有比较语义

- `e2e/dynamicJudgeEnrollment.spec.mjs:72` 是一条真实 Playwright 长流程；它通过角色/label/text 定位器检查开赛、派发、评委新增、替换、断网暂存、恢复补交、发布和应急重开等行为。
- `:25-59` 还在真实布局结果上验证卡片数量、可见性、溢出和元素重叠。这类断言观察浏览器结果，价值高于匹配 JSX/CSS 源码。
- `:61-69` 对多个 viewport 先验证几何，再调用 `page.screenshot()` 写入 PNG；`:103` 和 `:113` 也只保存管理页面截图。
- 调研时全仓未发现 `toHaveScreenshot()` 或 `toMatchSnapshot()`，也没有快照基线目录；本轮已为稳定投屏场景加入 `toHaveScreenshot()` 和仓库级跨平台基线。
- `scripts/run-visual-tests.mjs` 使用临时数据目录、动态端口和子进程退出码运行 Playwright，并显式采用单 worker、零重试和失败 trace。当前长流程共享服务端状态，零重试是防止重试污染结果的有意策略。

## 行为断言与实现细节断言

Node 官方将 `node:assert` 定义为“验证不变量”的断言函数集合；严格模式令非严格方法采用严格语义，并在对象不相等时提供 diff。[Node.js Assert 官方文档](https://nodejs.org/docs/latest-v22.x/api/assert.html#strict-assertion-mode)

React 官方在移除部分 `react-dom/test-utils` API 时明确说明，这些低层工具很容易让测试依赖组件和 React 的实现细节，并建议改用面向用户的测试库。[React 19 Upgrade Guide：移除 `react-dom/test-utils`](https://react.dev/blog/2024/04/25/react-19-upgrade-guide#removed-react-dom-test-utils)

Playwright 官方把 locator 上的异步 matcher 定义为 web-first assertions：测试会重新获取元素并反复检查，直到满足期望或超时；官方同时警告，普通非重试断言用于异步页面时更容易 flaky。[Playwright Assertions 官方文档](https://playwright.dev/docs/test-assertions)

据此，本仓库可以使用下面的判断规则：

| 问题 | 行为断言 | 实现细节断言 |
| --- | --- | --- |
| 断言对象 | 公开函数输入/输出、HTTP 状态与响应、持久化后的可观察状态、用户可见文本/角色/控件状态、最终布局 | 变量名、hook 声明文本、函数所在位置、class 名是否出现在源码、某段 JSX/CSS 的写法 |
| 重构容忍度 | 实现重构而公开行为不变时应继续通过 | 仅重命名、抽组件或改写等价 CSS 就可能失败 |
| 缺陷捕获 | 行为坏了就失败 | 字符串还在但行为坏了时仍可能通过 |
| 本仓库例子 | API 返回 409；登录后管理员看到开赛操作；脏编辑时切换被拦截；投屏卡片不重叠 | `assert.match(appSource, /const \[rosterOpen.../)`；匹配特定 class 或条件表达式 |

推荐迁移优先级：

1. 保留领域模块和路由测试中对返回值、状态转换、HTTP 响应及审计结果的严格断言；对象契约优先使用 `assert.deepStrictEqual()`，其递归比较自身可枚举属性并提供结构 diff。[Node.js `assert.deepStrictEqual()` 官方文档](https://nodejs.org/docs/latest-v22.x/api/assert.html#assertdeepstrictequalactual-expected-message)
2. 把“页面展示/隐藏什么、按钮能否操作、切换是否受保护、保存后是否保持”从源码正则迁移到 Playwright 的 role、label、text、value、enabled/disabled、visible/hidden 等自动重试断言。[Playwright Assertions 官方文档](https://playwright.dev/docs/test-assertions)
3. 只有无法从运行时合理观察、且文本本身就是交付契约的事项保留源码断言，例如 Dockerfile 的生产存储默认值。即使保留，也应补一条启动或 API smoke 证明该配置真正生效；这是基于上述官方断言能力作出的仓库工程建议。
4. 对异步服务状态不要先读取值再立即用普通 `expect(value)` 判断；优先使用 locator matcher，复杂的最终一致性条件使用官方提供的 `expect.poll` / `expect.toPass`。[Playwright Assertions：polling 与 retrying 官方文档](https://playwright.dev/docs/test-assertions#expectpoll)

## 覆盖率：作为盲区信号，而不是质量分数

Node 22 的测试运行器支持 `--experimental-test-coverage`，并提供 `--test-coverage-lines`、`--test-coverage-branches`、`--test-coverage-functions` 阈值；低于指定阈值时进程以状态码 1 退出。[Node 22 CLI：测试覆盖率选项](https://nodejs.org/docs/latest-v22.x/api/cli.html#--experimental-test-coverage) [Node 22 Test Runner：收集代码覆盖率](https://nodejs.org/docs/latest-v22.x/api/test.html#collecting-code-coverage)

Node 也支持 include/exclude glob，使门禁可以只覆盖本仓库拥有的领域、服务和共享模块，排除生成文件或不适合由 Node 测试执行的浏览器入口。[Node 22 CLI：`--test-coverage-include`](https://nodejs.org/docs/latest-v22.x/api/cli.html#--test-coverage-include) [Node 22 CLI：`--test-coverage-exclude`](https://nodejs.org/docs/latest-v22.x/api/cli.html#--test-coverage-exclude)

推荐落地方式：

- 先建立报告基线，不在第一天拍脑袋设置高百分比。查看 `domain/`、`server/`、`shared/` 中未执行的分支，优先补评分提交、冲突、会话失效、名单冻结/重开、MySQL mutation 等高风险路径。
- 基线稳定后，设置不会立即造成大量无意义补测的最低阈值，并采用“只升不降”策略。分支覆盖比单独的行覆盖更能暴露错误分支未执行，但仍不能证明断言正确；这是对 Node 覆盖率计数能力的工程解释，不是官方对测试质量的背书。
- 覆盖率门禁与行为门禁同时存在。源码正则即使执行了很多行，也不证明真实 UI 行为；真实浏览器路径也可能覆盖不到服务端异常分支。
- 由于仓库支持 Node 22 到 24，应在实际 CI Node 版本上先验证参数稳定性；Node 22 文档仍将该覆盖率开关标作 experimental。[Node 22 CLI 官方文档](https://nodejs.org/docs/latest-v22.x/api/cli.html#--experimental-test-coverage)

## 真实浏览器、截图比较、重试和隔离

### 真实浏览器行为门禁

Playwright locator assertions 会等待 DOM 达到期望状态，适用于登录、派发、评分、断网恢复、发布等异步用户旅程。[Playwright Assertions 官方文档](https://playwright.dev/docs/test-assertions) 当前 spec 已正确使用了大量此类断言，应将它从“可选视觉脚本”提升为聚合门禁中的关键旅程，而不是用更多源码正则替代。

建议把当前单个长流程拆成少量可独立运行的关键旅程，例如：管理员开赛与派发、评委评分/离线补交、动态评委从下一队生效、发布与投屏、应急重开。拆分后的每个测试自行创建所需状态，不依赖上一个测试留下的数据。

### 截图必须比较才是回归门禁

Playwright 官方说明，`page.screenshot({ path })` 的作用是把截图保存到文件；若要进行视觉比较，应使用 `expect(page).toHaveScreenshot()`，首次生成参考图，后续运行与参考图比较。[Playwright Screenshots 官方文档](https://playwright.dev/docs/screenshots) [Playwright Visual Comparisons 官方文档](https://playwright.dev/docs/test-snapshots)

因此，当前 `page.screenshot()` 产物可以保留为诊断附件，但不能称为视觉回归。应把稳定的投屏 stage 或关键局部元素改成 `toHaveScreenshot()`，提交并评审基线，给动态时间、光标或非确定内容加 mask/style；只有基于真实噪声证据才配置 `maxDiffPixels` 或 `maxDiffPixelRatio`。Playwright 官方支持这些差异阈值，同时提示截图会受 OS、浏览器版本、硬件和运行模式影响，基线与比较应运行在一致环境中。[Playwright Visual Comparisons 官方文档](https://playwright.dev/docs/test-snapshots)

对本项目而言，优先纳入比较的是 16:9 投屏 stage、不同评委人数的卡片密度、长队名与中英混排、极值和总分模块；管理后台更适合以行为/可访问语义断言为主，只为少数稳定关键布局设局部截图，避免大面积脆弱基线。

### 重试用于暴露 flaky，不用于掩盖它

Playwright 默认不重试。启用后，首轮失败而重试通过的测试会被分类为 `flaky`；失败时运行器会丢弃整个 worker 进程及浏览器，并在新 worker 中重试。[Playwright Retries 官方文档](https://playwright.dev/docs/test-retries)

推荐 CI 使用少量重试（通常 1 次）收集偶发性证据，同时加 `--fail-on-flaky-tests`，使“重试后通过”仍阻断合并；该 CLI 选项的官方定义就是在任何测试被标记 flaky 时令运行失败。[Playwright Test CLI 官方文档](https://playwright.dev/docs/test-cli#all-options)

可在首次重试时保留 trace，官方配置支持 `trace: 'on-first-retry'`，从而在不为每个成功测试制造大量产物的情况下诊断等待、网络和 DOM 状态。[Playwright Test `use` 配置官方文档](https://playwright.dev/docs/test-use-options#recording-options)

### 隔离是可靠重试的前提

Playwright 默认为每个测试创建独立 BrowserContext；每个 context 有独立的 local storage、session storage 和 cookie。官方指出，这能提高复现性、防止失败级联，并让测试可独立重跑。[Playwright Isolation 官方文档](https://playwright.dev/docs/browser-contexts)

这与本项目的 tab-scoped session storage、多人会话和服务端比赛状态尤其相关：浏览器身份应依赖每测试 context 隔离；服务端状态则必须通过每测试独立临时数据目录、API fixture 或显式 reset 隔离。当前 `run-visual-tests.mjs` 已为整次 run 创建临时目录，但若把长流程拆成多个测试，还需要测试级服务端状态隔离，否则浏览器 context 干净并不代表共享服务端状态干净。后一句是结合本仓库架构的推论。

## 建议的可靠回归门禁

以下是目标结构，不是本研究对代码的直接修改：

| 层级 | 必过内容 | 主要失败含义 |
| --- | --- | --- |
| 1. Node 行为测试 | 领域规则、状态机、存储 mutation、路由、会话、安全与审计断言 | 公开逻辑/API 契约回归 |
| 2. 覆盖率阈值 | 对 `domain/`、`server/`、`shared/` 收集 line/branch/function coverage | 新增或既有风险路径没有被执行 |
| 3. 生产构建 | `npm run build` | 编译、导入、资源或打包回归 |
| 4. Playwright 关键旅程 | 隔离数据、真实 Chromium、web-first assertions | 跨层用户工作流回归 |
| 5. 视觉比较 | 稳定 stage/局部元素的 `toHaveScreenshot()` | 投屏层级、密度、溢出或样式回归 |

聚合命令应顺序运行上述层级，任何子进程非零即立即失败。可保留 MySQL/Docker 检查为环境较重的第二级 CI 作业，但 PR 的必过状态必须明确列出哪些作业共同构成合并门禁；不能让开发者误以为 `npm test` 已代表全量验证。

建议的验收标准：

1. 仓库存在一个明确的聚合验证入口，至少包含 Node 行为测试、覆盖率阈值、生产构建、关键 Playwright 流程与截图比较。
2. UI 行为不再主要由 `App.jsx` / CSS 源码正则证明；每迁移一个正则契约，都以公开函数、API 或真实浏览器可观察结果接替。
3. 视觉测试仓库中存在经过评审的基线；故意改变关键投屏布局时测试必然失败，只有显式更新基线才能通过。
4. Playwright 每个测试可单独运行并重复运行；不依赖执行顺序或前序测试状态。官方建议测试彼此完全隔离，并说明这可避免失败传递。[Playwright Isolation 官方文档](https://playwright.dev/docs/browser-contexts)
5. CI 中 retry-pass 被报告且阻断，而不是静默变绿；失败时保留足够 trace/截图诊断证据。[Playwright Retries 官方文档](https://playwright.dev/docs/test-retries) [Playwright Test `use` 配置官方文档](https://playwright.dev/docs/test-use-options#recording-options)

## 实施顺序

1. 先增加聚合入口并接入现有 `npm test`、`npm run build`、`npm run test:visual`，立即消除“默认测试未覆盖浏览器”的认知缺口。
2. 给 Node 测试生成一次覆盖率报告，划定自有源码 include/exclude，补最高风险未覆盖分支，再设保守基线阈值。
3. 把 `appSurfaceContracts` 中关于可见性、交互保护和流程状态的正则逐批迁移为 Playwright 行为断言；保留真正的静态交付文本契约。
4. 把投屏截图从写文件迁移为 `toHaveScreenshot()`，固定 CI 浏览器与 OS 环境，先覆盖少量高价值稳定区域。
5. 拆分超长 Playwright 流程，建立测试级服务端数据隔离；开启一次重试、`--fail-on-flaky-tests` 和首次重试 trace。
6. 最后再逐步提高覆盖率阈值和视觉覆盖面。先让门禁可信、可诊断，再扩大数量。

## 官方资料

- [Node.js v22 Test Runner](https://nodejs.org/docs/latest-v22.x/api/test.html)
- [Node.js v22 Assert](https://nodejs.org/docs/latest-v22.x/api/assert.html)
- [Node.js v22 CLI 测试与覆盖率选项](https://nodejs.org/docs/latest-v22.x/api/cli.html#--experimental-test-coverage)
- [Playwright Assertions](https://playwright.dev/docs/test-assertions)
- [Playwright Screenshots](https://playwright.dev/docs/screenshots)
- [Playwright Visual Comparisons](https://playwright.dev/docs/test-snapshots)
- [Playwright Retries](https://playwright.dev/docs/test-retries)
- [Playwright Isolation](https://playwright.dev/docs/browser-contexts)
- [Playwright Test CLI](https://playwright.dev/docs/test-cli)
- [Playwright Test `use` configuration](https://playwright.dev/docs/test-use-options)
- [React 19 Upgrade Guide：移除低层测试工具](https://react.dev/blog/2024/04/25/react-19-upgrade-guide#removed-react-dom-test-utils)
