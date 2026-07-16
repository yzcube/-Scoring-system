# 评委端平板响应式头部与连接状态研究

日期：2026-07-16

## 结论

平板上“当前评分队伍”和“当前总分”分成两行不是浏览器兼容问题，而是现有 `@media (max-width: 860px)` 主动把 `.controlled-judge-hero` 从两列改成一列。该范围覆盖常见的 768、810、820、834 CSS px 竖屏平板。

建议保留基础样式已有的两列结构：动态队名使用 `minmax(0, 1fr)`，固定总分使用 `auto`/`max-content`。外层始终是一行；长队名只在左侧轨道内部换行，不把总分推到下一行，也不截断队名。

服务器状态可以使用正常绿色实心圆点、异常红色实心圆点，但圆点只能作为冗余视觉提示。旁边仍应显示“评分服务器已连接”或“评分服务器未连接”等完整文本，并让动态变化通过 `role="status"` 被辅助技术感知。

## 仓库现状

- [styles.css](../src/styles.css) 的 `.controlled-judge-hero` 基础规则已经使用 `grid-template-columns: minmax(0, 1fr) auto`，方向正确。
- 同文件在 `@media (max-width: 860px)` 内将其覆盖为 `grid-template-columns: 1fr`，这是平板变成上下两行的直接原因。
- `.controlled-team-name` 已有 `min-width: 0`，队名已有 `overflow-wrap: anywhere`，应保留。
- [App.jsx](../src/App.jsx) 已用 `role="status"` 和可见文本表达同步状态，也已经根据真实服务器请求成功/失败更新状态；改造时应保留这些语义，只增加实心圆点并收敛文案和颜色。
- [index.html](../index.html) 已声明 `width=device-width, initial-scale=1.0`，不需要通过禁用缩放来规避布局问题。MDN 明确提醒，禁用缩放会损害低视力用户可访问性。[MDN：viewport meta](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport)

## 布局建议

推荐的结构约束如下：

```css
.controlled-judge-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: center;
}

.controlled-team-name {
  min-width: 0;
}

.controlled-team-name strong {
  overflow-wrap: anywhere;
}

.score-compact {
  white-space: nowrap;
}
```

要点：

1. 不要在平板断点把头部改为单列。MDN 建议根据内容实际失效的位置选择断点，而不是绑定某个设备类别；媒体查询可以配合弹性网格和相对尺寸，而不是替代它们。[MDN：响应式设计](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Responsive_Design) [MDN：媒体查询基础](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Media_queries)
2. `minmax(0, 1fr)` 允许动态文本轨道真正收缩，把稳定空间留给总分。`minmax()` 用于给 Grid 轨道定义最小、最大范围。[MDN：`minmax()`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/minmax)
3. Flex/Grid 项的 `min-width: auto` 可能采用内容的最小固有宽度；动态文本容器显式设为 `min-width: 0`，才能在可用空间内收缩。[MDN：`min-width`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/min-width)
4. `overflow-wrap: anywhere` 只在没有正常断点、即将溢出时拆分长字符串，并且其断点会参与 `min-content` 计算，适合混合中英文队名和连续英文字符。[MDN：`overflow-wrap`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-wrap)
5. 不要用 `overflow: hidden`、省略号或固定高度掩盖问题；项目约束要求长队名完整显示。总分轨道可以禁止换行，但动态队名不能设置 `white-space: nowrap`。

如果改用 Flex，等价约束是外层 `flex-wrap: nowrap`，队名块 `flex: 1 1 auto; min-width: 0`，总分块 `flex: 0 0 auto`。`flex-wrap: nowrap` 会把项目保留在一条 flex line 上；内容超宽时仍需上述收缩和文本换行约束避免溢出。[MDN：`flex-wrap`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/flex-wrap)

## 连接状态建议

建议保留三种明确状态，避免连接中的瞬间被误报为故障：

| 状态 | 圆点 | 可见文本 |
| --- | --- | --- |
| checking | 中性灰色实心圆点 | 正在连接评分服务器 |
| online | 绿色实心圆点 | 评分服务器已连接 |
| offline | 红色实心圆点 | 评分服务器未连接，当前页面暂存 |

- WCAG 2.2 的“颜色使用”要求颜色不能成为传达信息的唯一视觉方式；绿色/红色之外必须保留可见文字，单独添加 `aria-label` 不能替代面向色觉障碍用户的可见线索。[W3C：SC 1.4.1 颜色使用](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color) [W3C：G14 用文字重复颜色信息](https://www.w3.org/WAI/WCAG22/Techniques/general/G14.html)
- 如果圆点本身承担有意义的图形提示，应与相邻背景保持至少 3:1 对比；不要使用过细描边，实心圆点更稳定。[W3C：SC 1.4.11 非文本对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast)
- 状态容器应继续使用 `role="status"`，圆点标记 `aria-hidden="true"`，让辅助技术只朗读一次完整文本。WAI-ARIA 规定 `status` 隐含 `aria-live="polite"` 和 `aria-atomic="true"`；WCAG 也将其列为应用状态消息的充分技术。[W3C：WAI-ARIA `status`](https://www.w3.org/TR/wai-aria/#status) [W3C：SC 4.1.3 状态消息](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- 连接状态应继续以评分服务器轮询/API 请求的真实结果为准，不要仅依赖 `navigator.onLine`。MDN 指出该属性在 LAN、VPN 和虚拟网络适配器环境中本质上不可靠。[MDN：`Navigator.onLine`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)

## 响应式验证建议

自动化至少覆盖以下 CSS viewport；平板同时测试横竖屏：

| 类别 | 视口 |
| --- | --- |
| 窄手机 | 360x800、390x844 |
| 平板竖屏 | 768x1024、810x1080、820x1180、834x1194 |
| 平板横屏 | 1024x768、1080x810、1180x820、1194x834 |
| 常规桌面 | 1366x768、1440x900 |

Playwright 的设备描述符可以同时模拟 viewport、screen、user agent 和触控能力，适合建立手机/平板项目；另用精确 viewport 补齐现场设备尺寸。[Playwright：设备模拟](https://playwright.dev/docs/emulation)

每个视口至少断言：

1. 当前队伍块和当前总分块都可见，并占据同一 Grid 行；不要只断言文字存在。
2. 注入普通、超长中文、混合中英文、无空格连续英文队名，队名完整可见且不与总分重叠。
3. `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`，页面无横向溢出。
4. online/offline/checking 均有实心圆点和可见文字，容器保持 `role="status"`；成功响应显示绿色已连接，失败或超时显示红色未连接。
5. 对稳定头部区域增加 `toHaveScreenshot()` 视觉基线，并在同一运行环境生成和比较，避免操作系统与渲染环境差异制造噪声。[Playwright：视觉比较](https://playwright.dev/docs/test-snapshots)

Chrome Device Mode 适合连续拖动宽度、跨断点和方向人工巡检，但 Chrome 官方将其定义为第一层近似而不是真实移动设备。最终验收应在至少一台现场平板上打开 LAN 地址，检查竖屏、横屏、长队名、断网和恢复连接。[Chrome DevTools：Device Mode 限制](https://developer.chrome.com/docs/devtools/device-mode#limitations)

## 验收边界

- 768 至 1194 CSS px 的常见平板横竖屏中，当前队伍与当前总分保持同一结构行。
- 超长队名完整换行，不截断、不溢出、不挤掉总分。
- 正常状态为绿色实心小圆点，异常状态为红色实心小圆点；两者始终配套清晰的可见文本。
- 不引入整页横向滚动，不以固定设备型号决定核心布局，不依赖纯截图或纯源码字符串证明响应式行为。
