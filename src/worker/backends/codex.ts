/**
 * Codex command backend.
 *
 * Adapts peak worker requests to the Codex CLI. It is one executable
 * backend behind AgentDriver; scheduling, role prompts, and graph state are
 * handled by higher layers.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { SubprocessBackend, type BuildArgvOptions } from "./subprocess.js";

const SESSION_RE = /session[: ]+([0-9a-fA-F-]{8,})/i;

export class CodexBackend extends SubprocessBackend {
  readonly id = "codex";

  buildArgv(config: WorkerConfig, prompt: string, opts?: BuildArgvOptions) {
    const argv = [
      "codex", "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      ...modelFlags(config),
      ...providerFlags(config),
    ];
    if (opts?.sessionId) argv.push("--resume", opts.sessionId);
    // Pass prompt via stdin (`-`) to avoid Windows cmd.exe arg-length/quoting
    // issues with long prompts containing newlines and special chars — same
    // approach as the opencode CLI backend.
    argv.push("-");
    return { argv, env: envFor(config), input: prompt };
  }

  extractSession(stdout: string, stderr: string): string | undefined {
    const m = SESSION_RE.exec(stderr) ?? SESSION_RE.exec(stdout);
    return m ? m[1] : undefined;
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
