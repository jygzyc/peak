#!/usr/bin/env node
/**
 * 构建期脚本校验：对 scripts/*.mjs 逐个执行 `node --check`，
 * 并检查启动器等脚本引用的静态资源存在（打包一致性）。
 * 由 build.mjs 与 pack.mjs 调用；语法/引用问题在打包时失败，而不是运行期才暴露。
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
    process.stderr.write(`[check-scripts] 语法错误: scripts/${name}\n`);
    failed = true;
  }
}

// run-example.mjs 引用的静态资源必须在打包时存在
const required = [
  ["scripts/run-example.mjs 引用的中文示例", join(root, "examples", "ai_agent_zh", "task.json")],
  ["版本文件", join(root, "version")],
  ["发布日志", join(root, "RELEASE.md")],
];
for (const [label, path] of required) {
  if (!existsSync(path)) {
    process.stderr.write(`[check-scripts] ${label} 缺失: ${path}\n`);
    failed = true;
  }
}

// 版本一致性：根目录 version 文件是唯一版本来源，package.json 必须与其一致
const versionPath = join(root, "version");
if (existsSync(versionPath)) {
  const fileVersion = readFileSync(versionPath, "utf8").trim();
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (packageVersion !== fileVersion) {
    process.stderr.write(`[check-scripts] package.json version (${packageVersion}) 与 version 文件 (${fileVersion}) 不一致\n`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
