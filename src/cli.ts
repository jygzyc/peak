#!/usr/bin/env node
import { closeSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { initializePeakPaths } from "./utils/paths.js";
import {
  dockerContainerState, dockerStop, pullTaskImage, resolveTaskImage, requireDocker, requireTaskContainer,
} from "./utils/docker.js";
import {
  deregisterRuntime, listProjectRegistrations, projectRegistrationExtension, taskFederationProjectIds,
} from "./utils/project-registry.js";
import { stopTask, taskManagerExtension, type TaskManagerContext } from "./utils/task-manager.js";
import { loadTaskConfig } from "./utils/task-config.js";
import { prepareTaskProjects } from "./utils/task-preparer.js";
import type { ExecutionMode } from "./utils/types.js";
import { initializeTaskDirectory } from "./utils/task-initializer.js";
import type { ApiExtension } from "./graph/http-server.js";
import {
  getServerProcessStatus, isProcessAlive, publishServerUrl, registerServerProcess, serverLogPath, stopServerProcess,
  terminateProcess,
} from "./utils/server-process.js";
import { GraphHttpServer } from "./graph/http-server.js";
import { GraphClient } from "./graph/graph-client.js";
import { ProjectStoreRegistry } from "./graph/project-store-registry.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { serveDashboard } from "./ui/dashboard.js";
import { TASK_TYPES } from "./utils/types.js";
import { WORKER_TYPES } from "./worker/registry.js";
import { EMBEDDED_VERSION } from "./generated/assets.js";

/** Version is sourced from the version file at the code root (embedded at build time, with the dist on-disk file as fallback). */
function packageVersion(): string {
  if (EMBEDDED_VERSION) return EMBEDDED_VERSION;
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
  peakHome?: string;
}

interface RunOptions {
  project?: string;
  installSkills: boolean;
  foreground: boolean;
  graphUrl: string;
  peakHome?: string;
  projectsRoot?: string;
  execution?: ExecutionMode;
  dockerImage?: string;
}

type DispatchOptions = Omit<RunOptions, "foreground">;

interface ServeOptions extends ServerOptions { port: string; foreground: boolean }

interface ArchiveOptions { peakHome?: string }

const program = new Command()
  .name("peak")
  .description("Peak — HTTP-native distributed Graph agent runtime")
  .version(packageVersion());

program.command("start")
  .description("Start an independent background Dispatch process against peak serve")
  .argument("[board-directory]", "Board directory containing task.json (or the task.json file itself)", ".")
  .option("--project <source>", "Start only the configured Project with this source; default starts the full Board")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .requiredOption("--graph-url <url>", "External peak serve Graph API")
  .option("--projects-root <directory>", "Local Projects root used to resolve relative Artifact paths (container: /peak/projects)")
  .option("--no-install-skills", "Skip Board Skill installation")
  .addOption(new Option("--foreground", "Run in the current process").default(false).hideHelp())
  .action(async (taskDirectory: string, options: RunOptions) => {
    if (options.foreground) await runForeground(taskDirectory, options, undefined, "start");
    else {
      await prepareTaskProjects(loadTaskConfig(taskDirectory), new GraphClient(options.graphUrl));
      await launchBackground(options.peakHome, "task");
    }
  });

program.command("resume")
  .description("Attach one persisted Project to an independent background Dispatch")
  .argument("<project-id>", "UUID of the persisted Project to attach")
  .argument("[board-directory]", "Board directory containing task.json (or the task.json file itself)", ".")
  .option("--project <source>", "Configured Project source when matching is ambiguous")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .requiredOption("--graph-url <url>", "External peak serve Graph API")
  .option("--projects-root <directory>", "Local Projects root used to resolve relative Artifact paths (container: /peak/projects)")
  .option("--no-install-skills", "Skip Board Skill installation")
  .addOption(new Option("--foreground", "Run in the current process").default(false).hideHelp())
  .action((projectId: string, taskDirectory: string, options: RunOptions) => options.foreground
    ? runForeground(taskDirectory, options, projectId, "resume")
    : launchBackground(options.peakHome, "task"));

program.command("serve")
  .description("Start the persisted Graph API and bundled Web UI in the background; no workers")
  .option("--host <host>", "HTTP host", "127.0.0.1")
  .option("--port <port>", "HTTP port", "8000")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .addOption(new Option("--foreground", "Run in the current process").default(false).hideHelp())
  .action((options: ServeOptions) => options.foreground ? serveForeground(options) : launchBackground(options.peakHome, "serve"));

program.command("status")
  .description("Show the background Peak server status")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .action((options: ArchiveOptions) => printServerStatus(options));

program.command("stop")
  .description("Stop one task by name, or stop the Peak server and all registered task Runtimes when no task is named")
  .argument("[task-name]", "Stop only this task by name; omit to stop all tasks and the server")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .action(async (taskName: string | undefined, options: ArchiveOptions) => {
    const peakHome = initializePeakPaths(options.peakHome).peakHome;
    if (taskName) await stopOneTask(peakHome, taskName);
    else await stopEverything(peakHome);
  });

program.command("dispatch")
  .description("Run Task Projects as an independent Dispatch process against peak serve")
  .argument("[board-directory]", "Board directory containing task.json (or the task.json file itself)", ".")
  .option("--project <source>", "Dispatch only the configured Project with this source; default dispatches the full Task")
  .requiredOption("--graph-url <url>", "External peak serve Graph API")
  .option("--projects-root <directory>", "Local Projects root used to resolve relative Artifact paths")
  .option("--peak-home <directory>", "Peak home directory (default: ~/.peak or PEAK_HOME)")
  .option("--no-install-skills", "Skip Task Skill installation")
  .action(async (taskDirectory: string, options: DispatchOptions) => {
    await runForeground(taskDirectory, { ...options, foreground: true }, undefined, "start");
  });

program.command("prepare")
  .description("Create missing Task Projects and persist the complete UUID set before sharded Dispatch")
  .argument("[board-directory]", "Board directory containing task.json (or the task.json file itself)", ".")
  .requiredOption("--graph-url <url>", "External peak serve Graph API")
  .action(async (taskDirectory: string, options: { graphUrl: string }) => {
    const config = loadTaskConfig(taskDirectory);
    const ids = await prepareTaskProjects(config, new GraphClient(options.graphUrl));
    for (const id of ids) process.stdout.write(`[peak] project: ${id}\n`);
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

const imageCommand = program.command("image")
  .description("Manage the Peak task image");

imageCommand.command("pull")
  .description("Pull the task image for this Peak version")
  .option("--force", "Pull even when the image is already cached", false)
  .action((options: { force: boolean }) => {
    requireDocker();
    const image = pullTaskImage(packageVersion(), options.force);
    process.stdout.write(`[peak] image ready: ${image}\n`);
  });

program.command("workers")
  .description("List supported Worker and task types")
  .action(() => {
    process.stdout.write(`${JSON.stringify({ workerTypes: WORKER_TYPES, taskTypes: TASK_TYPES }, null, 2)}\n`);
  });

try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function runForeground(
  taskDirectory: string,
  options: RunOptions,
  projectId: string | undefined,
  mode: "start" | "resume",
): Promise<void> {
  const lifecycle = shutdownLifecycle();
  const config = loadTaskConfig(taskDirectory);
  const execution = config.execution.mode;
  let dockerImage = options.dockerImage;
  if (execution === "docker") {
    try {
      requireDocker();
      dockerImage ??= resolveTaskImage(packageVersion());
      requireTaskContainer(dockerImage, config.execution.networkMode);
    } catch (error) {
      process.stderr.write(`[peak] ${(error as Error).message}\n[peak] falling back to local mode for this Task\n`);
      dockerImage = undefined;
    }
  }
  const runtimeId = randomBytes(4).toString("hex");
  const taskName = config.board.name ?? basename(config.taskDir);
  let monitorError: unknown;
  const runtime = new AgentRuntime(config, {
    peakHome: options.peakHome,
    installSkills: options.installSkills,
    graphUrl: options.graphUrl,
    projectsRoot: options.projectsRoot,
    execution: execution === "docker" && dockerImage ? "docker" : "local",
    dockerImage,
    registration: {
      taskName,
      boardDir: config.taskDir,
      mode,
      runtimeId,
      pid: process.pid,
      container: null,
      graphUrl: options.graphUrl,
      webUrl: null,
    },
    onLeaseLost(error) {
      monitorError = error;
      lifecycle.request();
    },
  });
  // Record process-level crashes in every Project's main.log, then keep the
  // default crash behavior (message + stack on stderr, non-zero exit).
  const crash = (kind: "uncaughtException" | "unhandledRejection") => (error: unknown): void => {
    runtime.logCrash(kind, error);
    process.stderr.write(`[peak] ${kind}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  };
  const uncaughtCrash = crash("uncaughtException");
  const rejectionCrash = crash("unhandledRejection");
  try {
    const projects = await runtime.start(options.project, projectId);
    // Startup errors are ordinary CLI failures. Crash handlers are installed
    // only after Runtime resources and leases have started successfully.
    process.once("uncaughtException", uncaughtCrash);
    process.once("unhandledRejection", rejectionCrash);
    process.stdout.write([
      `[peak] board: ${runtime.config.board.name ?? "board"}`,
      ...projects.flatMap((project) => [`[peak] source: ${project.title}`, `[peak] id: ${project.id}`]),
      `[peak] graph: ${runtime.endpointUrl}`,
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
    process.removeListener("uncaughtException", uncaughtCrash);
    process.removeListener("unhandledRejection", rejectionCrash);
    lifecycle.dispose();
    await runtime.stop();
  }
}

async function serveForeground(options: ServeOptions): Promise<void> {
  const lifecycle = shutdownLifecycle();
  const paths = initializePeakPaths(options.peakHome);
  const unregister = registerServerProcess(paths.peakHome);
  const registry = new ProjectStoreRegistry(paths.projectsDir);
  const extensions: ApiExtension[] = [projectRegistrationExtension(paths.peakHome)];
  const taskContext: TaskManagerContext = {
    peakHome: paths.peakHome,
    projectsDir: paths.projectsDir,
    registry,
    cliEntry: fileURLToPath(import.meta.url),
    serveUrl: "",
  };
  extensions.push(taskManagerExtension(taskContext));
  const server = new GraphHttpServer(
    registry,
    serveDashboard,
    extensions,
    (taskName) => taskFederationProjectIds(paths.peakHome, taskName),
  );
  try {
    await server.start({ host: options.host, port: parsePort(options.port) });
    const loopback = new URL(server.baseUrl);
    loopback.hostname = "127.0.0.1";
    taskContext.serveUrl = loopback.toString().replace(/\/$/, "");
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

async function launchBackground(peakHomeOption: string | undefined, kind: "serve" | "task"): Promise<void> {
  const paths = initializePeakPaths(peakHomeOption);
  if (kind === "serve") {
    const current = getServerProcessStatus(paths.peakHome);
    if (current.running) throw new Error(`Peak server is already running (pid ${current.pid})`);
  }
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
  // Serve readiness is quick; a task Runtime may spend minutes on first-time
  // image pull and container setup (docker mode) before it registers.
  const deadline = Date.now() + (kind === "serve" ? 15_000 : 120_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Peak background ${kind} exited with code ${child.exitCode}; see ${logPath}`);
    }
    if (kind === "serve") {
      const status = getServerProcessStatus(paths.peakHome);
      if (status.running && status.pid === child.pid && status.webUrl) {
        child.unref();
        const output = [
          `[peak] server: running`,
          `[peak] pid: ${status.pid}`,
          `[peak] web: ${status.webUrl}`,
          `[peak] log: ${logPath}`,
          "",
        ].join("\n");
        process.stdout.write(output);
        return;
      }
    } else {
      // A task Runtime is ready once its registration carries an endpoint
      // URL; run/resume no longer occupy the single server.pid slot.
      const ready = listProjectRegistrations(paths.peakHome)
        .find((entry) => entry.pid === child.pid && (entry.webUrl ?? entry.graphUrl));
      const readyUrl = ready?.webUrl ?? ready?.graphUrl;
      if (ready && readyUrl) {
        child.unref();
        const output = [
          `[peak] task: running`,
          `[peak] pid: ${child.pid ?? "unknown"}`,
          `[peak] web: ${readyUrl}`,
          `[peak] log: ${logPath}`,
          "",
        ].join("\n");
        process.stdout.write(output);
        return;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (kind === "task") {
    // The Dispatch is still initializing (image pull / container setup can
    // take minutes). It is healthy and will register when ready; killing it
    // here would throw away the work in flight.
    child.unref();
    process.stdout.write([
      `[peak] task: starting (may still be pulling the task image or creating its container); see ${logPath}`,
      `[peak] monitor with: peak status`,
      "",
    ].join("\n"));
    return;
  }
  try { process.kill(child.pid!, "SIGTERM"); } catch { /* best effort */ }
  throw new Error(`Peak background ${kind} did not become ready; see ${logPath}`);
}

function printServerStatus(options: ArchiveOptions): void {
  const paths = initializePeakPaths(options.peakHome);
  const status = getServerProcessStatus(paths.peakHome);
  const lines: string[] = [];
  if (status.running) {
    lines.push(
      "[peak] server: running",
      `[peak] pid: ${status.pid}`,
      `[peak] mode: ${status.mode ?? "unknown"}`,
      `[peak] web: ${status.webUrl ?? "starting"}`,
      `[peak] started: ${status.startedAt ?? "unknown"}`,
      `[peak] board: ${status.boardDir ?? "none"}`,
    );
  } else {
    lines.push("[peak] server: stopped");
  }
  lines.push(`[peak] log: ${serverLogPath(paths.peakHome)}`);
  const registrations = listProjectRegistrations(paths.peakHome);
  const runtimes = new Map<string, typeof registrations>();
  for (const entry of registrations) {
    const group = runtimes.get(entry.runtimeId) ?? [];
    group.push(entry);
    runtimes.set(entry.runtimeId, group);
  }
  for (const entries of runtimes.values()) {
    const first = entries[0]!;
    lines.push(
      `[peak] task: ${first.taskName} (${first.mode}, ${first.container ? `container ${first.container}` : `pid ${first.pid ?? "unknown"}`})`,
      `[peak]   board: ${first.boardDir}`,
      `[peak]   web: ${first.webUrl ?? first.graphUrl ?? "none"}`,
      `[peak]   started: ${first.startedAt}`,
      ...entries.map((entry) => `[peak]   project: ${entry.projectId}`),
    );
  }
  if (runtimes.size === 0) lines.push("[peak] tasks: none");
  process.stdout.write(`${lines.join("\n")}\n\n`);
}

async function stopOneTask(peakHome: string, taskName: string): Promise<void> {
  const before = listProjectRegistrations(peakHome).filter((entry) => entry.taskName === taskName);
  if (before.length === 0) {
    process.stdout.write(`[peak] no task named: ${taskName}\n`);
    return;
  }
  await stopTask({ peakHome }, taskName);
  process.stdout.write(`[peak] stopped task: ${taskName}\n`);
}

async function stopEverything(peakHome: string): Promise<void> {
  const registrations = listProjectRegistrations(peakHome);
  const pids = [...new Set(registrations.map((entry) => entry.pid).filter((pid): pid is number => pid !== null))]
    .filter(isProcessAlive);
  // Container tasks: docker stop by container name, then deregister. A
  // container that is already gone is a stale entry and is only deregistered.
  const containers = new Map<string, Set<string>>();
  for (const entry of registrations) {
    if (!entry.container) continue;
    const runtimeIds = containers.get(entry.container) ?? new Set<string>();
    runtimeIds.add(entry.runtimeId);
    containers.set(entry.container, runtimeIds);
  }
  let stopped = 0;
  for (const [container, runtimeIds] of containers) {
    try {
      if (dockerContainerState(container) === "running") dockerStop(container);
      for (const runtimeId of runtimeIds) deregisterRuntime(peakHome, runtimeId);
      process.stdout.write(`[peak] stopped container task: ${container}\n`);
      stopped += 1;
    } catch (error) {
      process.stderr.write(`[peak] failed to stop container ${container}: ${(error as Error).message}\n`);
    }
  }
  for (const pid of pids) {
    await terminateProcess(pid);
    for (const runtimeId of new Set(registrations.filter((entry) => entry.pid === pid).map((entry) => entry.runtimeId))) {
      deregisterRuntime(peakHome, runtimeId);
    }
    process.stdout.write(`[peak] stopped task: ${pid}\n`);
    stopped += 1;
  }
  if (getServerProcessStatus(peakHome).running) {
    const pid = await stopServerProcess(peakHome);
    process.stdout.write(`[peak] stopped server: ${pid}\n`);
    stopped += 1;
  }
  if (stopped === 0) process.stdout.write("[peak] nothing to stop\n");
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
