#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadTaskConfig } from "./config/task-config.js";
import { GraphHttpServer } from "./graph/http-server.js";
import { ProjectStoreRegistry } from "./graph/project-store-registry.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";

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
  .argument("<task>", "task.json path")
  .option("--project <title>")
  .option("--host <host>", "HTTP host", "127.0.0.1")
  .option("--port <port>", "HTTP port", "0")
  .option("--token <token>")
  .option("--peak-home <directory>")
  .option("--no-install-skills")
  .action((task: string, options: RunOptions) => run(task, options));

program.command("resume")
  .argument("<project-id>")
  .argument("<task>", "task.json path")
  .option("--host <host>", "HTTP host", "127.0.0.1")
  .option("--port <port>", "HTTP port", "0")
  .option("--token <token>")
  .option("--peak-home <directory>")
  .option("--no-install-skills")
  .action((projectId: string, task: string, options: RunOptions) => run(task, options, projectId));

program.command("serve")
  .description("Serve the Graph UI and API until interrupted")
  .option("--host <host>", "HTTP host", "127.0.0.1")
  .option("--port <port>", "HTTP port", "8000")
  .option("--token <token>")
  .option("--peak-home <directory>")
  .action((options: ServerOptions) => serve(options));

program.command("init")
  .argument("<directory>")
  .action((directory: string) => {
    const root = resolve(directory);
    mkdirSync(join(root, "skills"), { recursive: true });
    const path = join(root, "task.json");
    if (existsSync(path)) throw new Error(`task already exists: ${path}`);
    writeFileSync(path, `${JSON.stringify({
      task: { name: "peak-task", target: "Describe the starting state", goal: "Describe the proven goal", workspace: ".", skills: [] },
      workers: { default: { type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 2, priority: 1, args: [] } },
    }, null, 2)}\n`);
    process.stdout.write(`created: ${path}\n`);
  });

program.command("workers").action(() => {
  process.stdout.write(`${JSON.stringify({ workerTypes: ["opencode", "codex", "pi", "claude-code"], taskTypes: ["plan", "supervise", "execute"] }, null, 2)}\n`);
});

await program.parseAsync();

async function run(task: string, options: RunOptions, projectId?: string): Promise<void> {
  const lifecycle = shutdownLifecycle();
  const runtime = new AgentRuntime(loadTaskConfig(task), {
    host: options.host,
    port: parsePort(options.port),
    token: options.token,
    peakHome: options.peakHome,
    installSkills: options.installSkills,
  });
  let monitorError: unknown;
  try {
    const project = await runtime.start(options.project, projectId);
    process.stdout.write([
      `[peak] project: ${project.title}`,
      `[peak] id: ${project.id}`,
      `[peak] web: ${runtime.webUrl}`,
      "[peak] running; press Ctrl+C to stop",
      "",
    ].join("\n"));
    void runtime.wait(project.id).then((finished) => {
      process.stdout.write(`[peak] project status: ${finished.status}; web server remains available\n`);
    }).catch((error: unknown) => {
      monitorError = error;
      lifecycle.request();
    });
    await lifecycle.promise;
    if (monitorError) throw monitorError;
  } finally {
    lifecycle.dispose();
    await runtime.stop();
  }
}

async function serve(options: ServerOptions): Promise<void> {
  const lifecycle = shutdownLifecycle();
  const peakHome = resolve(options.peakHome ?? process.env.PEAK_HOME ?? join(homedir(), ".peak"));
  const registry = new ProjectStoreRegistry(join(peakHome, "projects"));
  const server = new GraphHttpServer(registry);
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
