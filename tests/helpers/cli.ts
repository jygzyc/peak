import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

/** Runs `dist/cli.js` with the given args and collects its output. */
export function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr })));
}

/** Extracts the Web URL a `serve` run prints to stdout. */
export function webUrl(output: string): string {
  const match = output.match(/\[peak] web: (http:\/\/\S+)/);
  assert.ok(match, `missing Web URL in output: ${output}`);
  return match[1]!;
}

/** Runs `peak stop` against a Peak home; optionally asserts success. */
export function stopServer(peakHome: string, required = true): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, ["dist/cli.js", "stop", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
  if (required) assert.equal(result.status, 0, result.stderr);
  return result;
}
