/**
 * Shared subprocess execution helper for command-style agent backends.
 *
 * Handles process spawning, stdin/prompt delivery, timeout handling, stdout and
 * stderr capture, and common result shaping so individual backend adapters stay
 * small.
 */

import { spawn } from "node:child_process";
import type { WorkerConfig } from "../../agent/types.js";
import type { AgentBackend, BackendInvokeInput, BackendInvokeResult } from "./types.js";

const SPAWN_ERROR_RETURNCODE = 127;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

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

    return new Promise((resolve) => {
      // Windows: npm-installed CLIs are .cmd shims that require shell:true to
      // spawn. Node quotes the argv array even in shell mode, so prompt args
      // with special chars are preserved (the DEP0190 warning is theoretical).
      const child = spawn(built.argv[0], built.argv.slice(1), {
        cwd: input.cwd ?? process.cwd(),
        stdio: built.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(built.env ?? {}), PEAK_AGENT_ACTIVE: "1" },
        shell: process.platform === "win32",
      });

      let stdoutLen = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      const finish = (result: BackendInvokeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.removeAllListeners(); } catch { /* */ }
        resolve(result);
      };

      if (built.input && child.stdin) {
        child.stdin.write(built.input);
        child.stdin.end();
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutLen += chunk.length;
        if (stdoutLen > MAX_STDOUT_BYTES) {
          try { child.kill("SIGTERM"); } catch { /* */ }
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrChunks.reduce((a, c) => a + c.length, 0) < MAX_STDOUT_BYTES) {
          stderrChunks.push(chunk);
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* */ }
      }, timeoutMs);

      child.on("error", (err) => {
        finish({ text: "", returncode: SPAWN_ERROR_RETURNCODE, stderr: err.message });
      });

      child.on("close", (code, signal) => {
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const sessionId = this.extractSession?.(rawStdout, stderr) ?? input.sessionId;
        const text = this.extractResponseText(rawStdout, stderr);
        if (timedOut || (signal && code === null)) {
          finish({
            text,
            returncode: SPAWN_ERROR_RETURNCODE,
            stderr: timedOut ? `worker timed out after ${timeoutMs}ms` : `worker terminated by signal ${signal}`,
            sessionId,
            timedOut: timedOut || undefined,
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
