import type { ProcessResult, ProcessSpec, WorkerCall, WorkerProtocol, WorkerType } from "../types.js";
import { jsonLines, session, textFromJson } from "./shared.js";

const TYPE: WorkerType = "opencode";

/**
 * OpenCode protocol. Prompt is piped via stdin (`opencode run` reads `-`).
 * Every JSON event carries the OpenCode session id; Finalize passes that id
 * back through `--session` to continue the same conversation.
 */
export const opencodeProtocol: WorkerProtocol = {
  type: TYPE,
  canResume: true,
  build(call: WorkerCall): ProcessSpec {
    const argv = ["opencode", "run", "--format", "json"];
    if (call.session) argv.push("--session", call.session.value);
    if (call.config.model) argv.push("--model", call.config.model);
    argv.push("-");
    return { argv, input: call.prompt };
  },
  parse(result: ProcessResult): { text: string; session?: ReturnType<typeof session> } {
    const events = jsonLines(result.stdout);
    const texts = events.flatMap((event) => {
      if (event.type !== "text" || !event.part || typeof event.part !== "object") return [];
      const part = event.part as Record<string, unknown>;
      return typeof part.text === "string" ? [part.text] : [];
    });
    const id = events.find((event) => typeof event.sessionID === "string")?.sessionID;
    return { text: texts.join("\n").trim() || textFromJson(result.stdout), session: session(TYPE, id) };
  },
};
