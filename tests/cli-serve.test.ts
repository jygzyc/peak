import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("peak serve keeps the Web UI available until SIGTERM", async () => {
  const peakHome = mkdtempSync(join(tmpdir(), "peak-serve-"));
  const child = spawn(process.execPath, ["dist/cli.js", "serve", "--peak-home", peakHome, "--port", "0"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const baseUrl = await outputUrl(child.stdout);
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Peak Graph/);
    assert.equal(child.exitCode, null);
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(peakHome, { recursive: true, force: true });
  }
});

function outputUrl(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for server URL: ${output}`)), 5_000);
    stream.on("data", (chunk: string) => {
      output += chunk;
      const match = output.match(/\[peak] web: (http:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]!);
    });
  });
}
