/**
 * Claude Code command backend.
 *
 * Translates a worker invocation into a claude-code CLI call with the prompt and
 * configured process options. Backend files should stay thin and delegate common
 * subprocess behavior to shared helpers.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { SubprocessBackend, type BuildArgvOptions } from "./subprocess.js";

export class ClaudeBackend extends SubprocessBackend {
  readonly id = "claude-code";

  buildArgv(config: WorkerConfig, prompt: string, opts?: BuildArgvOptions) {
    const argv = ["claude", "--dangerously-skip-permissions", "-p", "--output-format", "json"];
    if (opts?.sessionId) argv.push("--resume", opts.sessionId);
    // Keep task/prompt content off argv. This avoids command-line disclosure,
    // Windows quoting limits, and accidental shell interpretation.
    return { argv, env: envFor(config), input: prompt };
  }

  extractSession(stdout: string, _stderr: string): string | undefined {
    const result = parseResult(stdout);
    return typeof result?.session_id === "string" ? result.session_id : undefined;
  }

  extractResponseText(stdout: string, _stderr: string): string {
    const result = parseResult(stdout);
    return typeof result?.result === "string" ? result.result.trim() : "";
  }
}

function parseResult(stdout: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).type === "result"
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
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
