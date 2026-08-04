#!/usr/bin/env node
import { closeSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { initializePeakPaths } from "./config/paths.js";
import { loadTaskConfig } from "./config/task-config.js";
import { initializeTaskDirectory } from "./config/task-initializer.js";
import {
  getServerProcessStatus, publishServerUrl, registerServerProcess, serverLogPath, stopServerProcess,
} from "./config/server-process.js";
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
  foreground: boolean;
}

interface ServeOptions extends ServerOptions { foreground: boolean }

interface ArchiveOptions { peakHome?: string }

const program = new Command()
  .name("peak")
  .description("Peak — HTTP-native distributed Graph agent runtime")
  .version(packageVersion());

program.command("run")
  .description("Create or attach Board Projects and start Plan / Supervise / Execute in the background")
  .argument("[board-directory]", "Board directory containing task.json", ".")
  .option("--project <source>", "Run only the configured Project with this source; default runs the full Board")
  .option("--host <host>", "HTTP host (non-loopback requires --token)", "127.0.0.1")
  .option("--port <port>", "HTTP port (0 = ephemeral)", "0")
  .option("--token <token>", "Bearer token required for every /api/* request")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .option("--no-install-skills", "Skip Board Skill installation")
  .addOption(new Option("--foreground", "Run in the current process").default(false).hideHelp())
  .action((taskDirectory: string, options: RunOptions) => options.foreground
    ? runForeground(taskDirectory, options, undefined, "run")
    : launchBackground(options.peakHome));

program.command("resume")
  .description("Attach one persisted Project by UUID and start it in the background")
  .argument("<project-id>", "UUID of the persisted Project to attach")
  .argument("[board-directory]", "Board directory containing task.json", ".")
  .option("--project <source>", "Configured Project source when matching is ambiguous")
  .option("--host <host>", "HTTP host (non-loopback requires --token)", "127.0.0.1")
  .option("--port <port>", "HTTP port (0 = ephemeral)", "0")
  .option("--token <token>", "Bearer token required for every /api/* request")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .option("--no-install-skills", "Skip Board Skill installation")
  .addOption(new Option("--foreground", "Run in the current process").default(false).hideHelp())
  .action((projectId: string, taskDirectory: string, options: RunOptions) => options.foreground
    ? runForeground(taskDirectory, options, projectId, "resume")
    : launchBackground(options.peakHome));

program.command("serve")
  .description("Start the persisted Graph API and bundled Web UI in the background; no workers")
  .option("--host <host>", "HTTP host (non-loopback requires --token)", "127.0.0.1")
  .option("--port <port>", "HTTP port", "8000")
  .option("--token <token>", "Bearer token required for every /api/* request")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .addOption(new Option("--foreground", "Run in the current process").default(false).hideHelp())
  .action((options: ServeOptions) => options.foreground ? serveForeground(options) : launchBackground(options.peakHome));

program.command("status")
  .description("Show the background Peak server status")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .action((options: ArchiveOptions) => printServerStatus(options));

program.command("stop")
  .description("Stop the Peak server and its active Worker subprocesses")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .action(async (options: ArchiveOptions) => {
    const pid = await stopServerProcess(initializePeakPaths(options.peakHome).peakHome);
    process.stdout.write(`[peak] stopped server: ${pid}\n`);
  });

program.command("export")
  .description("Export one completed Project as a portable Graph/SQLite/Artifact archive")
  .argument("<project-id>", "UUID of the completed Project")
  .argument("[archive]", "Output .tar.gz path (must not already exist)")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .action((projectId: string, archive: string | undefined, options: ArchiveOptions) => exportCompletedProject(projectId, archive, options));

program.command("import")
  .description("Import a completed Project archive into Peak home for reuse by another Board")
  .argument("<archive>", "Project .tar.gz archive")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .action((archive: string, options: ArchiveOptions) => importCompletedProject(archive, options));

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

