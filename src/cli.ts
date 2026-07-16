#!/usr/bin/env node

/**
 * Command-line interface for peak.
 *
 * Parses user commands for running, resuming, inspecting, serving, and managing
 * agent tasks, then delegates runtime construction to agent-runtime.ts. Keep this
 * file thin so the runtime can be reused by tests and future frontends.
 */

import { Command } from "commander";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime } from "./app/agent-runtime.js";
import { loadConfig } from "./config/task-config.js";
import { SqliteGraph } from "./graph/sqlite-graph.js";
import { SessionManager } from "./session/session-manager.js";
import { FederatedGraph } from "./graph/federated-graph.js";
import { FederationBus } from "./graph/federation-bus.js";
import { AgentDriverPool } from "./worker/agent-driver-pool.js";
import { MockWorker } from "./worker/mock-worker.js";
import { workerCapabilities } from "./worker/registry.js";
import { defaultConfig } from "./config/default-config.js";
import { ensurePeakLayout, sessionsDir, agentsDir, tasksDir, federationFile } from "./config/peak-home.js";

/**
 * Process-level singleton for cross-session federation. When `--federation` is
 * passed, every AgentRuntime constructed in this process shares this bus so
 * siblings can cross-validate candidates. A single `peak run` only creates one
 * runtime, so the flag is inert without multiple sessions; it exists for the
 * multi-session mode and for SDK callers wiring several runtimes together.
 */
let sharedFederationBus: FederationBus | undefined;

const program = new Command();

program
  .name("peak")
  .description("Generic configured agent runtime")
  .version("0.1.0");

program
  .command("run <configPath>")
  .description("Run a task from a task.json config file")
  .option("-s, --session <session>", "session name override")
  .option("-P, --port <port>", "HTTP server port", "25429")
  .option("--host <host>", "HTTP server host", "127.0.0.1")
  .option("--http-token <token>", "protect HTTP control endpoints (or set PEAK_HTTP_TOKEN)", process.env.PEAK_HTTP_TOKEN)
  .option("--no-http", "disable HTTP server")
  .option("--no-metacog", "disable metacog loop")
  .option("--mock", "use MockWorker instead of real backends")
  .option("--federation", "share verified facts across sessions (cross-session corroboration)")
  .action(async (configPath: string, opts: {
    session?: string; port: string; host: string; httpToken?: string;
    http: boolean; metacog: boolean; mock: boolean; federation: boolean;
  }) => {
    // Ensure the ~/.peak/{agents,tasks,sessions} layout exists before running,
    // so the session DB has a home and agents/tasks commands work afterward.
    ensurePeakLayout();
    const { config, session, configPath: absPath } = loadConfig(configPath, opts.session);
    // Write the resolved session name back so AgentRuntime opens the right DB.
    config.task.session = session;

    // Persist the session DB under ~/.peak/sessions/ so resume/status/sessions
    // (which default to the same location) can find it. The task file's own
    // directory is recorded on the project, not used as the store root.
    const baseDir = sessionsDir();
    // With --mock, register a default scenario so the loop runs end-to-end
    // (planner → explorer → evaluator → verified fact) without a real backend.
    const workerPool = opts.mock ? new MockWorker().registerDefaults() : new AgentDriverPool();

    // Cross-session federation: share verified facts and dead-ends with sibling
    // sessions. The bus is a process-level singleton so multiple runtimes in one
    // process cross-validate; a single-session run gains nothing but the flag is
    // harmless and ready for the multi-session mode.
    const federationBus = opts.federation
      ? (sharedFederationBus ??= new FederationBus({ dbPath: federationFile() }))
      : undefined;

    const runtime = new AgentRuntime(config, {
      baseDir,
      workerPool,
      useHttp: opts.http,
      useMetacogSupervisor: opts.metacog,
      federationBus,
      sessionId: federationBus ? session : undefined,
    });

    const projectId = runtime.createProject({
      session,
      configPath: absPath,
    });

    console.log(`[peak] session: ${session}`);
    console.log(`[peak] project: ${projectId}`);
    console.log(`[peak] target: ${config.task.target}`);
    console.log(`[peak] goal: ${config.task.goal}`);

    if (opts.http) {
      await runtime.startHttp({ host: opts.host, port: parseInt(opts.port), token: opts.httpToken });
      console.log(`[peak] dashboard: http://${opts.host}:${opts.port}`);
    }
    if (opts.metacog) {
      console.log("[peak] metacog: synchronous (reviews graph each step)");
    }
    if (opts.federation) {
      console.log(`[peak] federation: sharing verified facts as session "${session}"`);
    }

    console.log("[peak] running...");
    const result = await runtime.run(projectId);
    console.log(`[peak] finished: ${result.type}`);

    if (result.type === "completed") {
      const graph = runtime.graph;
      const facts = graph.facts(projectId, "pass");
      console.log(`[peak] passed facts: ${facts.length}`);
      for (const f of facts) {
        console.log(`  ${f.id}: ${f.description}`);
      }
    }

    if (!opts.http) await runtime.close();
  });

