#!/usr/bin/env node
import { Command } from "commander";
import { initializePeakPaths } from "./config/paths.js";
import { loadTaskConfig } from "./config/task-config.js";
import { initializeTaskDirectory } from "./config/task-initializer.js";
import { GraphHttpServer } from "./graph/http-server.js";
import { ProjectStoreRegistry } from "./graph/project-store-registry.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { serveDashboard } from "./ui/dashboard.js";

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

const program = new Command().name("peak").description("Distributed Graph agent runtime");

program.command("run")
  .argument("[board-directory]", "Board directory containing task.json", ".")
  .option("--project <name>", "Run only one configured Project by name; defaults to the full Board")
  .option("--host <host>", "HTTP host", "127.0.0.1")
  .option("--port <port>", "HTTP port", "0")
  .option("--token <token>")
  .option("--peak-home <directory>")
  .option("--no-install-skills")
  .action((taskDirectory: string, options: RunOptions) => run(taskDirectory, options));

program.command("resume")
  .argument("<project-id>")
  .argument("[board-directory]", "Board directory containing task.json", ".")
  .option("--project <name>", "Configured Project name when matching is ambiguous")
  .option("--host <host>", "HTTP host", "127.0.0.1")
  .option("--port <port>", "HTTP port", "0")
  .option("--token <token>")
  .option("--peak-home <directory>")
  .option("--no-install-skills")
  .action((projectId: string, taskDirectory: string, options: RunOptions) => run(taskDirectory, options, projectId));

program.command("serve")
  .description("Serve the Graph UI and API until interrupted")
  .option("--host <host>", "HTTP host", "127.0.0.1")
  .option("--port <port>", "HTTP port", "8000")
  .option("--token <token>")
  .option("--peak-home <directory>")
  .action((options: ServerOptions) => serve(options));

program.command("init")
  .argument("[board-directory]", "Board directory to initialize", ".")
  .action((directory: string) => {
    const paths = initializeTaskDirectory(directory);
    process.stdout.write(`created: ${paths.configPath}\n`);
  });

program.command("workers").action(() => {
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
        process.stdout.write(`[peak] project status: ${finished.title} (${finished.id}) ${finished.status}; web server remains available\n`);
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
