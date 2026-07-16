import { expect, test } from "@playwright/test";
import { allItems } from "../shared/scoringRules.js";

const baseURL = process.env.VISUAL_BASE_URL || "http://127.0.0.1:8899";
const artifactDir = process.env.VISUAL_ARTIFACT_DIR || "test-results";

async function apiLogin(request, username, password) {
  const response = await request.post(`${baseURL}/api/login`, { data: { username, password } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function submittedEntry(score = 8) {
  return {
    scores: Object.fromEntries(allItems.map((item) => [item.id, Math.min(item.max, score)])),
    submitted: true,
    serverRevision: 0,
    clientUpdatedAt: Date.now(),
  };
}

async function assertScoreboardGeometry(page, viewport, teamId, judgeCount, adminToken) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseURL}/scoreboard?teamId=${teamId}#controlToken=${encodeURIComponent(adminToken)}`);
  const cardsLocator = page.locator(".single-score-card");
  await expect(cardsLocator).toHaveCount(judgeCount);
  await expect(page.locator(".single-scoreboard-judges")).toHaveAttribute("data-judge-count", String(judgeCount));
  await expect(cardsLocator.last()).toHaveCSS("opacity", "1", { timeout: 4000 });
  const geometry = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".single-score-card")].map((element) => ({ ...element.getBoundingClientRect().toJSON(), opacity: Number(getComputedStyle(element).opacity) }));
    const extremes = document.querySelector(".single-scoreboard-extremes")?.getBoundingClientRect().toJSON();
    const total = document.querySelector(".single-scoreboard-context")?.getBoundingClientRect().toJSON();
    const identity = document.querySelector(".single-scoreboard-identity")?.getBoundingClientRect().toJSON();
    const shell = document.querySelector(".single-scoreboard-shell")?.getBoundingClientRect().toJSON();
    return { cards, extremes, total, identity, shell, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  for (const card of geometry.cards) {
    expect(card.opacity).toBeGreaterThan(0.99);
    expect(card.left).toBeGreaterThanOrEqual(geometry.shell.left - 1);
    expect(card.right).toBeLessThanOrEqual(geometry.shell.right + 1);
    expect(card.bottom).toBeLessThanOrEqual(geometry.extremes.top + 1);
    const overlapsTotal = card.left < geometry.total.right - 1 && card.right > geometry.total.left + 1 && card.top < geometry.total.bottom - 1 && card.bottom > geometry.total.top + 1;
    const overlapsIdentity = card.left < geometry.identity.right - 1 && card.right > geometry.identity.left + 1 && card.top < geometry.identity.bottom - 1 && card.bottom > geometry.identity.top + 1;
    expect(overlapsTotal).toBeFalsy();
    expect(overlapsIdentity).toBeFalsy();
  }
  for (let left = 0; left < geometry.cards.length; left += 1) {
    for (let right = left + 1; right < geometry.cards.length; right += 1) {
      const a = geometry.cards[left];
      const b = geometry.cards[right];
      const overlaps = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      expect(overlaps).toBeFalsy();
    }
  }
}

