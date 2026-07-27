import type { WorkerConfig } from "../../config/types.js";
import type { ProcessResult, ProcessSpec, WorkerDriver } from "../types.js";
import { textFromJson } from "./base.js";

export class OpenCodeDriver implements WorkerDriver {
  readonly type = "opencode";
  readonly canResume = false;
  build(config: WorkerConfig, prompt: string): ProcessSpec {
    const argv = ["opencode", "run", "--format", "json"];
    if (config.model) argv.push("--model", config.model);
    argv.push(...config.args, "-");
    return { argv, input: prompt };
  }
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
  }
}
