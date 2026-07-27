import { randomUUID } from "node:crypto";
import type { WorkerConfig } from "../../config/types.js";
import type { ProcessResult, ProcessSpec, SessionRef, WorkerDriver } from "../types.js";
import { textFromJson } from "./base.js";

export class ClaudeCodeDriver implements WorkerDriver {
  readonly type = "claude-code";
  readonly canResume = true;
  build(config: WorkerConfig, prompt: string, current?: SessionRef): ProcessSpec {
    const id = current?.value ?? randomUUID();
    const argv = current
      ? ["claude", "-r", id, "--dangerously-skip-permissions", "-p", "--output-format", "json"]
      : ["claude", "--session-id", id, "--dangerously-skip-permissions", "-p", "--output-format", "json"];
    if (config.model) argv.push("--model", config.model);
    argv.push(...config.args);
    return { argv, input: prompt };
  }
  parse(result: ProcessResult): { text: string; session?: SessionRef } {
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(result.stdout) as Record<string, unknown>; } catch { /* raw output */ }
    const text = typeof value.result === "string" ? value.result.trim() : textFromJson(result.stdout);
    const id = typeof value.session_id === "string" ? value.session_id : undefined;
    return { text, session: id ? { workerType: this.type, value: id } : undefined };
  }
}
