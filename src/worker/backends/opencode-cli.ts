/**
 * OpenCode CLI backend.
 *
 * Runs OpenCode as a subprocess worker via `opencode run --format json`, which
 * emits an NDJSON event stream (one JSON object per line). The assistant's
 * response text is extracted from message events.
 *
 * Authentication and model selection are owned by the user's OpenCode config.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { BaseWorker } from "./subprocess.js";

export class OpenCodeWorker extends BaseWorker {
  readonly type = "opencode";

  buildArgv(config: WorkerConfig, prompt: string): { argv: string[]; env?: Record<string, string>; input?: string } {
    const args: string[] = ["run"];
    if (config.model) args.push("--model", config.model);
    if (config.args) args.push(...config.args);
    args.push("--format", "json");
    // Pass prompt via stdin to avoid Windows cmd.exe arg-length/quoting issues
    // with long prompts containing newlines and special chars.
    args.push("-");

    return {
      argv: ["opencode", ...args],
      input: prompt,
    };
  }

  /**
   * Parse the NDJSON event stream emitted by `opencode run --format json`.
   * Each line is a JSON event. The assistant's text is in events of type
   * "text", nested under `part.text`:
   *   {"type":"text","part":{"type":"text","text":"response"}}
   * Tool results are never role results. When no text event is emitted, return
   * "" so the role retry path records a clear empty-output failure instead of
   * treating a file read, web response, or shell output as the Agent answer.
   */
  extractResponseText(stdout: string): string {
    const texts: string[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: unknown;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue; // not JSON, skip (opencode may print non-JSON diagnostics)
      }
      const obj = evt as Record<string, unknown>;

      // OpenCode NDJSON format: { type: "text", part: { text: "..." } }
      if (obj.type === "text" && typeof obj.part === "object" && obj.part !== null) {
        const part = obj.part as Record<string, unknown>;
        if (typeof part.text === "string") {
          texts.push(part.text);
        }
      }

    }

    return texts.join("\n").trim();
  }
}
