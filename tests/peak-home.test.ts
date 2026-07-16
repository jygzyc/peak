import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  peakHome,
  peakPath,
  agentsDir,
  tasksDir,
  sessionsDir,
  providersFile,
  configFile,
  ensurePeakLayout,
  agentFile,
  taskFile,
} from "../dist/config/peak-home.js";

/**
 * Peak home layout tests. All use a temporary PEAK_HOME so they never touch the
 * real ~/.peak.
 */

function withTempHome<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "peak-home-"));
  const prev = process.env.PEAK_HOME;
  process.env.PEAK_HOME = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PEAK_HOME;
    else process.env.PEAK_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("peakHome: honors PEAK_HOME env override", () => {
  withTempHome(() => {
    const home = peakHome();
    assert.equal(home, process.env.PEAK_HOME);
  });
});

test("peakHome: defaults to ~/.peak when PEAK_HOME unset", () => {
  const prev = process.env.PEAK_HOME;
  delete process.env.PEAK_HOME;
  try {
    const home = peakHome();
    assert.ok(home.endsWith(join(".peak")) || home.endsWith(".peak"), `expected ~/.peak, got ${home}`);
  } finally {
    if (prev !== undefined) process.env.PEAK_HOME = prev;
  }
});

test("peakPath: joins segments under home", () => {
  withTempHome(() => {
    const p = peakPath("agents", "foo.json");
    assert.equal(p, join(process.env.PEAK_HOME!, "agents", "foo.json"));
  });
});

test("layout dirs: agents/tasks/sessions/providers resolve under home", () => {
  withTempHome(() => {
    const home = process.env.PEAK_HOME!;
    assert.equal(agentsDir(), join(home, "agents"));
    assert.equal(tasksDir(), join(home, "tasks"));
    assert.equal(sessionsDir(), join(home, "sessions"));
    assert.equal(providersFile(), join(home, "providers.json"));
    assert.equal(configFile(), join(home, "config.json"));
  });
});

test("agentFile/taskFile: build named config paths", () => {
  withTempHome(() => {
    const home = process.env.PEAK_HOME!;
    assert.equal(agentFile("android-source-finder"), join(home, "agents", "android-source-finder.json"));
    assert.equal(taskFile("app-audit"), join(home, "tasks", "app-audit.json"));
  });
});

test("agentFile/taskFile: reject names that escape their config directory", () => {
  withTempHome(() => {
    for (const name of ["../outside", "nested/name", "nested\\name", "..", " leading"]) {
      assert.throws(() => agentFile(name), /must not contain a path|must contain only/);
      assert.throws(() => taskFile(name), /must not contain a path|must contain only/);
    }
  });
});

test("ensurePeakLayout: creates agents/tasks/sessions idempotently", () => {
  withTempHome(() => {
    const home = process.env.PEAK_HOME!;
    assert.ok(!existsSync(join(home, "agents")));
    ensurePeakLayout();
    for (const sub of ["agents", "tasks", "sessions"]) {
      assert.ok(existsSync(join(home, sub)), `${sub} should exist after ensurePeakLayout`);
    }
    // Idempotent: running again must not throw.
    ensurePeakLayout();
    for (const sub of ["agents", "tasks", "sessions"]) {
      assert.ok(existsSync(join(home, sub)));
    }
  });
});
