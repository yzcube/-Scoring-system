import { useEffect, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  getLiveScoreboardEntryRoute,
  getScoreboardRoute,
  normalizeAppPath,
  SCOREBOARD_CLEAN_DEMO_PATH,
  SCOREBOARD_DEMO_PATH,
  SCOREBOARD_PREMIUM_DEMO_PATH,
  SCOREBOARD_RESULTS_PATH,
  SCOREBOARD_SLOGAN_PATH,
  SCOREBOARD_TECH_BACKUP_DEMO_PATH,
  SCOREBOARD_TECH_DEMO_PATH,
  SCOREBOARD_TECH_NINE_JUDGES_DEMO_PATH,
  SCOREBOARD_TECH_TOTAL_EXTREMES_GROUPED_DEMO_PATH,
} from "./appRoute.js";
import { mergeConfiguredTeamOrder, reconcileConfiguredTeamOrder } from "./teamOrderScope.js";
import {
  ArrowLeft,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  GripVertical,
  Keyboard,
  KeyRound,
  ListOrdered,
  LockKeyhole,
  MonitorPlay,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Trash2,
  X,
  UsersRound,
} from "lucide-react";
import { contestGroups, defaultCandidateOrderByGroup } from "../shared/contestData.js";
import { deriveCompetitionPreflight, deriveDispatchControlState } from "../shared/adminWorkflow.js";
import { createOperationGeneration } from "./sessionWorkGeneration.js";
import { getScoreboardJudgeLayout } from "./scoreboardLayout.js";
import {
  allItems,
  createBlankScores,
  createEntry,
  formatCents,
  formatScore,
  getScoresTotalCents,
  rubric,
  sanitizeEntry,
  scoreScale,
  toScore,
} from "../shared/scoringRules.js";

const authTokenStorageKey = "campus-final-tablet-auth-token-v2";
const projectionControlTokenStorageKey = "campus-final-projection-control-token-v1";
const judgeDraftStorageKey = "campus-final-tablet-controlled-drafts-v1";
const deviceStorageKey = "campus-final-tablet-device-v1";
const scoreboardNavigationPollMs = 500;
const scoreboardDataPollMs = 2000;
const scoreDraftPattern = /^\d{0,2}([.,]\d{0,2})?$/;
const emptyAssignment = {
  groupId: contestGroups[0]?.id ?? "gaozhi",
  teamId: null,
  status: "idle",
  assignmentRevision: 0,
  rosterRevision: 0,
  rosterSnapshot: [],
  rescoreRevision: 0,
  rescoreAssignmentsByJudge: {},
  updatedAt: "",
};
const emptyDisplay = { teamId: null, publicationStatus: "idle", displayRevision: 0, publishedAt: "", updatedAt: "" };

function createEmptyClientState() {
  return {
    teams: [],
    accounts: [],
    entriesByJudge: {},
    summariesByTeam: {},
    judgeRoster: { judgeIds: [], revision: 0, lockedAt: "" },
    competitionSetup: { activeGroupId: null, revision: 0, groups: {} },
    teamOrderRevisionByGroup: {},
    activeAssignment: emptyAssignment,
    displaySelection: emptyDisplay,
    restartImpactByGroup: {},
    security: { adminPasswordRotationRequired: false, adminPasswordRotated: true },
    workflowByGroup: {},
  };
}

function getGroupLabel(groupId) {
  return contestGroups.find((group) => group.id === groupId)?.label ?? "未知组别";
}

function getTeamStatusLabel(status) {
  return { active: "正常参赛", withdrawn: "退赛", archived: "归档" }[status] ?? "未设置";
}

function getDisplayTeamState(summary) {
  if (summary?.isFinal) return { label: "最终成绩", tone: "final" };
  if ((summary?.submittedCount ?? 0) > 0) return { label: `已提交 ${summary.submittedCount} 位`, tone: "ready" };
  return { label: "等待评分", tone: "waiting" };
}

function orderTeams(teams, groupId, includeArchived = true) {
  return teams
    .filter((team) => team.groupId === groupId && (includeArchived || team.status !== "archived"))
    .sort((left, right) => left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id));
}

function assignmentKey(assignment) {
  return assignment?.teamId ? `${assignment.teamId}:${assignment.assignmentRevision}` : "";
}

function getEntryFromState(state, judgeId, teamId) {
  return sanitizeEntry(state?.entriesByJudge?.[judgeId]?.[teamId]);
}

function isNewerDraft(localEntry, serverEntry) {
  const localRevision = Number(localEntry?.serverRevision ?? 0);
  const serverRevision = Number(serverEntry?.serverRevision ?? 0);
  return localRevision > serverRevision || (localRevision === serverRevision && Number(localEntry?.clientUpdatedAt ?? 0) > Number(serverEntry?.clientUpdatedAt ?? 0));
}

function getTeamMetaLine(team, fallback = "未填写项目名称") {
  return [team.registrationNumber || "未填写报名编号", team.projectName || fallback].filter(Boolean).join(" · ");
}

function ScoreboardTeamName({ name }) {
  const text = String(name ?? "");
  const isLatinName = /^[\sA-Za-z0-9 .,&+_-]+$/.test(text);
  const isShortCjkName = !/[A-Za-z]/.test(text) && Array.from(text).length <= 8;
  const isCompactName = Array.from(text.trim()).length <= 20;
  const fragments = text.split(/([A-Za-z][A-Za-z0-9&+_-]*)/g).filter(Boolean);
  const className = [isLatinName ? "is-latin-name" : "", isShortCjkName ? "is-short-cjk-name" : "", isCompactName ? "is-compact-name" : ""].filter(Boolean).join(" ") || undefined;
  return <h1 className={className}>{fragments.map((fragment, index) => /[A-Za-z]/.test(fragment) ? <span className="single-scoreboard-name-latin" key={`${fragment}-${index}`}>{fragment}</span> : fragment)}</h1>;
}

function ScoreboardPromotion() {
  return (
    <div className="scoreboard-promo-copy" role="status" aria-label="AI赋能跨电 数智融通东盟">
      <p className="scoreboard-promo-slogan">
        <span className="scoreboard-promo-line"><em>AI</em><strong>赋能跨电</strong></span>
        <span className="scoreboard-promo-line"><strong>数智融通</strong><em>东盟</em></span>
      </p>
    </div>
  );
}

function loadToken() {
  try {
    return sessionStorage.getItem(authTokenStorageKey) || "";
  } catch {
    return "";
  }
}

function loadDraftCache() {
  try {
    const value = JSON.parse(sessionStorage.getItem(judgeDraftStorageKey) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function createDeviceId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadDeviceId() {
  try {
    const current = sessionStorage.getItem(deviceStorageKey);
    if (current) return current;
    const next = createDeviceId();
    sessionStorage.setItem(deviceStorageKey, next);
    return next;
  } catch {
    return createDeviceId();
  }
}

function loadProjectionControlToken() {
  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const fragmentToken = hash.get("controlToken") || "";
    if (fragmentToken) {
      sessionStorage.setItem(projectionControlTokenStorageKey, fragmentToken);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      return fragmentToken;
    }
    return sessionStorage.getItem(projectionControlTokenStorageKey) || "";
  } catch {
    return "";
  }
}

function createApiError(message, status = 0) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function authHeaders(token, headers = {}) {
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

async function readApi(response, fallbackMessage) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // The fallback stays useful for malformed response bodies.
  }
  if (!response.ok || payload.ok === false) throw createApiError(payload.error || fallbackMessage, response.status);
  return payload;
}

async function requestApi(path, options = {}, fallbackMessage = "评分服务器请求失败") {
  const response = await fetch(path, { cache: "no-store", ...options });
  return readApi(response, fallbackMessage);
}

function replaceScoreboardRoute(pathname, { live = false } = {}) {
  const nextUrl = new URL(pathname, window.location.origin);
  if (live) nextUrl.searchParams.set("live", "1");
  const nextLocation = `${nextUrl.pathname}${nextUrl.search}`;
  if (`${window.location.pathname}${window.location.search}` === nextLocation) return;
  window.location.replace(nextLocation);
}

function formatScoreboardDrawOrder(orderLabel) {
  const value = Number.parseInt(String(orderLabel ?? "").split("/")[0], 10);
  return Number.isFinite(value) && value > 0 ? String(value).padStart(2, "0") : "--";
}

function ScoreboardSloganStage() {
  return (
    <main className="scoreboard-page single-scoreboard-page">
      <section className="single-scoreboard-shell scoreboard-promo-stage" aria-label="AI跨境电商比赛候场宣传页">
        <ScoreboardPromotion />
      </section>
    </main>
  );
}

function ScoreboardUnscoredStage({ team, topbar, orderLabel }) {
  return (
    <main className="scoreboard-page single-scoreboard-page">
      <section className={`single-scoreboard-shell scoreboard-empty-stage${topbar ? " has-controller" : ""}`} aria-label={`${team.teamName} 等待评分`}>
        {topbar}
        <div className="scoreboard-empty-copy" role="status">
          <div className="scoreboard-empty-draw-order">
            <span>抽签顺序</span>
            <strong>{formatScoreboardDrawOrder(orderLabel)}</strong>
          </div>
          <div className="scoreboard-empty-team-panel">
            <span className="scoreboard-empty-label">队伍名称 /</span>
            <ScoreboardTeamName name={team.teamName} />
            {team.registrationNumber ? <span className="scoreboard-empty-number">队伍编号：{team.registrationNumber}</span> : null}
            {team.projectName ? <span>{team.projectName}</span> : null}
            <span className="scoreboard-empty-status">等待评委评分</span>
          </div>
        </div>
      </section>
    </main>
  );
}

function ScoreboardSloganPage() {
  const [controlToken] = useState(loadProjectionControlToken);
  const isLiveProjection = new URLSearchParams(window.location.search).get("live") === "1";
  const inFlightRef = useRef(false);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!isLiveProjection) return undefined;
    let mounted = true;

    async function refreshDisplayRoute() {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const suffix = controlToken ? "?control=1" : "";
        const next = await requestApi(
          `/api/scoreboard${suffix}`,
          { signal: controller.signal, headers: authHeaders(controlToken) },
          "成绩展示数据不可用",
        );
        if (!mounted || controller.signal.aborted) return;
        replaceScoreboardRoute(getLiveScoreboardEntryRoute(next), { live: true });
      } catch (error) {
        if (error.name !== "AbortError") {
          // Keep the promotional page visible if the display server is temporarily unavailable.
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        inFlightRef.current = false;
      }
    }

    refreshDisplayRoute();
    const timer = window.setInterval(refreshDisplayRoute, scoreboardNavigationPollMs);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [controlToken, isLiveProjection]);

  return <ScoreboardSloganStage />;
}

async function fetchState(token, signal) {
  return requestApi("/api/state", { headers: authHeaders(token), signal }, "评分服务器不可用");
}

async function loginToServer(username, password, deviceId, signal) {
  return requestApi(
    "/api/login",
    { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, deviceId }) },
    "登录失败",
  );
}

async function fetchSession(token, signal) {
  return requestApi("/api/session", { headers: authHeaders(token), signal }, "登录已失效，请重新登录");
}

async function cloneAdminSession(token, deviceId) {
  return requestApi(
    "/api/session/clone",
    { method: "POST", headers: authHeaders(token, { "Content-Type": "application/json" }), body: JSON.stringify({ deviceId }) },
    "无法为新标签页创建独立登录会话",
  );
}

function Toast({ message, className = "" }) {
  return <div className={["toast", className, message ? "is-visible" : ""].filter(Boolean).join(" ")} role="status" aria-live="polite">{message}</div>;
}

function ConnectionStatus({ status, className = "" }) {
  const tone = ["checking", "online", "offline"].includes(status?.tone) ? status.tone : "checking";
  return (
    <div className={["sync-status", className, tone].filter(Boolean).join(" ")} role="status" aria-live="polite" aria-atomic="true">
      <span className="sync-status-dot" aria-hidden="true" />
      <span>{status?.label || "正在连接评分服务器"}</span>
    </div>
  );
}

