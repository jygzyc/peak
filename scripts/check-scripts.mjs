#!/usr/bin/env node
/**
 * Build-time script validation: runs `node --check` on each scripts/*.mjs,
 * and verifies the static assets required for packaging exist (packaging consistency).
 * Called by build.mjs and pack.mjs; syntax/reference errors fail the build instead
 * of surfacing at runtime.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let failed = false;

for (const name of readdirSync(join(root, "scripts")).filter((entry) => entry.endsWith(".mjs"))) {
  const result = spawnSync(process.execPath, ["--check", join(root, "scripts", name)], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`[check-scripts] syntax error: scripts/${name}\n`);
    failed = true;
  }
}

// Static assets required for packaging must exist.
const required = [
  ["version file", join(root, "version")],
  ["release notes", join(root, "RELEASE.md")],
];
for (const [label, path] of required) {
  if (!existsSync(path)) {
    process.stderr.write(`[check-scripts] ${label} missing: ${path}\n`);
    failed = true;
  }
}

// Version consistency: the root version file is the single source of truth; package.json must match it.
const versionPath = join(root, "version");
if (existsSync(versionPath)) {
  const fileVersion = readFileSync(versionPath, "utf8").trim();
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (packageVersion !== fileVersion) {
    process.stderr.write(`[check-scripts] package.json version (${packageVersion}) does not match the version file (${fileVersion})\n`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
