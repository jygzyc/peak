# AGENTS.md

Coding guidance for the optional TypeScript `peak` package.

## Package role

- `peak` is a standalone npm package (`@jygzyc/peak`) with its own `peak` binary.
- Treat it as a generic configured agent runtime. Do not add fixed business task subcommands.
- Keep domain-specific behavior in task config, prompts, rules, and skills rather than hardcoding it in source.

## Architecture

`peak` implements a configured multi-Agent control plane:

```text
GlobalSupervisor / AgentRuntime
  -> manages multiple SessionLoops
  -> global resource scheduling, worker quota, HTTP/API
  -> coordinates cross-session broadcasts without a separate database

SessionLoop(session)
  -> owns the session-local Graph
  -> owns the session-local MainAgent / Planner
  -> owns the session-local MetacogSupervisor
  -> controls active role executions in memory
  -> writes context/output JSON and main.log under sessions/<uuid>/logs
  -> writes back to the session Graph via permission-checked DecisionApplier

SubagentProfile
  = runtime + prompt + context policy + permissions + output contract + maxActive

Graph
  = persistent analysis truth per session: Fact / Intent / Hint / Directive / Link / Event
```

Core principles:

1. Source implements mechanism only — no hardcoded role semantics.
2. Roles, prompts, tools, skills, workers, permissions, and context policies come from configuration. A Worker's optional model is passed to its Agent CLI.
3. The Graph is the single session-local source of truth.
4. Main loop is easy to find: `session/session-loop.ts` (per-session) and `session/supervisor.ts` (global).
5. All four roles extend BaseAgent; live cancellation and concurrency are runtime state, while each execution writes only context/output JSON outside Graph.
6. Each active session has its own MainAgent/Planner and Metacog; the global layer only supervises.
7. Session-internal task state goes through Graph/events. Every pass Fact triggers metacog and one `{sessionId, factId, reason}` broadcast; FederationBus resolves the source Fact by reference and never writes either Session Graph.

Architecture and runtime data flow are documented in `docs/README.md` and `docs/data-flow.md`.

## Source layout

```text
src/
├── app/       # runtime composition root (AgentRuntime)
├── config/    # task/Agent/default config and prompt-loader
├── session/   # SessionLoop, GlobalSupervisor, MetacogSupervisor, SessionCoordinator, SessionManager
├── agent/     # MainAgent, DecisionApplier, contracts, permissions, context-builder, graph-view,
│              # parse-envelope, prompts/builtins, and role implementations
├── graph/     # Graph interface, persistent SQLite store, FederatedGraph, FederationBus
├── worker/    # BaseWorker, four Agent CLI workers, runtime pool, mock worker
├── server/    # HTTP API and embedded dashboard
├── cli.ts     # CLI entrypoint
└── index.ts   # public exports
```

## Config model

A Task file has one narrow top-level schema:

```text
task
agent       (optional task-local <name>.json bundle)
workers
scheduler   (optional — scheduler resource knobs only; NOT a "workflow")
federation  (optional scope)
```

Important points:

- `task.target` and `task.goal` are required.
- `agent` selects exactly one role bundle beside `task.json`. Omit it to use the native four roles.
- Agent files contain `roles`; custom ids may provide multiple roles of one protocol type, such as `explorer_gather` and `explorer_analysis`.
- A role config may set Worker refs, prompt, tools, skills, context and execution knobs. Permissions and output contracts are fixed by the four protocol roles and cannot be overridden. Permissions govern Graph mutations only; the control plane builds each role's Graph context from its fixed profile context policy and passes only the resulting JSON artifact to the Worker.
- `workers` defines named CLI workers: `type` is `opencode | codex | pi | claude-code`; optional fields are `model`, `args`, and `timeoutMs`.
- **There is no `workflow` concept.** Termination is natural (planner produces no new intent). `scheduler` (`maxConcurrent`/`refillPerTick`) is the only top-level execution knob and is optional. A `workflow` field is rejected as outside the first-version config schema.
- Old `profiles`, `agents` arrays, `control`, `task.session`, and `workflow` fields are rejected.

## Task workspace and Peak home

Task configuration is self-contained:

```text
workspace/
├── task.json
├── <task-agent>.json
└── skills/<skill>/SKILL.md
```

Persistent Session state lives under `PEAK_HOME` (default `~/.peak`):

```text
~/.peak/
└── sessions/
    ├── .session.yaml
    └── <uuid>/
        ├── analysis.db
        └── logs/<timestamp>-<role>-context|output.json + main.log
```

