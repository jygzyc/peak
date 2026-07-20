/**
 * Codex command backend.
 *
 * Adapts Peak worker requests to the Codex CLI. Scheduling, Agent inputs, and
 * graph state are handled by higher layers.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { BaseWorker } from "./subprocess.js";

export class CodexWorker extends BaseWorker {
  readonly type = "codex";

  buildArgv(config: WorkerConfig, prompt: string) {
    const argv = ["codex", "exec"];
    argv.push(
      "--dangerously-bypass-approvals-and-sandbox",
      ...(config.model ? ["--model", config.model] : []),
      "--json",
      ...(config.args ?? []),
    );
    // Pass prompt via stdin (`-`) to avoid Windows cmd.exe arg-length/quoting
    // issues with long prompts containing newlines and special chars — same
    // approach as the opencode CLI backend.
    argv.push("-");
    return { argv, input: prompt };
  }

  extractResponseText(stdout: string): string {
    const messages: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") continue;
        const item = event.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string") {
          messages.push(item.text);
        }
      } catch { /* ignore non-event diagnostics */ }
    }
    if (messages.length > 0) return messages.join("\n").trim();
    return "";
  }
}
