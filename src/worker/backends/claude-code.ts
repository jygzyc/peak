import { randomUUID } from "node:crypto";
import type { ProcessResult, ProcessSpec, SessionRef, WorkerCall, WorkerProtocol, WorkerType } from "../types.js";
import { textFromJson } from "./shared.js";

const TYPE: WorkerType = "claude-code";

/**
 * Claude Code protocol. A fresh UUID session is seeded before Execute so a
 * resume is still possible when the first call fails; resume uses `-r <id>`.
 */
export const claudeCodeProtocol: WorkerProtocol = {
  type: TYPE,
  canResume: true,
  prepareSession(call: WorkerCall): SessionRef {
    return call.session ?? { workerType: TYPE, value: randomUUID() };
  },
  build(call: WorkerCall, session: SessionRef | undefined): ProcessSpec {
    if (!session) throw new Error("claude-code session was not prepared");
    const argv = call.session
      ? ["claude", "-r", session.value, "--dangerously-skip-permissions", "-p", "--output-format", "json"]
      : ["claude", "--session-id", session.value, "--dangerously-skip-permissions", "-p", "--output-format", "json"];
    if (call.config.model) argv.push("--model", call.config.model);
    return { argv, input: call.prompt };
  },
  parse(result: ProcessResult): { text: string; session?: SessionRef } {
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(result.stdout) as Record<string, unknown>; } catch { /* raw output */ }
    const text = typeof value.result === "string" ? value.result.trim() : textFromJson(result.stdout);
    const id = typeof value.session_id === "string" ? value.session_id : undefined;
    return { text, session: id ? { workerType: TYPE, value: id } : undefined };
  },
};
