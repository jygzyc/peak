import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { containerCli, containerGraphUrl, DockerImageUnavailableError, dockerRunArgs, dockerSkillMounts, peakTaskImage, remoteTaskImage, requireDocker, taskContainerName } from "../dist/utils/docker.js";

test("container names and image tags are deterministic", () => {
  const digest = createHash("sha256").update("board-a", "utf8").digest("hex").slice(0, 6);
  assert.equal(taskContainerName("board-a"), `peak_${digest}`);
  assert.match(taskContainerName("另一个任务"), /^peak_[0-9a-f]{6}$/);
  assert.equal(peakTaskImage("0.1.2"), "peak-task:0.1.2");
});

test("the container CLI honors PEAK_CONTAINER_RUNTIME and otherwise prefers docker with podman fallback", () => {
  const previous = process.env.PEAK_CONTAINER_RUNTIME;
  try {
    process.env.PEAK_CONTAINER_RUNTIME = "podman";
    assert.equal(containerCli(), "podman");
    process.env.PEAK_CONTAINER_RUNTIME = " /custom/docker ";
    assert.equal(containerCli(), "/custom/docker");
    delete process.env.PEAK_CONTAINER_RUNTIME;
    const available = (name: string): boolean => {
      const probe = spawnSync(name, ["--version"], { stdio: "ignore" });
      return !probe.error && probe.status === 0;
    };
    assert.equal(containerCli(), available("docker") ? "docker" : available("podman") ? "podman" : "docker");
  } finally {
    if (previous === undefined) delete process.env.PEAK_CONTAINER_RUNTIME;
    else process.env.PEAK_CONTAINER_RUNTIME = previous;
  }
});

test("the registry image tag defaults to docker.io and honors PEAK_IMAGE_REPO", () => {
  const previous = process.env.PEAK_IMAGE_REPO;
  try {
    delete process.env.PEAK_IMAGE_REPO;
    assert.equal(remoteTaskImage("0.1.2"), "jygzyc/peak-task:0.1.2");
    process.env.PEAK_IMAGE_REPO = "registry.example.com/team/peak-task";
    assert.equal(remoteTaskImage("0.1.2"), "registry.example.com/team/peak-task:0.1.2");
  } finally {
    if (previous === undefined) delete process.env.PEAK_IMAGE_REPO;
    else process.env.PEAK_IMAGE_REPO = previous;
  }
});

test("an unavailable image points at local mode so run --docker can fall back", () => {
  const error = new DockerImageUnavailableError("peak-task:0.1.2");
  assert.equal(error.name, "DockerImageUnavailableError");
  assert.equal(error.image, "peak-task:0.1.2");
  assert.match(error.message, /pull failed/);
  assert.match(error.message, /without --docker/);
});

test("loopback serve URLs are rewritten for container reachability", () => {
  assert.equal(containerGraphUrl("http://127.0.0.1:8000"), "http://host.docker.internal:8000");
  assert.equal(containerGraphUrl("http://localhost:8123"), "http://host.docker.internal:8123");
  assert.equal(containerGraphUrl("http://192.168.1.10:8000"), "http://192.168.1.10:8000");
});