async function captureScoreboardSet(page, teamId, judgeCount, label, adminToken) {
  for (const viewport of [
    { width: 1920, height: 1080, suffix: "1920x1080" },
    { width: 1366, height: 768, suffix: "1366x768" },
    { width: 1024, height: 768, suffix: "1024x768" },
  ]) {
    await assertScoreboardGeometry(page, viewport, teamId, judgeCount, adminToken);
    await page.screenshot({ path: `${artifactDir}/scoreboard-${label}-${viewport.suffix}.png` });
    if (viewport.suffix === "1920x1080") {
      await expect(page).toHaveScreenshot(`scoreboard-${label}-1920x1080.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.005,
      });
    }
  }
}

test("赛中新增第八位评委从下一队生效并适配投屏", async ({ page, request, browser }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(10_000);
  await page.goto(baseURL);
  await page.getByLabel("账号").fill("admin");
  await page.getByLabel("密码").fill("admin123");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "赛事运营控制" })).toBeVisible();

  await page.getByRole("link", { name: "开赛配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "统一开赛配置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "赛前准备", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "高职组准备状态" })).toBeVisible();
  await expect(page.locator(".competition-preflight > div > div")).toHaveCount(5);
  await page.getByRole("button", { name: "开启本组比赛" }).click();
  await expect(page.getByLabel("当前比赛组别")).toHaveValue("gaozhi");
  await expect(page.getByRole("heading", { name: "等待派发", exact: true })).toBeVisible();

  await page.getByLabel("派发队伍").selectOption("GZ01");
  await page.getByRole("button", { name: "派发首支队伍" }).click();
  await expect(page.getByText("当前评分队伍已派发")).toBeVisible();
  await page.getByRole("link", { name: "评委管理", exact: true }).click();
  await expect(page.getByText("当前队按 7 位评委评分，后续计划为 7 位")).toBeVisible();

  await page.getByRole("button", { name: "新增评委" }).click();
  const dialog = page.getByRole("dialog", { name: "新增评委" });
  await dialog.locator('input[name="username"]').fill("008");
  await dialog.locator('input[name="displayName"]').fill("评委 08");
  await dialog.locator('input[name="password"]').fill("visual-008");
  await dialog.getByRole("button", { name: "新增评委", exact: true }).click();
  await expect(page.getByText("评委账号已创建，将从下一支首次派发队伍起参与评分")).toBeVisible();
  await expect(page.getByText("当前队按 7 位评委评分，后续计划为 8 位")).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/admin-future-judge-enrollment.png`, fullPage: true });

  const adminToken = await apiLogin(request, "admin", "admin123");
  let stateResponse = await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) });
  let state = await stateResponse.json();
  const dynamicJudge = state.accounts.find((account) => account.username === "008");
  const outgoingJudgeId = state.activeAssignment.rosterSnapshot[0];
  await page.locator(".admin-emergency-shortcut").click();
  await expect(page.getByRole("heading", { name: "应急处置" })).toBeVisible();
  await expect(page.locator(".admin-emergency-options article")).toHaveCount(3);
  await page.screenshot({ path: `${artifactDir}/admin-emergency-center.png`, fullPage: true });
  await page.getByRole("button", { name: "处理当前队评委" }).click();
  await expect(page.locator(".judge-matrix-panel")).toBeFocused();
  await page.getByRole("button", { name: "替换评委" }).first().click();
  const replacementPanel = page.getByLabel("当前队评委应急替换");
  await replacementPanel.getByLabel("替补评委").selectOption(dynamicJudge.id);
  await replacementPanel.getByLabel("处置原因").fill("评委现场临时离场");
  await replacementPanel.getByRole("button", { name: "确认替换评委" }).click();
  await expect(page.getByText("当前队评委已替换，其他评委成绩保持不变")).toBeVisible();
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  expect(state.activeAssignment.rosterSnapshot).toContain(dynamicJudge.id);
  expect(state.activeAssignment.rosterSnapshot).not.toContain(outgoingJudgeId);
  expect(state.activeAssignment.rosterSnapshot).toHaveLength(7);
  for (const judgeId of state.activeAssignment.rosterSnapshot) {
    const response = await request.put(`${baseURL}/api/entries/${judgeId}/GZ01`, { headers: auth(adminToken), data: { entry: submittedEntry(8) } });
    expect(response.ok()).toBeTruthy();
  }
  stateResponse = await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) });
  state = await stateResponse.json();
  await expect(page.getByRole("heading", { name: "前三队评分中", exact: true })).toBeVisible({ timeout: 5000 });
  await page.locator(".admin-workflow-banner .primary-action").click();
  await expect(page.getByLabel("派发队伍")).toHaveValue("GZ02");
  await expect(page.getByLabel("派发队伍")).toBeFocused();
  await captureScoreboardSet(page, "GZ01", 7, "seven-judges", adminToken);

  const dispatch = await request.post(`${baseURL}/api/assignments/dispatch`, {
    headers: auth(adminToken),
    data: { teamId: "GZ02", revision: state.activeAssignment.assignmentRevision },
  });
  expect(dispatch.ok()).toBeTruthy();
  const nextAssignment = (await dispatch.json()).activeAssignment;
  expect(nextAssignment.rosterSnapshot).toHaveLength(8);
  expect(nextAssignment.rosterSnapshot).toContain(dynamicJudge.id);
  const judgeContext = await browser.newContext();
  const judgePage = await judgeContext.newPage();
  await judgePage.goto(baseURL);
  await judgePage.getByLabel("账号").fill("008");
  await judgePage.getByLabel("密码").fill("visual-008");
  await judgePage.getByRole("button", { name: "登录" }).click();
  await expect(judgePage.getByText("当前评分队伍")).toBeVisible();
  await judgePage.route("**/api/entries/**", (route) => route.abort("internetdisconnected"));
  await judgePage.locator("[data-score-field]").first().click();
  const keypad = judgePage.locator("[data-score-pad]");
  const keypadKey = (label) => keypad.locator(".score-pad-keys button").filter({ hasText: new RegExp(`^${label}$`) });
  await keypadKey("8").click();
  await keypadKey("\\.").click();
  await keypadKey("2").click();
  await keypadKey("5").click();
  await expect(keypad.locator(".score-pad-readout strong")).toHaveText("8.25");
  await keypad.getByRole("button", { name: "退格" }).click();
  await expect(keypad.locator(".score-pad-readout strong")).toHaveText("8.2");
  await keypad.getByRole("button", { name: "清空" }).click();
  await expect(keypad.locator(".score-pad-readout strong")).toHaveText("--");
  await keypadKey("8").click();
  await keypad.getByRole("button", { name: "下一项" }).click();
  await expect(keypad.getByText(allItems[1].title, { exact: true })).toBeVisible();
  await keypad.getByRole("button", { name: "上一项" }).click();
  await expect(keypad.getByText(allItems[0].title, { exact: true })).toBeVisible();
  await keypad.getByRole("button", { name: "收起" }).click();
  const expandKeypad = judgePage.getByRole("button", { name: new RegExp(`展开${allItems[0].title}`) });
  await expect(expandKeypad).toBeVisible();
  await expandKeypad.click();
  await expect(keypad).toBeVisible();
  await expect(judgePage.getByRole("status").filter({ hasText: "服务器未连接，当前页面暂存" })).toBeVisible();
  await expect(judgePage.getByText("评分修改已在当前页面暂存，请勿刷新或退出；网络恢复后会自动补交。")).toBeVisible();
  await judgePage.unroute("**/api/entries/**");
  await expect(judgePage.getByRole("status").filter({ hasText: "评分服务器已连接" })).toBeVisible({ timeout: 7000 });
  const recoveredState = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  expect(recoveredState.entriesByJudge[dynamicJudge.id].GZ02.scores[allItems[0].id]).toBe(8);
  await judgeContext.close();
  for (const judgeId of nextAssignment.rosterSnapshot) {
    const entry = submittedEntry(judgeId === dynamicJudge.id ? 7 : 8);
    if (judgeId === dynamicJudge.id) entry.serverRevision = recoveredState.entriesByJudge[dynamicJudge.id].GZ02.serverRevision;
    const response = await request.put(`${baseURL}/api/entries/${judgeId}/GZ02`, { headers: auth(adminToken), data: { entry } });
    expect(response.ok()).toBeTruthy();
  }
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  await captureScoreboardSet(page, "GZ02", 8, "eight-judges", adminToken);

  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  async function enroll(number) {
    const username = String(number).padStart(3, "0");
    const enrollment = await request.post(`${baseURL}/api/admin/judge-enrollments`, {
      headers: auth(adminToken),
      data: { username, displayName: `评委 ${username}`, password: `visual-${username}`, operationId: `visual-enroll-${username}`, expectedRosterRevision: state.judgeRoster.revision, reason: "Visual regression dense roster" },
    });
    expect(enrollment.ok()).toBeTruthy();
    state.judgeRoster = (await enrollment.json()).judgeRoster;
  }
  await enroll(9);
  const thirdDispatch = await request.post(`${baseURL}/api/assignments/dispatch`, {
    headers: auth(adminToken),
    data: { teamId: "GZ03", revision: state.activeAssignment.assignmentRevision },
  });
  expect(thirdDispatch.ok()).toBeTruthy();
  const thirdAssignment = (await thirdDispatch.json()).activeAssignment;
  expect(thirdAssignment.rosterSnapshot).toHaveLength(9);
  for (const judgeId of thirdAssignment.rosterSnapshot) {
    const response = await request.put(`${baseURL}/api/entries/${judgeId}/GZ03`, { headers: auth(adminToken), data: { entry: submittedEntry(8) } });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto(`${baseURL}/?adminView=control`);
  await expect(page.getByRole("heading", { name: "前三队待集中公布", exact: true })).toBeVisible({ timeout: 7000 });
  await page.locator(".admin-workflow-banner .primary-action").click();
  await expect(page.getByRole("heading", { name: "选择要展示的队伍" })).toBeVisible();
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  expect(state.displaySelection.teamId).toBe("GZ01");
  expect(state.displaySelection.publicationStatus).toBe("final");
  const openingTeamNames = ["GZ02", "GZ03"].map((teamId) => state.teams.find((team) => team.id === teamId)?.teamName);
  for (const teamName of openingTeamNames) {
    await page.getByRole("option", { name: new RegExp(teamName) }).click();
    await page.getByRole("button", { name: "展示最终成绩" }).click();
    await expect(page.getByText("成绩展示已发布")).toBeVisible();
  }
  await page.goto(`${baseURL}/?adminView=control`);
  await expect(page.getByLabel("派发队伍")).toHaveValue("GZ04");
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  expect(state.displaySelection.teamId).toBe("GZ03");
  expect(state.displaySelection.publicationStatus).toBe("final");
  await captureScoreboardSet(page, "GZ03", 9, "nine-judges", adminToken);

  for (let number = 10; number <= 12; number += 1) await enroll(number);
  const fourthDispatch = await request.post(`${baseURL}/api/assignments/dispatch`, {
    headers: auth(adminToken),
    data: { teamId: "GZ04", revision: state.activeAssignment.assignmentRevision },
  });
  expect(fourthDispatch.ok()).toBeTruthy();
  const fourthAssignment = (await fourthDispatch.json()).activeAssignment;
  expect(fourthAssignment.rosterSnapshot).toHaveLength(12);
  await page.goto(`${baseURL}/?adminView=control`);
  await expect(page.getByRole("heading", { name: "正在评分", exact: true })).toBeVisible({ timeout: 7000 });
  for (const judgeId of fourthAssignment.rosterSnapshot) {
    const response = await request.put(`${baseURL}/api/entries/${judgeId}/GZ04`, { headers: auth(adminToken), data: { entry: submittedEntry(8) } });
    expect(response.ok()).toBeTruthy();
  }
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  const publishTwelve = await request.put(`${baseURL}/api/display-selection`, {
    headers: auth(adminToken),
    data: { teamId: "GZ04", publicationStatus: "final", revision: state.displaySelection.displayRevision },
  });
  expect(publishTwelve.ok()).toBeTruthy();
  await captureScoreboardSet(page, "GZ04", 12, "twelve-judges", adminToken);

  const threeJudgeIds = state.judgeRoster.judgeIds.slice(0, 3);
  const rosterUpdate = await request.put(`${baseURL}/api/judge-roster`, {
    headers: auth(adminToken),
    data: { judgeIds: threeJudgeIds, revision: state.judgeRoster.revision, reason: "Visual regression three-judge roster" },
  });
  expect(rosterUpdate.ok()).toBeTruthy();
  state.judgeRoster = (await rosterUpdate.json()).judgeRoster;
  const fifthDispatch = await request.post(`${baseURL}/api/assignments/dispatch`, {
    headers: auth(adminToken),
    data: { teamId: "GZ05", revision: state.activeAssignment.assignmentRevision },
  });
  expect(fifthDispatch.ok()).toBeTruthy();
  const fifthAssignment = (await fifthDispatch.json()).activeAssignment;
  expect(fifthAssignment.rosterSnapshot).toHaveLength(3);
  for (const judgeId of fifthAssignment.rosterSnapshot) {
    const response = await request.put(`${baseURL}/api/entries/${judgeId}/GZ05`, { headers: auth(adminToken), data: { entry: submittedEntry(8) } });
    expect(response.ok()).toBeTruthy();
  }
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  const publishThree = await request.put(`${baseURL}/api/display-selection`, {
    headers: auth(adminToken),
    data: { teamId: "GZ05", publicationStatus: "final", revision: state.displaySelection.displayRevision },
  });
  expect(publishThree.ok()).toBeTruthy();
  await captureScoreboardSet(page, "GZ05", 3, "three-judges", adminToken);

  await page.goto(`${baseURL}/?adminView=emergency`);
  await expect(page.getByRole("heading", { name: "应急处置" })).toBeVisible();
  await page.getByRole("button", { name: "重新配置当前组" }).click();
  await expect(page.locator(".competition-setup-actions")).toBeFocused();
  await page.getByRole("button", { name: "应急重新开赛" }).click();
  await expect(page.getByText("应急重新开赛将清除本组全部评分，请在 8 秒内再次点击确认")).toBeVisible();
  await page.getByRole("button", { name: "再次点击，确认清除并重开" }).click();
  await expect(page.getByText(/条评分已清除，请重新调整配置并开赛/)).toBeVisible();
  await expect(page.getByText("待配置", { exact: true }).first()).toBeVisible();

  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  expect(state.competitionSetup.activeGroupId).toBeNull();
  expect(state.competitionSetup.groups.gaozhi.status).toBe("draft");
  for (const entries of Object.values(state.entriesByJudge)) {
    expect(Object.keys(entries).some((teamId) => teamId.startsWith("GZ"))).toBeFalsy();
  }

  const setupSave = await request.put(`${baseURL}/api/competition-setup/gaozhi`, {
    headers: auth(adminToken),
    data: {
      teamIds: ["GZ01"],
      judgeIds: ["001", "002", "003"],
      revision: state.competitionSetup.groups.gaozhi.revision,
    },
  });
  expect(setupSave.ok()).toBeTruthy();
  state = await setupSave.json();
  const reopened = await request.post(`${baseURL}/api/competition-setup/gaozhi/open`, {
    headers: auth(adminToken),
    data: { revision: state.competitionSetup.groups.gaozhi.revision },
  });
  expect(reopened.ok()).toBeTruthy();
  const reopenedState = await reopened.json();
  const finalDispatch = await request.post(`${baseURL}/api/assignments/dispatch`, {
    headers: auth(adminToken),
    data: { teamId: "GZ01", revision: reopenedState.activeAssignment.assignmentRevision },
  });
  expect(finalDispatch.ok()).toBeTruthy();
  const finalAssignment = (await finalDispatch.json()).activeAssignment;
  const finalJudgeContext = await browser.newContext();
  const finalJudgePage = await finalJudgeContext.newPage();
  await finalJudgePage.goto(baseURL);
  await finalJudgePage.getByLabel("账号").fill("001");
  await finalJudgePage.getByLabel("密码").fill("001");
  await finalJudgePage.getByRole("button", { name: "登录" }).click();
  await expect(finalJudgePage.getByText("当前评分队伍", { exact: true })).toBeVisible();
  for (const judgeId of finalAssignment.rosterSnapshot) {
    const response = await request.put(`${baseURL}/api/entries/${judgeId}/GZ01`, {
      headers: auth(adminToken),
      data: { entry: submittedEntry(8) },
    });
    expect(response.ok()).toBeTruthy();
  }
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  const finalPublish = await request.put(`${baseURL}/api/display-selection`, {
    headers: auth(adminToken),
    data: { teamId: "GZ01", publicationStatus: "final", revision: state.displaySelection.displayRevision },
  });
  expect(finalPublish.ok()).toBeTruthy();
  await page.goto(`${baseURL}/?adminView=control`);
  await expect(page.getByRole("heading", { name: "待结束赛次", exact: true })).toBeVisible({ timeout: 7000 });
  await page.getByRole("button", { name: "结束本组比赛" }).click();
  await expect(page.getByText("高职组比赛已结束，赛次已锁定")).toBeVisible();
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  expect(state.competitionSetup.activeGroupId).toBeNull();
  expect(state.competitionSetup.groups.gaozhi.status).toBe("closed");
  expect(state.activeAssignment.status).toBe("closed");
  await expect(finalJudgePage.getByRole("heading", { name: "等待管理员安排评分队伍" })).toBeVisible({ timeout: 7000 });

  await expect(page.getByRole("heading", { name: "本组已完成", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "评委管理", exact: true }).click();
  await page.getByRole("button", { name: "调整后续计划名册" }).click();
  await page.getByRole("checkbox", { name: /评委 04/ }).check();
  await page.getByRole("button", { name: "保存计划名册" }).click();
  await expect(page.getByText("计划评分名册已保存")).toBeVisible();
  await page.locator(".judge-account-list button").filter({ hasText: "003" }).click();
  await page.getByLabel("停用", { exact: true }).check();
  await expect(page.getByText("保存后将停用账号，并同步从后续计划评分名册移除。")).toBeVisible();
  await page.getByRole("button", { name: "停用并移出名册" }).click();
  await expect(page.getByText("账号信息已保存")).toBeVisible();
  state = await (await request.get(`${baseURL}/api/state`, { headers: auth(adminToken) })).json();
  expect(state.accounts.find((account) => account.id === "003")?.status).toBe("disabled");
  expect(state.judgeRoster.judgeIds).not.toContain("003");

  const rankingPagePromise = page.context().waitForEvent("page");
  await page.getByRole("button", { name: "查看本组排名" }).click();
  const rankingPage = await rankingPagePromise;
  await rankingPage.waitForLoadState("domcontentloaded");
  expect(rankingPage.url()).toContain("/rankings?groupId=gaozhi");
  await expect(rankingPage.getByText("高职组").first()).toBeVisible();
  await rankingPage.close();
  await finalJudgeContext.close();
});
