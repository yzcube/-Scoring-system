**Source Visual Truth**

- Source route: `http://127.0.0.1:5179/scoreboard/demo-tech`.
- Source screenshot: `qa-artifacts/scoreboard-demo/demo-tech-source-1280x720.png`.
- Implementation route: `http://127.0.0.1:5179/scoreboard/demo-tech-premium`.
- Implementation screenshot: `qa-artifacts/scoreboard-demo/demo-tech-premium-bright-final.png`.
- Combined comparison: `qa-artifacts/scoreboard-demo/premium-bright-comparison.png`.
- Viewport and state: `1280 x 720`, first demo team, seven judge scores visible after the entrance animation.

**Findings**

- No actionable P0/P1/P2 findings remain.
- The revised premium route is visibly brighter than its first pass: the blue/cyan background artwork is legible, medium-blue panels separate cleanly from the stage, and the near-white composite-score panel remains the dominant result.
- The long team name, seven judge totals, and centralized removed-score module remain fully readable without overlap or clipping.

**Full-View Comparison Evidence**

- The original robot-tech route and the revised premium route were captured at the same `1280 x 720` viewport and placed together in `premium-bright-comparison.png`.
- Layout, content density, and stage crop remain stable. The intended change is limited to exposure, panel color, border contrast, and result hierarchy.
- The revised route uses lighter navy glass surfaces and a lower-opacity stage overlay, so the circuit lines, cyan light band, globe, and hand are no longer lost in near-black values.

**Focused Region Comparison Evidence**

- Identity: cool-white title text and brighter secondary text remain readable over the medium navy panel; the full long name wraps safely.
- Composite score: the near-white panel with dark tabular numerals is the highest-contrast element and reads first at projection distance.
- Judge cards: all seven cards use consistent medium-blue surfaces, cyan edge treatment, and white scores with no low-contrast labels.
- Removed scores: the module is brighter than the first pass, with neutral white for the removed high and cyan for the removed low; it remains centralized and large.

**Required Fidelity Surfaces**

- Fonts and typography: existing CJK/Latin-aware title styling, tabular score numerals, weights, and wrapping are preserved.
- Spacing and layout rhythm: 16:9 composition, margins, seven-column judge grid, and bottom result module remain unchanged and non-overlapping.
- Colors and visual tokens: bright cobalt stage, medium navy panels, cool white primary text, and one electric-cyan accent provide clearer projection exposure without leaving the AI competition palette.
- Image quality and asset fidelity: the supplied robot-arm/circuit/globe raster remains the actual full-stage background at cover scale; no substitute asset or CSS illustration is used.
- Copy and content: draw order, team name, registration number, project name, composite score, seven judge scores, and both removed scores are present and unchanged.

**Interaction And Runtime Checks**

- Right arrow changes to the second team; left arrow returns to the first team.
- Browser console errors: none.
- `npm run build`: passed.

**Comparison History**

- Pass 1 finding, P2: the premium route remained too dark because a `0.68` stage overlay and near-black panels suppressed the supplied blue artwork.
- Pass 1 fix: reduced the overlay, raised panel luminance, brightened borders and secondary text, and reserved a near-white surface for the composite score.
- Pass 2 finding, P2: the first brightness adjustment was still visually close to the dark version in the side-by-side comparison.
- Pass 2 fix: reduced the stage overlay to `0.16` and moved identity, judge, and removed-score panels to brighter cobalt/navy values.
- Post-fix evidence: `demo-tech-premium-bright-final.png` and `premium-bright-comparison.png` show the brighter background and panel separation with no readability regression.

**Follow-up Polish**

- P3: validate the chosen brightness once on the actual venue projector, because room lighting and projector black level can shift perceived contrast.

final result: passed