function ScoreboardPage() {
  const [payload, setPayload] = useState(null);
  const [requestedTeamId, setRequestedTeamId] = useState(() => new URLSearchParams(window.location.search).get("teamId") || "");
  const isLiveProjection = new URLSearchParams(window.location.search).get("live") === "1";
  const [isTeamMenuOpen, setIsTeamMenuOpen] = useState(false);
  const [controlToken] = useState(loadProjectionControlToken);
  const [menuGroupId, setMenuGroupId] = useState("");
  const payloadRef = useRef(null);
  const inFlightRef = useRef(false);
  const abortRef = useRef(null);
  const selectedTeamOptionRef = useRef(null);
  const requestedTeamIdRef = useRef(requestedTeamId);

  useEffect(() => {
    requestedTeamIdRef.current = requestedTeamId;
  }, [requestedTeamId]);

  useEffect(() => {
    if (!isTeamMenuOpen) return;
    selectedTeamOptionRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isTeamMenuOpen, menuGroupId, payload?.selectedTeam?.id]);

  useEffect(() => {
    if (!isTeamMenuOpen) setMenuGroupId(payload?.selectedTeam?.groupId ?? "");
  }, [isTeamMenuOpen, payload?.selectedTeam?.groupId]);

  async function refresh() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestTeamId = requestedTeamId;
    try {
      const query = new URLSearchParams();
      if (controlToken) query.set("control", "1");
      if (controlToken && requestTeamId) query.set("teamId", requestTeamId);
      const suffix = query.size ? `?${query.toString()}` : "";
      const next = await requestApi(`/api/scoreboard${suffix}`, { signal: controller.signal, headers: authHeaders(controlToken) }, "成绩展示数据不可用");
      if (requestTeamId !== requestedTeamIdRef.current) return;
      if (isLiveProjection) {
        const nextRoute = getScoreboardRoute(next.displaySelection?.publicationStatus);
        if (nextRoute !== SCOREBOARD_RESULTS_PATH) {
          replaceScoreboardRoute(nextRoute, { live: true });
          return;
        }
      }
      if (!next.displayTeam || !next.displaySummary) {
        replaceScoreboardRoute(SCOREBOARD_SLOGAN_PATH, { live: isLiveProjection });
        return;
      }
      payloadRef.current = next;
      setPayload(next);
    } catch (error) {
      if (error.name === "AbortError") return;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inFlightRef.current = false;
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, isLiveProjection ? scoreboardNavigationPollMs : scoreboardDataPollMs);
    const onPopState = () => {
      const nextTeamId = new URLSearchParams(window.location.search).get("teamId") || "";
      requestedTeamIdRef.current = nextTeamId;
      setRequestedTeamId(nextTeamId);
      setIsTeamMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsTeamMenuOpen(false);
        return;
      }
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      if (event.target instanceof Element && ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
      const nextPayload = payloadRef.current;
      const options = nextPayload?.teamOptions ?? [];
      const current = nextPayload?.selectedTeam;
      if (!current) return;
      const groupOptions = options.filter((item) => item.groupId === current.groupId);
      const currentIndex = groupOptions.findIndex((item) => item.id === current.id);
      const next = groupOptions[currentIndex + (event.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      selectTeam(next.id);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearInterval(timer);
      abortRef.current?.abort();
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isLiveProjection, requestedTeamId]);

  function selectTeam(teamId) {
    const nextTeamId = teamId || "";
    requestedTeamIdRef.current = nextTeamId;
    setRequestedTeamId(nextTeamId);
    setIsTeamMenuOpen(false);
    const nextUrl = new URL(window.location.href);
    if (nextTeamId) nextUrl.searchParams.set("teamId", nextTeamId);
    else nextUrl.searchParams.delete("teamId");
    window.history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}`);
  }

  const team = payload?.displayTeam;
  const selectedTeam = payload?.selectedTeam;
  const summary = payload?.displaySummary;
  const options = payload?.teamOptions ?? [];
  const availableMenuGroups = contestGroups.filter((group) => options.some((option) => option.groupId === group.id));
  const activeMenuGroupId = availableMenuGroups.some((group) => group.id === menuGroupId)
    ? menuGroupId
    : selectedTeam?.groupId ?? availableMenuGroups[0]?.id ?? "";
  const menuOptions = options.filter((option) => option.groupId === activeMenuGroupId);
  const currentGroupOptions = selectedTeam ? options.filter((item) => item.groupId === selectedTeam.groupId) : [];
  const currentIndex = selectedTeam ? currentGroupOptions.findIndex((item) => item.id === selectedTeam.id) : -1;
  const previousTeam = currentIndex > 0 ? currentGroupOptions[currentIndex - 1] : null;
  const nextTeam = currentIndex >= 0 && currentIndex < currentGroupOptions.length - 1 ? currentGroupOptions[currentIndex + 1] : null;
  const topbar = payload?.controller ? (
    <div className="single-scoreboard-topbar">
      <div className="single-scoreboard-toolbar" aria-label="成绩展示控制">
        <button className="single-scoreboard-nav-button" type="button" disabled={!previousTeam} onClick={() => selectTeam(previousTeam?.id)} aria-label={previousTeam ? `上一队 ${previousTeam.teamName}` : "没有上一队"}>
          <ArrowLeft size={16} aria-hidden="true" />上一队
        </button>
        <button className="single-scoreboard-current-button" type="button" aria-expanded={isTeamMenuOpen} aria-controls="scoreboard-team-menu" onClick={() => {
          if (!isTeamMenuOpen) setMenuGroupId(selectedTeam?.groupId ?? availableMenuGroups[0]?.id ?? "");
          setIsTeamMenuOpen((open) => !open);
        }}>
          <span className="single-scoreboard-current-order">{selectedTeam?.orderLabel ?? "选择队伍"}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        <button className="single-scoreboard-nav-button" type="button" disabled={!nextTeam} onClick={() => selectTeam(nextTeam?.id)} aria-label={nextTeam ? `下一队 ${nextTeam.teamName}` : "没有下一队"}>
          下一队<ArrowRight size={16} aria-hidden="true" />
        </button>
        {isTeamMenuOpen ? (
          <div className="single-scoreboard-team-menu" id="scoreboard-team-menu">
            <div className="single-scoreboard-group-switcher" aria-label="选择队伍分组">
              {availableMenuGroups.map((group) => (
                <button type="button" aria-pressed={group.id === activeMenuGroupId} key={group.id} onClick={() => setMenuGroupId(group.id)}>{group.label}</button>
              ))}
            </div>
            <div className="single-scoreboard-team-options" role="listbox" aria-label={`${getGroupLabel(activeMenuGroupId)}成绩展示队伍`}>
              {menuOptions.map((option) => (
                <button className="single-scoreboard-team-option" type="button" role="option" aria-selected={option.id === selectedTeam?.id} key={option.id} ref={option.id === selectedTeam?.id ? selectedTeamOptionRef : undefined} onClick={() => selectTeam(option.id)}>
                  <span className="single-scoreboard-team-code"><strong>{option.orderLabel}</strong><small>{option.groupLabel}</small></span>
                  <span className="single-scoreboard-team-name"><strong>{option.teamName}</strong><small>{option.projectName || "未填写项目名称"}</small></span>
                  <span className="single-scoreboard-team-status">{option.statusLabel}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  ) : null;
  if (!team || !summary) return <ScoreboardSloganStage />;
  if (summary.submittedCount === 0) return <ScoreboardUnscoredStage team={team} topbar={topbar} orderLabel={selectedTeam?.orderLabel} />;
  const scores = summary.anonymousScores ?? [];
  const judgeLayout = getScoreboardJudgeLayout(scores.length);
  const teamNameText = String(team.teamName ?? "");
  const isLongTeamName = teamNameText.length >= 12;
  return (
    <main className="scoreboard-page single-scoreboard-page">
      <section className={`single-scoreboard-shell${isLongTeamName ? " is-long-name" : ""}${topbar ? " has-controller" : ""}`} aria-label={`${team.teamName} 成绩展示`}>
        {topbar}
        <div className="single-scoreboard-main">
          <section className="single-scoreboard-judge-stage" aria-label="匿名评委评分">
            <div className={`single-scoreboard-judges is-${judgeLayout.density}`} data-judge-count={judgeLayout.count} style={{ "--judge-columns": judgeLayout.columns }}>
              {scores.map((item, index) => (
                <div className={item.submitted ? "single-score-card is-submitted" : "single-score-card is-pending"} key={`${team.id}-${index}`} style={{ "--score-delay": `${index * 90}ms` }}>
                  <span>评委{index + 1}</span>
                  <strong>{item.score}</strong>
                </div>
              ))}
            </div>
          </section>
          <section className="single-scoreboard-copy single-scoreboard-identity">
            <div className="single-scoreboard-draw-order">
              <span>抽签顺序</span>
              <strong>{formatScoreboardDrawOrder(selectedTeam?.orderLabel)}</strong>
            </div>
            <div className="single-scoreboard-identity-panel">
              <span className="single-scoreboard-identity-label">队伍名称 /</span>
              <ScoreboardTeamName name={team.teamName} />
              {team.registrationNumber ? <p className="single-scoreboard-team-number">队伍编号：{team.registrationNumber}</p> : null}
              {team.projectName ? <p className="single-scoreboard-product">{team.projectName}</p> : null}
            </div>
          </section>
          <aside className="single-scoreboard-context" aria-label="总成绩">
            <span className="single-scoreboard-total-label">总成绩</span>
            <div className="single-scoreboard-score-value"><strong>{summary.display}</strong></div>
          </aside>
          <div className="single-scoreboard-extremes">
            <div className="single-scoreboard-extreme is-high"><span>去掉最高分</span><strong>{summary.high?.score ?? "--"}</strong></div>
            <div className="single-scoreboard-extreme is-low"><span>去掉最低分</span><strong>{summary.low?.score ?? "--"}</strong></div>
          </div>
        </div>
      </section>
    </main>
  );
}

const scoreboardDemoTeams = [
  {
    drawOrder: "01",
    registrationNumber: "ST-0022",
    teamName: "跨境电商综合试验区全链路AI赋能公共服务平台建设项目团队",
    projectName: "跨境电商综合试验区全链路AI赋能公共服务平台建设项目",
    total: "88.47",
    scores: ["89.00", "87.08", "88.00", "89.48", "87.55", "88.51", "89.28"],
    additionalScores: ["88.47", "88.47"],
    high: "89.48",
    low: "87.08",
  },
  {
    drawOrder: "02",
    registrationNumber: "ST-0017",
    teamName: "数智融通东盟跨境电商创新团队",
    projectName: "AI驱动的跨境供应链协同服务平台",
    total: "87.96",
    scores: ["88.20", "86.75", "87.90", "89.10", "87.32", "88.63", "87.75"],
    additionalScores: ["87.96", "87.96"],
    high: "89.10",
    low: "86.75",
  },
  {
    drawOrder: "03",
    registrationNumber: "ST-0009",
    teamName: "Flyelep飞象全球电商内容智能体",
    projectName: "面向东盟市场的多语种商品内容智能生成平台",
    total: "90.12",
    scores: ["90.20", "89.65", "91.10", "89.88", "90.36", "90.51", "89.76"],
    additionalScores: ["90.06", "90.07"],
    high: "91.10",
    low: "89.65",
  },
];

function ScoreboardDemoPage({ variant = "light" }) {
  const [activeTeamIndex, setActiveTeamIndex] = useState(0);
  const team = scoreboardDemoTeams[activeTeamIndex];
  const isTechNineJudges = variant === "tech-nine-judges";
  const isTechTotalExtremesGrouped = variant === "tech-total-extremes-grouped";
  const demoScores = isTechNineJudges ? [...team.scores, ...team.additionalScores] : team.scores;
  const variantClass = variant === "clean"
    ? " is-clean"
    : variant === "tech"
      ? " is-tech"
      : variant === "tech-backup"
        ? " is-tech-backup"
        : isTechNineJudges
          ? " is-tech is-tech-nine-judges"
          : isTechTotalExtremesGrouped
            ? " is-tech is-tech-grouped"
            : variant === "premium"
              ? " is-premium"
              : "";
  const variantLabel = variant === "clean"
    ? "无背景图片"
    : variant === "tech"
      ? "机器人科技背景"
      : variant === "tech-backup"
        ? "机器人科技背景备份"
        : isTechNineJudges
          ? "九评委机器人科技背景"
          : isTechTotalExtremesGrouped
            ? "总成绩与剔除分数组合展示"
            : variant === "premium"
              ? "深空科技配色"
              : "淡蓝主题";

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && (event.target.matches("input, select, textarea, button") || event.target.isContentEditable)) return;
      event.preventDefault();
      setActiveTeamIndex((index) => Math.max(0, Math.min(scoreboardDemoTeams.length - 1, index + (event.key === "ArrowRight" ? 1 : -1))));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <main className={`scoreboard-demo-page${variantClass}`}>
      <section className={`scoreboard-demo-stage${variantClass}`} aria-label={`${team.teamName} ${variantLabel}成绩展示 demo`}>
        <section className="scoreboard-demo-identity" aria-label="队伍信息">
          <div className="scoreboard-demo-draw-order">
            <span>抽签顺序</span>
            <strong>{team.drawOrder}</strong>
          </div>
          <div className="scoreboard-demo-team-copy">
            <span className="scoreboard-demo-eyebrow">队伍名称 /</span>
            <ScoreboardTeamName name={team.teamName} />
            <p className="scoreboard-demo-team-number">队伍编号：{team.registrationNumber}</p>
            <p>{team.projectName}</p>
          </div>
        </section>

        {isTechTotalExtremesGrouped ? null : (
          <aside className="scoreboard-demo-total" aria-label="队伍总分">
            {(variant === "tech" || isTechNineJudges) ? <span>总成绩</span> : null}
            <strong>{team.total}</strong>
          </aside>
        )}

        <section className="scoreboard-demo-judges" aria-label="匿名评委评分">
          {demoScores.map((score, index) => (
            <div key={`${team.drawOrder}-${index}`} style={{ "--score-delay": `${index * 70}ms` }}>
              <span>评委{index + 1}</span>
              <strong>{score}</strong>
            </div>
          ))}
        </section>

        {isTechTotalExtremesGrouped ? (
          <section className="scoreboard-demo-summary-grouped" aria-label="总成绩与剔除分数">
            <div className="is-total"><span>总成绩</span><strong>{team.total}</strong></div>
            <div className="is-high"><span>去掉最高分</span><strong>{team.high}</strong></div>
            <div className="is-low"><span>去掉最低分</span><strong>{team.low}</strong></div>
          </section>
        ) : (
          <section className="scoreboard-demo-extremes" aria-label="剔除分数">
            {(variant === "tech" || isTechNineJudges) ? null : (
              <div className="scoreboard-demo-extremes-title">
                <span>综合评分计算</span>
                <strong>剔除分数</strong>
              </div>
            )}
            <div className="is-high"><span>去掉最高分</span><strong>{team.high}</strong></div>
            <div className="is-low"><span>去掉最低分</span><strong>{team.low}</strong></div>
          </section>
        )}
      </section>
    </main>
  );
}

function RankingsPage() {
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState(() => new URLSearchParams(window.location.search).get("groupId") || "");
  const [controlToken] = useState(loadProjectionControlToken);
  const inFlightRef = useRef(false);
  const selectedGroupIdRef = useRef(selectedGroupId);

  useEffect(() => {
    selectedGroupIdRef.current = selectedGroupId;
  }, [selectedGroupId]);

  async function refresh() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const requestGroupId = selectedGroupIdRef.current;
    try {
      const query = requestGroupId ? `?groupId=${encodeURIComponent(requestGroupId)}` : "";
      const next = await requestApi(`/api/rankings${query}`, { headers: authHeaders(controlToken) }, "队伍排名数据不可用");
      if (requestGroupId !== selectedGroupIdRef.current) return;
      setPayload(next);
      setLoadError("");
      if (!requestGroupId && next.selectedGroupId) {
        selectedGroupIdRef.current = next.selectedGroupId;
        setSelectedGroupId(next.selectedGroupId);
      }
    } catch (error) {
      if (!payload && error.name !== "AbortError") setLoadError(error.message || "队伍排名数据不可用");
    } finally {
      inFlightRef.current = false;
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [selectedGroupId]);

  function selectGroup(groupId) {
    selectedGroupIdRef.current = groupId;
    setSelectedGroupId(groupId);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("groupId", groupId);
    window.history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}`);
  }

  const rankings = payload?.rankings ?? [];
  const groups = payload?.groups ?? contestGroups.map((group) => ({ id: group.id, label: group.label, active: group.id === selectedGroupId }));

  return (
    <main className="rankings-page">
      <section className="rankings-shell" aria-label="队伍总排名">
        <header className="rankings-header">
          <div><span>决赛成绩总览</span><h1>{payload?.selectedGroupLabel ?? getGroupLabel(selectedGroupId)}队伍排名</h1></div>
          <nav className="rankings-group-tabs" aria-label="选择组别">
            {groups.map((group) => <button type="button" key={group.id} className={group.id === selectedGroupId ? "is-selected" : ""} onClick={() => selectGroup(group.id)}>{group.label}</button>)}
          </nav>
        </header>
        <div className="rankings-table" role="table" aria-label={`${payload?.selectedGroupLabel ?? ""}队伍排名和分数`}>
          <div className="rankings-row rankings-head" role="row">
            <span role="columnheader">排名</span>
            <span role="columnheader">队伍编号</span>
            <span role="columnheader">队伍</span>
            <span role="columnheader">提交</span>
            <span role="columnheader">综合分</span>
          </div>
          {!payload ? <div className="rankings-empty-state" role="status">{loadError || "正在加载队伍排名"}</div> : rankings.map((team) => (
            <div className={team.scoreValue === null ? "rankings-row is-pending" : "rankings-row"} role="row" key={team.id}>
              <span className="rankings-rank" role="cell">{team.scoreValue === null ? "--" : team.rank}</span>
              <span className="rankings-registration" role="cell">{team.registrationNumber || "--"}</span>
              <span className="rankings-team" role="cell"><strong>{team.teamName}</strong>{team.projectName ? <small>{team.projectName}</small> : null}</span>
              <span className="rankings-submissions" role="cell">{team.submittedCount}/{team.rosterCount}</span>
              <span className="rankings-score" role="cell">{team.score}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function SortableTeamRow({ team, index, teamCount, submittedCount, rosterCount, selected, onSelect, onMoveUp, onMoveDown }) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id: team.id });
  return (
    <div
      className={["admin-order-row", selected ? "is-selected" : "", isDragging ? "is-dragging" : ""].filter(Boolean).join(" ")}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button className="admin-order-row-main" type="button" onClick={onSelect}>
        <span className="admin-order-index">{String(index + 1).padStart(2, "0")}</span>
        <span className="admin-order-team"><strong>{team.teamName}</strong><small>{getTeamMetaLine(team)}</small></span>
      </button>
      <span className="admin-order-status"><b className={`team-status-dot is-${team.status || "unknown"}`}>{getTeamStatusLabel(team.status)}</b><span>提交 {submittedCount}/{rosterCount}</span></span>
      <div className="admin-order-row-actions">
        <button type="button" onClick={onMoveUp} disabled={index === 0} title="上移" aria-label={`上移 ${team.teamName}`}><ArrowUp size={16} aria-hidden="true" /></button>
        <button type="button" onClick={onMoveDown} disabled={index === teamCount - 1} title="下移" aria-label={`下移 ${team.teamName}`}><ArrowDown size={16} aria-hidden="true" /></button>
        <button type="button" className="admin-order-drag-handle" ref={setActivatorNodeRef} {...attributes} {...listeners} title="拖动排序" aria-label={`拖动 ${team.teamName} 调整出场顺序`}><GripVertical size={18} aria-hidden="true" /></button>
      </div>
    </div>
  );
}

function getAccountStatusLabel(status) {
  return status === "active" ? "启用" : status === "disabled" ? "停用" : "归档";
}

function getWorkflowPhaseCopy(phase) {
  return {
    security_check: ["开赛检查", "先完成管理员密码安全检查"],
    setup_required: ["赛前准备", "核对本场队伍与评委后开启比赛"],
    ready_to_dispatch: ["等待派发", "按抽签顺序派发下一支队伍"],
    scoring: ["正在评分", "关注当前队评委提交进度"],
    opening_scores_held: ["前三队评分中", "成绩暂不发布，继续按出场顺序完成前三队评分"],
    opening_batch_ready: ["前三队待集中公布", "在第四队开始前按出场顺序依次展示前三队成绩"],
    result_ready: ["成绩待发布", "核对当前队综合分并发布展示"],
    ready_to_close: ["待结束赛次", "全部队伍已完成，确认后结束本组比赛"],
    competition_complete: ["本组已完成", "查看并复核本组最终排名"],
  }[phase] ?? ["赛事准备", "核对当前比赛状态"];
}

function createAccountDraft(account) {
  return { displayName: account?.displayName ?? "", status: account?.status ?? "active", password: "", revision: account?.revision ?? 0 };
}

function JudgeManagementWorkspace({
  accounts,
  roster,
  rosterDraft,
  rosterDirty,
  currentAssignment,
  currentGroupOpen,
  newJudge,
  setNewJudge,
  onToggleRoster,
  onCancelRoster,
  onSaveRoster,
  onCreateJudge,
  onSaveAccount,
  showToast,
  preferredAccountId,
}) {
  const defaultAccountId = accounts.find((account) => account.username === "003")?.id ?? accounts[0]?.id ?? "";
  const [selectedAccountId, setSelectedAccountId] = useState(defaultAccountId);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(() => createAccountDraft(accounts.find((account) => account.id === defaultAccountId)));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const createDialogRef = useRef(null);
  const createTriggerRef = useRef(null);
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? accounts[0] ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredAccounts = normalizedQuery
    ? accounts.filter((account) => `${account.username} ${account.displayName}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : accounts;
  const rosterAccounts = roster.map((judgeId) => accounts.find((account) => account.id === judgeId)).filter(Boolean);
  const assignmentAccounts = (currentAssignment.rosterSnapshot ?? []).map((judgeId) => accounts.find((account) => account.id === judgeId)).filter(Boolean);
  const selectedInPlannedRoster = Boolean(selectedAccount?.role === "judge" && roster.includes(selectedAccount.id));
  const selectedInOpenAssignment = Boolean(
    selectedAccount?.role === "judge" &&
    currentGroupOpen &&
    currentAssignment.teamId &&
    currentAssignment.rosterSnapshot?.includes(selectedAccount.id),
  );
  const isDeactivatingSelectedAccount = Boolean(selectedAccount?.status === "active" && draft.status !== "active");
  const accountStatusBlocked = isDeactivatingSelectedAccount && selectedInOpenAssignment;

  useEffect(() => {
    if (selectedAccount || !accounts.length) return;
    const nextAccount = accounts.find((account) => account.username === "003") ?? accounts[0];
    setSelectedAccountId(nextAccount.id);
    setDraft(createAccountDraft(nextAccount));
    setDirty(false);
    setPasswordOpen(false);
  }, [accounts, selectedAccount]);

  useEffect(() => {
    if (!preferredAccountId || preferredAccountId === selectedAccountId || dirty) return;
    const account = accounts.find((item) => item.id === preferredAccountId);
    if (!account) return;
    setSelectedAccountId(account.id);
    setDraft(createAccountDraft(account));
    setPasswordOpen(account.role === "admin");
  }, [preferredAccountId, accounts, dirty, selectedAccountId]);

  useEffect(() => {
    if (!selectedAccount || dirty) return;
    setDraft(createAccountDraft(selectedAccount));
  }, [selectedAccount?.displayName, selectedAccount?.status, selectedAccount?.revision, dirty]);

  useEffect(() => {
    if (!createOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeCreateDialog();
      if (event.key !== "Tab" || !createDialogRef.current) return;
      const focusable = [...createDialogRef.current.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    createDialogRef.current?.querySelector("input")?.focus();
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createOpen]);

  function selectAccount(account) {
    if (account.id === selectedAccountId) return;
    if (dirty) return showToast("请先保存或取消当前账号修改");
    setSelectedAccountId(account.id);
    setDraft(createAccountDraft(account));
    setPasswordOpen(false);
  }

  function closeCreateDialog() {
    setCreateOpen(false);
    window.requestAnimationFrame(() => createTriggerRef.current?.focus());
  }

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  function cancelAccountChanges() {
    if (!selectedAccount) return;
    setDraft(createAccountDraft(selectedAccount));
    setDirty(false);
    setPasswordOpen(false);
  }

  function cancelPasswordChange() {
    setPasswordOpen(false);
    setDraft((current) => {
      const next = { ...current, password: "" };
      setDirty(Boolean(selectedAccount && (next.displayName !== selectedAccount.displayName || next.status !== selectedAccount.status)));
      return next;
    });
  }

  async function saveAccount() {
    if (!selectedAccount || !draft.displayName.trim()) return showToast("请输入账号显示名");
    if (rosterDirty) return showToast("请先保存或取消计划评分名册修改");
    if (accountStatusBlocked) return showToast("该评委仍在当前队评分快照中，请先在赛事控制完成评委替换");
    setSaving(true);
    const saved = await onSaveAccount(selectedAccount, draft);
    if (saved) {
      setDraft((current) => ({ ...current, password: "" }));
      setDirty(false);
      setPasswordOpen(false);
    }
    setSaving(false);
  }

  async function submitNewJudge(event) {
    event.preventDefault();
    const created = await onCreateJudge();
    if (created) closeCreateDialog();
  }

  return (
    <section className="judge-management-page">
      <header className="judge-management-heading">
        <div><span>评委与账号</span><h2>评委管理</h2></div>
        <button className="primary-action" type="button" ref={createTriggerRef} onClick={() => setCreateOpen(true)}><Plus size={17} aria-hidden="true" />新增评委</button>
      </header>

      <section className={`judge-roster-banner ${rosterOpen ? "is-open" : ""}`} aria-labelledby="judge-roster-title">
        <div className="judge-roster-summary">
          <LockKeyhole size={24} aria-hidden="true" />
          <div><strong id="judge-roster-title">{currentAssignment.teamId ? "当前队评分快照已确定" : "计划评分名册"}</strong><small>{currentAssignment.teamId ? `当前队按 ${currentAssignment.rosterSnapshot.length} 位评委评分，后续计划为 ${roster.length} 位` : `下次首次派发时按 ${roster.length} 位评委生成快照`}</small></div>
        </div>
        <p>{currentAssignment.teamId ? `当前快照：${assignmentAccounts.map((account) => account.displayName).join("、") || "无"}；后续计划：${rosterAccounts.map((account) => account.displayName).join("、") || "无"}` : `计划成员：${rosterAccounts.map((account) => account.displayName).join("、") || "尚未配置评委"}`}</p>
        <button className="judge-roster-edit-button" type="button" aria-expanded={rosterOpen} onClick={() => setRosterOpen((current) => !current)}>{rosterOpen ? "收起计划名册" : "调整后续计划名册"}<ChevronDown size={17} aria-hidden="true" /></button>
        {rosterOpen ? <div className="judge-roster-editor">
          <div className="judge-roster-editor-copy"><strong>后续首次派发队伍</strong><small>调整不会改变当前队伍已经锁定的评委快照。</small></div>
          <div className="judge-roster-options">{accounts.filter((account) => account.role === "judge").map((judge) => {
            const isSelected = rosterDraft.includes(judge.id);
            return <label key={judge.id}><input type="checkbox" checked={isSelected} disabled={judge.status !== "active" && !isSelected} onChange={() => onToggleRoster(judge.id)} /><span>{judge.displayName}</span><small>{getAccountStatusLabel(judge.status)}</small></label>;
          })}</div>
          <div className="judge-roster-actions"><span>{rosterDirty ? "计划名册有未保存修改" : `${rosterDraft.length} 位评委将在后续队伍生效`}</span><button className="ghost-action" type="button" disabled={!rosterDirty} onClick={onCancelRoster}>取消修改</button><button className="primary-action" type="button" disabled={!rosterDirty} onClick={onSaveRoster}><Save size={16} aria-hidden="true" />保存计划名册</button></div>
        </div> : null}
      </section>

      <section className="judge-account-workspace">
        <aside className="judge-account-directory" aria-label="账号目录">
          <label className="judge-account-search"><Search size={18} aria-hidden="true" /><span className="sr-only">搜索账号或显示名</span><input name="judge-account-search" type="search" autoComplete="off" placeholder="搜索账号或显示名…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="judge-account-count">{filteredAccounts.length === accounts.length ? `${accounts.length} 个账号` : `${filteredAccounts.length}/${accounts.length} 个账号`}</div>
          <div className="judge-account-list" aria-label="评委和管理员账号">
            {filteredAccounts.map((account) => <button type="button" aria-current={account.id === selectedAccount?.id ? "true" : undefined} className={account.id === selectedAccount?.id ? "is-selected" : ""} key={account.id} onClick={() => selectAccount(account)}><span className="judge-account-username" translate="no">{account.username}</span><strong>{account.displayName}</strong><span className={`judge-account-status is-${account.status}`}>{getAccountStatusLabel(account.status)}</span></button>)}
            {!filteredAccounts.length ? <p className="judge-account-empty">没有匹配的账号</p> : null}
          </div>
        </aside>

        <section className="judge-account-detail">
          {selectedAccount ? <>
            <header className="judge-account-detail-header"><div><h3>{selectedAccount.displayName} <small>/ 账号 <span translate="no">{selectedAccount.username}</span></small></h3></div><span className={`judge-account-status is-${draft.status}`}>{getAccountStatusLabel(draft.status)}</span></header>
            <div className="judge-account-detail-body">
              <section className="judge-account-section" aria-labelledby="account-basic-title">
                <h4 id="account-basic-title">基本信息</h4>
                <div className="judge-account-basic-grid">
                  <label>显示名<input name="displayName" autoComplete="off" value={draft.displayName} onChange={(event) => updateDraft({ displayName: event.target.value })} /></label>
                  <fieldset><legend>账号状态</legend><div className="judge-account-status-control">{[["active", "启用"], ["disabled", "停用"], ["archived", "归档"]].map(([value, label]) => <label key={value} className={draft.status === value ? "is-selected" : ""}><input type="radio" name="account-status" value={value} checked={draft.status === value} onChange={() => updateDraft({ status: value })} /><span>{label}</span></label>)}</div></fieldset>
                </div>
                {selectedAccount.role === "judge" ? <div className={`judge-account-scope${accountStatusBlocked ? " is-blocked" : isDeactivatingSelectedAccount && selectedInPlannedRoster ? " is-pending-removal" : ""}`}>
                  <div><span>参评范围</span><strong>{selectedInOpenAssignment ? "当前队评分快照成员" : selectedInPlannedRoster ? "后续计划评分成员" : "当前未加入计划名册"}</strong></div>
                  <p>{accountStatusBlocked ? "当前队仍需该评委完成评分。请先在赛事控制中替换评委，再停用或归档账号。" : isDeactivatingSelectedAccount && selectedInPlannedRoster ? `保存后将${draft.status === "archived" ? "归档" : "停用"}账号，并同步从后续计划评分名册移除。` : selectedInPlannedRoster ? "停用或归档时，系统会在同一次保存中将该账号移出后续计划名册。" : "账号状态变化不会改变已完成队伍的历史评分快照。"}</p>
                </div> : null}
                <div className="judge-account-readonly"><span>用户名</span><strong translate="no">{selectedAccount.username}</strong><small>登录账号创建后不可修改</small></div>
              </section>

              <section className="judge-account-section judge-account-credentials" aria-labelledby="account-credentials-title">
                <h4 id="account-credentials-title">登录凭据</h4>
                <p>为保障账号安全，系统不显示当前密码。修改密码会结束该账号现有登录会话。</p>
                {!passwordOpen ? <button className="ghost-action" type="button" onClick={() => setPasswordOpen(true)}><KeyRound size={17} aria-hidden="true" />设置新密码</button> : <div className="judge-password-editor"><label>新密码<input name="newPassword" type="password" minLength="8" maxLength="256" autoComplete="new-password" placeholder="输入 8–256 位新密码…" value={draft.password} onChange={(event) => updateDraft({ password: event.target.value })} /></label><button type="button" aria-label="取消设置新密码" title="取消设置新密码" onClick={cancelPasswordChange}><X size={18} aria-hidden="true" /></button></div>}
              </section>
            </div>
            <footer className="judge-account-detail-actions"><span className={dirty ? "is-dirty" : ""}>{accountStatusBlocked ? "当前队评分快照未解除" : rosterDirty ? "请先处理计划名册修改" : dirty ? "有未保存的更改" : "账号信息已同步"}</span><div><button className="ghost-action" type="button" disabled={!dirty || saving} onClick={cancelAccountChanges}>取消修改</button><button className="primary-action" type="button" disabled={!dirty || saving || accountStatusBlocked || rosterDirty} onClick={saveAccount}>{saving ? "保存中…" : isDeactivatingSelectedAccount && selectedInPlannedRoster ? `${draft.status === "archived" ? "归档" : "停用"}并移出名册` : "保存账号"}</button></div></footer>
          </> : <div className="judge-account-empty-detail"><strong>暂无账号</strong><span>新增评委后可在这里维护账号。</span></div>}
        </section>
      </section>

      {createOpen ? <div className="judge-create-backdrop" onClick={(event) => { if (event.target === event.currentTarget) closeCreateDialog(); }}>
        <section className="judge-create-dialog" role="dialog" aria-modal="true" aria-labelledby="judge-create-title" ref={createDialogRef}>
          <header><div><span>登录账号</span><h3 id="judge-create-title">新增评委</h3></div><button type="button" aria-label="关闭新增评委" title="关闭" onClick={closeCreateDialog}><X size={20} aria-hidden="true" /></button></header>
          <form onSubmit={submitNewJudge}>
            <label>账号<input required name="username" autoComplete="off" spellCheck="false" placeholder="例如 008…" value={newJudge.username} onChange={(event) => setNewJudge({ ...newJudge, username: event.target.value, operationId: "" })} /></label>
            <label>显示名<input required name="displayName" autoComplete="off" placeholder="例如 评委 08…" value={newJudge.displayName} onChange={(event) => setNewJudge({ ...newJudge, displayName: event.target.value, operationId: "" })} /></label>
            <label>初始密码<input required name="password" type="password" minLength="8" maxLength="256" autoComplete="new-password" placeholder="输入 8–256 位初始密码…" value={newJudge.password} onChange={(event) => setNewJudge({ ...newJudge, password: event.target.value, operationId: "" })} /></label>
            <fieldset className="judge-enrollment-options"><legend>参评范围</legend><label><input type="radio" name="judge-enrollment" value="future_assignments" checked={newJudge.enrollment === "future_assignments"} onChange={(event) => setNewJudge({ ...newJudge, enrollment: event.target.value, operationId: "" })} /><span>从下一支队伍起加入评分</span><small>推荐</small></label><label><input type="radio" name="judge-enrollment" value="account_only" checked={newJudge.enrollment === "account_only"} onChange={(event) => setNewJudge({ ...newJudge, enrollment: event.target.value, operationId: "" })} /><span>仅创建账号</span></label></fieldset>
            <footer><button className="ghost-action" type="button" onClick={closeCreateDialog}>取消</button><button className="primary-action" type="submit">新增评委</button></footer>
          </form>
        </section>
      </div> : null}
    </section>
  );
}

function AdminWorkspace({ state, authToken, syncStatus, logout, mutate, refresh, showToast, toast, expireSession, updateLocalTeam }) {
  const [view, setView] = useState(() =>
    new URLSearchParams(window.location.search).get("adminView") ||
    (state.competitionSetup?.activeGroupId ? "control" : "setup"),
  );
  const [selectedGroupId, setSelectedGroupId] = useState(() => {
    const publishedTeam = state.teams?.find((team) => team.id === state.displaySelection?.teamId);
    return view === "display" && publishedTeam?.groupId
      ? publishedTeam.groupId
      : state.activeAssignment?.groupId || contestGroups[0]?.id;
  });
  const [dispatchSelection, setDispatchSelection] = useState({ teamId: "", assignmentRevision: null });
  const [forceDispatch, setForceDispatch] = useState(false);
  const [displayTeamId, setDisplayTeamId] = useState(() => state.displaySelection?.teamId || "");
  const [displaySearch, setDisplaySearch] = useState("");
  const [managedTeamId, setManagedTeamId] = useState("");
  const [teamDraft, setTeamDraft] = useState({ registrationNumber: "", teamName: "", projectName: "", status: "active" });
  const [teamDirty, setTeamDirty] = useState(false);
  const [newTeamDraft, setNewTeamDraft] = useState({ registrationNumber: "", teamName: "", projectName: "" });
  const [orderDraftByGroup, setOrderDraftByGroup] = useState({});
  const [rosterDraft, setRosterDraft] = useState([]);
  const [rosterDraftRevision, setRosterDraftRevision] = useState(0);
  const [rosterDirty, setRosterDirty] = useState(false);
  const [newJudge, setNewJudge] = useState({ username: "", displayName: "", password: "", enrollment: "future_assignments", operationId: "" });
  const [showJudgeDetails, setShowJudgeDetails] = useState(false);
  const [setupGroupId, setSetupGroupId] = useState(() => state.competitionSetup?.activeGroupId || contestGroups[0]?.id);
  const [setupDraft, setSetupDraft] = useState({ teamIds: [], judgeIds: [], revision: 0 });
  const [setupDirty, setSetupDirty] = useState(false);
  const [restartIntentGroupId, setRestartIntentGroupId] = useState("");
  const [deleteTeamIntentId, setDeleteTeamIntentId] = useState("");
  const [preferredAccountId, setPreferredAccountId] = useState("");
  const [judgeReplacement, setJudgeReplacement] = useState(null);
  const [historicalRescoreDraft, setHistoricalRescoreDraft] = useState({
    teamId: "",
    judgeId: "",
    mode: "retain",
    reason: "",
    clearConfirmed: false,
  });
  const [navigationIntent, setNavigationIntent] = useState("");
  const adminMutationBusyRef = useRef(false);
  const previousAdminViewRef = useRef(view);
  const restartIntentTimerRef = useRef(null);
  const deleteTeamIntentTimerRef = useRef(null);
  const dispatchSelectRef = useRef(null);
  const judgeMatrixRef = useRef(null);
  const setupActionsRef = useRef(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const teams = state.teams ?? [];
  const accounts = state.accounts ?? [];
  const roster = state.judgeRoster?.judgeIds ?? [];
  const rosterCount = roster.length;
  const groupTeams = orderTeams(teams, selectedGroupId);
  const activeGroupTeams = groupTeams.filter((team) => team.status === "active");
  const displaySetupTeamIds = new Set(state.competitionSetup?.groups?.[selectedGroupId]?.teamIds ?? []);
  const displayCompetitionTeams = activeGroupTeams.filter((team) => displaySetupTeamIds.has(team.id));
  const normalizedDisplaySearch = displaySearch.trim().toLocaleLowerCase("zh-CN");
  const displayFilteredTeams = normalizedDisplaySearch
    ? displayCompetitionTeams.filter((team) => [team.registrationNumber, team.teamName, team.projectName]
        .some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(normalizedDisplaySearch)))
    : displayCompetitionTeams;
  const displayCandidateTeam = displayCompetitionTeams.find((team) => team.id === displayTeamId) ?? null;
  const displayCandidateSummary = displayCandidateTeam ? state.summariesByTeam?.[displayCandidateTeam.id] : null;
  const displayCandidateSubmittedCount = displayCandidateSummary?.submittedCount ?? 0;
  const publishedDisplayTeamId = state.displaySelection?.teamId ?? "";
  const publishedDisplayTeamGroupId = teams.find((team) => team.id === publishedDisplayTeamId)?.groupId ?? "";
  const openingDisplayTeam = displayCompetitionTeams[0] ?? null;
  const openingDisplaySummary = openingDisplayTeam ? state.summariesByTeam?.[openingDisplayTeam.id] : null;
  const openingDisplaySubmittedCount = openingDisplaySummary?.submittedCount ?? 0;
  const openingDisplayReady = Boolean(openingDisplayTeam && openingDisplaySubmittedCount >= 1);
  const scoreDisplayIsActive = ["final", "temporary"].includes(state.displaySelection?.publicationStatus);
  const projectionEntryPath = getScoreboardRoute(state.displaySelection?.publicationStatus);
  const activeCompetitionGroupId = state.competitionSetup?.activeGroupId ?? null;
  const activeCompetitionSetup = activeCompetitionGroupId ? state.competitionSetup?.groups?.[activeCompetitionGroupId] : null;
  const dispatchableTeams = activeGroupTeams.filter((team) => activeCompetitionSetup?.teamIds?.includes(team.id));
  const selectedSetup = state.competitionSetup?.groups?.[setupGroupId] ?? null;
  const availableSetupTeams = orderTeams(teams, setupGroupId, false).filter((team) => team.status === "active");
  const setupTeams = orderTeams(teams, setupGroupId).filter((team) => team.status === "active" || setupDraft.teamIds.includes(team.id));
  const availableSetupJudges = accounts.filter((account) => account.role === "judge" && account.status === "active");
  const setupJudges = accounts.filter((account) => account.role === "judge" && (account.status === "active" || setupDraft.judgeIds.includes(account.id)));
  const hasUnavailableSetupTeams = setupDraft.teamIds.some((id) => !availableSetupTeams.some((team) => team.id === id));
  const hasUnavailableSetupJudges = setupDraft.judgeIds.some((id) => !availableSetupJudges.some((judge) => judge.id === id));
  const setupHasUnavailableParticipants = hasUnavailableSetupTeams || hasUnavailableSetupJudges;
  const setupRestartImpact = state.restartImpactByGroup?.[setupGroupId] ?? { entryCount: 0, hasScoringData: false };
  const setupGroupHasScoringData = setupRestartImpact.hasScoringData;
  const managedTeam = groupTeams.find((team) => team.id === managedTeamId) ?? groupTeams[0] ?? null;
  const configuredTeamIds = state.competitionSetup?.groups?.[selectedGroupId]?.teamIds ?? [];
  const fullOfficialOrder = groupTeams.map((team) => team.id);
  const officialOrder = reconcileConfiguredTeamOrder(fullOfficialOrder, configuredTeamIds);
  const orderDraft = reconcileConfiguredTeamOrder(
    fullOfficialOrder,
    configuredTeamIds,
    orderDraftByGroup[selectedGroupId],
  );
  const orderDirty = orderDraft.length !== officialOrder.length || orderDraft.some((id, index) => id !== officialOrder[index]);
  const orderedDraftTeams = orderDraft.map((id) => teams.find((team) => team.id === id)).filter(Boolean);
  const currentAssignment = state.activeAssignment ?? emptyAssignment;
  const assignmentRoster = currentAssignment.rosterSnapshot ?? [];
  const currentRosterCount = assignmentRoster.length;
  const currentTeam = teams.find((team) => team.id === currentAssignment.teamId) ?? null;
  const rescoreAssignmentsByJudge = currentAssignment.rescoreAssignmentsByJudge ?? {};
  const activeHistoricalRescores = Object.entries(rescoreAssignmentsByJudge)
    .map(([judgeId, grant]) => ({ judgeId, ...grant }))
    .filter((grant) => grant.teamId);
  const activeHistoricalRescoreTeamIds = new Set(activeHistoricalRescores.map((grant) => grant.teamId));
  const historicalRescoreTeams = activeCompetitionSetup?.status === "open"
    ? orderTeams(teams, activeCompetitionGroupId, false).filter((team) =>
        team.status === "active"
        && activeCompetitionSetup.teamIds?.includes(team.id)
        && team.id !== currentAssignment.teamId
        && (state.summariesByTeam?.[team.id]?.isFinal || activeHistoricalRescoreTeamIds.has(team.id)))
    : [];
  const selectedHistoricalRescoreTeam = historicalRescoreTeams.find((team) => team.id === historicalRescoreDraft.teamId) ?? null;
  const selectedHistoricalRescoreJudges = (selectedHistoricalRescoreTeam?.judgeRosterSnapshot ?? []).map((judgeId) => {
    const judge = accounts.find((account) => account.id === judgeId);
    const scoreEntry = getEntryFromState(state, judgeId, selectedHistoricalRescoreTeam.id);
    return {
      id: judgeId,
      displayName: judge?.displayName ?? judgeId,
      username: judge?.username ?? "未知账号",
      status: judge?.status ?? "archived",
      submitted: scoreEntry.submitted,
      serverRevision: scoreEntry.serverRevision,
      grant: rescoreAssignmentsByJudge[judgeId] ?? null,
    };
  });
  const selectedHistoricalRescoreJudge = selectedHistoricalRescoreJudges.find((judge) => judge.id === historicalRescoreDraft.judgeId) ?? null;
  const historicalRescoreReason = historicalRescoreDraft.reason.trim();
  const historicalRescoreReady = Boolean(
    selectedHistoricalRescoreTeam
    && selectedHistoricalRescoreJudge
    && selectedHistoricalRescoreJudge.status === "active"
    && selectedHistoricalRescoreJudge.submitted
    && !selectedHistoricalRescoreJudge.grant
    && historicalRescoreReason.length >= 3
    && historicalRescoreReason.length <= 500
    && (historicalRescoreDraft.mode !== "clear" || historicalRescoreDraft.clearConfirmed),
  );
  const currentTeamSummary = currentTeam ? state.summariesByTeam?.[currentTeam.id] : null;
  const currentSubmittedCount = currentTeamSummary?.submittedCount ?? 0;
  const currentExpectedCount = currentTeamSummary?.rosterCount ?? currentRosterCount ?? rosterCount;
  const currentSubmissionPercentage = currentExpectedCount
    ? Math.min(100, Math.round((currentSubmittedCount / currentExpectedCount) * 100))
    : 0;
  const selectedDisplayTeam = teams.find((team) => team.id === state.displaySelection?.teamId) ?? null;
  const replacementCandidates = accounts.filter((account) => account.role === "judge" && account.status === "active" && !assignmentRoster.includes(account.id));
  const workflowGroupId = activeCompetitionGroupId || setupGroupId;
  const workflow = state.workflowByGroup?.[workflowGroupId] ?? null;
  const selectedSetupWorkflow = state.workflowByGroup?.[setupGroupId] ?? null;
  const setupPreflightChecks = selectedSetupWorkflow ? deriveCompetitionPreflight(state, {
    groupId: setupGroupId,
    passwordReady: state.security?.adminPasswordRotated !== false,
    teamIds: setupDraft.teamIds,
    judgeIds: setupDraft.judgeIds,
  }) : [];
  const workflowPhaseCopy = getWorkflowPhaseCopy(workflow?.phase);
  const selectedSetupPhaseCopy = getWorkflowPhaseCopy(selectedSetupWorkflow?.phase);
  const workflowCurrentTeam = teams.find((team) => team.id === workflow?.currentTeamId) ?? null;
  const workflowRecommendedTeam = teams.find((team) => team.id === workflow?.recommendedTeamId) ?? null;
  const dispatchControl = deriveDispatchControlState({
    activeGroupId: activeCompetitionGroupId,
    currentAssignment,
    currentSummary: currentTeamSummary,
    recommendedTeamId: workflow?.recommendedTeamId,
    selectedTeamId: dispatchSelection.teamId,
    selectionRevision: dispatchSelection.assignmentRevision,
  });
  const dispatchTeamId = dispatchControl.suggestedTeamId;
  const selectedDispatchTeam = teams.find((team) => team.id === dispatchTeamId) ?? null;
  const isForcedDispatch = forceDispatch && !dispatchControl.canDispatch;
  const dispatchDisabled = !dispatchTeamId
    || (!dispatchControl.canDispatch && !isForcedDispatch);
  const forcedDispatchTargetLabel = selectedDispatchTeam
    ? `强制切换到：${selectedDispatchTeam.teamName}`
    : "确认强制切换";
  const setupProgress = selectedSetupWorkflow?.progress ?? {
    completedTeams: 0,
    totalTeams: setupDraft.teamIds.length,
    percentage: 0,
    currentTeamId: null,
    currentSubmittedCount: 0,
    currentRosterCount: 0,
  };
  const setupCurrentTeam = teams.find((team) => team.id === setupProgress.currentTeamId) ?? null;
  const setupRemainingTeams = Math.max(0, setupProgress.totalTeams - setupProgress.completedTeams);

  function chooseDispatchTeam(teamId) {
    setDispatchSelection({ teamId, assignmentRevision: currentAssignment.assignmentRevision });
  }

  function clearDispatchSelection() {
    setDispatchSelection({ teamId: "", assignmentRevision: null });
  }

  useEffect(() => {
    const group = currentAssignment.groupId || contestGroups[0]?.id;
    if (!selectedGroupId || !contestGroups.some((item) => item.id === selectedGroupId)) setSelectedGroupId(group);
  }, [currentAssignment.groupId, selectedGroupId]);

  useEffect(() => {
    const selectedTeams = orderTeams(teams, selectedGroupId);
    const nextTeam = selectedTeams.find((team) => team.id === managedTeamId) ?? selectedTeams[0] ?? null;
    if (!nextTeam) return;
    if (!teamDirty) {
      setManagedTeamId((current) => current === nextTeam.id ? current : nextTeam.id);
      setTeamDraft((current) =>
        current.registrationNumber === nextTeam.registrationNumber && current.teamName === nextTeam.teamName && current.projectName === nextTeam.projectName && current.status === nextTeam.status
          ? current
          : { registrationNumber: nextTeam.registrationNumber ?? "", teamName: nextTeam.teamName, projectName: nextTeam.projectName, status: nextTeam.status },
      );
    }
  }, [managedTeamId, selectedGroupId, state.teams, teamDirty]);

  useEffect(() => {
    if (!rosterDirty) {
      setRosterDraft(roster);
      setRosterDraftRevision(state.judgeRoster?.revision ?? 0);
    }
  }, [roster.join(","), state.judgeRoster?.revision, rosterDirty]);

  useEffect(() => {
    if (activeCompetitionGroupId && selectedGroupId !== activeCompetitionGroupId && view === "control") {
      setSelectedGroupId(activeCompetitionGroupId);
      clearDispatchSelection();
    }
  }, [activeCompetitionGroupId, selectedGroupId, view]);

  useEffect(() => {
    if (!selectedSetup || setupDirty) return;
    setSetupDraft({
      teamIds: [...(selectedSetup.teamIds ?? [])],
      judgeIds: [...(selectedSetup.judgeIds ?? [])],
      revision: selectedSetup.revision ?? 0,
    });
  }, [selectedSetup, setupDirty]);

  useEffect(() => () => {
    if (restartIntentTimerRef.current) window.clearTimeout(restartIntentTimerRef.current);
    if (deleteTeamIntentTimerRef.current) window.clearTimeout(deleteTeamIntentTimerRef.current);
  }, []);

  useEffect(() => {
    if (!navigationIntent) return undefined;
    const timer = window.setTimeout(() => {
      const target = {
        dispatch: dispatchSelectRef.current,
        judge_matrix: judgeMatrixRef.current,
        setup_actions: setupActionsRef.current,
      }[navigationIntent];
      if (!target) {
        setNavigationIntent("");
        return;
      }
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
      setNavigationIntent("");
    }, 80);
    return () => window.clearTimeout(timer);
  }, [navigationIntent, showJudgeDetails, view]);

  useEffect(() => {
    const enteringDisplay = view === "display" && previousAdminViewRef.current !== "display";
    previousAdminViewRef.current = view;
    if (!enteringDisplay) return;
    if (!displayTeamId && publishedDisplayTeamId) setDisplayTeamId(publishedDisplayTeamId);
    if ((!displayTeamId || displayTeamId === publishedDisplayTeamId) && publishedDisplayTeamGroupId) {
      setSelectedGroupId(publishedDisplayTeamGroupId);
    }
  }, [displayTeamId, publishedDisplayTeamId, publishedDisplayTeamGroupId, view]);

  function changeView(nextView) {
    setView(nextView);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("adminView", nextView);
    window.history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}`);
  }

  async function openViewInNewTab(nextView) {
    const nextWindow = window.open("about:blank", "_blank");
    if (!nextWindow) {
      showToast("浏览器阻止了新标签页，请允许弹出窗口后重试");
      return;
    }
    const nextDeviceId = createDeviceId();
    try {
      const session = await cloneAdminSession(authToken, nextDeviceId);
      nextWindow.sessionStorage.setItem(authTokenStorageKey, session.token);
      nextWindow.sessionStorage.setItem(deviceStorageKey, nextDeviceId);
      nextWindow.opener = null;
      nextWindow.location.replace(`/?adminView=${encodeURIComponent(nextView)}`);
    } catch (error) {
      nextWindow.close();
      showToast(error.message || "无法打开新的后台标签页");
    }
  }

  function activateAdminView(event, nextView) {
    if (event.button !== 0) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      openViewInNewTab(nextView);
      return;
    }
    event.preventDefault();
    changeView(nextView);
  }

  function openAdminViewFromMiddleClick(event, nextView) {
    if (event.button !== 1) return;
    event.preventDefault();
    openViewInNewTab(nextView);
  }

  function selectManagedTeam(teamId) {
    if (teamDirty) {
      showToast("请先保存或取消当前修改");
      return;
    }
    const team = teams.find((item) => item.id === teamId);
    if (!team) return;
    setDeleteTeamIntentId("");
    setManagedTeamId(team.id);
    setTeamDraft({ registrationNumber: team.registrationNumber ?? "", teamName: team.teamName, projectName: team.projectName, status: team.status });
    setTeamDirty(false);
  }

  function resetManagedTeamDraft(team) {
    if (!team) return;
    setManagedTeamId(team.id);
    setTeamDraft({ registrationNumber: team.registrationNumber ?? "", teamName: team.teamName, projectName: team.projectName, status: team.status });
    setTeamDirty(false);
  }

  function changeManagedGroup(groupId) {
    if (teamDirty && groupId !== selectedGroupId) {
      showToast("请先保存或取消当前修改");
      return;
    }
    setDeleteTeamIntentId("");
    setSelectedGroupId(groupId);
    setManagedTeamId("");
    setTeamDirty(false);
  }

  async function runAdminMutation(path, options, fallback) {
    if (adminMutationBusyRef.current) {
      showToast("正在处理上一项管理员操作，请稍候");
      return null;
    }
    adminMutationBusyRef.current = true;
    try {
      const payload = await mutate(path, options, fallback);
      if (!payload) return null;
      await refresh();
      return payload;
    } catch (error) {
      if (error.status === 401 || error.status === 403) expireSession(error.message || "登录已失效，请重新登录");
      else showToast(error.message || fallback, 4200);
      return null;
    } finally {
      adminMutationBusyRef.current = false;
    }
  }

  async function dispatch() {
    if (!activeCompetitionGroupId) return showToast("请先在开赛配置中开启比赛组别");
    if (!dispatchTeamId) return showToast("请选择要派发的队伍");
    if (!dispatchControl.canDispatch && !isForcedDispatch) return showToast(dispatchControl.reason, 5200);
    const result = await runAdminMutation(
      "/api/assignments/dispatch",
      {
        method: "POST",
        body: {
          teamId: dispatchTeamId,
          revision: currentAssignment.assignmentRevision,
          force: isForcedDispatch,
        },
      },
      "派发评分失败",
    );
    if (result) {
      setForceDispatch(false);
      showToast("当前评分队伍已派发");
    }
  }

  function changeSetupGroup(groupId) {
    if (setupDirty) {
      showToast("请先保存或取消当前开赛配置");
      return;
    }
    setRestartIntentGroupId("");
    setSetupGroupId(groupId);
  }

  function openTeamMaintenance() {
    setSelectedGroupId(setupGroupId);
    setManagedTeamId("");
    setTeamDirty(false);
    changeView("teams");
  }

  function openJudgeMaintenance(accountId = "") {
    setPreferredAccountId(accountId);
    changeView("judges");
  }

  async function closeCompetition(groupId = workflowGroupId) {
    const setup = state.competitionSetup?.groups?.[groupId];
    if (!setup || setup.status !== "open") return;
    const result = await runAdminMutation(
      `/api/competition-setup/${encodeURIComponent(groupId)}/close`,
      { method: "POST", body: { revision: setup.revision } },
      "结束本组比赛失败",
    );
    if (result) {
      setSetupGroupId(groupId);
      showToast(`${getGroupLabel(groupId)}比赛已结束，赛次已锁定`);
      changeView("setup");
    }
  }

  async function followWorkflowAction(action = workflow?.primaryAction) {
    if (!action) return;
    switch (action.id) {
      case "rotate_admin_password":
        openJudgeMaintenance(accounts.find((account) => account.role === "admin")?.id ?? "");
        break;
      case "review_competition_setup":
        if (action.groupId) setSetupGroupId(action.groupId);
        changeView("setup");
        break;
      case "publish_current_result":
        if (action.teamId) {
          const resultTeam = teams.find((team) => team.id === action.teamId);
          if (resultTeam) setSelectedGroupId(resultTeam.groupId);
          setDisplayTeamId(action.teamId);
        }
        changeView("display");
        break;
      case "publish_opening_batch":
        setSelectedGroupId(workflowGroupId);
        if (action.teamIds?.[0]) {
          const firstOpeningTeam = teams.find((team) => team.id === action.teamIds[0]);
          if (firstOpeningTeam) {
            setDisplayTeamId(firstOpeningTeam.id);
            const published = await publish(firstOpeningTeam, "final");
            if (published) changeView("display");
          }
        }
        break;
      case "monitor_current_team":
        setShowJudgeDetails(true);
        setNavigationIntent("judge_matrix");
        changeView("control");
        break;
      case "dispatch_recommended_team":
        if (action.teamId) chooseDispatchTeam(action.teamId);
        setNavigationIntent("dispatch");
        changeView("control");
        break;
      case "close_competition_group":
        await closeCompetition(action.groupId);
        break;
      case "review_rankings": {
        const groupId = action.groupId || workflowGroupId;
        window.open(`/rankings?groupId=${encodeURIComponent(groupId)}#controlToken=${encodeURIComponent(authToken)}`, "_blank", "noopener,noreferrer");
        break;
      }
      default:
        break;
    }
  }

  function openCurrentJudgeEmergency() {
    setShowJudgeDetails(true);
    setNavigationIntent("judge_matrix");
    changeView("control");
  }

  function openForcedDispatchEmergency() {
    setForceDispatch(true);
    setNavigationIntent("dispatch");
    changeView("control");
  }

  function openGroupRestartEmergency() {
    if (activeCompetitionGroupId) setSetupGroupId(activeCompetitionGroupId);
    setNavigationIntent("setup_actions");
    changeView("setup");
  }

  function toggleSetupItem(field, id) {
    if (selectedSetup?.status !== "draft") return;
    setSetupDirty(true);
    setSetupDraft((current) => ({
      ...current,
      [field]: current[field].includes(id)
        ? current[field].filter((item) => item !== id)
        : [...current[field], id],
    }));
  }

  function cancelSetupChanges() {
    if (!selectedSetup) return;
    setSetupDraft({
      teamIds: [...selectedSetup.teamIds],
      judgeIds: [...selectedSetup.judgeIds],
      revision: selectedSetup.revision,
    });
    setSetupDirty(false);
  }

  async function saveSetup() {
    if (!setupDraft.teamIds.length) return showToast("请至少选择一支参赛队伍");
    if (setupDraft.judgeIds.length < 3) return showToast("请至少选择 3 位启用评委");
    if (setupHasUnavailableParticipants) return showToast("请先移出已退赛队伍或已停用评委");
    const result = await runAdminMutation(
      `/api/competition-setup/${encodeURIComponent(setupGroupId)}`,
      { method: "PUT", body: { ...setupDraft, revision: selectedSetup?.revision ?? setupDraft.revision } },
      "开赛配置保存失败",
    );
    if (result) {
      setSetupDirty(false);
      showToast(`${getGroupLabel(setupGroupId)}开赛配置已保存`);
    }
  }

  async function openCompetition() {
    if (setupDirty) return showToast("请先保存当前开赛配置");
    if (!selectedSetup) return;
    if (state.security?.adminPasswordRotationRequired && !state.security?.adminPasswordRotated) {
      showToast("正式开赛前必须先修改管理员初始密码");
      openJudgeMaintenance(accounts.find((account) => account.role === "admin")?.id ?? "");
      return;
    }
    const result = await runAdminMutation(
      `/api/competition-setup/${encodeURIComponent(setupGroupId)}/open`,
      { method: "POST", body: { revision: selectedSetup.revision } },
      "开启比赛失败",
    );
    if (result) {
      setSelectedGroupId(setupGroupId);
      clearDispatchSelection();
      showToast(`${getGroupLabel(setupGroupId)}已开启，可以开始派发队伍`);
      changeView("control");
    }
  }

  async function reopenCompetitionForSetup() {
    if (!selectedSetup || selectedSetup.status !== "open") return;
    if (activeCompetitionGroupId && activeCompetitionGroupId !== setupGroupId) {
      return showToast("其他组别正在比赛，不能重开当前历史组别");
    }
    if (setupGroupHasScoringData && restartIntentGroupId !== setupGroupId) {
      setRestartIntentGroupId(setupGroupId);
      if (restartIntentTimerRef.current) window.clearTimeout(restartIntentTimerRef.current);
      restartIntentTimerRef.current = window.setTimeout(() => setRestartIntentGroupId(""), 8000);
      showToast("应急重新开赛将清除本组全部评分，请在 8 秒内再次点击确认", 8000);
      return;
    }
    const result = await runAdminMutation(
      `/api/competition-setup/${encodeURIComponent(setupGroupId)}/reopen`,
      { method: "POST", body: { revision: selectedSetup.revision, confirmClearScores: setupGroupHasScoringData } },
      "重新开赛失败",
    );
    if (result) {
      if (restartIntentTimerRef.current) window.clearTimeout(restartIntentTimerRef.current);
      setRestartIntentGroupId("");
      setSetupDirty(false);
      clearDispatchSelection();
      showToast(result.restart?.hadScoringData ? `本组 ${result.restart.clearedEntryCount} 条评分已清除，请重新调整配置并开赛` : "已撤回开赛，可以重新调整队伍和评委");
    }
  }

  async function saveTeam() {
    if (!managedTeam || !teamDraft.teamName.trim()) return showToast("请输入队伍名称");
    const result = await runAdminMutation(
      `/api/teams/${encodeURIComponent(managedTeam.id)}`,
      { method: "PUT", body: { ...teamDraft, revision: managedTeam.revision } },
      "队伍信息保存失败",
    );
    if (result) {
      updateLocalTeam(result.team);
      setTeamDirty(false);
      showToast("队伍信息已保存");
    }
  }

  async function createTeam(event) {
    event.preventDefault();
    const result = await runAdminMutation(
      "/api/teams",
      { method: "POST", body: { groupId: selectedGroupId, ...newTeamDraft } },
      "新增队伍失败",
    );
    if (result?.team) {
      updateLocalTeam(result.team);
      setNewTeamDraft({ registrationNumber: "", teamName: "", projectName: "" });
      setManagedTeamId(result.team.id);
      setTeamDirty(false);
      showToast("队伍已加入当前组别末尾");
    }
  }

  async function deleteManagedTeam() {
    if (!managedTeam) return;
    if (teamDirty || orderDirty) return showToast("请先保存或取消当前修改");
    if (managedTeam.hasScoringHistory) return showToast("该队伍已有评分历史，只能退赛或归档");
    if (deleteTeamIntentId !== managedTeam.id) {
      setDeleteTeamIntentId(managedTeam.id);
      if (deleteTeamIntentTimerRef.current) window.clearTimeout(deleteTeamIntentTimerRef.current);
      deleteTeamIntentTimerRef.current = window.setTimeout(() => setDeleteTeamIntentId(""), 8000);
      showToast("再次点击删除队伍，确认移除这条队伍记录", 8000);
      return;
    }
    const result = await runAdminMutation(
      `/api/teams/${encodeURIComponent(managedTeam.id)}`,
      { method: "DELETE", body: { revision: managedTeam.revision } },
      "删除队伍失败",
    );
    if (!result) return;
    if (deleteTeamIntentTimerRef.current) window.clearTimeout(deleteTeamIntentTimerRef.current);
    setDeleteTeamIntentId("");
    setManagedTeamId("");
    setTeamDraft({ registrationNumber: "", teamName: "", projectName: "", status: "active" });
    setTeamDirty(false);
    setOrderDraftByGroup((current) => {
      const next = { ...current };
      delete next[selectedGroupId];
      return next;
    });
    showToast("队伍记录已删除");
  }

  function updateOrderDraft(nextOrder) {
    setOrderDraftByGroup((current) => ({ ...current, [selectedGroupId]: nextOrder }));
  }

  function restoreDefaultOrder() {
    const defaultIds = (defaultCandidateOrderByGroup[selectedGroupId] ?? []).filter((id) => officialOrder.includes(id));
    const extraIds = officialOrder.filter((id) => !defaultIds.includes(id));
    updateOrderDraft([...defaultIds, ...extraIds]);
  }

  async function saveOrder() {
    if (!orderDirty) return showToast("出场顺序没有变化");
    const persistedOrder = mergeConfiguredTeamOrder(fullOfficialOrder, configuredTeamIds, orderDraft);
    const result = await runAdminMutation(
      `/api/team-order/${encodeURIComponent(selectedGroupId)}`,
      { method: "PUT", body: { orderedTeamIds: persistedOrder, revision: state.teamOrderRevisionByGroup?.[selectedGroupId] ?? 0 } },
      "出场顺序保存失败",
    );
    if (result) {
      setOrderDraftByGroup((current) => {
        const next = { ...current };
        delete next[selectedGroupId];
        return next;
      });
      showToast("出场顺序已保存");
    }
  }

  function toggleRoster(judgeId) {
    setRosterDirty(true);
    setRosterDraft((current) => current.includes(judgeId) ? current.filter((id) => id !== judgeId) : [...current, judgeId]);
  }

  function cancelRosterChanges() {
    setRosterDraft(roster);
    setRosterDraftRevision(state.judgeRoster?.revision ?? 0);
    setRosterDirty(false);
  }

  async function saveRoster() {
    const result = await runAdminMutation(
      "/api/judge-roster",
      { method: "PUT", body: { judgeIds: rosterDraft, revision: rosterDraftRevision, reason: "管理员调整计划评分名册" } },
      "计划评分名册保存失败",
    );
    if (result) {
      setRosterDirty(false);
      showToast(currentAssignment.teamId ? "计划评分名册已保存，将从下一支首次派发队伍生效" : "计划评分名册已保存");
    }
  }

  async function createJudge() {
    const operationId = newJudge.operationId || globalThis.crypto?.randomUUID?.() || `enroll-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (!newJudge.operationId) setNewJudge((current) => ({ ...current, operationId }));
    const enrollForFuture = newJudge.enrollment === "future_assignments";
    const result = await runAdminMutation(
      enrollForFuture ? "/api/admin/judge-enrollments" : "/api/accounts",
      {
        method: "POST",
        body: enrollForFuture
          ? { username: newJudge.username, displayName: newJudge.displayName, password: newJudge.password, operationId, expectedRosterRevision: state.judgeRoster?.revision ?? 0, reason: "管理员新增临时评委" }
          : { username: newJudge.username, displayName: newJudge.displayName, password: newJudge.password, role: "judge" },
      },
      "新增评委失败",
    );
    if (result) {
      setNewJudge({ username: "", displayName: "", password: "", enrollment: "future_assignments", operationId: "" });
      showToast(enrollForFuture ? "评委账号已创建，将从下一支首次派发队伍起参与评分" : "评委账号已创建，当前未加入计划评分名册");
    }
    return Boolean(result);
  }

  async function saveAccount(account, draft) {
    const body = { displayName: draft.displayName, status: draft.status, revision: draft.revision };
    if (account.role === "judge" && draft.status !== "active" && roster.includes(account.id)) {
      body.removeFromPlannedRoster = true;
      body.rosterRevision = state.judgeRoster?.revision ?? 0;
    }
    if (draft.password) body.password = draft.password;
    const result = await runAdminMutation(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "PUT", body }, "账号保存失败");
    if (result) showToast("账号信息已保存");
    return Boolean(result);
  }

  async function changeJudgeEntry(judgeId, teamId, operation) {
    const entry = getEntryFromState(state, judgeId, teamId);
    const nextEntry = operation === "clear"
      ? { ...entry, scores: createBlankScores(), submitted: false, clientUpdatedAt: Date.now() }
      : { ...entry, submitted: false, clientUpdatedAt: Date.now() };
    const result = await runAdminMutation(
      `/api/entries/${encodeURIComponent(judgeId)}/${encodeURIComponent(teamId)}`,
      { method: "PUT", body: { entry: nextEntry } },
      operation === "clear" ? "清空评分失败" : "撤回提交失败",
    );
    if (result) showToast(operation === "clear" ? "评委评分已清空" : "评委提交已撤回");
  }

  async function startHistoricalJudgeRescore() {
    if (activeCompetitionSetup?.status !== "open") return showToast("只能在当前已开启的比赛组中发起历史重评");
    if (!selectedHistoricalRescoreTeam) return showToast("请选择一支已完成评分的历史队伍");
    if (!selectedHistoricalRescoreJudge) return showToast("请选择该队冻结名册中的一名评委");
    if (selectedHistoricalRescoreJudge.status !== "active") return showToast("该评委账号当前不可用");
    if (selectedHistoricalRescoreJudge.grant) return showToast("该评委已有进行中的历史重评任务");
    if (!selectedHistoricalRescoreJudge.submitted) return showToast("只能撤回该评委已提交的历史评分");
    if (historicalRescoreReason.length < 3 || historicalRescoreReason.length > 500) return showToast("请填写 3–500 个字符的应急处置原因");
    if (historicalRescoreDraft.mode === "clear" && !historicalRescoreDraft.clearConfirmed) return showToast("请确认只清空这名评委在该历史队的评分");
    const result = await runAdminMutation(
      "/api/admin/judge-rescores",
      {
        method: "POST",
        body: {
          teamId: selectedHistoricalRescoreTeam.id,
          judgeId: selectedHistoricalRescoreJudge.id,
          mode: historicalRescoreDraft.mode,
          reason: historicalRescoreReason,
          expectedEntryRevision: selectedHistoricalRescoreJudge.serverRevision,
        },
      },
      "发起历史队伍指定评委重评失败",
    );
    if (!result) return;
    setHistoricalRescoreDraft((current) => ({
      ...current,
      judgeId: "",
      mode: "retain",
      reason: "",
      clearConfirmed: false,
    }));
    showToast(historicalRescoreDraft.mode === "clear" ? "已向指定评委发起清空重评" : "已向指定评委发起保留原分重评", 3600);
  }

  function beginJudgeReplacement(judgeId) {
    const entry = currentTeam ? getEntryFromState(state, judgeId, currentTeam.id) : createEntry();
    const hasScores = entry.submitted || allItems.some((item) => entry.scores[item.id] !== "");
    setJudgeReplacement({ outgoingJudgeId: judgeId, incomingJudgeId: "", reason: "", hasScores, confirmed: false });
  }

  async function replaceCurrentJudge() {
    if (!judgeReplacement?.incomingJudgeId) return showToast("请选择替补评委");
    if (judgeReplacement.reason.trim().length < 3) return showToast("请填写至少 3 个字符的应急处置原因");
    if (judgeReplacement.hasScores && !judgeReplacement.confirmed) return showToast("请确认清除被替换评委的当前队评分");
    const result = await runAdminMutation(
      "/api/assignments/replace-judge",
      {
        method: "POST",
        body: {
          outgoingJudgeId: judgeReplacement.outgoingJudgeId,
          incomingJudgeId: judgeReplacement.incomingJudgeId,
          rosterRevision: currentAssignment.rosterRevision ?? 0,
          reason: judgeReplacement.reason,
        },
      },
      "替换当前队评委失败",
    );
    if (result) {
      setJudgeReplacement(null);
      showToast("当前队评委已替换，其他评委成绩保持不变");
    }
  }

  async function publish(team, publicationStatus) {
    const result = await runAdminMutation(
      "/api/display-selection",
      { method: "PUT", body: { teamId: team?.id, publicationStatus, revision: state.displaySelection?.displayRevision ?? 0 } },
      "成绩展示操作失败",
    );
    if (result) showToast(publicationStatus === "idle" ? "已返回候场标语页" : "成绩展示已发布");
    return result;
  }

  async function startOpeningDisplay() {
    if (!openingDisplayTeam) return showToast("当前组还没有本场参赛队伍");
    if (!openingDisplayReady) return showToast("第 1 队尚无评委提交，暂不能开始成绩展示");
    setDisplayTeamId(openingDisplayTeam.id);
    return publish(openingDisplayTeam, openingDisplaySummary?.isFinal ? "final" : "temporary");
  }

  const navItems = [
    ["setup", "开赛配置"],
    ["control", "赛事控制"],
    ["teams", "队伍管理"],
    ["judges", "评委管理"],
    ["display", "成绩展示"],
    ["emergency", "应急处置"],
  ];
  const selectedDisplaySummary = selectedDisplayTeam ? state.summariesByTeam?.[selectedDisplayTeam.id] : null;

  return (
    <main className="admin-workspace">
      <header className="admin-shell-header">
        <div><span>决赛评分后台</span><h1>赛事运营控制</h1></div>
        <div className="admin-shell-actions"><ConnectionStatus status={syncStatus} /><button className="ghost-action admin-emergency-shortcut" type="button" onClick={() => changeView("emergency")}><ShieldAlert size={17} aria-hidden="true" />应急处置</button><button className="ghost-action" type="button" onClick={logout}>退出登录</button></div>
      </header>
      <nav className="admin-module-nav" aria-label="后台模块">
        {navItems.map(([id, label]) => <a href={`/?adminView=${encodeURIComponent(id)}`} key={id} className={view === id ? "is-selected" : ""} aria-current={view === id ? "page" : undefined} title={`${label}；中键或 Ctrl/⌘ 点击可在新标签页打开`} onClick={(event) => activateAdminView(event, id)} onAuxClick={(event) => openAdminViewFromMiddleClick(event, id)}>{label}</a>)}
      </nav>
      {workflow ? <section className={`admin-workflow-banner is-${workflow.phase}`} aria-labelledby="admin-workflow-title">
        <div className="admin-workflow-phase"><span>{getGroupLabel(workflowGroupId)} · 当前阶段</span><h2 id="admin-workflow-title">{workflowPhaseCopy[0]}</h2><p>{workflowPhaseCopy[1]}</p></div>
        <div className="admin-workflow-context">
          <div><span>当前队</span><strong>{workflowCurrentTeam?.teamName ?? "尚未派发"}</strong><small>{workflowCurrentTeam ? `${workflow.progress?.currentSubmittedCount ?? 0}/${workflow.progress?.currentRosterCount ?? 0} 位已提交` : "等待管理员派发"}</small></div>
          <ArrowRight size={18} aria-hidden="true" />
          <div><span>建议下一队</span><strong>{workflowRecommendedTeam?.teamName ?? "暂无"}</strong><small>{workflowRecommendedTeam?.registrationNumber || (workflowRecommendedTeam ? "按抽签顺序推荐" : "按当前阶段继续")}</small></div>
        </div>
        <div className="admin-workflow-actions">{workflow.secondaryAction ? <button className="ghost-action" type="button" onClick={() => followWorkflowAction(workflow.secondaryAction)}>{workflow.secondaryAction.label}</button> : null}<button className="primary-action" type="button" onClick={() => followWorkflowAction()}>{workflow.primaryAction.label}<ArrowRight size={17} aria-hidden="true" /></button></div>
      </section> : null}
      <Toast message={toast} className="admin-toast-slot" />

      {view === "setup" ? (
        <section className="competition-setup-page">
          <header className="competition-setup-heading">
            <div><span>分组赛次</span><h2>统一开赛配置</h2><p>每个组别独立确定本场参赛队伍和评委，开启后配置冻结。</p></div>
            <div className={`competition-live-status ${activeCompetitionGroupId ? "is-open" : ""}`}><span>{activeCompetitionGroupId ? "当前已开启" : "等待开赛"}</span><strong>{activeCompetitionGroupId ? getGroupLabel(activeCompetitionGroupId) : "尚未开启组别"}</strong></div>
          </header>
          <section className="competition-maintenance-bar">
            <div><strong>抽签后资料调整</strong><span>在开赛前维护队伍名称、报名编号、项目资料和评委账号，再回到这里确认最终数量。</span></div>
            <div><button className="ghost-action" type="button" onClick={openTeamMaintenance}>维护队伍资料</button><button className="ghost-action" type="button" onClick={() => openJudgeMaintenance()}>维护评委账号</button></div>
          </section>
          <nav className="competition-group-tabs" aria-label="选择开赛组别">
            {contestGroups.map((group) => {
              const setup = state.competitionSetup?.groups?.[group.id];
              return <button type="button" key={group.id} className={setupGroupId === group.id ? "is-selected" : ""} onClick={() => changeSetupGroup(group.id)}><strong>{group.label}</strong><small>{setup?.status === "open" ? "进行中" : setup?.status === "closed" ? "已结束" : "待配置"}</small></button>;
            })}
          </nav>
          {selectedSetupWorkflow ? <section className={`competition-status-panel is-${selectedSetupWorkflow.phase}`} aria-labelledby="competition-status-title">
            <header>
              <div><span>当前比赛状态</span><h3 id="competition-status-title">{getGroupLabel(setupGroupId)} · {selectedSetupPhaseCopy[0]}</h3><p>{selectedSetupPhaseCopy[1]}</p></div>
              <strong>{setupProgress.percentage}%</strong>
            </header>
            <div className="competition-status-progress">
              <div><span>队伍完成进度</span><strong>{setupProgress.completedTeams} / {setupProgress.totalTeams} 支</strong></div>
              <div className="competition-progress-track" role="progressbar" aria-label={`${getGroupLabel(setupGroupId)}队伍完成进度`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={setupProgress.percentage}><span style={{ width: `${setupProgress.percentage}%` }} /></div>
            </div>
            <div className="competition-status-details">
              <div><span>当前队伍</span><strong>{setupCurrentTeam?.teamName ?? (selectedSetup?.status === "open" ? "等待派发" : "尚未开赛")}</strong></div>
              <div><span>当前队提交</span><strong>{setupCurrentTeam ? `${setupProgress.currentSubmittedCount} / ${setupProgress.currentRosterCount} 位` : "--"}</strong></div>
              <div><span>剩余队伍</span><strong>{setupRemainingTeams} 支</strong></div>
            </div>
          </section> : null}
          {selectedSetupWorkflow ? <section className="competition-preflight" aria-labelledby="competition-preflight-title">
            <header><div><span>开赛前核对</span><h3 id="competition-preflight-title">{getGroupLabel(setupGroupId)}准备状态</h3></div><small>{setupDirty ? "当前修改尚未保存" : "关键项确认后可开启本组比赛"}</small></header>
            <div>{setupPreflightChecks.map((check) => <div className={`is-${check.status}`} key={check.id}><span>{check.label}</span><strong>{check.id === "team_count" ? `${check.value} 支` : check.id === "judge_count" ? `${check.value} 位` : check.status === "complete" ? "已确认" : check.status === "blocked" ? "未完成" : "待核对"}</strong></div>)}</div>
          </section> : null}
          <section className="competition-setup-summary">
            <div><span>参赛队伍</span><strong>{setupDraft.teamIds.length}</strong><small>支队伍纳入本场</small></div>
            <div><span>评分评委</span><strong>{setupDraft.judgeIds.length}</strong><small>位评委参与本场</small></div>
            <div><span>配置状态</span><strong className="is-text">{selectedSetup?.status === "open" ? "已开启" : selectedSetup?.status === "closed" ? "已结束" : setupDirty ? "未保存" : "已保存"}</strong><small>{selectedSetup?.status === "draft" ? "开赛后将锁定" : "当前配置只读"}</small></div>
          </section>
          <section className="competition-setup-grid">
            <section className="admin-panel competition-selection-panel">
              <header><div><span>队伍范围</span><h2>{getGroupLabel(setupGroupId)}参赛队伍</h2></div><button className="ghost-action" type="button" disabled={selectedSetup?.status !== "draft"} onClick={() => { setSetupDirty(true); setSetupDraft((current) => ({ ...current, teamIds: availableSetupTeams.every((team) => current.teamIds.includes(team.id)) && !hasUnavailableSetupTeams ? [] : availableSetupTeams.map((team) => team.id) })); }}>{availableSetupTeams.every((team) => setupDraft.teamIds.includes(team.id)) && !hasUnavailableSetupTeams ? "取消全选" : "选择全部可用队伍"}</button></header>
              <div className="competition-check-list">{setupTeams.map((team, index) => <label key={team.id} className={setupDraft.teamIds.includes(team.id) ? "is-selected" : ""}><input type="checkbox" checked={setupDraft.teamIds.includes(team.id)} disabled={selectedSetup?.status !== "draft"} onChange={() => toggleSetupItem("teamIds", team.id)} /><span><strong>{index + 1}. {team.teamName}</strong><small>{team.registrationNumber || "未填写报名编号"}{team.status !== "active" ? ` · ${getTeamStatusLabel(team.status)}，请移出本场` : ""}</small></span></label>)}</div>
            </section>
            <section className="admin-panel competition-selection-panel">
              <header><div><span>评委范围</span><h2>本场评分评委</h2></div><button className="ghost-action" type="button" disabled={selectedSetup?.status !== "draft"} onClick={() => { setSetupDirty(true); setSetupDraft((current) => ({ ...current, judgeIds: availableSetupJudges.every((judge) => current.judgeIds.includes(judge.id)) && !hasUnavailableSetupJudges ? [] : availableSetupJudges.map((judge) => judge.id) })); }}>{availableSetupJudges.every((judge) => setupDraft.judgeIds.includes(judge.id)) && !hasUnavailableSetupJudges ? "取消全选" : "选择全部启用评委"}</button></header>
              <div className="competition-check-list is-judges">{setupJudges.map((judge) => <label key={judge.id} className={setupDraft.judgeIds.includes(judge.id) ? "is-selected" : ""}><input type="checkbox" checked={setupDraft.judgeIds.includes(judge.id)} disabled={selectedSetup?.status !== "draft"} onChange={() => toggleSetupItem("judgeIds", judge.id)} /><span><strong>{judge.displayName}</strong><small>账号 {judge.username}{judge.status !== "active" ? " · 已停用，请移出本场" : ""}</small></span></label>)}</div>
            </section>
          </section>
          <footer className="competition-setup-actions" ref={setupActionsRef} tabIndex={-1}><span>{restartIntentGroupId === setupGroupId ? "再次点击应急重新开赛，将清除本组全部评分" : setupHasUnavailableParticipants ? "队伍或评委状态已变化，请移出不可用成员并重新保存" : setupDirty ? "当前配置有未保存修改" : setupPreflightChecks.some((check) => check.status !== "complete") ? "开赛核对仍有未完成项目" : selectedSetup?.status === "draft" ? "配置已保存，确认无误后开启本组比赛" : selectedSetup?.status === "closed" ? "本组赛次已结束，历史配置和成绩已锁定" : "本组赛次配置已经冻结；需要调整时可撤回或应急重开"}</span>{selectedSetup?.status === "open" ? <button className={setupGroupHasScoringData ? "danger-action" : "ghost-action"} type="button" disabled={Boolean(activeCompetitionGroupId && activeCompetitionGroupId !== setupGroupId)} onClick={reopenCompetitionForSetup}>{restartIntentGroupId === setupGroupId ? "再次点击，确认清除并重开" : setupGroupHasScoringData ? "应急重新开赛" : "撤回开赛并调整"}</button> : null}<button className="ghost-action" type="button" disabled={!setupDirty} onClick={cancelSetupChanges}>取消修改</button><button className="ghost-action" type="button" disabled={!setupDirty} onClick={saveSetup}><Save size={17} aria-hidden="true" />保存配置</button><button className="primary-action" type="button" disabled={setupDirty || setupHasUnavailableParticipants || setupPreflightChecks.some((check) => check.status !== "complete") || selectedSetup?.status !== "draft" || !setupDraft.teamIds.length || setupDraft.judgeIds.length < 3 || (state.security?.adminPasswordRotationRequired && !state.security?.adminPasswordRotated)} onClick={openCompetition}><Play size={17} aria-hidden="true" />{selectedSetup?.status === "open" ? "本组已开启" : selectedSetup?.status === "closed" ? "本组已结束" : "开启本组比赛"}</button></footer>
        </section>
      ) : null}

      {view === "control" ? (
        <section className="admin-module-grid control-module">
          <section className="admin-panel assignment-panel">
            <header><span>当前派发</span><h2>{currentTeam ? currentTeam.teamName : "等待派发队伍"}</h2><small>{currentAssignment.status === "final" ? "本队评分已完成，下一队已经预选" : currentAssignment.status === "awaiting_submissions" ? "等待有效评委提交" : currentAssignment.status === "scoring" ? "正在评分" : "尚未开始"}</small></header>
            <div className="assignment-form">
              <label>当前比赛组别<select value={activeCompetitionGroupId ?? ""} disabled><option value="">请先完成开赛配置</option>{contestGroups.map((group) => <option value={group.id} key={group.id}>{group.label}</option>)}</select></label>
              <label>下一支派发队伍<select ref={dispatchSelectRef} value={dispatchTeamId} disabled={!activeCompetitionGroupId} onChange={(event) => chooseDispatchTeam(event.target.value)}><option value="">请选择队伍</option>{dispatchableTeams.map((team) => {
                const isCurrent = team.id === currentAssignment.teamId;
                const isCompleted = Boolean(state.summariesByTeam?.[team.id]?.isFinal);
                const suffix = isCurrent ? "（当前队）" : isCompleted ? "（已完成）" : "";
                return <option value={team.id} key={team.id} disabled={isCurrent}>{team.registrationNumber ? `${team.registrationNumber} · ${team.teamName}${suffix}` : `${team.teamName}${suffix}`}</option>;
              })}</select></label>
              <div className={`dispatch-readiness is-${dispatchControl.tone}`} role="status">
                <span>{dispatchControl.label}</span>
                <strong>{selectedDispatchTeam ? `准备派发：${selectedDispatchTeam.teamName}` : "等待下一步"}</strong>
                <small>{dispatchControl.reason}</small>
              </div>
              {!dispatchControl.canDispatch && currentTeam && dispatchTeamId ? <button className={`force-toggle-button ${forceDispatch ? "is-active" : ""}`} type="button" aria-pressed={forceDispatch} onClick={() => setForceDispatch((current) => !current)}><ShieldAlert size={17} aria-hidden="true" />{forceDispatch ? "取消应急切换" : "应急：改用强制切换"}</button> : null}
              {isForcedDispatch ? <div className="force-dispatch-note" role="status">
                <strong>应急切换会立即改派评委端当前队伍</strong>
                <span>旧派发版本的延迟提交会被拒绝；已保存成绩不会自动清空，可在下方评委矩阵中单独撤回或清空。</span>
              </div> : null}
              <button className={isForcedDispatch ? "danger-action" : "primary-action"} type="button" disabled={dispatchDisabled} onClick={dispatch}><Send size={17} aria-hidden="true" />{isForcedDispatch ? forcedDispatchTargetLabel : dispatchControl.actionLabel}</button>
            </div>
          </section>
          <section className="admin-panel control-summary-panel">
            <span>当前队评分进度</span><strong>{currentTeam ? `${currentSubmittedCount}/${currentExpectedCount}` : "--"}</strong>
            <div className="control-submission-progress" role="progressbar" aria-label="当前队评委提交进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={currentSubmissionPercentage}><span style={{ width: `${currentSubmissionPercentage}%` }} /></div>
            <small>{currentTeam ? `${currentTeamSummary?.status ?? "等待评委开始评分"} · 当前队按 ${currentExpectedCount} 位评委快照统计` : "派发后在这里查看服务器确认的实时进度"}</small>
            {currentTeam ? <>
              <div className="control-score-summary"><span>队伍综合分</span><strong>{currentTeamSummary?.display ?? "--"}</strong><small>{currentTeamSummary?.status ?? "等待评委开始评分"}</small></div>
              <div className="control-score-summary"><span>下一队计划名册</span><strong>{rosterCount} 位</strong><small>{`当前队快照 ${currentRosterCount} 位`}</small></div>
            </> : null}
          </section>
          <section className="admin-panel judge-matrix-panel" ref={judgeMatrixRef} tabIndex={-1}>
            <header className="admin-panel-header"><div><span>当前队提交矩阵</span><h2>{currentTeam ? currentTeam.teamName : "暂无当前队伍"}</h2></div><button className="ghost-action" type="button" aria-expanded={showJudgeDetails} onClick={() => setShowJudgeDetails((current) => !current)}>{showJudgeDetails ? "收起评委详情" : `展开 ${currentRosterCount} 位评委`}</button></header>
            {judgeReplacement && currentTeam ? <section className="assignment-judge-replacement" aria-label="当前队评委应急替换"><div><span>应急替换</span><strong>替换 {accounts.find((account) => account.id === judgeReplacement.outgoingJudgeId)?.displayName ?? "当前评委"}</strong><small>只清除此席位在当前队的评分，其他评委成绩不变。</small></div><label>替补评委<select value={judgeReplacement.incomingJudgeId} onChange={(event) => setJudgeReplacement((current) => ({ ...current, incomingJudgeId: event.target.value }))}><option value="">请选择启用评委</option>{replacementCandidates.map((judge) => <option value={judge.id} key={judge.id}>{judge.displayName} · {judge.username}</option>)}</select></label><label>处置原因<input value={judgeReplacement.reason} onChange={(event) => setJudgeReplacement((current) => ({ ...current, reason: event.target.value }))} placeholder="例如：评委身体不适离场" /></label>{judgeReplacement.hasScores ? <label className="replacement-confirm"><input type="checkbox" checked={judgeReplacement.confirmed} onChange={(event) => setJudgeReplacement((current) => ({ ...current, confirmed: event.target.checked }))} />我确认清除该评委当前队评分</label> : null}<div><button className="ghost-action" type="button" onClick={() => setJudgeReplacement(null)}>取消</button><button className="danger-action" type="button" disabled={!judgeReplacement.incomingJudgeId || judgeReplacement.reason.trim().length < 3 || (judgeReplacement.hasScores && !judgeReplacement.confirmed)} onClick={replaceCurrentJudge}>确认替换评委</button></div></section> : null}
            {currentTeam ? showJudgeDetails ? <div className="judge-matrix-list">
              {assignmentRoster.map((judgeId) => {
                const judge = accounts.find((account) => account.id === judgeId);
                const entry = getEntryFromState(state, judgeId, currentTeam.id);
                const hasScores = allItems.some((item) => entry.scores[item.id] !== "");
                return <div className="judge-matrix-row" key={judgeId}>
                  <div><strong>{judge?.displayName ?? "评委"}</strong><span>{entry.submitted ? "已提交" : hasScores ? "已录入未提交" : "未评分"} · {formatCents(getScoresTotalCents(entry.scores))}</span></div>
                  <button className="ghost-action" type="button" disabled={!entry.submitted} onClick={() => changeJudgeEntry(judgeId, currentTeam.id, "reopen")}>撤回提交</button>
                  <button className="danger-action" type="button" disabled={!entry.submitted && !hasScores} onClick={() => changeJudgeEntry(judgeId, currentTeam.id, "clear")}>清空重评</button>
                  <button className="ghost-action" type="button" disabled={!replacementCandidates.length} onClick={() => beginJudgeReplacement(judgeId)}>替换评委</button>
                </div>;
              })}
            </div> : <div className="judge-matrix-summary"><span>当前队伍评委进度</span><strong>{currentTeamSummary?.submittedCount ?? 0}/{currentTeamSummary?.rosterCount ?? rosterCount} 位已提交</strong><small>{currentTeamSummary?.status ?? "等待评委开始评分"}，展开后可执行撤回或清空。</small></div> : <p className="admin-empty-copy">管理员派发队伍后，评委进度会在这里汇总。</p>}
          </section>
        </section>
      ) : null}

      {view === "teams" ? (
        <section className="admin-module-grid teams-module">
          <section className="admin-panel team-editor-panel">
            <header className="team-editor-header"><div><span>队伍资料 · {groupTeams.length} 支</span><h2>编辑队伍信息</h2></div>{managedTeam ? <span className={`team-editor-save-state ${teamDirty ? "is-dirty" : ""}`}>{teamDirty ? "未保存更改" : "已同步"}</span> : null}</header>
            <div className="team-editor-selectors">
              <label>比赛组别<select value={selectedGroupId} onChange={(event) => changeManagedGroup(event.target.value)}><>{contestGroups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}</></select></label>
              <label>当前队伍<select value={managedTeam?.id ?? ""} onChange={(event) => selectManagedTeam(event.target.value)}>{groupTeams.map((team) => <option value={team.id} key={team.id}>{team.registrationNumber ? `${team.registrationNumber} · ${team.teamName}` : team.teamName}</option>)}</select></label>
            </div>
            {managedTeam ? <>
              <div className="managed-team-summary">
                <div className="managed-team-summary-id"><span>报名编号</span><strong>{teamDraft.registrationNumber || "未填写"}</strong></div>
                <div className="managed-team-summary-status"><span>队伍状态</span><strong>{getTeamStatusLabel(teamDraft.status)}</strong></div>
                <div className="managed-team-summary-name"><span>队伍名称</span><strong>{teamDraft.teamName || "未命名队伍"}</strong></div>
                <div className="managed-team-summary-project"><span>项目名称</span><strong>{teamDraft.projectName || "未填写"}</strong></div>
              </div>
              <div className="team-editor-fields">
                <label>报名编号<input value={teamDraft.registrationNumber} onChange={(event) => { setTeamDraft({ ...teamDraft, registrationNumber: event.target.value }); setTeamDirty(true); }} /></label>
                <label>队伍状态<select value={teamDraft.status} onChange={(event) => { setTeamDraft({ ...teamDraft, status: event.target.value }); setTeamDirty(true); }}><option value="active">正常参赛</option><option value="withdrawn">退赛</option><option value="archived">归档</option></select></label>
                <label className="is-wide">队伍名称<input value={teamDraft.teamName} onChange={(event) => { setTeamDraft({ ...teamDraft, teamName: event.target.value }); setTeamDirty(true); }} /></label>
                <label className="is-wide">项目名称<input value={teamDraft.projectName} onChange={(event) => { setTeamDraft({ ...teamDraft, projectName: event.target.value }); setTeamDirty(true); }} /></label>
              </div>
              <div className="admin-form-actions"><span className={teamDirty ? "is-dirty" : ""}>{teamDirty ? "有未保存修改" : managedTeam.hasScoringHistory ? "已保存，评分历史保留" : "已保存，编号已同步"}</span><div className="team-editor-actions"><button className="danger-action" type="button" title={managedTeam.hasScoringHistory ? "已有评分历史的队伍只能退赛或归档" : "删除当前队伍记录"} disabled={teamDirty || orderDirty || managedTeam.hasScoringHistory} onClick={deleteManagedTeam}><Trash2 size={16} aria-hidden="true" />{deleteTeamIntentId === managedTeam.id ? "再次点击确认删除" : "删除队伍"}</button><button className="ghost-action" type="button" disabled={!teamDirty} onClick={() => resetManagedTeamDraft(managedTeam)}><RotateCcw size={16} aria-hidden="true" />取消更改</button><button className="primary-action" type="button" disabled={!teamDirty} onClick={saveTeam}><Save size={17} aria-hidden="true" />保存队伍信息</button></div></div>
            </> : <p className="admin-empty-copy">当前组别没有可维护的队伍。</p>}
            <form className="new-team-form" onSubmit={createTeam}><header><div><span>新增队伍 · 不限数量</span><small>{getGroupLabel(selectedGroupId)} · 排在当前组别末尾</small></div></header><div className="new-team-fields"><label>报名编号<input aria-label="新队伍报名编号" placeholder="例如 CT-0311" value={newTeamDraft.registrationNumber} onChange={(event) => setNewTeamDraft({ ...newTeamDraft, registrationNumber: event.target.value })} /></label><label>队伍名称<input required aria-label="新队伍名称" placeholder="输入队伍名称" value={newTeamDraft.teamName} onChange={(event) => setNewTeamDraft({ ...newTeamDraft, teamName: event.target.value })} /></label><label>项目名称<input aria-label="新队伍项目名称" placeholder="输入项目名称" value={newTeamDraft.projectName} onChange={(event) => setNewTeamDraft({ ...newTeamDraft, projectName: event.target.value })} /></label></div><button className="ghost-action" type="submit"><Plus size={16} aria-hidden="true" />新增队伍</button></form>
          </section>
          <section className="admin-panel order-editor-panel">
            <header><div className="order-editor-heading"><span>出场顺序</span><h2>{getGroupLabel(selectedGroupId)}</h2><small>本场已配置 {orderedDraftTeams.length} 支 · {orderDirty ? "未保存" : "已同步"}</small></div><div className="admin-order-toolbar"><button className="ghost-action" type="button" disabled={!officialOrder.length} onClick={restoreDefaultOrder}>恢复默认</button><button className="ghost-action" type="button" disabled={!orderDirty} onClick={() => setOrderDraftByGroup((current) => { const next = { ...current }; delete next[selectedGroupId]; return next; })}>取消</button><button className="primary-action" type="button" disabled={!orderDirty} onClick={saveOrder}><Save size={17} aria-hidden="true" />保存顺序</button></div></header>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => { if (!over || active.id === over.id) return; const oldIndex = orderDraft.indexOf(active.id); const newIndex = orderDraft.indexOf(over.id); updateOrderDraft(arrayMove(orderDraft, oldIndex, newIndex)); }}>
              <SortableContext items={orderDraft} strategy={verticalListSortingStrategy}><div className="admin-order-list">{orderedDraftTeams.length ? orderedDraftTeams.map((team, index) => <SortableTeamRow key={team.id} team={team} index={index} teamCount={orderedDraftTeams.length} selected={team.id === managedTeam?.id} submittedCount={state.summariesByTeam?.[team.id]?.submittedCount ?? 0} rosterCount={state.summariesByTeam?.[team.id]?.rosterCount ?? rosterCount} onSelect={() => selectManagedTeam(team.id)} onMoveUp={() => index > 0 && updateOrderDraft(arrayMove(orderDraft, index, index - 1))} onMoveDown={() => index < orderedDraftTeams.length - 1 && updateOrderDraft(arrayMove(orderDraft, index, index + 1))} />) : <p className="admin-empty-copy">请先到开赛配置选择并保存本场参赛队伍。</p>}</div></SortableContext>
            </DndContext>
          </section>
        </section>
      ) : null}

      {view === "judges" ? (
        <JudgeManagementWorkspace
          accounts={accounts}
          roster={roster}
          rosterDraft={rosterDraft}
          rosterDirty={rosterDirty}
          currentAssignment={currentAssignment}
          currentGroupOpen={state.competitionSetup?.activeGroupId === currentAssignment.groupId && state.competitionSetup?.groups?.[currentAssignment.groupId]?.status === "open"}
          newJudge={newJudge}
          setNewJudge={setNewJudge}
          onToggleRoster={toggleRoster}
          onCancelRoster={cancelRosterChanges}
          onSaveRoster={saveRoster}
          onCreateJudge={createJudge}
          onSaveAccount={saveAccount}
          showToast={showToast}
          preferredAccountId={preferredAccountId}
        />
      ) : null}

      {view === "display" ? (
        <section className="admin-module-grid display-module">
          <section className="admin-panel display-launch-panel" aria-label="成绩大屏启动控制">
            <header><div><span>大屏候场</span><h2>标语页与首队成绩</h2></div><p>未启动成绩展示时，投屏保持宣传标语页，不显示任何队伍或实时成绩。</p></header>
            <div className="display-launch-control">
              <div><span>{scoreDisplayIsActive ? "成绩页已启动" : "候场标语正在展示"}</span><strong>AI赋能跨电　数智融通东盟</strong><small>{openingDisplayTeam ? `首队：${openingDisplayTeam.registrationNumber || `第 ${openingDisplayTeam.appearanceOrder} 队`}·${openingDisplayTeam.teamName}${openingDisplayReady ? openingDisplaySummary?.isFinal ? "，最终成绩已就绪" : `，已提交 ${openingDisplaySubmittedCount} 位评委` : "，等待评委提交"}` : "请先在开赛配置中选择本场参赛队伍。"}</small></div>
              <button className="primary-action" type="button" disabled={!openingDisplayReady || scoreDisplayIsActive} onClick={startOpeningDisplay}><Play size={18} aria-hidden="true" />{scoreDisplayIsActive ? "成绩展示已启动" : "从第 1 队开始展示"}</button>
            </div>
          </section>
          <section className="admin-panel display-control-panel">
            <header className="display-page-heading"><div><span>第 1 步</span><h2>选择要展示的队伍</h2></div><p>前三队和后续队伍都在同一列表，点击队伍后去右侧展示。</p></header>
            <div className="display-browser-tools">
              <label>比赛组别<select value={selectedGroupId} onChange={(event) => { setSelectedGroupId(event.target.value); setDisplayTeamId(""); setDisplaySearch(""); }}>{contestGroups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label>
              <label className="display-team-search"><span>查找队伍</span><div><Search size={17} aria-hidden="true" /><input type="search" value={displaySearch} onChange={(event) => setDisplaySearch(event.target.value)} placeholder="搜索队伍编号、名称或项目" /></div></label>
            </div>
            <section className="display-team-browser" aria-labelledby="display-team-browser-title">
              <header><div><h3 id="display-team-browser-title">本场参赛队伍</h3><span>所有队伍都可选；有任意 1 位评委提交后即可展示</span></div><strong>{displayFilteredTeams.length === displayCompetitionTeams.length ? `${displayCompetitionTeams.length} 支` : `${displayFilteredTeams.length} / ${displayCompetitionTeams.length} 支`}</strong></header>
              <div className="display-team-list" role="listbox" aria-label="展示队伍">
                {displayFilteredTeams.map((team, index) => {
                  const summary = state.summariesByTeam?.[team.id];
                  const displayState = getDisplayTeamState(summary);
                  const isSelected = displayTeamId === team.id;
                  const isPublished = publishedDisplayTeamId === team.id;
                  return <button type="button" role="option" aria-selected={isSelected} aria-posinset={index + 1} aria-setsize={displayFilteredTeams.length} key={team.id} className={[isSelected ? "is-selected" : "", isPublished ? "is-published" : ""].filter(Boolean).join(" ")} onClick={() => setDisplayTeamId(team.id)}>
                    <span className="display-team-order">第 {team.appearanceOrder} 队</span>
                    <span className="display-team-identity"><small>{team.registrationNumber || "未填队伍编号"}</small><strong>{team.teamName}</strong><em>{team.projectName || "未填项目名称"}</em></span>
                    <span className="display-team-progress"><strong>{summary?.submittedCount ?? 0}/{summary?.rosterCount ?? rosterCount}</strong><small>评委已提交</small></span>
                    <span className={`display-team-state is-${displayState.tone}`}>{isPublished ? "大屏展示中" : displayState.label}</span>
                  </button>;
                })}
                {!displayCompetitionTeams.length ? <div className="display-team-empty"><strong>该组还没有本场队伍</strong><span>请先在开赛配置中选择参赛队伍。</span></div> : null}
                {displayCompetitionTeams.length > 0 && !displayFilteredTeams.length ? <div className="display-team-empty"><strong>没有匹配的队伍</strong><span>请尝试队伍编号或名称。</span></div> : null}
              </div>
            </section>
          </section>
          <section className="admin-panel display-publish-panel">
            <header><span>第 2 步</span><h2>展示到大屏</h2></header>
            {displayCandidateTeam ? <div className="display-preview-summary">
              <div className="display-preview-team"><span>{displayCandidateTeam.registrationNumber || `第 ${displayCandidateTeam.appearanceOrder} 队`}</span><h3>{displayCandidateTeam.teamName}</h3><small>{displayCandidateTeam.projectName || "未填项目名称"}</small></div>
              <dl><div><dt>评委提交</dt><dd>{displayCandidateSubmittedCount}/{displayCandidateSummary?.rosterCount ?? rosterCount}</dd></div><div><dt>当前综合分</dt><dd>{displayCandidateSummary?.display ?? "--"}</dd></div></dl>
              <p>{displayCandidateSubmittedCount === 0 ? "该队还没有评委提交。第 1 位评委提交后即可展示。" : displayCandidateSummary?.isFinal ? "全体评委已提交，将展示最终综合分。" : displayCandidateSubmittedCount < 3 ? "现在即可展示已提交的评委分；第 3 位提交后自动计算暂算综合分。" : "现在可展示暂算综合分；后续评委提交后大屏会自动更新。"}</p>
              <div className="display-publish-actions"><button className="primary-action" type="button" disabled={displayCandidateSubmittedCount < 1} onClick={() => publish(displayCandidateTeam, displayCandidateSummary?.isFinal ? "final" : "temporary")}>{publishedDisplayTeamId === displayCandidateTeam.id ? "更新当前大屏" : displayCandidateSummary?.isFinal ? "展示最终成绩" : "立即展示当前成绩"}</button><button className="danger-action" type="button" disabled={!publishedDisplayTeamId} onClick={() => publish(null, "idle")}>切换到标语页</button></div>
            </div> : <div className="display-preview-empty"><strong>先选择一支队伍</strong><span>从左侧点击队伍，即可在这里确认并展示。</span></div>}
            <section className="display-current-panel" aria-label="当前大屏"><div><span>当前大屏</span><strong>{selectedDisplayTeam?.teamName ?? "未展示队伍"}</strong><small>{state.displaySelection?.publicationStatus === "final" ? "最终成绩" : state.displaySelection?.publicationStatus === "temporary" ? "实时成绩" : state.displaySelection?.publicationStatus === "review_required" ? "待复核" : "大屏等待中"}</small></div><b>{selectedDisplaySummary?.display ?? "--"}</b></section>
            <div className="display-entry-actions">
              <a className="display-entry-button" href={`${projectionEntryPath}?live=1#controlToken=${encodeURIComponent(authToken)}`} target="_blank" rel="noreferrer"><ExternalLink size={17} aria-hidden="true" /><span><small>{scoreDisplayIsActive ? "成绩页 URL" : "标语页 URL"}</small><strong>打开受控大屏</strong></span></a>
              <a className="display-entry-button" href={`/rankings?groupId=${encodeURIComponent(selectedGroupId)}#controlToken=${encodeURIComponent(authToken)}`} target="_blank" rel="noreferrer"><ExternalLink size={17} aria-hidden="true" /><span><small>总览投屏</small><strong>打开队伍排名</strong></span></a>
            </div>
          </section>
        </section>
      ) : null}
      {view === "emergency" ? (
        <section className="admin-emergency-page">
          <header className="admin-emergency-heading"><div><span>现场异常</span><h2>应急处置</h2><p>先按影响范围选择处置类型，系统继续执行原有版本校验、数据清理和审计。</p></div><div><span>当前比赛</span><strong>{activeCompetitionGroupId ? getGroupLabel(activeCompetitionGroupId) : "尚未开赛"}</strong><small>{currentTeam?.teamName ?? "暂无当前队"}</small></div></header>
          <section className="historical-rescore-panel" aria-labelledby="historical-rescore-title">
            <header className="historical-rescore-heading">
              <div><span>只影响一名评委的历史成绩</span><h3 id="historical-rescore-title">历史队伍指定评委重评</h3><p>全局仍保持当前队派发；只有被指定的评委临时返回历史队，其他评委和当前队评分不受影响。</p></div>
              <div className="historical-rescore-current"><span>全局当前队</span><strong>{currentTeam?.teamName ?? "尚未派发"}</strong><small>指定重评期间继续正常评分</small></div>
            </header>

            <div className={`historical-rescore-status-band${activeHistoricalRescores.length ? " is-active" : ""}`}>
              <div><span>活动任务</span><strong>{activeHistoricalRescores.length ? `${activeHistoricalRescores.length} 项指定重评进行中` : "暂无指定重评"}</strong></div>
              {activeHistoricalRescores.length ? <div className="historical-rescore-active-list">{activeHistoricalRescores.map((grant) => {
                const grantTeam = teams.find((team) => team.id === grant.teamId);
                const grantJudge = accounts.find((account) => account.id === grant.judgeId);
                return <div key={`${grant.judgeId}-${grant.teamId}`}><strong>{grantJudge?.displayName ?? grant.judgeId}</strong><span>{grantTeam?.registrationNumber || "未填队伍编号"} · {grantTeam?.teamName ?? grant.teamId}</span><small>{grant.mode === "clear" ? "清空后重评" : "保留原分修改"}{grant.reason ? ` · ${grant.reason}` : ""}</small></div>;
              })}</div> : <p>发起后，此处会持续显示指定评委、历史队伍和重评方式。</p>}
            </div>

            <div className="historical-rescore-fields">
              <label><span>1. 选择已完成历史队</span><select value={historicalRescoreDraft.teamId} disabled={activeCompetitionSetup?.status !== "open" || !historicalRescoreTeams.length} onChange={(event) => setHistoricalRescoreDraft((current) => ({ ...current, teamId: event.target.value, judgeId: "", clearConfirmed: false }))}><option value="">{activeCompetitionSetup?.status !== "open" ? "当前没有已开启的比赛组" : historicalRescoreTeams.length ? "请选择历史队伍" : "暂无可重评的已完成队伍"}</option>{historicalRescoreTeams.map((team) => <option value={team.id} key={team.id}>{team.registrationNumber || `第 ${team.appearanceOrder} 队`} · {team.teamName}{activeHistoricalRescoreTeamIds.has(team.id) ? " · 已有重评任务" : ""}</option>)}</select><small>只列出当前赛次已完成且非全局当前队的队伍。</small></label>
              <label><span>2. 选择指定评委</span><select value={historicalRescoreDraft.judgeId} disabled={!selectedHistoricalRescoreTeam || !selectedHistoricalRescoreJudges.length} onChange={(event) => setHistoricalRescoreDraft((current) => ({ ...current, judgeId: event.target.value, clearConfirmed: false }))}><option value="">{selectedHistoricalRescoreTeam ? selectedHistoricalRescoreJudges.length ? "请选择冻结名册评委" : "该队缺少冻结评委名册" : "请先选择历史队伍"}</option>{selectedHistoricalRescoreJudges.map((judge) => <option value={judge.id} key={judge.id} disabled={judge.status !== "active" || !judge.submitted || Boolean(judge.grant)}>{judge.displayName} · {judge.username}{judge.grant ? " · 已有重评任务" : judge.status !== "active" ? " · 账号不可用" : judge.submitted ? " · 已提交" : " · 未提交"}</option>)}</select><small>评委范围来自该队开始评分时锁定的冻结名册。</small></label>
              <fieldset><legend>3. 选择重评方式</legend><label><input type="radio" name="historical-rescore-mode" value="retain" checked={historicalRescoreDraft.mode === "retain"} onChange={() => setHistoricalRescoreDraft((current) => ({ ...current, mode: "retain", clearConfirmed: false }))} /><span><strong>保留原分修改</strong><small>撤回提交，保留原有分项。</small></span></label><label><input type="radio" name="historical-rescore-mode" value="clear" checked={historicalRescoreDraft.mode === "clear"} onChange={() => setHistoricalRescoreDraft((current) => ({ ...current, mode: "clear", clearConfirmed: false }))} /><span><strong>清空后重评</strong><small>只清空这名评委的分项。</small></span></label></fieldset>
              <label className="historical-rescore-reason"><span>4. 应急处置原因</span><textarea rows="3" minLength="3" maxLength="500" value={historicalRescoreDraft.reason} onChange={(event) => setHistoricalRescoreDraft((current) => ({ ...current, reason: event.target.value }))} placeholder="例如：评委误提交，组委会确认由该评委修正后重新提交。" /><small>{historicalRescoreDraft.reason.length}/500 字符，至少填写 3 个字符。轮询更新不会清空本处草稿。</small></label>
            </div>

            <footer className="historical-rescore-actions">
              <div><strong>{selectedHistoricalRescoreTeam && selectedHistoricalRescoreJudge ? `将仅影响 ${selectedHistoricalRescoreJudge.displayName} · ${selectedHistoricalRescoreTeam.teamName}` : "请完成队伍、评委、方式和原因选择"}</strong><span>其他评委继续评当前队；指定评委重新提交后会自动返回全局当前队。</span></div>
              {historicalRescoreDraft.mode === "clear" ? <label className="historical-rescore-clear-confirm"><input type="checkbox" checked={historicalRescoreDraft.clearConfirmed} onChange={(event) => setHistoricalRescoreDraft((current) => ({ ...current, clearConfirmed: event.target.checked }))} /><span>我确认只清空这名评委在该历史队的分项成绩</span></label> : null}
              <button className={historicalRescoreDraft.mode === "clear" ? "danger-action" : "primary-action"} type="button" disabled={!historicalRescoreReady} onClick={startHistoricalJudgeRescore}>{historicalRescoreDraft.mode === "clear" ? "确认清空并发起重评" : "发起保留原分重评"}</button>
            </footer>
          </section>
          <div className="admin-emergency-options">
            <article><div><span>影响一个评委席位</span><h3>当前队评委异常</h3><p>用于误提交、清空重评或评委临时离场。其他评委当前队成绩保持不变。</p></div><dl><div><dt>当前队</dt><dd>{currentTeam?.teamName ?? "未派发"}</dd></div><div><dt>有效评委</dt><dd>{currentRosterCount} 位</dd></div></dl><button className="primary-action" type="button" disabled={!currentTeam} onClick={openCurrentJudgeEmergency}>处理当前队评委<ArrowRight size={17} aria-hidden="true" /></button></article>
            <article><div><span>影响当前派发</span><h3>必须中断或切换队伍</h3><p>仅在当前队无法继续时使用。旧派发版本的延迟评分会被拒绝。</p></div><dl><div><dt>当前队</dt><dd>{currentTeam?.teamName ?? "未派发"}</dd></div><div><dt>当前状态</dt><dd>{currentAssignment.status === "scoring" ? "正在评分" : currentAssignment.status === "awaiting_submissions" ? "等待提交" : "无开放评分"}</dd></div></dl><button className="danger-action" type="button" disabled={!currentTeam} onClick={openForcedDispatchEmergency}>进入强制切队<ArrowRight size={17} aria-hidden="true" /></button></article>
            <article><div><span>影响整个组别</span><h3>队伍或评委数量错误</h3><p>返回开赛配置重新核对。本组已有评分时，需要二次确认并清除本组评分与队伍快照。</p></div><dl><div><dt>将清理评分</dt><dd>{state.restartImpactByGroup?.[activeCompetitionGroupId]?.entryCount ?? 0} 条</dd></div><div><dt>仍会保留</dt><dd>队伍资料、顺序、账号</dd></div></dl><button className="danger-action" type="button" disabled={!activeCompetitionGroupId} onClick={openGroupRestartEmergency}>重新配置当前组<ArrowRight size={17} aria-hidden="true" /></button></article>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function JudgeWorkspace({ account, state, entry, submissionState, syncStatus, logout, onScoreChange, onReset, onSubmit, toast, showToast }) {
  const assignment = state.activeAssignment ?? emptyAssignment;
  const team = state.teams?.find((item) => item.id === assignment.teamId) ?? null;
  const isAssignedJudge = Boolean(assignment.rosterSnapshot?.includes(account.id));
  const isHistoricalRescore = assignment.rescore === true;
  const [activeScoreId, setActiveScoreId] = useState(allItems[0].id);
  const [selectedScoreId, setSelectedScoreId] = useState(null);
  const [isKeypadOpen, setIsKeypadOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [replaceOnKey, setReplaceOnKey] = useState(true);
  const rowRefs = useRef({});
  const rubricListRef = useRef(null);
  const keypadRef = useRef(null);
  const resetIntentRef = useRef({ key: "", timer: null });
  const pendingKeypadDismissRef = useRef(null);
  const activeItem = allItems.find((item) => item.id === activeScoreId) ?? allItems[0];
  const activeIndex = allItems.findIndex((item) => item.id === activeItem.id);
  const value = entry.scores?.[activeItem.id] ?? "";
  const activeDraft = draft === "" && value !== "" ? formatScore(value) : draft;
  const completed = allItems.filter((item) => entry.scores?.[item.id] !== "").length;
  const total = getScoresTotalCents(entry.scores) / scoreScale;
  const isPendingSubmission = submissionState === "saving" || submissionState === "pending";
  const isServerSubmitted = Boolean(entry.submitted && submissionState === "confirmed");
  const canScore = Boolean(team && isAssignedJudge && ["scoring", "awaiting_submissions"].includes(assignment.status) && !entry.submitted);
  const canExpandKeypad = Boolean(selectedScoreId && canScore && !isKeypadOpen);

  function keepVisible(itemId) {
    const adjust = () => {
      const row = rowRefs.current[itemId];
      const keypad = keypadRef.current;
      if (!row || !keypad) return;
      const rowRect = row.getBoundingClientRect();
      const keypadRect = keypad.getBoundingClientRect();
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const scrollContainer = row.closest(".rubric-list");
      const scrollContainerRect = scrollContainer?.getBoundingClientRect();
      const topLimit = Math.max(scrollContainerRect?.top ?? 16, 16) + 16;
      const bottomLimit = Math.min(keypadRect.top - 24, viewportHeight - keypadRect.height - 24);
      if (rowRect.bottom > bottomLimit) {
        const offset = rowRect.bottom - bottomLimit;
        if (scrollContainer) scrollContainer.scrollBy({ top: offset, behavior: "auto" });
        else window.scrollBy({ top: offset, behavior: "auto" });
      } else if (rowRect.top < topLimit) {
        const offset = rowRect.top - topLimit;
        if (scrollContainer) scrollContainer.scrollBy({ top: offset, behavior: "auto" });
        else window.scrollBy({ top: offset, behavior: "auto" });
      }
    };
    requestAnimationFrame(adjust);
    window.setTimeout(adjust, 140);
  }

  useEffect(() => {
    if (!isKeypadOpen) return undefined;
    const onViewportChange = () => keepVisible(activeScoreId);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("scroll", onViewportChange);
    requestAnimationFrame(() => keypadRef.current?.focus({ preventScroll: true }));
    return () => {
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("scroll", onViewportChange);
    };
  }, [activeScoreId, isKeypadOpen]);

  useEffect(() => {
    if (!entry.submitted) return;
    setIsKeypadOpen(false);
    setSelectedScoreId(null);
    setDraft("");
    setReplaceOnKey(true);
  }, [entry.submitted]);

  useEffect(() => {
    setIsKeypadOpen(false);
    setSelectedScoreId(null);
    setDraft("");
    setReplaceOnKey(true);
    rubricListRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [assignment.teamId, assignment.assignmentRevision]);

  useEffect(() => () => window.clearTimeout(resetIntentRef.current.timer), []);

  useEffect(() => {
    if (!isKeypadOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      collapseKeypad();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isKeypadOpen]);

  function collapseKeypad({ restoreFocus = true } = {}) {
    setIsKeypadOpen(false);
    setReplaceOnKey(true);
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      if (!selectedScoreId) return;
      rowRefs.current[selectedScoreId]?.querySelector("[data-score-field]")?.focus({ preventScroll: true });
    });
  }

  function expandKeypad() {
    const selectedItem = allItems.find((item) => item.id === selectedScoreId);
    if (!canScore || !selectedItem) return;
    setActiveScoreId(selectedItem.id);
    setDraft(entry.scores?.[selectedItem.id] === "" ? "" : formatScore(entry.scores?.[selectedItem.id]));
    setReplaceOnKey(true);
    setIsKeypadOpen(true);
    keepVisible(selectedItem.id);
  }

  function isKeypadDismissExempt(target) {
    return target instanceof Element && Boolean(target.closest("[data-score-field], [data-score-pad], button, a, input, select, textarea, [role='button']"));
  }

  function beginKeypadDismiss(event) {
    if (!isKeypadOpen || !event.isPrimary || event.button !== 0 || isKeypadDismissExempt(event.target)) {
      pendingKeypadDismissRef.current = null;
      return;
    }
    pendingKeypadDismissRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
  }

  function completeKeypadDismiss(event) {
    const pending = pendingKeypadDismissRef.current;
    pendingKeypadDismissRef.current = null;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) > 10) return;
    collapseKeypad();
  }

  function selectItem(item) {
    if (!canScore) return showToast(entry.submitted ? "当前队伍评分已提交，如需修改请联系管理员撤回" : !isAssignedJudge ? "当前账号不在本队有效评分名册中" : "请等待管理员派发可评分队伍");
    setActiveScoreId(item.id);
    setSelectedScoreId(item.id);
    setDraft(entry.scores?.[item.id] === "" ? "" : formatScore(entry.scores?.[item.id]));
    setReplaceOnKey(true);
    setIsKeypadOpen(true);
    keepVisible(item.id);
  }

  function setCurrentValue(nextValue) {
    if (!scoreDraftPattern.test(nextValue)) return false;
    const normalized = nextValue.replace(",", ".");
    if (normalized === "") {
      setDraft("");
      onScoreChange(activeItem, "");
      return true;
    }
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric > activeItem.max) {
      if (numeric > activeItem.max) showToast(`不能超过 ${formatScore(activeItem.max)} 分`);
      return false;
    }
    setDraft(nextValue);
    onScoreChange(activeItem, numeric);
    return true;
  }

  function pressKey(key) {
    if (key === "backspace") { setReplaceOnKey(false); setCurrentValue(activeDraft.slice(0, -1)); return; }
    if (key === "clear") { setReplaceOnKey(false); setCurrentValue(""); return; }
    const base = replaceOnKey ? "" : activeDraft;
    let next = base;
    if (key === ".") { if (base.includes(".")) return; next = base ? `${base}.` : "0."; }
    else if (base === "0") next = key === "0" ? "0" : key;
    else next = `${base}${key}`;
    setReplaceOnKey(false);
    setCurrentValue(next);
  }

  function goItem(direction) {
    const next = allItems[activeIndex + direction];
    if (!next) return showToast(direction > 0 ? "已到最后一项" : "已到第一项");
    setActiveScoreId(next.id);
    setSelectedScoreId(next.id);
    setDraft(entry.scores?.[next.id] === "" ? "" : formatScore(entry.scores?.[next.id]));
    setReplaceOnKey(true);
    keepVisible(next.id);
  }

  async function submit() {
    if (completed !== allItems.length) {
      const missing = allItems.find((item) => entry.scores?.[item.id] === "");
      if (missing) {
        selectItem(missing);
        showToast(`还有 ${allItems.length - completed} 项未评分，已定位到 ${missing.title}`, 3200);
      }
      return;
    }
    const saved = await onSubmit();
    if (saved) {
      collapseKeypad({ restoreFocus: false });
      setSelectedScoreId(null);
      rubricListRef.current?.scrollTo({ top: 0, behavior: "auto" });
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  async function reset() {
    if (!canScore) return showToast(isPendingSubmission ? "评分正在提交，请等待服务器确认" : entry.submitted ? "当前队伍评分已提交，如需修改请联系管理员撤回" : "请等待管理员派发可评分队伍");
    const key = assignmentKey(assignment);
    if (resetIntentRef.current.key !== key) {
      resetIntentRef.current.key = key;
      window.clearTimeout(resetIntentRef.current.timer);
      resetIntentRef.current.timer = window.setTimeout(() => { resetIntentRef.current.key = ""; }, 4200);
      showToast("再次点击重置，清空当前队伍评分");
      return;
    }
    window.clearTimeout(resetIntentRef.current.timer);
    resetIntentRef.current.key = "";
    const result = await onReset();
    collapseKeypad({ restoreFocus: false });
    setSelectedScoreId(null);
    showToast(result?.ok ? "已清空当前队伍评分" : "本机已清空评分，等待服务器确认", result?.ok ? 2600 : 4200);
  }

  if (!team || assignment.status === "idle" || assignment.status === "closed" || !isAssignedJudge) {
    const isRosterWaiting = Boolean(team && !isAssignedJudge);
    return <main className="judge-app judge-waiting"><div className="judge-session-actions"><button className="judge-logout-button" type="button" onClick={logout}>退出登录</button></div><ConnectionStatus status={syncStatus} className="judge-sync-status" /><section className="judge-waiting-panel"><span>{account.displayName}</span><h1>{isRosterWaiting ? "当前队伍未分配给此评委" : "等待管理员安排评分队伍"}</h1><p>{syncStatus.tone === "offline" ? "当前未连接评分服务器，请保持本页，网络恢复后会自动重连。" : isRosterWaiting ? "请联系管理员确认本队有效评分名册。" : "评分队伍派发后，当前页面会自动进入评分。"}</p></section><Toast message={toast} /></main>;
  }

  return (
    <main className={`judge-app is-scoring${isKeypadOpen ? " is-keypad-open" : ""}${canExpandKeypad ? " has-keypad-expand" : ""}`} onPointerDownCapture={beginKeypadDismiss} onPointerUpCapture={completeKeypadDismiss} onPointerCancelCapture={() => { pendingKeypadDismissRef.current = null; }}>
      <div className="judge-session-actions"><button className="judge-logout-button" type="button" onClick={logout}>退出登录</button></div>
      <ConnectionStatus status={syncStatus} className="judge-sync-status" />
      <Toast message={toast} className="judge-toast-slot" />
      <header className="hero controlled-judge-hero" aria-label="当前评分队伍与总分">
        <div className="controlled-team-name"><span>{isHistoricalRescore ? "应急重评队伍" : "当前评分队伍"}</span><strong>{team.teamName}</strong></div>
        <div className="score-compact"><span>当前总分</span><strong>{formatScore(total)}</strong></div>
      </header>
      {isHistoricalRescore ? <section className="judge-rescore-notice" role="status"><strong>管理员已安排历史队伍应急重评</strong><span>{assignment.rescoreMode === "clear" ? "原分项已清空，请重新完成全部评分并提交。" : "原分项已保留，请核对修改后重新提交。"} 提交成功后将自动返回当前比赛队伍。</span>{assignment.rescoreReason ? <small>处置原因：{assignment.rescoreReason}</small> : null}</section> : null}
      {isPendingSubmission ? <div className="judge-submitted-banner is-pending">{submissionState === "saving" ? isHistoricalRescore ? "正在提交重评，等待服务器确认。" : "正在提交评分，等待服务器确认。" : isHistoricalRescore ? "重评已在当前页面暂存，请勿刷新或退出；网络恢复后会自动补交。" : "评分已在当前页面暂存，请勿刷新或退出；网络恢复后会自动补交。"}</div> : syncStatus.tone === "offline" && completed > 0 ? <div className="judge-submitted-banner is-pending">{isHistoricalRescore ? "重评修改" : "评分修改"}已在当前页面暂存，请勿刷新或退出；网络恢复后会自动补交。</div> : isServerSubmitted ? <div className="judge-submitted-banner">{isHistoricalRescore ? "服务器已确认重评提交，正在返回当前比赛队伍。" : "服务器已确认评分提交，等待管理员派发下一队。"}</div> : null}
      <section className="rubric-list" aria-label="评分细则" ref={rubricListRef}>
        {rubric.map((dimension, dimensionIndex) => {
          const dimensionTotal = dimension.items.reduce((sum, item) => sum + Number(entry.scores?.[item.id] || 0), 0);
          return <article className={`dimension-section ${dimension.accent}`} key={dimension.id}>
            <header className="dimension-head"><div><span>维度 {dimensionIndex + 1}</span><h2>{dimension.title}</h2></div><div className="dimension-score"><strong>{formatScore(dimensionTotal)}</strong><span>/ {formatScore(dimension.max)}</span></div></header>
            {dimension.items.map((item) => {
              const itemValue = entry.scores?.[item.id] ?? "";
              const selected = item.id === selectedScoreId;
              const active = isKeypadOpen && selected;
              return <div className={`score-row${selected ? " is-selected" : ""}${active ? " is-active" : ""}`} key={item.id} ref={(node) => { rowRefs.current[item.id] = node; }}>
                <div className="score-copy"><div className="row-title"><h3>{item.title}</h3><span>{formatScore(item.max)} 分</span></div><p>{item.desc}</p></div>
                <div className="score-editor"><div className="score-control"><button className="score-value-button" data-score-field type="button" onClick={() => selectItem(item)} aria-expanded={active} aria-controls={active ? "judge-score-pad" : undefined} aria-label={`录入${item.title}得分，当前得分 ${itemValue === "" ? "未录入" : formatScore(itemValue)}`}><strong>{itemValue === "" ? "--" : formatScore(itemValue)}</strong></button></div></div>
              </div>;
            })}
          </article>;
        })}
      </section>
      {isKeypadOpen ? <section className="score-pad" data-score-pad id="judge-score-pad" aria-labelledby="judge-score-pad-title" ref={keypadRef} tabIndex={-1}>
        <div className="score-pad-head"><div><span>当前评分项</span><strong id="judge-score-pad-title" aria-live="polite">{activeItem.title}</strong></div><div className="score-pad-readout" aria-live="polite"><strong>{activeDraft || "--"}</strong></div><button className="score-pad-collapse-button" type="button" onClick={collapseKeypad}><ChevronDown size={18} aria-hidden="true" />收起</button></div>
        <div className="score-pad-body"><div className="score-pad-keys">{["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", ".", "backspace"].map((key) => <button type="button" key={key} onClick={() => pressKey(key)}>{key === "backspace" ? "退格" : key}</button>)}</div><div className="score-pad-actions"><button type="button" onClick={() => pressKey("clear")}>清空</button><button type="button" disabled={activeIndex === 0} onClick={() => goItem(-1)}>上一项</button><button className="score-pad-next" type="button" disabled={activeIndex === allItems.length - 1} onClick={() => goItem(1)}>下一项</button><button className="score-pad-submit" type="button" disabled={!canScore || isPendingSubmission} onClick={submit}><Send size={17} aria-hidden="true" />{isPendingSubmission ? "提交中" : "提交评分"}</button></div></div>
      </section> : null}
      {canExpandKeypad ? <button className="score-pad-expand-button" type="button" onClick={expandKeypad} aria-label={`展开${activeItem.title}的虚拟键盘`}><Keyboard size={18} aria-hidden="true" />展开键盘</button> : null}
      <footer className="submit-bar"><button className="ghost-action" type="button" onClick={reset}><RotateCcw size={18} aria-hidden="true" />重置</button><div><span>当前总分</span><strong>{formatScore(total)}</strong></div><button className="primary-action" type="button" disabled={!canScore || isPendingSubmission} onClick={submit}><Send size={18} aria-hidden="true" />{isServerSubmitted ? "已提交" : isPendingSubmission ? "提交中" : "提交评分"}</button></footer>
    </main>
  );
}

export function App() {
  const [account, setAccount] = useState(null);
  const [authToken, setAuthToken] = useState(loadToken);
  const [serverState, setServerState] = useState(createEmptyClientState);
  const [judgeEntry, setJudgeEntry] = useState(createEntry);
  const [judgeSubmissionState, setJudgeSubmissionState] = useState("idle");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [sessionRestoreError, setSessionRestoreError] = useState("");
  const [isRestoringSession, setIsRestoringSession] = useState(Boolean(authToken));
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [toast, setToast] = useState("");
  const [syncStatus, setSyncStatus] = useState({ tone: "checking", label: "正在连接评分服务器" });
  const accountRef = useRef(account);
  const tokenRef = useRef(authToken);
  const stateRef = useRef(serverState);
  const entryRef = useRef(judgeEntry);
  const entryAssignmentKeyRef = useRef("");
  const sessionEpochRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshAbortRef = useRef(null);
  const refreshGenerationRef = useRef(createOperationGeneration());
  const loginAbortRef = useRef(null);
  const sessionRestoreAbortRef = useRef(null);
  const saveAbortRef = useRef(null);
  const mutationAbortControllersRef = useRef(new Set());
  const saveInFlightRef = useRef(false);
  const savePromiseRef = useRef(Promise.resolve());
  const saveGenerationRef = useRef(createOperationGeneration());
  const pendingSaveRef = useRef(null);
  const assignmentRef = useRef(emptyAssignment);
  const draftsRef = useRef(loadDraftCache());
  const toastTimerRef = useRef(null);
  const deviceIdRef = useRef(loadDeviceId());
  const appPath = normalizeAppPath(window.location.pathname);
  const isScoreboardPage = appPath === SCOREBOARD_RESULTS_PATH;
  const isScoreboardSloganPage = appPath === SCOREBOARD_SLOGAN_PATH;
  const isScoreboardDemoPage = appPath === SCOREBOARD_DEMO_PATH;
  const isScoreboardCleanDemoPage = appPath === SCOREBOARD_CLEAN_DEMO_PATH;
  const isScoreboardTechDemoPage = appPath === SCOREBOARD_TECH_DEMO_PATH;
  const isScoreboardTechBackupDemoPage = appPath === SCOREBOARD_TECH_BACKUP_DEMO_PATH;
  const isScoreboardTechNineJudgesDemoPage = appPath === SCOREBOARD_TECH_NINE_JUDGES_DEMO_PATH;
  const isScoreboardTechTotalExtremesGroupedDemoPage = appPath === SCOREBOARD_TECH_TOTAL_EXTREMES_GROUPED_DEMO_PATH;
  const isScoreboardPremiumDemoPage = appPath === SCOREBOARD_PREMIUM_DEMO_PATH;
  const isRankingsPage = appPath === "/rankings";

  useEffect(() => { accountRef.current = account; }, [account]);
  useEffect(() => { tokenRef.current = authToken; }, [authToken]);
  useEffect(() => { stateRef.current = serverState; assignmentRef.current = serverState.activeAssignment ?? emptyAssignment; }, [serverState]);
  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  function showToast(message, duration = 2600) {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), duration);
  }

  function setJudgeEntryForAssignment(key, entry) {
    entryAssignmentKeyRef.current = key;
    entryRef.current = entry;
    setJudgeEntry(entry);
  }

  function cacheDraft(teamId, revision, entry) {
    if (!teamId || accountRef.current?.role !== "judge" || !tokenRef.current) return;
    draftsRef.current = { ...draftsRef.current, [`${teamId}:${revision}`]: entry };
    try {
      sessionStorage.setItem(judgeDraftStorageKey, JSON.stringify(draftsRef.current));
    } catch {
      showToast("本机存储受限，当前页面内评分仍可继续", 3200);
    }
  }

  function clearDraftCache() {
    draftsRef.current = {};
    try {
      sessionStorage.removeItem(judgeDraftStorageKey);
    } catch {
      // The in-memory cache is already cleared for this tab.
    }
  }

  function discardDraft(teamId, revision) {
    const key = `${teamId}:${revision}`;
    if (!draftsRef.current[key]) return;
    const nextDrafts = { ...draftsRef.current };
    delete nextDrafts[key];
    draftsRef.current = nextDrafts;
    try {
      sessionStorage.setItem(judgeDraftStorageKey, JSON.stringify(nextDrafts));
    } catch {
      // The in-memory cache is already updated for this tab.
    }
  }

  function invalidateRefreshWork() {
    refreshGenerationRef.current.invalidate();
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    refreshInFlightRef.current = false;
  }

  function invalidateJudgeSaveWork() {
    saveGenerationRef.current.invalidate();
    saveAbortRef.current?.abort();
    saveAbortRef.current = null;
    pendingSaveRef.current = null;
    saveInFlightRef.current = false;
    savePromiseRef.current = Promise.resolve();
  }

  function invalidateSessionWork() {
    sessionEpochRef.current += 1;
    invalidateRefreshWork();
    invalidateJudgeSaveWork();
    loginAbortRef.current?.abort();
    sessionRestoreAbortRef.current?.abort();
    mutationAbortControllersRef.current.forEach((controller) => controller.abort());
    mutationAbortControllersRef.current.clear();
    clearDraftCache();
  }

  function isCurrentContext(context) {
    return context.epoch === sessionEpochRef.current && context.token === tokenRef.current && context.accountId === accountRef.current?.id;
  }

  function clearSessionUi() {
    replaceServerState(createEmptyClientState());
    const blankEntry = createEntry();
    setJudgeEntryForAssignment("", blankEntry);
    setJudgeSubmissionState("idle");
    setLoginPassword("");
    setLoginError("");
  }

  function replaceServerState(nextState) {
    stateRef.current = nextState;
    assignmentRef.current = nextState.activeAssignment ?? emptyAssignment;
    setServerState(nextState);
  }

  function mergeServerState(patch) {
    replaceServerState({ ...stateRef.current, ...patch });
  }

  function updateLocalTeam(nextTeam) {
    if (!nextTeam?.id) return;
    const currentTeams = stateRef.current.teams ?? [];
    const hasTeam = currentTeams.some((team) => team.id === nextTeam.id);
    mergeServerState({
      teams: hasTeam
        ? currentTeams.map((team) => team.id === nextTeam.id ? { ...team, ...nextTeam } : team)
        : [...currentTeams, nextTeam],
    });
  }

  function persistToken(nextToken) {
    try {
      if (nextToken) sessionStorage.setItem(authTokenStorageKey, nextToken);
      else sessionStorage.removeItem(authTokenStorageKey);
    } catch {
      // The in-memory session remains usable in the current tab.
    }
  }

  function setAuthenticated(nextAccount, nextToken, nextState) {
    invalidateSessionWork();
    setSessionRestoreError("");
    setIsRestoringSession(false);
    setAccount(nextAccount);
    accountRef.current = nextAccount;
    setAuthToken(nextToken);
    tokenRef.current = nextToken;
    persistToken(nextToken);
    replaceServerState(nextState);
    setSyncStatus({ tone: "online", label: "评分服务器已连接" });
    setLoginUsername("");
    setLoginPassword("");
  }

  function expireSession(message = "登录已失效，请重新登录") {
    invalidateSessionWork();
    setSessionRestoreError("");
    setIsRestoringSession(false);
    setAccount(null);
    accountRef.current = null;
    setAuthToken("");
    tokenRef.current = "";
    persistToken("");
    clearSessionUi();
    setSyncStatus({ tone: "offline", label: "请重新登录" });
    setLoginError(message);
    showToast(message, 3200);
  }

  async function logout() {
    const token = tokenRef.current;
    if (token) requestApi("/api/logout", { method: "POST", headers: authHeaders(token) }).catch(() => {});
    invalidateSessionWork();
    setAccount(null);
    accountRef.current = null;
    setAuthToken("");
    tokenRef.current = "";
    persistToken("");
    clearSessionUi();
    setToast("");
  }

  function applyState(nextState, options = {}) {
    const currentAccount = options.account ?? accountRef.current;
    const previousKey = assignmentKey(assignmentRef.current);
    const nextAssignment = nextState.activeAssignment ?? emptyAssignment;
    const nextKey = assignmentKey(nextAssignment);
    replaceServerState(nextState);
    if (currentAccount?.role !== "judge") return;
    const teamId = nextAssignment.teamId;
    if (previousKey && previousKey !== nextKey) {
      invalidateJudgeSaveWork();
    }
    if (!teamId) {
      const blankEntry = createEntry();
      setJudgeEntryForAssignment("", blankEntry);
      setJudgeSubmissionState("idle");
      return;
    }
    const serverEntry = getEntryFromState(nextState, currentAccount.id, teamId);
    const cachedEntry = draftsRef.current[`${teamId}:${nextAssignment.assignmentRevision}`] ? sanitizeEntry(draftsRef.current[`${teamId}:${nextAssignment.assignmentRevision}`]) : null;
    const pending = pendingSaveRef.current;
    const pendingKey = pending ? `${pending.teamId}:${pending.assignmentRevision}` : "";
    const currentEntry = entryAssignmentKeyRef.current === nextKey ? entryRef.current : null;
    const serverRevisionAdvanced = Boolean(currentEntry) && serverEntry.serverRevision > (currentEntry.serverRevision ?? 0);
    const pendingMatchesServerRevision = pendingKey === assignmentKey(nextAssignment) && pending.entry.serverRevision >= serverEntry.serverRevision;
    if (pendingKey === assignmentKey(nextAssignment) && pending.entry.submitted) setJudgeSubmissionState((current) => current === "saving" ? current : "pending");
    else setJudgeSubmissionState(serverEntry.submitted ? "confirmed" : "idle");
    const local = currentEntry ?? cachedEntry;
    const remoteUpdateWins = serverRevisionAdvanced && !pendingMatchesServerRevision;
    const chosen = remoteUpdateWins ? serverEntry : local && isNewerDraft(local, serverEntry) ? local : cachedEntry && isNewerDraft(cachedEntry, serverEntry) ? cachedEntry : serverEntry;
    if (remoteUpdateWins) discardDraft(teamId, nextAssignment.assignmentRevision);
    setJudgeEntryForAssignment(nextKey, chosen);
  }

  async function refresh(options = {}) {
    const currentAccount = accountRef.current;
    const token = tokenRef.current;
    if (!currentAccount || !token || refreshInFlightRef.current) return false;
    refreshInFlightRef.current = true;
    const context = { epoch: sessionEpochRef.current, token, accountId: currentAccount.id };
    const operation = refreshGenerationRef.current.begin();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    try {
      const next = await fetchState(token, controller.signal);
      if (!isCurrentContext(context) || !refreshGenerationRef.current.isCurrent(operation)) return false;
      applyState(next, { account: currentAccount });
      setSyncStatus({ tone: "online", label: "评分服务器已连接" });
      if (pendingSaveRef.current && assignmentKey(next.activeAssignment) === `${pendingSaveRef.current.teamId}:${pendingSaveRef.current.assignmentRevision}`) flushJudgeSave();
      return true;
    } catch (error) {
      if (!isCurrentContext(context) || !refreshGenerationRef.current.isCurrent(operation) || error.name === "AbortError") return false;
      if (error.status === 401 || error.status === 403) expireSession(error.message || "登录已失效，请重新登录");
      else {
        setSyncStatus({ tone: "offline", label: "服务器未连接，当前页面暂存" });
        if (options.showError) showToast("未连接评分服务器，当前评分仅在当前页面暂存，请勿刷新或退出", 4200);
      }
      return false;
    } finally {
      if (refreshGenerationRef.current.isCurrent(operation)) {
        if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
        refreshInFlightRef.current = false;
      }
    }
  }

  async function mutate(path, { method = "PUT", body = {}, signal } = {}, fallback) {
    const token = tokenRef.current;
    const currentAccount = accountRef.current;
    if (!token || !currentAccount) throw createApiError("登录已失效，请重新登录", 401);
    const context = { epoch: sessionEpochRef.current, token, accountId: currentAccount.id };
    const controller = signal ? null : new AbortController();
    if (controller) mutationAbortControllersRef.current.add(controller);
    try {
      const payload = await requestApi(
        path,
        { method, signal: signal ?? controller.signal, headers: authHeaders(token, { "Content-Type": "application/json" }), body: JSON.stringify(body) },
        fallback,
      );
      if (!isCurrentContext(context)) return null;
      invalidateRefreshWork();
      return payload;
    } catch (error) {
      if (!isCurrentContext(context)) return null;
      throw error;
    } finally {
      if (controller) mutationAbortControllersRef.current.delete(controller);
    }
  }

  async function flushJudgeSave() {
    if (saveInFlightRef.current) return savePromiseRef.current;
    const accountNow = accountRef.current;
    if (!pendingSaveRef.current || accountNow?.role !== "judge" || !tokenRef.current) return Promise.resolve({ ok: false, submittedConfirmed: false });
    saveInFlightRef.current = true;
    const context = { epoch: sessionEpochRef.current, token: tokenRef.current, accountId: accountNow.id };
    const operation = saveGenerationRef.current.begin();
    const promise = (async () => {
      let activePending = null;
      let activeController = null;
      let submittedSaveConfirmed = false;
      try {
        while (pendingSaveRef.current && isCurrentContext(context) && saveGenerationRef.current.isCurrent(operation)) {
          const pending = pendingSaveRef.current;
          const pendingKey = `${pending.teamId}:${pending.assignmentRevision}`;
          activePending = pending;
          pendingSaveRef.current = null;
          if (pending.entry.submitted) setJudgeSubmissionState("saving");
          activeController = new AbortController();
          saveAbortRef.current = activeController;
          const payload = await mutate(
            `/api/entries/${encodeURIComponent(accountNow.id)}/${encodeURIComponent(pending.teamId)}`,
            { method: "PUT", signal: activeController.signal, body: { entry: pending.entry, assignmentRevision: pending.assignmentRevision } },
            "评分保存失败",
          );
          if (!isCurrentContext(context) || !saveGenerationRef.current.isCurrent(operation) || assignmentKey(stateRef.current.activeAssignment) !== pendingKey) return { ok: false, submittedConfirmed: false };
          const saved = sanitizeEntry(payload.entry);
          if (pending.entry.submitted && saved.submitted) submittedSaveConfirmed = true;
          setJudgeSubmissionState(saved.submitted ? "confirmed" : "idle");
          const newerPending = pendingSaveRef.current;
          const samePendingTarget = newerPending && `${newerPending.teamId}:${newerPending.assignmentRevision}` === `${pending.teamId}:${pending.assignmentRevision}`;
          if (samePendingTarget) {
            const rebased = {
              ...newerPending.entry,
              serverRevision: saved.serverRevision,
              serverUpdatedAt: saved.serverUpdatedAt,
            };
            pendingSaveRef.current = { ...newerPending, entry: rebased };
            if (assignmentKey(stateRef.current.activeAssignment) === `${pending.teamId}:${pending.assignmentRevision}`) {
              setJudgeEntryForAssignment(pendingKey, rebased);
              cacheDraft(pending.teamId, pending.assignmentRevision, rebased);
            }
          } else if (assignmentKey(stateRef.current.activeAssignment) === `${pending.teamId}:${pending.assignmentRevision}`) {
            setJudgeEntryForAssignment(pendingKey, saved);
            cacheDraft(pending.teamId, pending.assignmentRevision, saved);
          }
          if (payload.activeAssignment) {
            const responseAssignmentKey = assignmentKey(payload.activeAssignment);
            const assignmentTargetChanged = responseAssignmentKey !== pendingKey;
            mergeServerState({
              ...(assignmentTargetChanged ? {} : { activeAssignment: payload.activeAssignment }),
              displaySelection: payload.displaySelection ?? stateRef.current.displaySelection,
            });
          }
          setSyncStatus({ tone: "online", label: "评分服务器已连接" });
        }
        if (!isCurrentContext(context) || !saveGenerationRef.current.isCurrent(operation)) return { ok: false, submittedConfirmed: false };
        return { ok: true, submittedConfirmed: submittedSaveConfirmed };
      } catch (error) {
        if (!isCurrentContext(context) || !saveGenerationRef.current.isCurrent(operation) || error.name === "AbortError") return { ok: false, submittedConfirmed: false };
        if (error.status === 401 || error.status === 403) {
          expireSession(error.message || "登录已失效，请重新登录");
        } else if (error.status === 409) {
          pendingSaveRef.current = null;
          setJudgeSubmissionState("idle");
          const pendingKey = activePending ? `${activePending.teamId}:${activePending.assignmentRevision}` : "";
          if (entryRef.current.submitted && assignmentKey(stateRef.current.activeAssignment) === pendingKey) {
            const revertedEntry = { ...entryRef.current, submitted: false };
            setJudgeEntryForAssignment(pendingKey, revertedEntry);
          }
          showToast(error.message || "评分状态已变化，请核对后继续", 4200);
          refresh();
        } else {
          pendingSaveRef.current = pendingSaveRef.current ?? activePending;
          if (activePending?.entry.submitted) setJudgeSubmissionState("pending");
          setSyncStatus({ tone: "offline", label: "服务器未连接，当前页面暂存" });
        }
        return { ok: false, submittedConfirmed: false };
      } finally {
        if (saveGenerationRef.current.isCurrent(operation)) {
          if (saveAbortRef.current === activeController) saveAbortRef.current = null;
          saveInFlightRef.current = false;
        }
      }
    })();
    savePromiseRef.current = promise;
    return promise;
  }

  function queueJudgeEntry(next, assignment) {
    setJudgeEntryForAssignment(assignmentKey(assignment), next);
    setJudgeSubmissionState(next.submitted ? "saving" : "idle");
    cacheDraft(assignment.teamId, assignment.assignmentRevision, next);
    pendingSaveRef.current = { teamId: assignment.teamId, assignmentRevision: assignment.assignmentRevision, entry: next };
    return flushJudgeSave();
  }

  function updateJudgeScore(item, value) {
    const assignment = stateRef.current.activeAssignment ?? emptyAssignment;
    if (!assignment.teamId || !["scoring", "awaiting_submissions"].includes(assignment.status) || !assignment.rosterSnapshot?.includes(accountRef.current?.id)) return;
    const next = {
      ...entryRef.current,
      submitted: false,
      clientUpdatedAt: Date.now(),
      scores: { ...entryRef.current.scores, [item.id]: toScore(value, item.max) },
    };
    queueJudgeEntry(next, assignment);
  }

  function resetJudgeScores() {
    const assignment = stateRef.current.activeAssignment ?? emptyAssignment;
    if (!assignment.teamId || !["scoring", "awaiting_submissions"].includes(assignment.status) || !assignment.rosterSnapshot?.includes(accountRef.current?.id)) return Promise.resolve({ ok: false, submittedConfirmed: false });
    return queueJudgeEntry(
      { ...entryRef.current, scores: createBlankScores(), submitted: false, clientUpdatedAt: Date.now() },
      assignment,
    );
  }

  async function submitJudgeScore() {
    const assignment = stateRef.current.activeAssignment ?? emptyAssignment;
    if (!assignment.teamId) return false;
    const wasHistoricalRescore = assignment.rescore === true;
    const next = { ...entryRef.current, submitted: true, clientUpdatedAt: Date.now() };
    const result = await queueJudgeEntry(next, assignment);
    if (result?.submittedConfirmed && entryRef.current.submitted && !pendingSaveRef.current) {
      if (wasHistoricalRescore) {
        discardDraft(assignment.teamId, assignment.assignmentRevision);
        await refresh();
        showToast("重评已提交，已返回当前评分队伍", 3600);
      } else {
        showToast("评分已提交，等待管理员派发下一队", 3200);
      }
      return true;
    }
    return false;
  }

  async function submitLogin(event) {
    event.preventDefault();
    setIsLoggingIn(true);
    setLoginError("");
    setSessionRestoreError("");
    setIsRestoringSession(false);
    invalidateSessionWork();
    setAuthToken("");
    tokenRef.current = "";
    persistToken("");
    const loginEpoch = sessionEpochRef.current;
    const controller = new AbortController();
    loginAbortRef.current?.abort();
    loginAbortRef.current = controller;
    try {
      const session = await loginToServer(loginUsername, loginPassword, deviceIdRef.current, controller.signal);
      const state = await fetchState(session.token, controller.signal);
      if (controller.signal.aborted || loginEpoch !== sessionEpochRef.current) return;
      setAuthenticated(session.account, session.token, state);
      applyState(state, { account: session.account });
    } catch (error) {
      if (controller.signal.aborted || loginEpoch !== sessionEpochRef.current) return;
      setLoginError(error.message || "无法连接评分服务器，请检查网络或联系工作人员");
    } finally {
      if (loginAbortRef.current === controller) {
        loginAbortRef.current = null;
        setIsLoggingIn(false);
      }
    }
  }

  useEffect(() => {
    if (isScoreboardPage || isScoreboardSloganPage || isScoreboardDemoPage || isScoreboardCleanDemoPage || isScoreboardTechDemoPage || isScoreboardTechBackupDemoPage || isScoreboardTechNineJudgesDemoPage || isScoreboardTechTotalExtremesGroupedDemoPage || isScoreboardPremiumDemoPage || isRankingsPage || !authToken || account) return undefined;
    const controller = new AbortController();
    sessionRestoreAbortRef.current = controller;
    const restoreEpoch = sessionEpochRef.current;
    setIsRestoringSession(true);
    setSessionRestoreError("");
    (async () => {
      try {
        const session = await fetchSession(authToken, controller.signal);
        const state = await fetchState(authToken, controller.signal);
        if (controller.signal.aborted || restoreEpoch !== sessionEpochRef.current || authToken !== tokenRef.current) return;
        setIsRestoringSession(false);
        setAccount(session.account);
        accountRef.current = session.account;
        applyState(state, { account: session.account });
        setSyncStatus({ tone: "online", label: "评分服务器已连接" });
      } catch (error) {
        if (controller.signal.aborted || restoreEpoch !== sessionEpochRef.current) return;
        setIsRestoringSession(false);
        if (error.status === 401 || error.status === 403) {
          expireSession(error.message || "登录已失效，请重新登录");
        } else {
          setSyncStatus({ tone: "offline", label: "评分服务器未连接" });
          setSessionRestoreError("评分服务器暂时不可用，本地评分草稿仍保留，请重试恢复登录");
        }
      }
    })();
    return () => {
      controller.abort();
      if (sessionRestoreAbortRef.current === controller) sessionRestoreAbortRef.current = null;
    };
  }, [account, authToken, isScoreboardPage, isScoreboardSloganPage, isScoreboardDemoPage, isScoreboardCleanDemoPage, isScoreboardTechDemoPage, isScoreboardTechBackupDemoPage, isScoreboardTechNineJudgesDemoPage, isScoreboardTechTotalExtremesGroupedDemoPage, isScoreboardPremiumDemoPage, isRankingsPage, restoreAttempt]);

  useEffect(() => {
    if (!account || isScoreboardPage || isScoreboardSloganPage || isScoreboardDemoPage || isScoreboardCleanDemoPage || isScoreboardTechDemoPage || isScoreboardTechBackupDemoPage || isScoreboardTechNineJudgesDemoPage || isScoreboardTechTotalExtremesGroupedDemoPage || isScoreboardPremiumDemoPage || isRankingsPage) return undefined;
    refresh({ showError: account.role === "admin" });
    const timer = window.setInterval(() => refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [account?.id, account?.role, isScoreboardPage, isScoreboardSloganPage, isScoreboardDemoPage, isScoreboardCleanDemoPage, isScoreboardTechDemoPage, isScoreboardTechBackupDemoPage, isScoreboardTechNineJudgesDemoPage, isScoreboardTechTotalExtremesGroupedDemoPage, isScoreboardPremiumDemoPage, isRankingsPage]);

  if (isScoreboardPage) return <ScoreboardPage />;
  if (isScoreboardSloganPage) return <ScoreboardSloganPage />;
  if (isScoreboardDemoPage) return <ScoreboardDemoPage />;
  if (isScoreboardCleanDemoPage) return <ScoreboardDemoPage variant="clean" />;
  if (isScoreboardTechDemoPage) return <ScoreboardDemoPage variant="tech" />;
  if (isScoreboardTechBackupDemoPage) return <ScoreboardDemoPage variant="tech-backup" />;
  if (isScoreboardTechNineJudgesDemoPage) return <ScoreboardDemoPage variant="tech-nine-judges" />;
  if (isScoreboardTechTotalExtremesGroupedDemoPage) return <ScoreboardDemoPage variant="tech-total-extremes-grouped" />;
  if (isScoreboardPremiumDemoPage) return <ScoreboardDemoPage variant="premium" />;
  if (isRankingsPage) return <RankingsPage />;
  if (!account) {
    return <main className="login-shell"><section className="login-panel" aria-label="评分系统登录"><div className="login-copy"><span className="login-kicker">决赛评分表</span><h1>现场评分终端</h1><p>评委与管理员从同一入口登录，现场平板统一提交到共享评分服务器。</p></div><form className="login-form" onSubmit={submitLogin}><div className="login-form-head"><span>{isRestoringSession ? "恢复登录" : "账号验证"}</span><strong>{isRestoringSession ? "正在恢复当前标签页会话" : "请输入账号密码"}</strong></div><label>账号<input name="username" autoComplete="username" value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} placeholder="输入账号" /></label><label>密码<input type="password" name="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} placeholder="输入密码" /></label>{(sessionRestoreError || loginError) ? <div className="login-error" role="alert">{sessionRestoreError || loginError}</div> : null}<div className="login-form-actions">{authToken && sessionRestoreError ? <button className="ghost-action" type="button" onClick={() => setRestoreAttempt((current) => current + 1)}>重试恢复登录</button> : null}<button className="primary-action login-submit" disabled={isLoggingIn} type="submit">{isLoggingIn ? "登录中" : "登录"}</button></div></form></section></main>;
  }
  if (account.role === "admin") return <AdminWorkspace state={serverState} authToken={authToken} syncStatus={syncStatus} logout={logout} mutate={mutate} refresh={refresh} showToast={showToast} toast={toast} expireSession={expireSession} updateLocalTeam={updateLocalTeam} />;
  return <JudgeWorkspace account={account} state={serverState} entry={judgeEntry} submissionState={judgeSubmissionState} syncStatus={syncStatus} logout={logout} onScoreChange={updateJudgeScore} onReset={resetJudgeScores} onSubmit={submitJudgeScore} toast={toast} showToast={showToast} />;
}
