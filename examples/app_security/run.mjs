#!/usr/bin/env node
/**
 * 一键真实启动 Peak（个人使用，不属于 npm test 流程）。不需要任何参数。
 *
 * 流程：
 *   1. 在当前目录新建 .peak_test 作为测试根目录（先清理旧内容）；
 *   2. 把 examples/ai_agent_zh 的中文测试项目复制到 .peak_test；
 *   3. 独立启动 Server，再连接该 Server 启动后台 Dispatch；
 *      所有 Project 数据隔离在 .peak_test 下，可用 peak status/stop 管理。
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
function spawnPeak(args, stdio = "inherit") {
  if (process.platform !== "win32") {
    return spawn("peak", args, { cwd, env: process.env, stdio });
  }
  const quote = (arg) => (arg.includes(" ") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  const line = ["peak", ...args].map(quote).join(" ");
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], { cwd, env: process.env, stdio });
}

async function runPeak(args) {
  const child = spawnPeak(args, ["ignore", "pipe", "pipe"]);
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { stderr += chunk; process.stderr.write(chunk); });
  const code = await new Promise(resolve => child.once("exit", resolve));
  if (code !== 0) throw new Error(`peak ${args[0]} failed (${code}): ${stderr}`);
  return stdout;
}

const served = await runPeak(["serve", "--peak-home", testRoot, "--port", "0"]);
const graphUrl = served.match(/\[peak] web: (http:\/\/\S+)/)?.[1];
if (!graphUrl) throw new Error("peak serve did not report its Graph URL");
await runPeak(["start", testRoot, "--peak-home", testRoot, "--graph-url", graphUrl]);