async function runForeground(
  taskDirectory: string,
  options: RunOptions,
  projectId: string | undefined,
  mode: "run" | "resume",
): Promise<void> {
  const lifecycle = shutdownLifecycle();
  const config = loadTaskConfig(taskDirectory);
  const paths = initializePeakPaths(options.peakHome);
  const unregister = registerServerProcess(paths.peakHome, mode, config.taskDir);
  const runtime = new AgentRuntime(config, {
    host: options.host,
    port: parsePort(options.port),
    token: options.token,
    peakHome: options.peakHome,
    installSkills: options.installSkills,
  });
  // Record process-level crashes in every Project's main.log, then keep the
  // default crash behavior (message + stack on stderr, non-zero exit).
  const crash = (kind: "uncaughtException" | "unhandledRejection") => (error: unknown): void => {
    runtime.logCrash(kind, error);
    process.stderr.write(`[peak] ${kind}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  };
  process.once("uncaughtException", crash("uncaughtException"));
  process.once("unhandledRejection", crash("unhandledRejection"));
  let monitorError: unknown;
  try {
    const projects = await runtime.start(options.project, projectId);
    publishServerUrl(paths.peakHome, runtime.webUrl);
    process.stdout.write([
      `[peak] board: ${runtime.config.board.name ?? "board"}`,
      ...projects.flatMap((project) => [`[peak] source: ${project.title}`, `[peak] id: ${project.id}`]),
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
    unregister();
  }
}

async function serveForeground(options: ServeOptions): Promise<void> {
  const lifecycle = shutdownLifecycle();
  const paths = initializePeakPaths(options.peakHome);
  const unregister = registerServerProcess(paths.peakHome, "serve");
  const registry = new ProjectStoreRegistry(paths.projectsDir);
  const server = new GraphHttpServer(registry, serveDashboard);
  try {
    await server.start({ host: options.host, port: parsePort(options.port), token: options.token });
    publishServerUrl(paths.peakHome, server.baseUrl);
    process.stdout.write(`[peak] web: ${server.baseUrl}\n[peak] serving; press Ctrl+C to stop\n`);
    await lifecycle.promise;
  } finally {
    lifecycle.dispose();
    await server.stop();
    registry.close();
    unregister();
  }
}

async function launchBackground(peakHomeOption?: string): Promise<void> {
  const paths = initializePeakPaths(peakHomeOption);
  const current = getServerProcessStatus(paths.peakHome);
  if (current.running) throw new Error(`Peak server is already running (pid ${current.pid})`);
  const logPath = serverLogPath(paths.peakHome);
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--foreground"], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Peak background server exited with code ${child.exitCode}; see ${logPath}`);
    }
    const status = getServerProcessStatus(paths.peakHome);
    if (status.running && status.pid === child.pid && status.webUrl) {
      child.unref();
      process.stdout.write([
        `[peak] server: running`,
        `[peak] pid: ${status.pid}`,
        `[peak] web: ${status.webUrl}`,
        `[peak] log: ${logPath}`,
        "",
      ].join("\n"));
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  try { process.kill(child.pid!, "SIGTERM"); } catch { /* best effort */ }
  throw new Error(`Peak background server did not become ready; see ${logPath}`);
}

function printServerStatus(options: ArchiveOptions): void {
  const paths = initializePeakPaths(options.peakHome);
  const status = getServerProcessStatus(paths.peakHome);
  if (!status.running) {
    process.stdout.write("[peak] server: stopped\n");
    return;
  }
  process.stdout.write([
    "[peak] server: running",
    `[peak] pid: ${status.pid}`,
    `[peak] mode: ${status.mode ?? "unknown"}`,
    `[peak] web: ${status.webUrl ?? "starting"}`,
    `[peak] started: ${status.startedAt ?? "unknown"}`,
    `[peak] board: ${status.boardDir ?? "none"}`,
    `[peak] log: ${serverLogPath(paths.peakHome)}`,
    "",
  ].join("\n"));
}

async function exportCompletedProject(projectId: string, archive: string | undefined, options: ArchiveOptions): Promise<void> {
  const registry = new ProjectStoreRegistry(initializePeakPaths(options.peakHome).projectsDir);
  const output = resolve(archive ?? `peak-${projectId}.tar.gz`);
  try {
    const manifest = await registry.exportProjectArchive(projectId, output);
    process.stdout.write(`[peak] exported project source: ${manifest.project.source} (${manifest.project.id})\n[peak] archive: ${output}\n`);
  } finally {
    registry.close();
  }
}

async function importCompletedProject(archive: string, options: ArchiveOptions): Promise<void> {
  const registry = new ProjectStoreRegistry(initializePeakPaths(options.peakHome).projectsDir);
  try {
    const imported = await registry.importProjectArchive(resolve(archive));
    process.stdout.write([
      `[peak] imported project: ${imported.project.title} (${imported.project.id})`,
      "[peak] add this block to board.projects in task.json:",
      JSON.stringify(imported.boardProject, null, 2),
      "",
    ].join("\n"));
  } finally {
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
