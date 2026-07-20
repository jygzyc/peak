#!/usr/bin/env node

/**
 * Command-line interface for peak.
 *
 * Parses user commands for running, resuming, inspecting, serving, and managing
 * agent tasks, then delegates runtime construction to agent-runtime.ts. Keep this
 * file thin so the runtime can be reused by tests and future frontends.
 */

import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentRuntime } from "./app/agent-runtime.js";
import { loadConfig } from "./config/task-config.js";
import { SessionManager } from "./session/session-manager.js";
import { FederatedGraph } from "./graph/federated-graph.js";
import { FederationBus } from "./graph/federation-bus.js";
import { AgentDriverPool } from "./worker/agent-driver-pool.js";
import { MockWorker } from "./worker/mock-worker.js";
import { workerCapabilities } from "./worker/registry.js";
import { ensurePeakLayout, sessionsDir } from "./config/peak-home.js";
import { installTaskSkills } from "./config/task-skill-installer.js";

/**
 * Process-level coordinator shared by Session runtimes created in this process.
 * Broadcast history remains in each Session's logs/main.log.
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
  .option("--mock", "use MockWorker instead of real backends")
  .action(async (configPath: string, opts: {
    session?: string; port: string; host: string; httpToken?: string;
    http: boolean; mock: boolean;
  }) => {
    // Ensure the persistent Session layout exists before running.
    ensurePeakLayout();
    const { config, session, configPath: absPath } = loadConfig(configPath, opts.session);
    installTaskSkills(config, dirname(absPath));
    // Persist the session DB under ~/.peak/sessions/ so resume/status/sessions
    // (which default to the same location) can find it. The task file's own
    // directory is recorded on the project, not used as the store root.
    const baseDir = sessionsDir();
    // With --mock, register a default scenario so the loop runs end-to-end
    // (planner → explorer → evaluator → verified fact) without a real backend.
    const workerPool = opts.mock ? new MockWorker().registerDefaults() : new AgentDriverPool();

    const sessionManager = new SessionManager(baseDir);
    const active = sessionManager.create(session);
    const federationBus = sharedFederationBus ??= new FederationBus();

    const runtime = new AgentRuntime(config, {
      baseDir,
      workerPool,
      useHttp: opts.http,
      federationBus,
      sessionId: active.id,
    });

    const projectId = runtime.createProject({
      session,
      configPath: absPath,
    });

    console.log(`[peak] session: ${session} (${active.id})`);
    console.log(`[peak] project: ${projectId}`);
    console.log(`[peak] target: ${config.task.target}`);
    console.log(`[peak] goal: ${config.task.goal}`);

    if (opts.http) {
      await runtime.startHttp({ host: opts.host, port: parseInt(opts.port), token: opts.httpToken });
      console.log(`[peak] dashboard: http://${opts.host}:${opts.port}`);
    }
    console.log("[peak] metacog: synchronous (reviews every pass Fact and final proposal)");
    console.log("[peak] running...");
    const result = await runtime.run(projectId);
    console.log(`[peak] finished: ${result.type}`);
    if (result.type === "failed") {
      console.error(`[peak] failure: ${result.reason}`);
      process.exitCode = 1;
    }

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
  .command("resume [session]")
  .description("Resume a stopped/paused session")
  .option("-P, --port <port>", "HTTP server port", "25429")
  .option("--http-token <token>", "protect HTTP control endpoints (or set PEAK_HTTP_TOKEN)", process.env.PEAK_HTTP_TOKEN)
  .option("--no-http", "disable HTTP server")
  .action(async (session: string | undefined, opts: { port: string; httpToken?: string; http: boolean }) => {
    const sm = new SessionManager(sessionsDir());
    const selected = sm.resolve(session);
    if (!selected) {
      console.error(`session not found: ${session ?? "active"}`);
      process.exit(1);
    }
    sm.activate(selected);
    const graph = sm.open(selected.id);
    const projects = graph.listProjects();
    if (projects.length === 0) {
      console.error(`no projects in session: ${selected.name}`);
      process.exit(1);
    }
    const project = projects[0];
    graph.updateProjectStatus(project.id, "active");

    const config = project.taskConfig;
    installTaskSkills(config, dirname(project.configPath));
    (graph as { close?: () => void }).close?.();
    const pool = new AgentDriverPool();
    const federationBus = sharedFederationBus ??= new FederationBus();
    const runtime = new AgentRuntime(config, {
      baseDir: sessionsDir(),
      workerPool: pool,
      useHttp: opts.http,
      federationBus,
      sessionId: selected.id,
    });
    const projectId = runtime.createProject({
      session: selected.name,
      configPath: project.configPath,
    });
    if (opts.http) {
      await runtime.startHttp({ port: parseInt(opts.port), token: opts.httpToken });
      console.log(`[peak] dashboard: http://127.0.0.1:${opts.port}`);
    }

    console.log(`[peak] resuming project: ${projectId}`);
    const result = await runtime.run(projectId);
    console.log(`[peak] finished: ${result.type}`);
    if (result.type === "failed") {
      console.error(`[peak] failure: ${result.reason}`);
      process.exitCode = 1;
    }
    await runtime.close();
  });

program
  .command("status [session]")
  .description("Show project status for a session")
  .action((session: string | undefined) => {
    const sm = new SessionManager(sessionsDir());
    const selected = sm.resolve(session);
    if (!selected) {
      console.log(`session not found: ${session ?? "active"}`);
      return;
    }
    const graph = sm.open(selected.id);
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
  .description("List available Agent CLI worker types")
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
      console.log(`  ${info.name ?? "unnamed"} ${s} (${info.dir})`);
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
    mkdirSync(join(dir, "skills"), { recursive: true });
    const config = {
      task: {
        target: "example-target",
        goal: "Describe what you want to analyze",
      },
      agent: "task-agent",
      workers: {
        opencode: { type: "opencode" },
      },
    };
    const agent = {
      roles: {
        planner: { worker: "opencode", tools: [], skills: [] },
        explorer: { worker: "opencode", tools: [], skills: [] },
        evaluator: { worker: "opencode", tools: [], skills: [] },
        metacog: { worker: "opencode", tools: [], skills: [] },
      },
    };
    const configPath = join(dir, "task.json");
    const agentPath = join(dir, "task-agent.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    writeFileSync(agentPath, JSON.stringify(agent, null, 2));
    console.log(`created: ${configPath}`);
    console.log(`created: ${agentPath}`);
    console.log(`created: ${join(dir, "skills")}`);
    console.log("edit task/agent/workers/skills, then run: peak run task.json");
  });

program.parse();
