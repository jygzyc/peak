import type { ProcessResult, ProcessSpec, WorkerCall, WorkerProtocol, WorkerType } from "../types.js";
import { jsonLines, session, textFromJson } from "./shared.js";

const TYPE: WorkerType = "codex";

/**
 * Codex protocol. `codex exec --json` reads the prompt from stdin (`-`).
 * Session ids are recovered from the `thread.started` event, or from
 * `session id:` stderr diagnostics on a failed command.
 */
export const codexProtocol: WorkerProtocol = {
  type: TYPE,
  canResume: true,
  build(call: WorkerCall): ProcessSpec {
    const argv = call.session
      ? ["codex", "exec", "resume", call.session.value, "--json"]
      : ["codex", "exec", "--json"];
    if (call.config.model) argv.push("--model", call.config.model);
    argv.push("-");
    return { argv, input: call.prompt };
  },
  parse(result: ProcessResult): { text: string; session?: ReturnType<typeof session> } {
    const events = jsonLines(result.stdout);
    const id = events.find((event) => event.type === "thread.started")?.thread_id
      ?? /session id:\s*([0-9a-f-]+)/i.exec(result.stderr)?.[1];
    const messages = events.flatMap((event) => {
      if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") return [];
      const item = event.item as Record<string, unknown>;
      return item.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
    });
    return { text: messages.join("\n").trim() || textFromJson(result.stdout), session: session(TYPE, id) };
  },
};