program
  .command("resume <session>")
  .description("Resume a stopped/paused session")
  .option("-P, --port <port>", "HTTP server port", "25429")
  .option("--http-token <token>", "protect HTTP control endpoints (or set PEAK_HTTP_TOKEN)", process.env.PEAK_HTTP_TOKEN)
  .option("--no-http", "disable HTTP server")
  .option("--federation", "share verified facts across sessions (cross-session corroboration)")
  .action(async (session: string, opts: { port: string; httpToken?: string; http: boolean; federation: boolean }) => {
    const sm = new SessionManager(sessionsDir());
    const info = sm.info(session);
    if (!info.exists) {
      console.error(`session not found: ${session}`);
      process.exit(1);
    }
    const graph = sm.open(session);
    const projects = graph.listProjects();
    if (projects.length === 0) {
      console.error(`no projects in session: ${session}`);
      process.exit(1);
    }
    const project = projects[0];
    graph.updateProjectStatus(project.id, "active");

    const config = project.taskConfig;
    config.task.session = session;
    (graph as { close?: () => void }).close?.();
    const pool = new AgentDriverPool();
    const federationBus = opts.federation
      ? (sharedFederationBus ??= new FederationBus({ dbPath: federationFile() }))
      : undefined;
    const runtime = new AgentRuntime(config, {
      baseDir: sessionsDir(),
      workerPool: pool,
      useHttp: opts.http,
      useMetacogSupervisor: true,
      federationBus,
      sessionId: federationBus ? session : undefined,
    });
    const projectId = runtime.createProject({
      session,
      configPath: project.configPath,
    });
    if (opts.http) {
      await runtime.startHttp({ port: parseInt(opts.port), token: opts.httpToken });
      console.log(`[peak] dashboard: http://127.0.0.1:${opts.port}`);
    }

    console.log(`[peak] resuming project: ${projectId}`);
    if (opts.federation) {
      console.log(`[peak] federation: sharing verified facts as session "${session}"`);
    }
    const result = await runtime.run(projectId);
    console.log(`[peak] finished: ${result.type}`);
    await runtime.close();
  });

program
  .command("status <session>")
  .description("Show project status for a session")
  .action((session: string) => {
    const sm = new SessionManager(sessionsDir());
    const info = sm.info(session);
    if (!info.exists) {
      console.log(`session not found: ${session}`);
      return;
    }
    const graph = sm.open(session);
    const projects = graph.listProjects();
    for (const p of projects) {
      const progress = graph.progress(p.id);
      console.log(`project: ${p.id}`);
      console.log(`  status: ${p.status}`);
      console.log(`  target: ${p.target}`);
      console.log(`  goal: ${p.goal}`);
      console.log(`  steps: ${progress.stepsExecuted}`);
      console.log(`  passed: ${progress.passFacts}`);
      console.log(`  candidate: ${progress.candidateFacts}`);
      console.log(`  pending: ${progress.pendingFacts}`);
      console.log(`  denied: ${progress.denyFacts}`);
      console.log(`  open intents: ${progress.openIntents}`);
    }
  });

program
  .command("workers")
  .description("List available worker backends and providers")
  .action(() => {
    const caps = workerCapabilities();
    console.log(JSON.stringify(caps, null, 2));
  });

program
  .command("sessions")
  .description("List all analysis sessions")
  .option("--base-dir <dir>", "base directory", sessionsDir())
  .action((opts: { baseDir: string }) => {
    const sm = new SessionManager(opts.baseDir);
    const sessions = sm.listSessions();
    if (sessions.length === 0) {
      console.log("no sessions found");
      return;
    }
    for (const s of sessions) {
      const info = sm.info(s);
      console.log(`  ${s} (${info.dir})`);
    }
  });

program
  .command("search <query>")
  .description("Search facts across all sessions")
  .option("--base-dir <dir>", "base directory", sessionsDir())
    .option("--status <status>", "filter by fact status (pass/pending/deny)")
  .option("--min-confidence <n>", "minimum confidence", parseFloat)
  .option("--limit <n>", "max results", parseInt, 50)
  .action((query: string, opts: {
    baseDir: string; status?: string; minConfidence?: number; limit: number;
  }) => {
    const sm = new SessionManager(opts.baseDir);
    const fed = new FederatedGraph(sm);
    const sessions = sm.listSessions();
    if (sessions.length === 0) {
      console.log("no sessions found");
      return;
    }
    const results = fed.searchFactsAcrossSessions(sessions, {
      query,
      status: opts.status as "candidate" | "pass" | "pending" | "deny" | undefined,
      minConfidence: opts.minConfidence,
      limit: opts.limit,
    });
    console.log(`found ${results.length} facts matching "${query}":`);
    for (const r of results) {
      console.log(`  [${r.sessionId}] ${r.fact.id} (${r.fact.status}, ${Math.round(r.fact.confidence * 100)}%): ${r.fact.description}`);
    }
  });

program
  .command("init [dir]")
  .description("Create a minimal task.json in the specified directory")
  .action((dir: string = ".") => {
    const config = defaultConfig();
    config.task.target = "example-target";
    config.task.goal = "Describe what you want to analyze";
    const configPath = join(dir, "task.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`created: ${configPath}`);
    console.log("edit target/goal/workers, then run: peak run task.json");
  });

program
  .command("agents")
  .description("List reusable agent configs in ~/.peak/agents/")
  .action(() => {
    const dir = agentsDir();
    if (!existsSync(dir)) {
      console.log("no agents directory; run a task first to initialize ~/.peak/");
      return;
    }
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => d.name.replace(/\.json$/, ""))
      .sort();
    if (names.length === 0) {
      console.log("no agent configs found");
      return;
    }
    for (const n of names) console.log(`  ${n}`);
    console.log(`\nreference these by name in a task's \`agents\` array`);
  });

program
  .command("tasks")
  .description("List task configs in ~/.peak/tasks/")
  .action(() => {
    const dir = tasksDir();
    if (!existsSync(dir)) {
      console.log("no tasks directory; run a task first to initialize ~/.peak/");
      return;
    }
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => d.name.replace(/\.json$/, ""))
      .sort();
    if (names.length === 0) {
      console.log("no task configs found");
      return;
    }
    for (const n of names) console.log(`  ${n}`);
  });

program.parse();
