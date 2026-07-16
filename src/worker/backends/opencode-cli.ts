/**
 * OpenCode CLI backend.
 *
 * Runs OpenCode as a subprocess worker via `opencode run --format json`, which
 * emits an NDJSON event stream (one JSON object per line). The assistant's
 * response text is extracted from message events. Session resume is supported
 * via `--session <id>`.
 *
 * HTTP transport lives in opencode-http.ts.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { SubprocessBackend, type BuildArgvOptions } from "./subprocess.js";

export class OpencodeCliBackend extends SubprocessBackend {
  readonly id = "opencode";

  buildArgv(config: WorkerConfig, prompt: string, opts?: BuildArgvOptions): { argv: string[]; env?: Record<string, string>; input?: string } {
    const args: string[] = ["run"];
    if (config.model) args.push("--model", config.model);
    if (opts?.sessionId) args.push("--session", opts.sessionId);
    args.push("--format", "json");
    if (config.args) args.push(...config.args);
    // Pass prompt via stdin to avoid Windows cmd.exe arg-length/quoting issues
    // with long prompts containing newlines and special chars.
    args.push("-");

    const env: Record<string, string> = {};
    if (config.baseUrl) env.OPENCODE_BASE_URL = config.baseUrl;
    const keyEnv = config.apiKeyEnv ?? "OPENCODE_API_KEY";
    const key = process.env[keyEnv];
    if (key) env.OPENCODE_API_KEY = key;

    return {
      argv: ["opencode", ...args],
      env: Object.keys(env).length > 0 ? env : undefined,
      input: prompt,
    };
  }

  extractSession(stdout: string, _stderr: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (typeof event.sessionID === "string" && /^ses_[0-9a-zA-Z]{10,}$/.test(event.sessionID)) {
          return event.sessionID;
        }
      } catch { /* ignore non-event diagnostics */ }
    }
    return undefined;
  }

  /**
   * Parse the NDJSON event stream emitted by `opencode run --format json`.
   * Each line is a JSON event. The assistant's text is in events of type
   * "text", nested under `part.text`:
   *   {"type":"text","part":{"type":"text","text":"response"}}
   * Recovery paths (opencode `run -` is non-deterministic and the model
   * sometimes returns its answer in a tool-call step instead of a final text
   * step):
   *   - When no `text` event is emitted, fall back to `tool_use` event
   *     `part.state.output` — the model frequently emits the JSON envelope by
   *     running it through the bash tool (e.g. `echo {...}`), and that output
   *     appears here rather than in a text event.
   *   - When neither is present (model stopped early with near-empty output),
   *     return "" so parseEnvelope reports a clear "empty output" error instead
   *     of leaking raw NDJSON into the error message.
   */
  extractResponseText(stdout: string, _stderr: string): string {
    const texts: string[] = [];
    const toolOutputs: string[] = [];
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

      // Tool-call step: { type: "tool_use", part: { state: { output: "..." } } }
      // Collected as a fallback only — used when no text event is emitted but
      // the model produced its answer via a tool (e.g. bash echo of the JSON).
      if (obj.type === "tool_use" && typeof obj.part === "object" && obj.part !== null) {
        const part = obj.part as Record<string, unknown>;
        const state = part.state as Record<string, unknown> | undefined;
        if (state && typeof state.output === "string") {
          toolOutputs.push(state.output);
        }
      }
    }

    if (texts.length > 0) {
      return texts.join("\n").trim();
    }
    // No assistant text event: try tool-call outputs (model answered via tool).
    const fromTools = toolOutputs.map((t) => t.trim()).filter(Boolean).join("\n");
    if (fromTools) {
      return fromTools;
    }
    return "";
  }
}
