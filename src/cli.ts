#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { initializePeakPaths } from "./config/paths.js";
import { loadTaskConfig } from "./config/task-config.js";
import { initializeTaskDirectory } from "./config/task-initializer.js";
import { GraphHttpServer } from "./graph/http-server.js";
import { ProjectStoreRegistry } from "./graph/project-store-registry.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { serveDashboard } from "./ui/dashboard.js";

/** 版本号以代码根目录的 version 文件为准（打包时随 dist 一起发布）。 */
function packageVersion(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDir, "..", "version"), join(moduleDir, "version")];
  for (const path of candidates) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    } catch { /* try next */ }
  }
  throw new Error(`version file not found (expected at ${join(moduleDir, "..", "version")})`);
}

interface ServerOptions {
  host: string;
  port: string;
  token?: string;
  peakHome?: string;
}

interface RunOptions extends ServerOptions {
  project?: string;
  installSkills: boolean;
}

const program = new Command()
  .name("peak")
  .description("Peak — HTTP-native distributed Graph agent runtime")
  .version(packageVersion());

program.command("run")
  .description("Create or attach Board Projects and run Plan / Supervise / Execute until SIGINT/SIGTERM")
  .argument("[board-directory]", "Board directory containing task.json", ".")
  .option("--project <name>", "Run only this configured Project by name; default runs the full Board")
  .option("--host <host>", "HTTP host (non-loopback requires --token)", "127.0.0.1")
  .option("--port <port>", "HTTP port (0 = ephemeral)", "0")
  .option("--token <token>", "Bearer token required for every /api/* request")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .option("--no-install-skills", "Skip Board Skill installation")
  .action((taskDirectory: string, options: RunOptions) => run(taskDirectory, options));

program.command("resume")
  .description("Attach one persisted Project by UUID and validate its configured Goal")
  .argument("<project-id>", "UUID of the persisted Project to attach")
  .argument("[board-directory]", "Board directory containing task.json", ".")
  .option("--project <name>", "Configured Project name when matching is ambiguous")
  .option("--host <host>", "HTTP host (non-loopback requires --token)", "127.0.0.1")
  .option("--port <port>", "HTTP port (0 = ephemeral)", "0")
  .option("--token <token>", "Bearer token required for every /api/* request")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .option("--no-install-skills", "Skip Board Skill installation")
  .action((projectId: string, taskDirectory: string, options: RunOptions) => run(taskDirectory, options, projectId));

program.command("serve")
  .description("Serve the persisted Graph API and bundled Web UI; no scheduler or workers")
  .option("--host <host>", "HTTP host (non-loopback requires --token)", "127.0.0.1")
  .option("--port <port>", "HTTP port", "8000")
  .option("--token <token>", "Bearer token required for every /api/* request")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .action((options: ServerOptions) => serve(options));

program.command("init")
  .description("Scaffold a new Board directory with an empty task.json")
  .argument("[board-directory]", "Board directory to initialize", ".")
  .action((directory: string) => {
    const paths = initializeTaskDirectory(directory);
    process.stdout.write(`created: ${paths.configPath}\n`);
  });

program.command("workers")
  .description("List supported Worker and task types")
  .action(() => {
    process.stdout.write(`${JSON.stringify({ workerTypes: ["opencode", "codex", "pi", "claude-code"], taskTypes: ["plan", "supervise", "execute"] }, null, 2)}\n`);
  });

await program.parseAsync();

async function run(taskDirectory: string, options: RunOptions, projectId?: string): Promise<void> {
  const lifecycle = shutdownLifecycle();
  const runtime = new AgentRuntime(loadTaskConfig(taskDirectory), {
    host: options.host,
    port: parsePort(options.port),
    token: options.token,
    peakHome: options.peakHome,
    installSkills: options.installSkills,
  });
  let monitorError: unknown;
  try {
    const projects = await runtime.start(options.project, projectId);
    process.stdout.write([
      `[peak] board: ${runtime.config.board.name ?? "board"}`,
      ...projects.flatMap((project) => [`[peak] project: ${project.title}`, `[peak] id: ${project.id}`]),
      `[peak] web: ${runtime.webUrl}`,
      "[peak] running; press Ctrl+C to stop",
      "",
    ].join("\n"));
    for (const project of projects) {
      void runtime.wait(project.id).then((finished) => {
        const lines = [`[peak] project status: ${finished.title} (${finished.id}) ${finished.status}; web server remains available`];
        for (const deliverable of finished.deliverables) lines.push(`[peak] deliverable: ${deliverable}`);
        process.stdout.write(`${lines.join("\n")}\n`);
      }).catch((error: unknown) => {
        monitorError = error;
        lifecycle.request();
      });
    }
    await lifecycle.promise;
    if (monitorError) throw monitorError;
  } finally {
    lifecycle.dispose();
    await runtime.stop();
  }
}

async function serve(options: ServerOptions): Promise<void> {
  const lifecycle = shutdownLifecycle();
  const paths = initializePeakPaths(options.peakHome);
  const registry = new ProjectStoreRegistry(paths.projectsDir);
  const server = new GraphHttpServer(registry, serveDashboard);
  try {
    await server.start({ host: options.host, port: parsePort(options.port), token: options.token });
    process.stdout.write(`[peak] web: ${server.baseUrl}\n[peak] serving; press Ctrl+C to stop\n`);
    await lifecycle.promise;
  } finally {
    lifecycle.dispose();
    await server.stop();
    registry.close();
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`invalid port: ${value}`);
  return port;
}

function shutdownLifecycle(): { promise: Promise<void>; request: () => void; dispose: () => void } {
  let resolveShutdown!: () => void;
  let requested = false;
  const promise = new Promise<void>((resolvePromise) => { resolveShutdown = resolvePromise; });
  const request = (): void => {
    if (requested) return;
    requested = true;
    resolveShutdown();
  };
  process.once("SIGINT", request);
  process.once("SIGTERM", request);
  return {
    promise,
    request,
    dispose: () => {
      process.off("SIGINT", request);
      process.off("SIGTERM", request);
    },
  };
}
