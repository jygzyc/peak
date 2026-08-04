import type { ProcessResult, ProcessSpec, WorkerCall, WorkerProtocol, WorkerType } from "../types.js";
import { textFromJson } from "./shared.js";

const TYPE: WorkerType = "opencode";

/**
 * OpenCode protocol. Prompt is piped via stdin (`opencode run` reads `-`).
 * Does not currently support Finalize resume.
 */
export const opencodeProtocol: WorkerProtocol = {
  type: TYPE,
  canResume: false,
  build(call: WorkerCall): ProcessSpec {
    const argv = ["opencode", "run", "--format", "json"];
    if (call.config.model) argv.push("--model", call.config.model);
    argv.push("-");
    return { argv, input: call.prompt };
  },
  parse(result: ProcessResult): { text: string } {
    const texts = result.stdout.split(/\r?\n/).flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== "text" || !event.part || typeof event.part !== "object") return [];
        const part = event.part as Record<string, unknown>;
        return typeof part.text === "string" ? [part.text] : [];
      } catch { return []; }
    });
    return { text: texts.join("\n").trim() || textFromJson(result.stdout) };
  },
};
