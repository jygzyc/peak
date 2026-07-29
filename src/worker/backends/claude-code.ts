import { randomUUID } from "node:crypto";
import type { ProcessResult, ProcessSpec, SessionRef, WorkerRequest } from "../types.js";
import { CliWorkerDriver, textFromJson } from "./base.js";

export class ClaudeCodeDriver extends CliWorkerDriver {
  readonly type = "claude-code";
  readonly canResume = true;

  protected override prepareSession(request: WorkerRequest): SessionRef {
    return request.session ?? { workerType: this.type, value: randomUUID() };
  }

  protected build(request: WorkerRequest, session: SessionRef | undefined): ProcessSpec {
    if (!session) throw new Error("claude-code session was not prepared");
    const argv = request.session
      ? ["claude", "-r", session.value, "--dangerously-skip-permissions", "-p", "--output-format", "json"]
      : ["claude", "--session-id", session.value, "--dangerously-skip-permissions", "-p", "--output-format", "json"];
    if (request.config.model) argv.push("--model", request.config.model);
    argv.push(...request.config.args);
    return { argv, input: request.prompt };
  }

  protected parse(result: ProcessResult): { text: string; session?: SessionRef } {
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(result.stdout) as Record<string, unknown>; } catch { /* raw output */ }
    const text = typeof value.result === "string" ? value.result.trim() : textFromJson(result.stdout);
    const id = typeof value.session_id === "string" ? value.session_id : undefined;
    return { text, session: id ? { workerType: this.type, value: id } : undefined };
  }
}
