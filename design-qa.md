**Source Visual Truth**

- Selected source image: `/Users/xukaihong/.codex/generated_images/019f7a89-63e9-7940-a863-8be71f9b889d/exec-f13a3ef5-2d72-45b3-acc2-afd760e2fa68.png`.
- Implementation route: `http://127.0.0.1:8776/scoreboard?live=1`.
- Browser-rendered implementation screenshot: `/tmp/scoreboard-waiting-1080p-restored.png`.
- Viewport and state: `1920 x 1080`, `ZZ11 / 星途队 / CT-0777`, zero submitted judges, controlled live projection.
- Full-view combined comparison: `/tmp/waiting-design-full-comparison.png` (source left, implementation right).
- Focused combined comparison: `/tmp/waiting-design-focused-comparison.png` (source left, implementation right).

**Findings**

- No actionable P0, P1, or P2 findings remain.
- The implementation matches the selected composition: the content group is at `x 309 / y 257`, is `1302px` wide and approximately `559px` high, with a large draw-order card, broad identity panel, and full-width waiting band.
- The exact status copy `等待评委打分中` is projection-prominent, and the team name, registration number, and draw order are fully visible without clipping.

**Required Fidelity Surfaces**

- Fonts and typography: the reference's high-contrast CJK display treatment is represented with the product's existing Source Han/Noto/Songti serif stack; the labels and status use the existing projection-safe sans-serif stack. Font size, weight, line height, tabular numerals, wrapping, and mixed-script fallbacks were checked at 1080p and 720p.
- Spacing and layout rhythm: source and implementation share the same 16:9 crop, `16.1%` left offset, `23.8%` top offset, `67.8%` content width, card proportions, inter-card gap, and full-width lower status band. No page scroll or content overflow remains.
- Colors and visual tokens: both use the same midnight navy, cool white, and electric-cyan projection palette. The glass opacity, cyan borders, restrained glow, and background-to-panel contrast remain readable without suppressing the supplied artwork.
- Image quality and asset fidelity: the implementation uses the existing full-resolution robot-arm/circuit/globe background asset directly at cover scale. No substitute SVG, CSS illustration, placeholder, or upscaled screenshot is used.
- Copy and content: `抽签顺序`, `队伍名称 /`, `队伍编号：CT-0777`, and `等待评委打分中` all match the approved visual and current product terminology.

**Full-View Comparison Evidence**

- `/tmp/waiting-design-full-comparison.png` places the normalized 1920×1080 source and implementation in one image. The robot arm, light beam, globe, hand, content centroid, panel proportions, and lower-band position align closely.
- The implementation intentionally keeps the product's real background and glass system rather than approximating the reference's tiny corner ornaments as CSS art.

**Focused Region Comparison Evidence**

- `/tmp/waiting-design-focused-comparison.png` compares the complete three-panel module at native content scale. Draw-order sizing, label hierarchy, short CJK team-name scale, registration-number baseline, status-band height, border weight, and internal padding are readable in this focused view.

**Primary Interaction And Runtime Checks**

- Zero submitted judges: the approved ceremonial waiting page is visible.
- One submitted judge: without reloading or changing the URL, the already-open page switched through normal polling to the existing formal score layout; `实时成绩`, `持续更新`, `评委1 100.00`, and six pending judge cards were visible. Evidence: `/tmp/scoreboard-one-judge-live-1080p.png`.
- The simulated entry was then cleared through the administrator API; the same open page returned to the waiting state. The isolated test data now has zero submissions for `ZZ11`.
- Responsive checks: `1280 x 720`, `1024 x 768` with centered 16:9 letterboxing, and `620 x 349` all fit without overflow or scrolling. Evidence: `/tmp/scoreboard-waiting-1280x720.png` plus measured browser geometry.
- Browser console errors and warnings: none.

**Comparison History**

- Pass 1 finding, P2: `/tmp/scoreboard-waiting-1080p-pass1.png` matched the structure, but the labels, draw-order number, team name, and status were smaller than the selected visual and lacked the intended projection hierarchy.
- Pass 1 fix: increased reference-critical title, numeral, identity, and status typography and aligned the card content from the source's top padding.
- Pass 2 finding, P1: `/tmp/scoreboard-waiting-1080p-pass2.png` exposed a two-line wrap in the large `11`, causing the second digit to overlap the lower status band.
- Pass 2 fix: kept the dynamic draw-order value on one line with scoped `white-space: nowrap` while preserving the measured card width and type scale.
- Post-fix evidence: `/tmp/scoreboard-waiting-1080p-restored.png`, `/tmp/waiting-design-full-comparison.png`, and `/tmp/waiting-design-focused-comparison.png` show no clipping, wrapping, or substantive visual mismatch.

**Open Questions**

- None.

**Implementation Checklist**

