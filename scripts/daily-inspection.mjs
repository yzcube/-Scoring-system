import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const checks = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, action) {
  await action();
  checks.push(name);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`,
          ),
        );
    });
  });
}

async function main() {
  const [
    appSource,
    serverSource,
    stylesSource,
    authSource,
    stateStoreSource,
    httpRoutesSource,
    sessionApiRoutesSource,
    contestApiRoutesSource,
    contestStorageSource,
  ] = await Promise.all([
    readFile("src/App.jsx", "utf8"),
    readFile("contest-server.mjs", "utf8"),
    readFile("src/styles.css", "utf8"),
    readFile("server/auth-session.mjs", "utf8"),
    readFile("server/state-store.mjs", "utf8"),
    readFile("server/http-routes.mjs", "utf8"),
    readFile("server/session-api-routes.mjs", "utf8"),
    readFile("server/contest-api-routes.mjs", "utf8"),
    readFile("server/storage/contest-storage.mjs", "utf8"),
  ]);

  await check(
    "frontend keeps credentials and draft cache tab-scoped",
    async () => {
      assert(
        appSource.includes("sessionStorage"),
        "session-scoped storage is missing",
      );
      assert(
        !appSource.includes("localStorage"),
        "shared local storage must not hold authentication or scoring state",
      );
      assert(
        appSource.includes("invalidateSessionWork"),
        "session invalidation is missing",
      );
      assert(
        appSource.includes("AbortController"),
        "in-flight requests are not abortable",
      );
      assert(
        appSource.includes("mutationAbortControllersRef"),
        "administrator mutations are not session-abortable",
      );
      assert(
        appSource.includes("sessionRestoreAbortRef"),
        "session restoration is not session-abortable",
      );
      assert(
        appSource.includes("invalidateRefreshWork"),
        "state refresh cannot be invalidated after a successful mutation",
      );
      assert(
        appSource.includes("saveGenerationRef.current.isCurrent(operation)"),
        "stale judge saves are not generation-guarded",
      );
      assert(
        appSource.includes("clearDraftCache"),
        "drafts from a prior session are not cleared",
      );
    },
  );

  await check(
    "judge scoring surface retains the professional keypad and viewport positioning",
    async () => {
      assert(
        appSource.includes("visualViewport"),
        "scoring keypad does not react to the visual viewport",
      );
      assert(
        appSource.includes("assignmentRevision"),
        "judge writes do not carry the assignment revision",
      );
      assert(
        appSource.includes("backspace"),
        "keypad backspace support is missing",
      );
      assert(
        appSource.includes("score-pad-collapse-button"),
        "keypad collapse control is missing",
      );
      assert(
        appSource.includes("score-pad-expand-button") &&
          appSource.includes("expandKeypad"),
        "keypad manual expand control is missing",
      );
      assert(
        appSource.includes("data-score-field"),
        "score input is not a dedicated tap target",
      );
      assert(
        !appSource.includes("score-row-hitbox"),
        "score rows must not retain a full-row tap target",
      );
      assert(
        appSource.includes("beginKeypadDismiss") &&
          appSource.includes("Math.hypot"),
        "outside taps do not safely collapse the keypad",
      );
      assert(
        stylesSource.includes("prefers-reduced-motion"),
        "reduced-motion handling is missing",
      );
    },
  );

  await check(
    "public display remains a controlled, read-only projection consumer",
    async () => {
      const scoreboardStart = appSource.indexOf("function ScoreboardPage");
      const appStart = appSource.indexOf(
        "export function App",
        scoreboardStart,
      );
      assert(
        scoreboardStart >= 0 && appStart > scoreboardStart,
        "scoreboard component is missing",
      );
      const scoreboardSource = appSource.slice(scoreboardStart, appStart);
      assert(
        !scoreboardSource.includes("/api/state"),
        "scoreboard must not consume the administrator state endpoint",
      );
      assert(
        scoreboardSource.includes("/api/scoreboard"),
        "scoreboard does not consume its read-only endpoint",
      );
      assert(
        scoreboardSource.includes("teamId") &&
          scoreboardSource.includes("history.replaceState") &&
          scoreboardSource.includes("ArrowLeft") &&
          scoreboardSource.includes("ArrowRight"),
        "scoreboard team selection and keyboard navigation contract is missing",
      );
      assert(
        scoreboardSource.includes("teamOptions") &&
          scoreboardSource.includes("orderLabel"),
        "scoreboard does not expose appearance-order team selection",
      );
      assert(
        scoreboardSource.includes("summary.anonymousScores ?? []") &&
          !appSource.includes("shuffledScores"),
        "scoreboard judge cards must preserve the server-provided account order",
      );
    },
  );

  await check(
    "server composition keeps assignment, display, account, audit, and storage boundaries",
    async () => {
      [
        '"./shared/contestData.js"',
        "activeAssignment",
        "displaySelection",
        "judgeRoster",
        "assignmentRevision",
        "serverRevision",
        "createSessionService",
        "createStateStore",
        "createHttpRoutes",
        "createSessionApiRoutes",
        "createContestApiRoutes",
        "createContestStorage",
      ].forEach((contract) =>
        assert(
          serverSource.includes(contract),
          `server contract is missing: ${contract}`,
        ),
      );
      assert(
        !serverSource.includes('"./src/'),
        "server must not import runtime rules from src",
      );
      assert(
        authSource.includes("hashPassword") &&
          authSource.includes("timingSafeEqual") &&
          authSource.includes("token_hash"),
        "password, session hashing, or timing-safe comparison is missing",
      );
      assert(
        authSource.includes("headersDistinct") &&
          authSource.includes("assertQueuedSession"),
        "session header and queued-session checks are missing",
      );
      assert(
        stateStoreSource.includes("let writeQueue") &&
          stateStoreSource.includes("assertQueuedSession"),
        "single queued state write is missing",
      );
      assert(
        httpRoutesSource.includes("readJsonBody") &&
          httpRoutesSource.includes("serveStatic"),
        "HTTP input and static routing are missing",
      );
      assert(
        sessionApiRoutesSource.includes('"/api/login"') &&
          sessionApiRoutesSource.includes('"/api/state"') &&
          sessionApiRoutesSource.includes("checkStorageHealth"),
        "session API routes are missing",
      );
      assert(
        contestApiRoutesSource.includes("applyContestControl") &&
          contestApiRoutesSource.includes('"/api/entries/"') &&
          contestApiRoutesSource.includes("itemScores") &&
          contestApiRoutesSource.includes("changedScores"),
        "contest write routes or entry audit details are missing",
      );
      assert(
        contestStorageSource.includes("withMysqlConsistentSnapshot") &&
          contestStorageSource.includes("writeMysqlMutation") &&
          contestStorageSource.includes("account_sessions") &&
          contestStorageSource.includes("FOREIGN KEY"),
        "storage adapter is missing transaction, session-table, mutation, or relationship handling",
      );
      assert(
        !contestStorageSource.includes("writeQueue"),
        "storage adapter must not create a second write queue",
      );
    },
  );

  await check("server modules parse", async () =>
    Promise.all(
      [
        "contest-server.mjs",
        "server/auth-session.mjs",
        "server/state-store.mjs",
        "server/http-routes.mjs",
        "server/session-api-routes.mjs",
        "server/contest-api-routes.mjs",
        "server/storage/contest-storage.mjs",
        "server/mysql-transaction.mjs",
      ].map((file) => run(process.execPath, ["--check", file])),
    ),
  );
  await check("shared scoring and competition-control contracts", async () =>
    run(process.execPath, [
      "--test",
      "test/scoringRules.test.mjs",
      "test/appScoringImport.test.mjs",
      "test/contestControl.test.mjs",
      "test/stateStore.test.mjs",
      "test/httpRoutes.test.mjs",
      "test/sessionApiRoutes.test.mjs",
      "test/contestStorage.test.mjs",
      "test/mysqlTransaction.test.mjs",
      "test/sessionWorkGeneration.test.mjs",
    ]),
  );
  await check("state transfer tools parse", async () =>
    run(process.execPath, [
      "--check",
      "scripts/competition-state-transfer.mjs",
    ]).then(() =>
      Promise.all([
        run(process.execPath, ["--check", "scripts/import-state-to-mysql.mjs"]),
        run(process.execPath, ["--check", "scripts/docker-smoke.mjs"]),
      ]),
    ),
  );
  await check("state transfer source dry run", async () =>
    run(process.execPath, ["scripts/import-state-to-mysql.mjs", "--dry-run"]),
  );
  await check("administrator control regression", async () =>
    run(process.execPath, ["scripts/admin-control-regression.mjs"]),
  );
  await check("team management regression", async () =>
    run(process.execPath, ["scripts/admin-edit-regression.mjs"]),
  );

  console.log(`daily inspection passed (${checks.length} checks)`);
  checks.forEach((name) => console.log(`- ${name}`));
}

await main();
