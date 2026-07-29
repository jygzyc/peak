import type { ProcessResult, ProcessSpec, SessionRef, WorkerRequest } from "../types.js";
import { CliWorkerDriver, textFromJson } from "./base.js";

export class OpenCodeDriver extends CliWorkerDriver {
  readonly type = "opencode";
  readonly canResume = false;

  protected build(request: WorkerRequest, _session: SessionRef | undefined): ProcessSpec {
    const argv = ["opencode", "run", "--format", "json"];
    if (request.config.model) argv.push("--model", request.config.model);
    argv.push(...request.config.args, "-");
    return { argv, input: request.prompt };
  }

  protected parse(result: ProcessResult): { text: string } {
    const texts = result.stdout.split(/\r?\n/).flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== "text" || !event.part || typeof event.part !== "object") return [];
        const part = event.part as Record<string, unknown>;
        return typeof part.text === "string" ? [part.text] : [];
      } catch { return []; }
    });
    return { text: texts.join("\n").trim() || textFromJson(result.stdout) };
  }
}