- [x] Separate the identity row from the full-width waiting-status band.
- [x] Match the approved 16:9 geometry and projection-readable typography.
- [x] Preserve the existing robot-tech background and live polling behavior.
- [x] Verify the zero-to-one-submission transition on an already-open display.
- [x] Restore isolated test data to the zero-submission waiting state.

**Follow-up Polish**

- P3: verify the chosen cyan exposure once on the venue projector, because projector black level and room lighting can shift perceived contrast.

final result: passed

---

## Single-Column Live Ranking Scale

**Source Visual Truth**

- Durable requirement: use the original single-column live-ranking format for every revealed-team count, reduce the `实时排名` heading, and spend the recovered height on more readable rows, team names, scores, and registration/team numbers.
- Visual reference: `/tmp/scoreboard-square-live-ranking-1080.png`, the approved original single-column projection language.
- Browser-rendered implementation: `/tmp/realtime-ranking-two-column-qa/single-column-number-larger-square.jpg` and `/tmp/realtime-ranking-two-column-qa/single-column-number-larger-wide.jpg`.
- Viewports: `1080 × 1080` and `1920 × 1080` CSS px, both at `devicePixelRatio: 1`; isolated public live projection with 20 scored/revealed teams.

**Findings**

- No actionable P0, P1, or P2 findings remain.
- The 20-team state renders as 20 visual rows in one column. All 20 cards stay inside the ranking window with zero page, track, or card overflow.
- The current team moves only vertically through rank positions; there is no horizontal transform or column handoff.
- The smaller heading releases enough height for `40.5px` square cards while keeping all rank, registration, team, state, and score content visible.

**Required Fidelity Surfaces**

- Fonts and typography: at `1080 × 1080`, the heading is `49.68px`, registration/team number `18.36px`, team name `22.14px`, and score `33.48px`. At `1920 × 1080`, those sizes are `64.32px`, `19.2px`, `23.81px`, and `36.48px` respectively.
- Spacing and layout rhythm: the heading separator and list move upward, the ranking window extends lower, and vertical padding/gaps are reduced without removing the glass-card rhythm. At `1080 × 1080`, each card is approximately `910 × 40.5px`; at `1920 × 1080`, approximately `1619 × 40.25px`.
- Colors and visual tokens: the existing midnight navy glass, electric-cyan rank treatment, cool-white team copy, gold current score, borders, and restrained glow are unchanged.
- Image quality and asset fidelity: the existing native square and 16:9 robot-tech background assets remain untouched; no substitute artwork or CSS illustration was introduced.
- Copy and content: all ranks, registration numbers, team names, score states, scores, the `当前队伍` badge, heading, count, and manual-advance footer remain directly visible.

**Full-View Comparison Evidence**

- `/tmp/realtime-ranking-two-column-qa/single-column-number-larger-square.jpg` shows the requested 20-team single-column square state at native resolution.
- `/tmp/realtime-ranking-two-column-qa/single-column-number-larger-wide.jpg` confirms that the same hierarchy remains intact on the 16:9 stage.

**Focused Region Comparison Evidence**

- A separate focused crop was unnecessary because the original-resolution captures keep all registration numbers, team names, state labels, and scores directly readable.

**Primary Interaction And Runtime Checks**

- A real shared `ArrowRight` transition was triggered against an isolated copy of the local contest state. The current team climbed vertically from the last row to rank 04 and then held at `实时排名已更新` for the required second confirmation.
- Measured 20-team square geometry: 20 cards, one `910px` column, 20 visual rows, no clipped registration numbers or team names, zero track overflow, and zero document overflow.
- Measured 20-team 16:9 geometry: 20 cards, one `1619px` column, 20 visual rows, no clipped registration numbers or team names, zero track overflow, and zero document overflow.
- Dynamic keyframes contained no horizontal ranking motion; `rankingColumnCount=1` and `rankingColumnHandoffs=0` throughout.
- Browser console warnings/errors and framework overlays: none.

**Comparison History**

- A two-column exploration was rejected because repeated left/right motion felt visually noisy.
- Final pass restored the original single column, removed every lateral ranking slot, reduced the title from the prior scale, enlarged registration/team number and primary ranking content, and expanded the list's vertical safe area.

**Open Questions**

- None.

**Implementation Checklist**

- [x] Keep every revealed-team count in one column.
- [x] Keep every revealed team visible without scrolling or clipping.
- [x] Preserve one-rank-at-a-time vertical current-team motion with no horizontal movement.
- [x] Reduce the heading and enlarge registration/team number, team name, and score typography.
- [x] Verify the 20-team state at square and 16:9 viewports.

**Follow-up Polish**

- P3: confirm the enlarged registration-number weight once on the venue screen, because panel calibration can soften secondary cyan text differently from the browser preview.

final result: passed

---

## 1080 × 1080 Native Projection Adaptation

**Source Visual Truth**

