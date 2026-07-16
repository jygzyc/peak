/**
 * Codex command backend.
 *
 * Adapts peak worker requests to the Codex CLI. It is one executable
 * backend behind AgentDriver; scheduling, role prompts, and graph state are
 * handled by higher layers.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { SubprocessBackend, type BuildArgvOptions } from "./subprocess.js";

export class CodexBackend extends SubprocessBackend {
  readonly id = "codex";

  buildArgv(config: WorkerConfig, prompt: string, opts?: BuildArgvOptions) {
    const options = [
      "--dangerously-bypass-approvals-and-sandbox",
      ...modelFlags(config),
      ...providerFlags(config),
      "--json",
    ];
    const argv = opts?.sessionId
      ? ["codex", "exec", "resume", ...options, opts.sessionId]
      : ["codex", "exec", ...options];
    // Pass prompt via stdin (`-`) to avoid Windows cmd.exe arg-length/quoting
    // issues with long prompts containing newlines and special chars — same
    // approach as the opencode CLI backend.
    argv.push("-");
    return { argv, env: envFor(config), input: prompt };
  }

  extractSession(stdout: string, _stderr: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          return event.thread_id;
        }
      } catch { /* ignore non-event diagnostics */ }
    }
    return undefined;
  }

  extractResponseText(stdout: string, _stderr: string): string {
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

function modelFlags(config: WorkerConfig): string[] {
  const model = config.model ?? process.env.CODEX_MODEL;
  return model ? ["--model", model] : [];
}

function providerFlags(config: WorkerConfig): string[] {
  const baseUrl = config.baseUrl ?? process.env.CODEX_BASE_URL;
  if (!baseUrl) return [];
  return [
    "-c", 'model_provider="peak"',
    "-c", 'model_providers.peak.name="peak"',
    "-c", 'model_providers.peak.wire_api="responses"',
    "-c", 'model_reasoning_effort="high"',
    `-c`, `model_providers.peak.base_url="${baseUrl}"`,
    "-c", 'model_providers.peak.env_key="OPENAI_API_KEY"',
  ];
}

function envFor(config: WorkerConfig): Record<string, string> | undefined {
  const keyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const key = process.env[keyEnv];
  return key ? { OPENAI_API_KEY: key } : undefined;
}
