import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  peakHome,
  peakPath,
  sessionsDir,
  ensurePeakLayout,
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

test("layout dirs: sessions resolves under home", () => {
  withTempHome(() => {
    const home = process.env.PEAK_HOME!;
    assert.equal(sessionsDir(), join(home, "sessions"));
  });
});

test("ensurePeakLayout: creates only sessions idempotently", () => {
  withTempHome(() => {
    const home = process.env.PEAK_HOME!;
    assert.ok(!existsSync(join(home, "agents")));
    ensurePeakLayout();
    assert.ok(existsSync(join(home, "sessions")));
    assert.equal(existsSync(join(home, "agents")), false);
    // Idempotent: running again must not throw.
    ensurePeakLayout();
    assert.equal(existsSync(join(home, "tasks")), false);
    assert.ok(existsSync(join(home, "sessions")));
  });
});
