#!/usr/bin/env node
/**
 * 一键真实启动 Peak（个人使用，不属于 npm test 流程）。不需要任何参数。
 *
 * 流程：
 *   1. 在当前目录新建 .peak_test 作为测试根目录（先清理旧内容）；
 *   2. 把 examples/ai_agent_zh 的中文测试项目复制到 .peak_test；
 *   3. 直接运行安装版本的 peak（`peak start .peak_test --peak-home .peak_test`），
 *      所有 Project 数据隔离在 .peak_test 下；Server 在后台运行，可用 peak status/stop 管理。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const cwd = process.cwd();
const testRoot = join(cwd, ".peak_test");
const exampleDir = resolve(import.meta.dirname);

if (!existsSync(exampleDir)) {
  process.stderr.write(`[peak-launcher] 找不到示例项目: ${exampleDir}\n`);
  process.exit(1);
}

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(testRoot, { recursive: true });
cpSync(exampleDir, testRoot, { recursive: true });

process.stdout.write(`[peak-launcher] 测试根目录: ${testRoot}\n`);
process.stdout.write("[peak-launcher] 在后台启动安装版本的 peak ...\n");

// Windows 上 peak 是 .cmd shim，经 cmd.exe 解析（与 ProcessRunner 相同的引号处理）；
// POSIX 直接 spawn peak 可执行文件。
function spawnPeak(args) {
  if (process.platform !== "win32") {
    return spawn("peak", args, { cwd, env: process.env, stdio: "inherit" });
  }
  const quote = (arg) => (arg.includes(" ") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  const line = ["peak", ...args].map(quote).join(" ");
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], { cwd, env: process.env, stdio: "inherit" });
}

const child = spawnPeak(["start", testRoot, "--peak-home", testRoot]);
child.on("exit", (code) => process.exit(code ?? 1));
