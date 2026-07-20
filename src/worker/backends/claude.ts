/**
 * Claude Code command backend.
 *
 * Translates a worker execution into a claude-code CLI call with the prompt and
 * configured process options. Worker files stay thin and delegate common
 * subprocess behavior to BaseWorker.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { BaseWorker } from "./subprocess.js";

export class ClaudeCodeWorker extends BaseWorker {
  readonly type = "claude-code";

  buildArgv(config: WorkerConfig, prompt: string) {
    const argv = ["claude", "--dangerously-skip-permissions", "-p", "--output-format", "json"];
    if (config.model) argv.push("--model", config.model);
    if (config.args) argv.push(...config.args);
    // Keep task/prompt content off argv. This avoids command-line disclosure,
    // Windows quoting limits, and accidental shell interpretation.
    return { argv, input: prompt };
  }

  extractResponseText(stdout: string): string {
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
