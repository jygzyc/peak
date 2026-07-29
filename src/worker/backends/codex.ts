import type { ProcessResult, ProcessSpec, SessionRef, WorkerRequest } from "../types.js";
import { CliWorkerDriver, jsonLines, session, textFromJson } from "./base.js";

export class CodexDriver extends CliWorkerDriver {
  readonly type = "codex";
  readonly canResume = true;

  protected build(request: WorkerRequest, _session: SessionRef | undefined): ProcessSpec {
    const argv = request.session
      ? ["codex", "exec", "resume", request.session.value, "--json"]
      : ["codex", "exec", "--json"];
    if (request.config.model) argv.push("--model", request.config.model);
    argv.push(...request.config.args, "-");
    return { argv, input: request.prompt };
  }

  protected parse(result: ProcessResult): { text: string; session?: SessionRef } {
    const events = jsonLines(result.stdout);
    const id = events.find((event) => event.type === "thread.started")?.thread_id
      ?? /session id:\s*([0-9a-f-]+)/i.exec(result.stderr)?.[1];
    const messages = events.flatMap((event) => {
      if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") return [];
      const item = event.item as Record<string, unknown>;
      return item.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
    });
    return { text: messages.join("\n").trim() || textFromJson(result.stdout), session: session(this.type, id) };
  }
}
