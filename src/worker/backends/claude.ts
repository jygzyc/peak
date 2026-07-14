/**
 * Claude Code command backend.
 *
 * Translates a worker invocation into a claude-code CLI call with the prompt and
 * configured process options. Backend files should stay thin and delegate common
 * subprocess behavior to shared helpers.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { SubprocessBackend, type BuildArgvOptions } from "./subprocess.js";

const SESSION_RE = /session[: ]+([0-9a-fA-F-]{8,})/i;

export class ClaudeBackend extends SubprocessBackend {
  readonly id = "claude-code";

  buildArgv(config: WorkerConfig, prompt: string, opts?: BuildArgvOptions) {
    const argv = ["claude", "--dangerously-skip-permissions", "-p"];
    if (opts?.sessionId) argv.push("--resume", opts.sessionId);
    argv.push("--", prompt);
    return { argv, env: envFor(config) };
  }

  extractSession(stdout: string, stderr: string): string | undefined {
    const m = SESSION_RE.exec(stderr) ?? SESSION_RE.exec(stdout);
    return m ? m[1] : undefined;
  }
}

function envFor(config: WorkerConfig): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (config.model) env.ANTHROPIC_MODEL = config.model;
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  const keyEnv = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const key = process.env[keyEnv];
  if (key) env.ANTHROPIC_AUTH_TOKEN = key;
  return Object.keys(env).length > 0 ? env : undefined;
}
