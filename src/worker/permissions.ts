import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { WorkerPermissions } from "./types.js";

/**
 * Permission defaults: full local tool set, no allow-list, no extra deny
 * patterns ({@link DEFAULT_BASH_DENY} is always enforced on top), 1 MiB bash
 * output cap.
 */
export const DEFAULT_WORKER_PERMISSIONS: WorkerPermissions = {
  write: true,
  bash: true,
  bashAllow: [],
  bashDeny: [],
  bashMaxOutputBytes: 1024 * 1024,
};

/**
 * Built-in deny-list applied on top of any task-configured patterns. A command
 * is denied when it contains one of these substrings (case-insensitive).
 */
export const DEFAULT_BASH_DENY: readonly string[] = [
  "rm -rf /",
  "rm -fr /",
  "rm -rf ~",
  "rm -rf $HOME",
  "mkfs",
  "dd if=",
  ":(){",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "diskpart",
  "format c:",
  "bcdedit",
  "reg delete hklm",
  "reg delete hkcu",
];

/** Environment variables the bash tool may inherit; everything else (API keys, tokens) is scrubbed. */
const BASH_ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "COMSPEC", "SystemRoot", "SystemDrive", "WINDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SHELL", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ",
];

/** Thrown when a tool path escapes the session working directory. */
export class PathPermissionError extends Error {
  constructor(readonly target: string, readonly boundary: string) {
    super(`path escapes the worker working directory: ${target}`);
    this.name = "PathPermissionError";
  }
}

function canonicalize(path: string): string {
  // Resolve symlinks on the nearest existing ancestor so a symlink inside the
  // boundary that points outside is still caught, even for not-yet-existing
  // write targets.
  let current = path;
  let tail = "";
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail = sep + current.slice(parent.length + 1) + tail;
    current = parent;
  }
  try {
    return realpathSync(current) + tail;
  } catch {
    return current + tail;
  }
}

function normalizeCase(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** True when `absolutePath` is the boundary directory itself or lives underneath it. */
export function isWithinCwd(cwd: string, absolutePath: string): boolean {
  const boundary = normalizeCase(canonicalize(resolve(cwd)));
  const target = normalizeCase(canonicalize(resolve(absolutePath)));
  return target === boundary || target.startsWith(boundary + sep);
}

/**
 * Resolves `target` against the session working directory and verifies the
 * result stays inside it. Throws {@link PathPermissionError} otherwise.
 */
export function resolveWithinCwd(cwd: string, target: string): string {
  const resolved = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  if (!isWithinCwd(cwd, resolved)) throw new PathPermissionError(target, cwd);
  return resolved;
}

/**
 * Returns a denial reason when `command` violates the policy, `undefined`
 * when it may run. Deny patterns win over the allow-list.
 */
export function checkBashCommand(command: string, permissions: WorkerPermissions): string | undefined {
  const haystack = command.toLowerCase();
  for (const pattern of [...DEFAULT_BASH_DENY, ...permissions.bashDeny]) {
    if (pattern && haystack.includes(pattern.toLowerCase())) {
      return `command matches denied pattern: ${pattern}`;
    }
  }
  if (permissions.bashAllow.length > 0) {
    const trimmed = command.trim();
    if (!permissions.bashAllow.some((prefix) => trimmed.startsWith(prefix))) {
      return `command does not match any allowed prefix`;
    }
  }
  return undefined;
}

/** Minimal, credential-free environment for bash tool commands. */
export function scrubBashEnv(cwd: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASH_ENV_ALLOWLIST) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  for (const key of Object.keys(base)) {
    if (key.startsWith("PI_")) env[key] = base[key];
  }
  env.TMPDIR = cwd;
  env.TMP = cwd;
  env.TEMP = cwd;
  return env;
}

/**
 * Bash operations enforcing the permission policy: command deny/allow check,
 * working directory pinned to the session boundary, scrubbed environment, and
 * a hard byte cap on streamed output.
 */
export function guardedBashOperations(cwd: string, permissions: WorkerPermissions): BashOperations {
  const inner = createLocalBashOperations();
  return {
    exec: async (command, _requestedCwd, options) => {
      const denial = checkBashCommand(command, permissions);
      if (denial) {
        options.onData(Buffer.from(`peak permission: bash denied: ${denial}\n`));
        return { exitCode: 126 };
      }
      const cap = permissions.bashMaxOutputBytes;
      let forwarded = 0;
      let truncated = false;
      const onData = (data: Buffer) => {
        if (truncated) return;
        forwarded += data.length;
        if (forwarded <= cap) {
          options.onData(data);
        } else {
          truncated = true;
          options.onData(Buffer.from(`\n[peak] bash output truncated at ${cap} bytes\n`));
        }
      };
      return inner.exec(command, cwd, { ...options, env: scrubBashEnv(cwd, options.env ?? process.env), onData });
    },
  };
}

/** Returns a copy of the tool definition whose `path` argument is confined to `cwd`. */
function guardToolPath(definition: ToolDefinition, cwd: string): ToolDefinition {
  return {
    ...definition,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const target = (params as { path?: unknown }).path;
      if (typeof target === "string") {
        try {
          resolveWithinCwd(cwd, target);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: `peak permission: ${message}` }], details: undefined as never };
        }
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * Builds the permission-controlled tool set for one SDK session. Every file
 * tool is wrapped with the working-directory guard; bash (when enabled) runs
 * through {@link guardedBashOperations}. The returned names double as the
 * `tools` allow-list passed to createAgentSession, so nothing else — builtin
 * or extension — can become active.
 */
export function buildPermittedTools(cwd: string, permissions: WorkerPermissions): { tools: ToolDefinition[]; toolNames: string[] } {
  const tools: ToolDefinition[] = [
    guardToolPath(createReadToolDefinition(cwd), cwd),
    guardToolPath(createGrepToolDefinition(cwd), cwd),
    guardToolPath(createFindToolDefinition(cwd), cwd),
    guardToolPath(createLsToolDefinition(cwd), cwd),
  ];
  if (permissions.write) {
    tools.push(
      guardToolPath(createWriteToolDefinition(cwd), cwd),
      guardToolPath(createEditToolDefinition(cwd), cwd),
    );
  }
  if (permissions.bash) {
    tools.push(createBashToolDefinition(cwd, { operations: guardedBashOperations(cwd, permissions) }));
  }
  return { tools, toolNames: tools.map((tool) => tool.name) };
}