- Source visual truth: `/tmp/scoreboard-wide-result-1920x1080.png`, the existing formal 16:9 result stage rendered with the approved robot-tech language and the same `GZ01 / 从容应队 / CT-1903` result data.
- Browser-rendered implementation: `/tmp/scoreboard-square-result-1080-final.png`.
- Additional square-state evidence: `/tmp/scoreboard-square-waiting-1080.png`, `/tmp/scoreboard-square-live-ranking-1080.png`, `/tmp/scoreboard-square-overall-ranking-1080.png`, and `/tmp/slogan-ratio-qa/slogan-1080-square.jpg`.
- Viewport: source `1920 × 1080 CSS px`; implementation `1080 × 1080 CSS px`.
- Pixel dimensions and density: source `1920 × 1080 px`, implementation `1080 × 1080 px`, both at `devicePixelRatio: 1`; no density resampling was needed.
- State: controlled public projection at `/scoreboard?live=1`, final result published for seven submitted judges.
- The aspect-ratio change is intentional: the source establishes visual language and hierarchy, while the implementation is the approved native 1:1 reflow rather than a geometrically identical crop.

**Findings**

- No actionable P0, P1, or P2 findings remain.
- The square result preserves the source hierarchy and all visible data: identity/final score remain above the judge field, seven judge cards reflow to a centered `4 + 3` arrangement, and both removed-score values remain directly visible at the bottom.
- The full `1080 × 1080` canvas is used without letterboxing, page scrolling, card overlap, content clipping, or stretched artwork.

**Required Fidelity Surfaces**

- Fonts and typography: the existing CJK/Latin-compatible stacks, optical weight hierarchy, tabular score numerals, labels, line heights, and mixed-script alignment are preserved. The team name, registration number, final score, judge labels, and extreme-score labels remain readable at projection distance.
- Spacing and layout rhythm: the square stage keeps the approved top identity/result pairing, redistributes judge cards into two balanced rows, and anchors the result callout above the lower safe area. Measured shell and document scroll geometry are both exactly `1080 × 1080`.
- Colors and visual tokens: midnight navy glass, cool white, electric cyan, and the restrained gold/cyan extreme-score accents match the formal 16:9 route; contrast and border treatment remain consistent.
- Image quality and asset fidelity: the formal robot-arm/circuit/globe background remains unchanged. The slogan route now loads a dedicated `1254 × 1254` native-square image at `1080 × 1080`, with no CSS blur or letterbox layer, while `1920 × 1080` loads the newly supplied landscape JPEG byte-for-byte. Both render at their native aspect ratio without crop or stretch.
- Copy and content: `抽签顺序`, `队伍名称 /`, `队伍编号`, `最终得分`, `评委1–评委7`, `去掉最高分`, and `去掉最低分` remain unchanged and fully visible.

**Full-View Comparison Evidence**

- The source and implementation were opened together in one original-resolution comparison input. The visual hierarchy, glass treatment, palette, background focal points, typography roles, and score emphasis remain consistent across the intentional 16:9-to-1:1 reflow.
- Additional state captures confirm native square layouts for zero-submission waiting, live ranking, 20-team overall ranking, and slogan presentation.

**Focused Region Comparison Evidence**

- A separate crop was not needed: at the original `1080 × 1080` implementation resolution, all identity, score, judge-card, and extreme-score typography is directly readable in the full-view comparison.

**Primary Interaction And Runtime Checks**

- The stable public URL followed administrator-driven projection changes among score, slogan, live ranking, and overall ranking without opening a new document.
- Square result, waiting, slogan, live-ranking, and overall-ranking states were inspected at `1080 × 1080`; the slogan route was also rechecked at `1920 × 1080`. Responsive source selection changed from `scoreboard-slogan-2026-asean-nanning-square.png` to the supplied `scoreboard-slogan-2026-asean-nanning-16x9.jpg`, with zero document overflow in both viewports.
- The live projection fullscreen entry remained directly visible before Fullscreen API entry.
- Browser console errors and warnings: none.

**Comparison History**

- Formal comparison pass 1: no P0/P1/P2 mismatch was found, so no post-comparison visual fix iteration was required.
- The earlier landscape-image-plus-blurred-ambient square treatment was replaced after feedback with a dedicated 1:1 asset. Final evidence is `/tmp/slogan-ratio-qa/slogan-1080-square.jpg` and `/tmp/slogan-ratio-qa/slogan-1920-wide.jpg`.

**Open Questions**

- None.

**Implementation Checklist**

- [x] Add a native near-square stage without changing 16:9 behavior.
- [x] Reflow seven judge cards into a projection-readable `4 + 3` layout.
- [x] Allocate live-ranking and overall-ranking row heights from actual row counts.
- [x] Use separate native-aspect slogan assets for the 1:1 and 16:9 stages.
- [x] Verify all formal projection states without overflow or console errors.

**Follow-up Polish**

- P3: validate ambient blue brightness once on the actual 1080×1080 display, because venue panel calibration may differ from the browser preview.

final result: passed
