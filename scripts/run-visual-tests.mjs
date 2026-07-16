import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Visual test server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error("Visual test server did not become healthy");
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const testTargets = process.argv.slice(2);
if (testTargets.length > 1) throw new Error("Run one visual test target at a time so each spec receives isolated server state.");
const testTarget = testTargets[0] || "e2e/dynamicJudgeEnrollment.spec.mjs";
const dataDir = await mkdtemp(join(tmpdir(), "contest-visual-"));
const artifactDir = join(dataDir, "artifacts");
let server;
let completedSuccessfully = false;

try {
  await mkdir(artifactDir, { recursive: true });
  server = spawn(process.execPath, ["contest-server.mjs"], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "development", CONTEST_STORAGE: "file", CONTEST_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(baseUrl, server);
  const playwright = spawn(join(rootDir, "node_modules", ".bin", "playwright"), [
    "test",
    testTarget,
    "--workers=1",
    "--retries=0",
    "--trace=retain-on-failure",
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      VISUAL_BASE_URL: baseUrl,
      VISUAL_ARTIFACT_DIR: artifactDir,
      PLAYWRIGHT_OUTPUT_DIR: join(dataDir, "playwright-results"),
    },
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    playwright.once("error", reject);
    playwright.once("exit", resolveExit);
  });
  if (exitCode !== 0) process.exitCode = exitCode ?? 1;
  else completedSuccessfully = true;
} finally {
  await stop(server);
  if (completedSuccessfully) await rm(dataDir, { recursive: true, force: true });
  else console.error(`Visual test artifacts preserved at ${dataDir}`);
}