- A Task's singular `agent` references `<task-dir>/<name>.json`; role Worker refs must resolve in the Task's `workers`.
- Role Skill entries are names, never paths. Task initialization validates `<task-dir>/skills/<name>/SKILL.md` and links it to `~/.agents/skills` for OpenCode/Pi or `~/.claude/skills` for Claude Code. Existing real directories are never overwritten.
- Session display name: `--session` > `task.name` > derived from `task.target` > derived from the task directory. The state directory always uses a random UUID.
- `ensurePeakLayout()` creates only `sessions/`.

## Graph model

Graph state is session-local and is the source of truth:

- Projects
- Facts (`candidate` -> `pass` / `deny` / `pending`)
- Intents (`open` -> `claimed` -> `pass` / `deny`)
- Hints
- Directives
- Links
- Events
- Dead-end route hashes

Role execution state is intentionally not part of Graph. Active controllers, cancellation, and concurrency live in memory; only timestamped context/output files and Graph operation `main.log` remain as history.

Intent stores only task state (`open/claimed/pass/deny`). Worker ownership, lease epochs, heartbeats, retry counters, and planner cooldowns are not Graph data. A new SessionLoop reopens orphaned `claimed` Intents. Broadcast send/receive history is JSONL in each Session's `logs/main.log`; FederationBus rebuilds its in-memory queue from those logs and owns no database.

Do not introduce domain-specific fact enums. Keep domain meaning in descriptions, evidence, prompts, and references.

## Agent protocol layer

- `agent/permissions.ts` — PermissionChecker enforces per-profile capability tokens before any graph mutation.
- `agent/contracts.ts` — named output validators (main_decision, candidate_fact, verdict, hints, stop, chain).
- `agent/context-builder.ts` — assembles dynamic prompt context from the graph per profile.context.
- `agent/graph-view.ts` — renders graph state per view policy (full / focused / evidence-only / summary).
- `agent/main-agent.ts` — session-local MainAgent wrapper around the planner profile.
- `agent/decision-applier.ts` — applies MainDecision to the graph with permission checks.
- `agent/parse-envelope.ts` — JSON envelope extraction shared by stages, contracts, and the applier.

## Workers

Worker adapters are bottom-layer execution only. They must not own graph state, Agent prompt policy, or scheduling policy.

- `BaseWorker` owns subprocess execution, stdin, timeout, cancellation, output limits, and result shaping.
- `OpenCodeWorker`, `CodexWorker`, `PiWorker`, and `ClaudeCodeWorker` inherit `BaseWorker` and implement only CLI arguments plus JSON result parsing.
- `BaseAgent` supplies the complete role input assembled from prompt, tools, skills, context, assignment, and output contract.
- Worker `model` is passed to the selected CLI's `--model`; authentication and provider configuration stay in that CLI.
- Peak has no direct model API/SDK path, no HTTP Worker, and no `providers.json`.

## Editing gotchas

- Worker configuration has one taxonomy only: `WorkerConfig.type`. Do not reintroduce `kind`, `backend`, `transport`, Provider, or API Worker layers.
- **Windows path handling in scripts:** use `fileURLToPath(new URL("..", import.meta.url))` for the repo root, never `new URL("..", import.meta.url).pathname` (yields a malformed `\\E:\\` drive path on Windows). When deleting SQLite-backed session dirs in tests, `close()` the graph handle before `rmSync` (open files fail with EPERM on Windows).
- **Session ids are filesystem-derived.** `SessionManager` sanitizes them via `safeSessionName` and rejects paths that escape `baseDir` — never bypass `sessionDir()` by joining `baseDir` with a raw id.

## Validation

This repo *is* the package root (there is no nested `peak/` directory). Run all commands from the repo root:

```bash
npm run typecheck   # tsc --noEmit — fast, run before commits
npm run build       # clean + tsc + copy dashboard.html → dist/
npm test            # builds first, then node --test tests/*.test.ts
npm run smoke       # exercises the built CLI; requires dist/cli.js (build first)
npm run pack        # builds the npm tarball into dist-packages/
```

Testing conventions:

- Tests import compiled output via `../dist/**.js`, **never** `../src/`. `npm test` builds first for this reason — after editing source you must rebuild before tests see the change.
- `tests/helper.ts` provides `minimalConfig()`, `createProject()`, `freshSetup()` (on-disk TestGraph + MockWorker), and `env(kind, data)` (JSON envelope builder). Reuse these instead of hand-rolling fixtures.
- Builtin role system prompts live in `src/agent/prompts/*.ts` and are referenced as `builtin:<id>`; tests should use those identifiers rather than reaching into `src/` for prompt files.
- Focused run: `node --test tests/<name>.test.ts` (after a build).
