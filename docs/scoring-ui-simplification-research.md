# 评委平板评分端简化研究

日期：2026-07-06

## 研究范围

这次研究围绕 9:16 竖屏平板上的现场评委评分页面，重点检索了三类来源：

- 竞品/同类系统：Award Force、OpenWater、Evalato、CompetitionSuite、Skild、Marching Maestro、准到、微管家、云互动、Hi现场等。
- 表单与输入控件准则：NNGroup、W3C WCAG、Material Design、Apple HIG、Baymard 等。
- 评分业务模式：多评分项、权重/满分、评语、签名/确认、自动汇总、实时同步、大屏联动。

## 可采纳结论

### 1. 首屏只保留“当前考生 + 总分 + 当前评分项”

现在页面把 5 个维度、11 个评分项、快捷按钮、滑杆、输入框、备注、提交条同时暴露出来，首屏负担偏重。竞品更常见的方式是让评委聚焦当前参赛对象和当前评分任务。

建议改成：

- 顶部固定：考生名、编号、评委、总分、完成进度。
- 主体只展开一个维度或一个评分项。
- 其他维度折叠成进度列表，不在首屏展开全文。
- 长说明默认收起，点“查看细则”再展开。

依据：

- Award Force 把评分项归入 score set，并汇总成总分，说明 UI 可以围绕“当前 score set + 当前 entry”组织，而不是把全部规则表格摊开。
- OpenWater 建议常规 judging scorecard 用 3 到 5 个问题、1-5 或 1-10 分制；我们的细项有 11 项，应通过分组/分步减少同时可见字段。
- NNGroup 的表单研究强调结构、透明、清晰、支持，以降低表单认知负担。

### 2. 移除滑杆，改成“大数字输入 + 快捷分档”

评分是精确值，不是音量/亮度这类模糊调节。当前每项同时有加减按钮、数字框、滑杆，控件重复。滑杆在触屏上选精确分值更慢，也更容易误触。

建议改成：

- 每个评分项一个大数字输入。
- 配套 4 个快捷分档：满分、良好、合格、较弱。
- 保留 +/- 0.5 微调。
- 不再展示滑杆。

依据：

- Award Force 的评分控件支持 dropdown、slider、keyboard input 等多种 control type；这说明评分输入可以按场景选择，不必默认滑杆。
- NNGroup 对 slider 的研究指出，精确取值不适合用 slider，应改用其他控件。
- CompetitionSuite/Marching Maestro 截图都倾向突出当前分值输入，而不是让评委在密集规则中拖动多条滑杆。

### 3. 维度卡片应变成“评分向导”，而不是长列表

当前页面像把评分表变成了可编辑长表单；评委在现场看路演时需要快速决策，不适合频繁滚动找项。

建议改成两种模式之一：

- 模式 A：逐项评分向导。一次只显示 1 个评分项，底部“上一项/下一项”，右侧或顶部显示总分。
- 模式 B：维度折叠面板。默认只显示 5 个维度小计，点开某个维度后评分该维度下的 2-3 项。

更推荐模式 B，因为评委可以快速回看各维度分布，且不会完全失去总览。

### 4. 备注从常驻大文本框改为“可选补充”

多数现场评分系统把评语作为可选能力，不应占据主流程空间。

建议改成：

- 默认只显示“添加评语”按钮。
- 点开后显示文本框。
- 提交前如果有低分项，再提示“是否补充扣分说明”。

依据：

- CompetitionSuite 的 tablet app 支持 score 与 commentary，但评分和记录是独立 tab。
- 微管家、云互动都把评委评语/签名作为可开关项，而不是评分必填主流程。

### 5. 提交前要做轻量确认，而不是只靠底部固定按钮

现场高压环境下，评委误触提交或漏评风险很高。应该保留固定提交，但提交前展示简短确认。

建议提交确认内容：

- 当前考生。
- 总分。
- 未评分项数量。
- 低于 60% 的评分项。
- “确认提交 / 返回修改”。

依据：

- 准到、云互动、微管家等现场评分系统都强调自动计算和实时展示；提交动作一旦进入统计链路，就需要更强确认。
- WCAG 触控目标要求至少 24 x 24 CSS px，并建议重要控件采用更稳妥尺寸；提交按钮应大、清楚、远离误触区域。

## 下一版信息架构建议

```text
顶部固定区
  当前考生 A01 / 项目
  总分 86.5 / 完成 8/11 / 评委 01

维度进度区
  商品数字化营销实践 18/25
  AI 技术应用能力 24/30
  应用成效与优化思路 16/20
  路演展示表现 13/15
  实践报告质量 8/10

当前展开维度
  维度标题 + 小计
  评分项标题 + 满分
  一句话评分标准
  [查看完整细则]
  大数字评分输入
  快捷分档：满分 / 良好 / 合格 / 较弱
  上一项 / 下一项

底部固定区
  上一位
  当前总分
  提交
```

## 具体删减清单

- 删除每项滑杆。
- 删除每个维度顶部的“满分 / 85% / 清空”三按钮，改成当前评分项的分档按钮。
- 删除首屏展开的全部长说明，改成当前项一句话 + 可展开全文。
- 删除常驻备注大框，改成可选抽屉/弹层。
- 删除彩色维度大面积背景，改成更安静的状态线或左侧色条。
- 底部固定条保留，但减少为“总分 + 提交”，考生切换放到顶部或提交后下一位。

## 参考来源

- Award Force Scoring Criteria: https://support.awardforce.com/hc/en-us/articles/360000381495-Scoring-criteria
- Award Force VIP Judging Modes: https://support.awardforce.com/hc/en-us/articles/207420243-Understanding-judging-modes
- Award Force VIP Judging Configuration: https://support.awardforce.com/hc/en-us/articles/208175846-VIP-judging-configuration
- OpenWater Evaluation Scorecard: https://help.getopenwater.com/en/articles/1321587-add-a-question-to-the-judging-evaluation-scorecard
- CompetitionSuite Tablet Judge App: https://help.competitionsuite.com/article/76-using-the-judge-app-tablets
- CompetitionSuite Judge App Store: https://apps.apple.com/us/app/competitionsuite-judge/id765095616
- Skild Judging Interface: https://www.skild.com/blog/skilds-new-judging-interface-is-here
- Marching Maestro Mobile App: https://get.marchingmaestro.com/mobile-app
- 准到评分系统: https://www.zhundao.net/app/83
- 准到评分系统使用说明: https://www.zhundao.net/service/help/detail/278
- 微管家现场评分配置教程: https://weixin.gycode.com/news/?id=1486
- 云互动现场评分: https://www.yunhudong.cn/gj/62.html
- Hi现场评分系统: https://www.hixianchang.com/info/article-47068.html
- NNGroup Form Cognitive Load: https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/
- NNGroup Slider Controls: https://www.nngroup.com/articles/gui-slider-controls/
- W3C WCAG 2.2 Target Size Minimum: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- Material Design Text Fields: https://m3.material.io/components/text-fields/guidelines
- Apple HIG Layout: https://developer.apple.com/design/human-interface-guidelines/layout
- Apple HIG Sliders: https://developer.apple.com/design/human-interface-guidelines/sliders
- Baymard Slider Interfaces: https://baymard.com/blog/slider-interfaces