test("docker run argv makes only Project .tmp mounts writable", () => {
  const args = dockerRunArgs({
    name: "peak_a1b2c3",
    image: "peak-task:0.1.2",
    projectIds: ["uuid-1", "uuid-2"],
    projectsRoot: "/data/peak/projects",
    boardDir: "/path/to/board-a",
    graphUrl: "http://127.0.0.1:8000",
    credentialMounts: [["/home/u/.claude", "/root/.claude"]],
    skillMounts: [["/path/to/board-a/skills/review", "/root/.agents/skills/review"]],
    preflightBackends: ["codex"],
  });
  assert.deepEqual(args, [
    "run", "-d", "--rm", "--read-only", "--name", "peak_a1b2c3",
    "-v", "/data/peak/projects/uuid-1:/peak/projects/uuid-1:ro",
    "-v", "/data/peak/projects/uuid-1/.tmp:/peak/projects/uuid-1/.tmp:rw",
    "-v", "/data/peak/projects/uuid-2:/peak/projects/uuid-2:ro",
    "-v", "/data/peak/projects/uuid-2/.tmp:/peak/projects/uuid-2/.tmp:rw",
    "-v", "/path/to/board-a:/board:ro",
    "-v", "/home/u/.claude:/root/.claude:ro",
    "-v", "/path/to/board-a/skills/review:/root/.agents/skills/review:ro",
    "-e", "PEAK_PREFLIGHT_BACKENDS=codex",
    "--add-host", "host.docker.internal:host-gateway",
    "peak-task:0.1.2",
    "start", "/board", "--foreground", "--attach-only",
    "--graph-url", "http://host.docker.internal:8000",
    "--projects-root", "/peak/projects",
    "--no-install-skills",
  ]);
  // The host root itself is never mounted, and no host env is ever scanned or forwarded.
  assert.equal(args.some((arg) => arg === "/data/peak:/peak"), false);
  assert.equal(args.some((arg) => /API_KEY|AUTH_TOKEN|BASE_URL/.test(arg)), false);
});

test("Docker overlays Board-local Skills read-only and never installs inside the container", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-docker-skills-"));
  const taskDir = join(root, "task");
  mkdirSync(join(taskDir, "skills", "review"), { recursive: true });
  writeFileSync(join(taskDir, "skills", "review", "SKILL.md"), "# Review\n");
  try {
    const mounts = dockerSkillMounts({
      configPath: join(taskDir, "task.json"),
      taskDir,
      board: { skills: ["review"], projects: [{ source: "s", goal: "g" }] },
      workers: {
        plan: { type: "opencode", taskTypes: ["plan"], maxRunning: 1, priority: 0, env: {} },
        execute: { type: "claude-code", taskTypes: ["execute"], maxRunning: 1, priority: 0, env: {} },
      },
      scheduler: { maxRunningProjects: 1, intervalMs: 1_000 },
      phase: { plan: {}, supervise: { intervalMs: 60_000 }, execute: { maxArtifactBytes: 1024, customProfile: [] } },
    });
    assert.deepEqual(mounts.map(([, target]) => target).sort(), [
      "/root/.agents/skills/review",
      "/root/.claude/skills/review",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo container assets are plain files with the expected content", () => {
  for (const name of ["Dockerfile", "entrypoint.sh", "docker-compose.yaml", "AUTH.md"]) {
    assert.ok(existsSync(join("container", name)), `container/${name} exists`);
  }
  assert.match(readFileSync(join("container", "Dockerfile"), "utf8"), /^FROM node:/m);
  assert.match(readFileSync(join("container", "entrypoint.sh"), "utf8"), /^#!\/bin\/bash/);
});

test("entrypoint.sh is valid bash", () => {
  const bash = spawnSync("bash", ["-n", join("container", "entrypoint.sh")], { encoding: "utf8" });
  if (bash.error) return; // no bash on this host; syntax is covered by review
  assert.equal(bash.status, 0, bash.stderr);
});

test("container engine absence produces a readable error with a local-mode fallback hint", () => {
  const probe = spawnSync(containerCli(), ["info"], { stdio: "ignore" });
  if (probe.status === 0 && !probe.error) return; // engine available here; error path not applicable
  assert.throws(() => requireDocker(), /CLI or its engine is not available/);
});

test("peak start --docker fails fast with a readable error when no container engine is available", async () => {
  const probe = spawnSync(containerCli(), ["info"], { stdio: "ignore" });
  if (probe.status === 0 && !probe.error) return; // engine available here
  const root = mkdtempSync(join(tmpdir(), "peak-docker-cli-"));
  const taskDir = join(root, "task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    board: { name: "dockerless", projects: [{ id: "", source: "s", goal: "g" }] },
    workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
  }));
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [
        "dist/cli.js", "start", taskDir, "--docker", "--peak-home", join(root, "peak-home"),
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("exit", (code) => resolve({ code, stderr }));
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /CLI or its engine is not available/);
    assert.match(result.stderr, /local mode/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
