import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DockerBackend } from "../../dist/runtime/docker-backend.js";
import { containerCli, DockerImageUnavailableError, peakTaskImage, remoteTaskImage, requireDocker } from "../../dist/utils/docker.js";

test("the task image tag is peak-task:<version>", () => {
  assert.equal(peakTaskImage("0.1.2"), "peak-task:0.1.2");
});

test("DockerBackend assigns a distinct deterministic container to each Project", () => {
  const backend = new DockerBackend("peak-task:test", { mode: "docker" }, [], "docker");
  assert.equal(backend.containerName("11111111-1111-4111-8111-111111111111"), "peak_111111111111");
  assert.equal(backend.containerName("22222222-2222-4222-8222-222222222222"), "peak_222222222222");
  assert.notEqual(
    backend.containerName("11111111-1111-4111-8111-111111111111"),
    backend.containerName("22222222-2222-4222-8222-222222222222"),
  );
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

test("an unavailable image points at task-level local fallback", () => {
  const error = new DockerImageUnavailableError("peak-task:0.1.2");
  assert.equal(error.name, "DockerImageUnavailableError");
  assert.equal(error.image, "peak-task:0.1.2");
  assert.match(error.message, /pull failed/);
  assert.match(error.message, /execution\.mode local/);
});

test("repo container assets are plain files with the expected content", () => {
  for (const name of ["Dockerfile", "docker-compose.yaml", "AUTH.md"]) {
    assert.ok(existsSync(join("container", name)), `container/${name} exists`);
  }
  // The base is an ARG (mirror-swappable) whose default is the Kali image.
  const dockerfile = readFileSync(join("container", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG KALI_IMAGE=docker\.io\/kalilinux\/kali-last-release/m);
  assert.match(dockerfile, /^FROM \$\{KALI_IMAGE\}/m);
});

test("container analysis helpers and device bridge exist and are valid", () => {
  const scripts = ["adb-setup.sh", "frida-auto.sh"];
  const hooks = ["crypto-hook.js", "ssl-pinning-bypass.js", "root-bypass.js"];
  assert.ok(existsSync(join("container", "device-bridge.sh")), "container/device-bridge.sh exists");
  assert.match(readFileSync(join("container", "device-bridge.sh"), "utf8"), /^#!\/bin\/bash/);
  for (const name of scripts) {
    assert.ok(existsSync(join("container", "scripts", "bin", name)), `container/scripts/bin/${name} exists`);
  }
  for (const name of hooks) {
    assert.ok(existsSync(join("container", "scripts", "frida-hooks", name)), `container/scripts/frida-hooks/${name} exists`);
  }
  for (const name of ["device-bridge.sh", ...scripts.map((s) => `scripts/bin/${s}`)]) {
    const probe = spawnSync("bash", ["-n", join("container", name)], { encoding: "utf8" });
    if (probe.error) continue; // no bash on this host
    assert.equal(probe.status, 0, `${name}: ${probe.stderr}`);
  }
});

test("container engine absence produces a readable error with a local-mode fallback hint", () => {
  const probe = spawnSync(containerCli(), ["info"], { stdio: "ignore" });
  if (probe.status === 0 && !probe.error) return; // engine available here; error path not applicable
  assert.throws(() => requireDocker(), /CLI or its engine is not available/);
});

test("task.json docker execution falls back to local when no container engine is available", async () => {
  const probe = spawnSync(containerCli(), ["info"], { stdio: "ignore" });
  if (probe.status === 0 && !probe.error) return; // engine available here
  const root = mkdtempSync(join(tmpdir(), "peak-docker-cli-"));
  const taskDir = join(root, "task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    board: { name: "dockerless", projects: [{ id: "", source: "s", goal: "g" }] },
    execution: { mode: "docker" },
    workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
  }));
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [
        "dist/cli.js", "dispatch", taskDir, "--graph-url", "http://127.0.0.1:1", "--peak-home", join(root, "peak-home"),
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

test("peak image pull is explicit and fails instead of falling back when the container engine is unavailable", () => {
  const result = spawnSync(process.execPath, ["dist/cli.js", "image", "pull"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PEAK_CONTAINER_RUNTIME: "peak-missing-container-runtime" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLI or its engine is not available/);
  assert.doesNotMatch(result.stderr, /falling back to local mode/);
});

test("peak image pull exposes the force option", () => {
  const result = spawnSync(process.execPath, ["dist/cli.js", "image", "pull", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--force/);
});
