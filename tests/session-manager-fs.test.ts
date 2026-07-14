import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../dist/session/session-manager.js";

/**
 * Regression tests for filesystem SessionManager path safety
 * (docs 04-session.md §4.5 / 09-config.md §9.7).
 *
 * Previously `sessionDir = join(baseDir, sessionId)` performed no sanitization,
 * so a sessionId containing `../` could escape the session root — letting
 * open() create and delete() rmSync directories outside baseDir.
 */

test("SessionManager: sanitizes a traversal sessionId so sessionDir stays under baseDir", () => {
  const base = mkdtempSync(join(tmpdir(), "peak-smfs-"));
  try {
    const sm = new SessionManager(base);
    const dir = sm.sessionDir("../evil");
    // The resolved directory must be inside base, never its parent.
    assert.ok(
      dir === base || dir.startsWith(base + "\\") || dir.startsWith(base + "/"),
      `sessionDir escaped base: ${dir} (base=${base})`,
    );
    assert.ok(!dir.includes(".."), `sanitized dir must not contain "..": ${dir}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("SessionManager: open with a traversal id does NOT create a dir outside baseDir", () => {
  const base = mkdtempSync(join(tmpdir(), "peak-smfs-"));
  try {
    const sm = new SessionManager(base);
    const g = sm.open("../escape-attempt");
    try {
      const sanitizedDir = sm.sessionDir("../escape-attempt");
      // The created db lives under base (sanitized), never beside/above it.
      assert.ok(
        sanitizedDir === base || sanitizedDir.startsWith(base + "\\") || sanitizedDir.startsWith(base + "/"),
        `created dir must stay under baseDir: ${sanitizedDir}`,
      );
      assert.ok(existsSync(join(sanitizedDir, "analysis.db")), "db created under sanitized dir");
      // No file should appear in the parent directory next to base.
      assert.ok(!existsSync(join(base, "..", "escape-attempt", "analysis.db")),
        "open() must NOT create files outside baseDir");
    } finally {
      g.close();
      // Clean up the sanitized dir under base.
      sm.delete("../escape-attempt");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("SessionManager: delete with a traversal id does NOT remove anything outside baseDir", () => {
  const base = mkdtempSync(join(tmpdir(), "peak-smfs-"));
  // Plant a sentinel directory BESIDE base that a buggy delete would remove.
  const sibling = mkdtempSync(join(tmpdir(), "peak-smfs-sibling-"));
  try {
    const sm = new SessionManager(base);
    // Even if an attacker passes ../sibling-..., delete must not reach it.
    sm.delete(`../${sibling.split(/[\\/]/).pop()}`);
    assert.ok(existsSync(sibling), "sibling directory outside baseDir must survive delete()");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test("SessionManager: normal session names still work end-to-end", () => {
  const base = mkdtempSync(join(tmpdir(), "peak-smfs-"));
  try {
    const sm = new SessionManager(base);
    const g = sm.open("normal-session");
    g.close();
    assert.ok(sm.info("normal-session").exists);
    assert.ok(sm.listSessions().includes("normal-session"));
    sm.delete("normal-session");
    assert.ok(!sm.info("normal-session").exists);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
