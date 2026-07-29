import { spawn } from "node:child_process";
import type { ProcessResult, ProcessSpec } from "./types.js";

const MAX_OUTPUT = 10 * 1024 * 1024;

export class ProcessRunner {
  run(spec: ProcessSpec, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    if (signal?.aborted) return Promise.resolve(result(false, "", "cancelled", 1, false, true));
    return new Promise((resolve) => {
      const child = spawn(...launchTarget(spec.argv), {
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

/**
 * Returns the `[command, args]` tuple for spawning a worker CLI.
 *
 * On Windows, npm-installed CLIs ship as `.cmd` batch shims that Node cannot
 * exec directly (`spawn ... EINVAL`/`ENOENT`). They must be driven through
 * `cmd.exe`, which resolves the shim via PATHEXT. We invoke cmd.exe ourselves
 * (instead of `spawn(..., { shell: true })`) so we fully own argument quoting
 * and never pass unescaped args to a shell; argv is trusted Board config and
 * the prompt is always piped via stdin, never placed on the command line.
 * Unix stays shell-less so detached process-group kills keep working.
 */
function launchTarget(argv: string[]): [string, string[]] {
  if (process.platform !== "win32") return [argv[0]!, argv.slice(1)];
  const line = argv.map(quoteWindowsArg).join(" ");
  return [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line]];
}

/** Quotes a single argv element for the Windows CRT (CommandLineToArgvW). */
function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (let i = 0; i < arg.length; i += 1) {
    const ch = arg[i]!;
    if (ch === "\\") slashes += 1;
    else if (ch === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; }
    else { out += "\\".repeat(slashes) + ch; slashes = 0; }
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}
