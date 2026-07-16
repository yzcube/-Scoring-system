import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} failed with exit ${code}${output ? `:\n${output}` : ""}`));
    });
  });
}

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const payload = await response.json();
      if (response.ok && payload.storage === "file") return;
    } catch {
      // The container is still starting.
    }
    await delay(100);
  }
  throw new Error("Docker container did not become healthy in file storage mode");
}

async function waitForDockerHealth(container) {
  let lastStatus = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    lastStatus = (await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}", container], { capture: true })).trim();
    if (lastStatus === "healthy") return;
    if (lastStatus === "unhealthy") {
      const details = await run("docker", ["inspect", "--format", "{{json .State.Health}}", container], { capture: true, allowFailure: true });
      throw new Error(`Docker health check is unhealthy: ${details.trim()}`);
    }
    await delay(1000);
  }
  throw new Error(`Docker health check did not become healthy (last status: ${lastStatus || "unknown"})`);
}

async function main() {
  const suffix = `${process.pid}-${Date.now()}`;
  const image = `campus-final-scoring-smoke:${suffix}`;
  const container = `campus-final-scoring-smoke-${suffix}`;
  const hostPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${hostPort}`;
  let started = false;

  try {
    await run("docker", ["build", "--tag", image, "."]);
    await run("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--env",
      "CONTEST_STORAGE=file",
      "--env",
      "NODE_ENV=development",
      "--env",
      "CONTEST_DATA_DIR=/tmp/contest-data",
      "--env",
      "CONTEST_LOG_DIR=/tmp/contest-logs",
      "--env",
      "HOST=0.0.0.0",
      "--env",
      "PORT=8776",
      "--publish",
      `127.0.0.1:${hostPort}:8776`,
      image,
    ]);
    started = true;
    await waitForDockerHealth(container);
    await waitForHealth(baseUrl);
    const scoreboard = await fetch(`${baseUrl}/scoreboard`);
    assert(scoreboard.ok && (scoreboard.headers.get("content-type") ?? "").includes("text/html"), "Docker image did not serve the score display route");
    console.log("docker smoke test passed (build, startup, health, and score display route)");
  } finally {
    if (started) await run("docker", ["rm", "--force", container], { capture: true, allowFailure: true });
    await run("docker", ["image", "rm", "--force", image], { capture: true, allowFailure: true });
  }
}

await main();
