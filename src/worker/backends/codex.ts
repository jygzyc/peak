import type { WorkerConfig } from "../../config/types.js";
import type { ProcessResult, ProcessSpec, SessionRef, WorkerDriver } from "../types.js";
import { jsonLines, session, textFromJson } from "./base.js";

export class CodexDriver implements WorkerDriver {
  readonly type = "codex";
  readonly canResume = true;
  build(config: WorkerConfig, prompt: string, current?: SessionRef): ProcessSpec {
    const argv = current ? ["codex", "exec", "resume", current.value, "--json"] : ["codex", "exec", "--json"];
    if (config.model) argv.push("--model", config.model);
    argv.push(...config.args, "-");
    return { argv, input: prompt };
  }
  parse(result: ProcessResult): { text: string; session?: SessionRef } {
    const events = jsonLines(result.stdout);
    const id = events.find((event) => event.type === "thread.started")?.thread_id;
    const messages = events.flatMap((event) => {
      if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") return [];
      const item = event.item as Record<string, unknown>;
      return item.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
    });
    return { text: messages.join("\n").trim() || textFromJson(result.stdout), session: session(this.type, id) };
  }
}
