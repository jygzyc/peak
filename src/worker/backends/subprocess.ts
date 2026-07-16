/**
 * Shared subprocess execution helper for command-style agent backends.
 *
 * Handles process spawning, stdin/prompt delivery, timeout handling, stdout and
 * stderr capture, and common result shaping so individual backend adapters stay
 * small.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";
import type { WorkerConfig } from "../../agent/types.js";
import type { AgentBackend, BackendInvokeInput, BackendInvokeResult } from "./types.js";

const SPAWN_ERROR_RETURNCODE = 127;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_500;

/** Options passed to buildArgv for session resume and conclude-phase calls. */
export interface BuildArgvOptions {
  sessionId?: string;
  conclude?: boolean;
}

export abstract class SubprocessBackend implements AgentBackend {
  abstract readonly id: string;

  abstract buildArgv(config: WorkerConfig, prompt: string, opts?: BuildArgvOptions): { argv: string[]; env?: Record<string, string>; input?: string };

  /** Subclasses override to extract a reusable session id from worker output. */
  extractSession(_stdout: string, _stderr: string): string | undefined {
    return undefined;
  }

  /**
   * Default: the response text IS stdout. CLI backends that emit the assistant
   * response directly (codex, claude) use this. Backends with structured output
   * (opencode --format json) override to parse NDJSON events.
   */
  extractResponseText(stdout: string, _stderr: string): string {
    return stdout;
  }

  invoke(input: BackendInvokeInput): Promise<BackendInvokeResult> {
    const built = this.buildArgv(input.config, input.prompt, { sessionId: input.sessionId, conclude: input.conclude });
    const timeoutMs = input.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (input.signal?.aborted) {
      return Promise.resolve({
        text: "",
        returncode: SPAWN_ERROR_RETURNCODE,
        stderr: "worker cancelled before start",
        aborted: true,
      });
    }

    return new Promise((resolve) => {
      const cwd = input.cwd ?? process.cwd();
      const invocation = resolveSpawnInvocation(built.argv[0], built.argv.slice(1), cwd);
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        stdio: built.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(built.env ?? {}), PEAK_AGENT_ACTIVE: "1" },
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

      let stdoutLen = 0;
      let stderrLen = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let aborted = false;
      let outputLimitExceeded = false;
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;

      const forceKill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === "win32" && child.pid) {
          // child.kill() does not reliably terminate descendants of .cmd
          // shims. taskkill is invoked directly (never through a shell) and
          // receives only the numeric pid created by Node.
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
              shell: false,
            });
            killer.unref();
          } catch { /* process may already have exited */ }
          return;
        }
        try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
      };

      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === "win32" && child.pid) {
          // Windows has no reliable SIGTERM/process-group equivalent for npm
          // shims. Kill the tree immediately so a short-lived cmd.exe cannot
          // exit first and orphan its actual agent child.
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
              shell: false,
            });
            killer.unref();
          } catch { /* process may already have exited */ }
          return;
        }
        try { child.kill("SIGTERM"); } catch { /* process may already have exited */ }
        if (!forceTimer) {
          forceTimer = setTimeout(forceKill, TERMINATION_GRACE_MS);
          forceTimer.unref?.();
        }
      };

      const onAbort = () => {
        aborted = true;
        terminate();
      };

      const finish = (result: BackendInvokeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        input.signal?.removeEventListener("abort", onAbort);
        try { child.removeAllListeners(); } catch { /* */ }
        resolve(result);
      };

      input.signal?.addEventListener("abort", onAbort, { once: true });

      if (built.input !== undefined && child.stdin) {
        child.stdin.on("error", () => { /* worker may exit before stdin drains */ });
        child.stdin.write(built.input);
        child.stdin.end();
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutLen += chunk.length;
        if (stdoutLen > MAX_STDOUT_BYTES) {
          outputLimitExceeded = true;
          terminate();
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrLen += chunk.length;
        if (stderrLen <= MAX_STDOUT_BYTES) {
          stderrChunks.push(chunk);
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timer.unref?.();

      child.on("error", (err) => {
        finish({
          text: "",
          returncode: SPAWN_ERROR_RETURNCODE,
          stderr: aborted ? "worker cancelled" : err.message,
          aborted: aborted || undefined,
        });
      });

      child.on("close", (code, signal) => {
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const sessionId = this.extractSession?.(rawStdout, stderr) ?? input.sessionId;
        const text = this.extractResponseText(rawStdout, stderr);
        if (aborted || timedOut || outputLimitExceeded || (signal && code === null)) {
          finish({
            text,
            returncode: SPAWN_ERROR_RETURNCODE,
            stderr: aborted
              ? "worker cancelled"
              : timedOut
                ? `worker timed out after ${timeoutMs}ms`
                : outputLimitExceeded
                  ? `worker output exceeded ${MAX_STDOUT_BYTES} bytes`
                  : `worker terminated by signal ${signal}`,
            sessionId,
            timedOut: timedOut || undefined,
            aborted: aborted || undefined,
          });
          return;
        }
        finish({
          text,
          returncode: code ?? SPAWN_ERROR_RETURNCODE,
          stderr,
          sessionId,
        });
      });
    });
  }
}

export interface SpawnInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/** Resolve npm Windows shims without enabling Node's broad `shell:true` mode.
 * Native executables remain direct child processes. Only a command that
 * resolves to a trusted local `.cmd`/`.bat` file is wrapped by `cmd.exe`; all
 * dynamic prompt content remains on stdin and never enters this command line. */
export function resolveSpawnInvocation(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnInvocation {
  if (platform !== "win32") return { command, args };
  const resolved = resolveWindowsExecutable(command, cwd, env);
  if (!resolved || !/\.(?:cmd|bat)$/i.test(resolved)) {
    return { command: resolved ?? command, args };
  }
  const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  const commandLine = [resolved, ...args].map(quoteCmdArgument).join(" ");
  return {
    command: comspec,
    // `/s /c` requires an outer quote pair when the executable path itself is
    // quoted; otherwise cmd strips the wrong pair and treats the quote as part
    // of the command name.
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const extensions = extname(command)
    ? [""]
    : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const containsPath = isAbsolute(command) || /[\\/]/.test(command);
  const bases = containsPath
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (env.PATH ?? env.Path ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((entry) => resolve(entry, command));
  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = base + extension;
      if (existsSync(candidate)) return candidate;
      const lower = base + extension.toLowerCase();
      if (lower !== candidate && existsSync(lower)) return lower;
    }
  }
  return undefined;
}

function quoteCmdArgument(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) return value;
  // Windows CommandLineToArgvW-compatible quoting. cmd metacharacters remain
  // escaped for cmd's outer `/c` parse; delayed expansion is not enabled.
  const quoted = `"${value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1")}"`;
  return quoted.replace(/[&|<>()^]/g, "^$&");
}
