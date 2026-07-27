import { spawn } from "node:child_process";
import type { ProcessResult, ProcessSpec } from "./types.js";

const MAX_OUTPUT = 10 * 1024 * 1024;

export class ProcessRunner {
  run(spec: ProcessSpec, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    if (signal?.aborted) return Promise.resolve(result(false, "", "cancelled", 1, false, true));
    return new Promise((resolve) => {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd, env: { ...process.env, ...spec.env, PEAK_AGENT_ACTIVE: "1" },
        stdio: [spec.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32", windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputExceeded = false;
      let timedOut = false;
      let cancelled = false;
      let started = false;
      let settled = false;
      const kill = (): void => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref(); }
          catch { /* exited */ }
          return;
        }
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
      };
      const finish = (returncode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(result(started, Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8"), returncode, timedOut, cancelled));
      };
      const abort = (): void => { cancelled = true; kill(); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      child.once("spawn", () => { started = true; });
      child.once("error", (error) => { stderr.push(Buffer.from(error.message)); finish(127); });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT) { outputExceeded = true; kill(); }
        else stdout.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_OUTPUT) stderr.push(chunk);
      });
      child.once("close", (code) => finish(timedOut || cancelled || outputExceeded ? 1 : code ?? 1));
      if (spec.input !== undefined) child.stdin?.end(spec.input);
    });
  }
}

function result(started: boolean, stdout: string, stderr: string, returncode: number, timedOut: boolean, cancelled: boolean): ProcessResult {
  return { started, stdout, stderr, returncode, timedOut, cancelled };
}
