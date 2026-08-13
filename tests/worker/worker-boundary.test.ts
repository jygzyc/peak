import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";

test("worker module owns its types and has no imports outside src/worker", () => {
  const workerRoot = resolve("src", "worker");
  const files = sourceFiles(workerRoot);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:TaskType|taskTypes|maxRunning|priority)\b/,
      `${relative(workerRoot, file)} contains config-layer routing metadata`,
    );
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(file), match[1]!);
      assert.equal(
        target === workerRoot || target.startsWith(`${workerRoot}\\`) || target.startsWith(`${workerRoot}/`),
        true,
        `${relative(workerRoot, file)} imports outside worker: ${match[1]}`,
      );
    }
  }
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}
