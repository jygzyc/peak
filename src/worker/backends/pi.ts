/** Pi coding-agent CLI backend. */

import type { WorkerConfig } from "../../agent/types.js";
import { BaseWorker } from "./subprocess.js";

export class PiWorker extends BaseWorker {
  readonly type = "pi";

  buildArgv(config: WorkerConfig, prompt: string) {
    const argv = ["pi", "--mode", "json"];
    if (config.model) argv.push("--model", config.model);
    if (config.args) argv.push(...config.args);
    argv.push("-p");
    return { argv, input: prompt };
  }

  extractResponseText(stdout: string): string {
    let assistant: Record<string, unknown> | undefined;
    for (const event of events(stdout)) {
      if (event.type === "turn_end" && isAssistantMessage(event.message)) {
        assistant = event.message;
      }
      if (event.type === "agent_end" && Array.isArray(event.messages)) {
        assistant = [...event.messages].reverse().find(isAssistantMessage);
      }
    }
    if (!assistant || !Array.isArray(assistant.content)) return "";
    return assistant.content
      .filter((part): part is { type: "text"; text: string } => Boolean(
        part && typeof part === "object"
        && (part as Record<string, unknown>).type === "text"
        && typeof (part as Record<string, unknown>).text === "string",
      ))
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
}

function events(stdout: string): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        result.push(value as Record<string, unknown>);
      }
    } catch { /* ignore diagnostics outside the JSON event stream */ }
  }
  return result;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).role === "assistant");
}
