import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/**
 * Removes a directory tree, falling back to PowerShell on Windows where a
 * just-stopped child process can keep files locked past the rmSync retries.
 */
export function removeTree(path: string): void {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    const removed = spawnSync("powershell.exe", ["-NoProfile", "-Command", "& { param([string]$target) Remove-Item -LiteralPath $target -Recurse -Force }", path], {
      encoding: "utf8",
    });
    assert.equal(removed.status, 0, removed.stderr);
  }
}

/** Creates a unique temp directory that is removed when the test finishes. */
export function makeTempDir(t: TestContext, prefix = "peak-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { removeTree(dir); });
  return dir;
}
