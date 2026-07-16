import { expect, test } from "@playwright/test";

const baseURL = process.env.VISUAL_BASE_URL || "http://127.0.0.1:8899";

const judgeViewports = [
  { width: 320, height: 568 },
  { width: 568, height: 320 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 810, height: 1080 },
  { width: 820, height: 1180 },
  { width: 834, height: 1194 },
  { width: 1024, height: 768 },
  { width: 1080, height: 810 },
  { width: 1180, height: 820 },
  { width: 1194, height: 834 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];

async function readJudgeHeader(page) {
  return page.evaluate(() => {
    const hero = document.querySelector(".controlled-judge-hero")?.getBoundingClientRect();
    const team = document.querySelector(".controlled-team-name")?.getBoundingClientRect();
    const score = document.querySelector(".controlled-judge-hero .score-compact")?.getBoundingClientRect();
    const status = document.querySelector(".judge-sync-status");
    const dot = status?.querySelector(".sync-status-dot");
    const teamName = document.querySelector(".controlled-team-name strong");
    const logout = document.querySelector(".judge-logout-button")?.getBoundingClientRect();
    const submitBar = document.querySelector(".submit-bar")?.getBoundingClientRect();
    const submitBarNode = document.querySelector(".submit-bar");
    const resetButton = document.querySelector(".submit-bar > button:first-child")?.getBoundingClientRect();
    const scoreSummary = document.querySelector(".submit-bar > div")?.getBoundingClientRect();
    const submitButton = document.querySelector(".submit-bar > button:last-child")?.getBoundingClientRect();
    return {
      hero: hero?.toJSON(),
      team: team?.toJSON(),
      teamName: teamName?.textContent,
      teamNameClientHeight: teamName?.clientHeight,
      teamNameClientWidth: teamName?.clientWidth,
      teamNameScrollHeight: teamName?.scrollHeight,
      teamNameScrollWidth: teamName?.scrollWidth,
      score: score?.toJSON(),
      statusRole: status?.getAttribute("role"),
      statusText: status?.textContent?.trim(),
      status: status?.getBoundingClientRect().toJSON(),
      logout: logout?.toJSON(),
      submitBar: submitBar?.toJSON(),
      submitBarPosition: submitBarNode ? getComputedStyle(submitBarNode).position : "",
      submitBarBottomGap: submitBar ? window.innerHeight - submitBar.bottom : null,
      resetButton: resetButton?.toJSON(),
      scoreSummary: scoreSummary?.toJSON(),
      submitButton: submitButton?.toJSON(),
      dotColor: dot ? getComputedStyle(dot).backgroundColor : "",
      dotRadius: dot ? getComputedStyle(dot).borderRadius : "",
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

async function readSubmitBarClearance(page) {
  return page.evaluate(() => {
    const rubric = document.querySelector(".rubric-list");
    const submitBar = document.querySelector(".submit-bar");
    const scoreRows = Array.from(document.querySelectorAll(".score-row"));
    if (!rubric || !submitBar || scoreRows.length === 0) return null;

    rubric.scrollTop = rubric.scrollHeight;
    const rubricRect = rubric.getBoundingClientRect();
    const submitBarRect = submitBar.getBoundingClientRect();
    const lastRowRect = scoreRows.at(-1).getBoundingClientRect();
    const result = {
      position: getComputedStyle(submitBar).position,
      rubricBottom: rubricRect.bottom,
      submitBarTop: submitBarRect.top,
      lastRowBottom: lastRowRect.bottom,
    };
    rubric.scrollTop = 0;
    return result;
  });
}

function expectSingleRowHeader(geometry) {
  expect(geometry.hero).toBeTruthy();
  expect(geometry.score.left).toBeGreaterThan(geometry.team.left);
  expect(geometry.score.left).toBeGreaterThanOrEqual(geometry.team.right - 1);
  expect(Math.min(geometry.team.bottom, geometry.score.bottom) - Math.max(geometry.team.top, geometry.score.top)).toBeGreaterThan(0);
  expect(geometry.score.right).toBeLessThanOrEqual(geometry.hero.right + 1);
  expect(geometry.teamNameScrollHeight).toBeLessThanOrEqual(geometry.teamNameClientHeight + 1);
  expect(geometry.teamNameScrollWidth).toBeLessThanOrEqual(geometry.teamNameClientWidth + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  const topControlsOverlap = geometry.status.left < geometry.logout.right
    && geometry.status.right > geometry.logout.left
    && geometry.status.top < geometry.logout.bottom
    && geometry.status.bottom > geometry.logout.top;
  expect(topControlsOverlap).toBeFalsy();
  expect(geometry.resetButton.right).toBeLessThanOrEqual(geometry.scoreSummary.left + 1);
  expect(geometry.scoreSummary.right).toBeLessThanOrEqual(geometry.submitButton.left + 1);
  expect(geometry.resetButton.left).toBeGreaterThanOrEqual(geometry.submitBar.left - 1);
  expect(geometry.submitButton.right).toBeLessThanOrEqual(geometry.submitBar.right + 1);
  expect(geometry.submitBarPosition).toBe("fixed");
  expect(geometry.submitBarBottomGap).toBeGreaterThanOrEqual(10);
  expect(geometry.submitBarBottomGap).toBeLessThanOrEqual(26);
}

test("评委头部和服务器状态适配手机、平板与桌面", async ({ page, browser }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);

  await page.goto(baseURL);
  await page.getByLabel("账号").fill("admin");
  await page.getByLabel("密码").fill("admin123");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "开赛配置", exact: true }).click();
  await page.getByRole("button", { name: "开启本组比赛" }).click();

  const judgeContext = await browser.newContext({ viewport: judgeViewports[0], hasTouch: true });
  const judgePage = await judgeContext.newPage();
  await judgePage.goto(baseURL);
  await judgePage.getByLabel("账号").fill("001");
  await judgePage.getByLabel("密码").fill("001");
  await judgePage.getByRole("button", { name: "登录" }).click();
  await expect(judgePage.getByRole("heading", { name: "等待管理员安排评分队伍" })).toBeVisible();
  await expect(judgePage.locator(".judge-sync-status .sync-status-dot")).toHaveCSS("background-color", "rgb(21, 128, 61)");

  await page.getByLabel("派发队伍").selectOption("GZ01");
  await page.getByRole("button", { name: "派发首支队伍" }).click();
  await expect(page.getByText("当前评分队伍已派发")).toBeVisible();
  await expect(judgePage.getByText("当前评分队伍", { exact: true })).toBeVisible();

  for (const viewport of judgeViewports) {
    await judgePage.setViewportSize(viewport);
    const geometry = await readJudgeHeader(judgePage);
    expectSingleRowHeader(geometry);
    expect(geometry.statusRole).toBe("status");
    expect(geometry.statusText).toBe("评分服务器已连接");
    expect(geometry.dotColor).toBe("rgb(21, 128, 61)");
    expect(geometry.dotRadius).toBe("50%");
  }

  for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }, { width: 834, height: 1194 }, { width: 1194, height: 834 }]) {
    await judgePage.setViewportSize(viewport);
    const clearance = await readSubmitBarClearance(judgePage);
    expect(clearance.position).toBe("fixed");
    expect(clearance.rubricBottom).toBeGreaterThan(clearance.submitBarTop);
    expect(clearance.lastRowBottom).toBeLessThanOrEqual(clearance.submitBarTop - 12);
  }

  const stressTeamNames = [
    "超长混合队伍名称 Flyelep Global AI Cross-border Commerce Innovation Team 2026",
    "人工智能赋能跨境电子商务全链路数字化创新实践先锋示范队伍",
    "UnbrokenEnglishTeamNameWithoutNaturalWrapPointsForResponsiveStressTesting2026",
  ];
  for (const teamName of stressTeamNames) {
    for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 800 }, { width: 768, height: 1024 }, { width: 834, height: 1194 }]) {
      await judgePage.setViewportSize(viewport);
      await judgePage.locator(".controlled-team-name strong").evaluate((node, name) => { node.textContent = name; }, teamName);
      const geometry = await readJudgeHeader(judgePage);
      expectSingleRowHeader(geometry);
      expect(geometry.teamName).toBe(teamName);
    }
  }

  await judgePage.reload();
  await expect(judgePage.getByText("当前评分队伍", { exact: true })).toBeVisible();
  await judgePage.route("**/api/state", (route) => route.abort("internetdisconnected"));
  await expect(judgePage.getByRole("status").filter({ hasText: "服务器未连接，当前页面暂存" })).toBeVisible({ timeout: 7000 });
  await expect(judgePage.locator(".judge-sync-status .sync-status-dot")).toHaveCSS("background-color", "rgb(220, 38, 38)");
  await judgePage.unroute("**/api/state");
  await expect(judgePage.getByRole("status").filter({ hasText: "评分服务器已连接" })).toBeVisible({ timeout: 7000 });
  await expect(judgePage.locator(".judge-sync-status .sync-status-dot")).toHaveCSS("background-color", "rgb(21, 128, 61)");
  await judgeContext.close();
});
