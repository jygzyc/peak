# AGENTS.md

Coding guidance for the optional TypeScript `peak` package.

## Package role

- `peak` is a standalone npm package (`@jygzyc/peak`) with its own `peak` binary.
- Treat it as a generic configured agent runtime. Do not add fixed business task subcommands.
- Keep domain-specific behavior in task config, prompts, rules, and skills rather than hardcoding it in source.

## Architecture

`peak` implements a profile-driven subagent control plane:

```text
GlobalSupervisor / AgentRuntime
  -> manages multiple SessionLoops
  -> global resource scheduling, worker quota, HTTP/API
  -> owns the cross-session FederationBus

SessionLoop(session)
  -> owns the session-local Graph
  -> owns the session-local MainAgent / Planner
  -> owns the session-local MetacogSupervisor
  -> creates / cancels session-local SubagentRuns
  -> writes back to the session Graph via permission-checked DecisionApplier

SubagentProfile
  = runtime + prompt + context policy + permissions + output contract + maxActive

Graph
  = single source of truth per session: Fact / Intent / Hint / Directive / Link / Event / SubagentRun
```

Core principles:

1. Source implements mechanism only — no hardcoded role semantics.
2. Roles, prompts, models, workers, permissions, and context policies come from configuration.
3. The Graph is the single session-local source of truth.
4. Main loop is easy to find: `session/session-loop.ts` (per-session) and `session/supervisor.ts` (global).
5. Explorer / Evaluator / Metacog are trackable, cancellable, configurable SubagentRuns.
6. Each active session has its own MainAgent/Planner and Metacog; the global layer only supervises.
7. Session-internal sync goes through Graph/events; cross-session insight goes through FederationBus (read-only summary + refs, never cross-session graph writes).

Per-file audit of `src/` (purpose, exports, dependencies, bugs, dead code per file) lives in `docs/` — start at `docs/README.md` for the cross-cutting findings summary and recommended audit order before touching `src/agent/`, `src/session/`, or `src/config/`.

## Source layout

```text
src/
├── app/       # runtime composition root (AgentRuntime)
├── config/    # task/default/provider config, profile-loader, prompt-loader
├── session/   # SessionLoop, GlobalSupervisor, MetacogSupervisor, SessionCoordinator, SessionManager
├── agent/     # MainAgent, DecisionApplier, contracts, permissions, context-builder, graph-view,
│              # parse-envelope, prompts/builtins, and role implementations
├── graph/     # Graph interface, SQLite/InMemory stores, FederatedGraph, FederationBus
├── worker/    # worker runtime, drivers, backends, providers, mock worker
├── server/    # HTTP API and embedded dashboard
├── cli.ts     # CLI entrypoint
└── index.ts   # public exports
```

## Config model

A `TaskConfig` is profiles-first:

```text
task
profiles
workers
scheduler   (optional — scheduler resource knobs only; NOT a "workflow")
control
```

Important points:

- `task.target` and `task.goal` are required.
- `profiles` declares SubagentProfiles. The built-in slots are `planner`, `explorer`, `evaluator`, and optional `metacog`; custom profiles (e.g. `source-finder`, `strict-reviewer`) live under arbitrary keys.
- A SubagentProfile binds together: `runtime` (worker + optional model), `prompt` (file/text/rules/knowledge), `context` (graphView + maxFacts), `permissions` (capability tokens), `output` (contract name), plus per-agent tuning knobs: `maxActive`, `cooldownSteps` (planner), `triggers` (metacog), `intervalSeconds`.
- `workers` defines low-level worker configs (`kind: "agent" | "api" | "mock"`).
- **There is no `workflow` concept.** Termination is natural (planner produces no new intent). `scheduler` (`maxConcurrent`/`refillPerTick`/`workerLeaseMs`) is the only top-level execution knob and is optional. A `workflow` field is rejected as outside the first-version config schema.
- `control.mainProfile` and `control.metacogProfile` select which profiles drive planning and metacognition. Metacog cadence belongs to `profiles.<id>.triggers.everySeconds`.

## Peak home layout (`~/.peak/`)

All persistent state lives under one root (`PEAK_HOME` env overrides; default `~/.peak`):

```text
~/.peak/
├── config.json          global baseline (default workers/control) — optional
├── agents/<name>.json   reusable role configs injected into builtin slots
├── tasks/<name>.json    task configs (target/goal/session + agent refs + workers)
├── sessions/<session>/  per-session execution state (analysis.db)
└── providers.json       model provider configs
```

- **Agent files are patches, not standalone profiles.** An agent file declares a builtin `slot` (planner/explorer/evaluator/metacog) and is deep-merged over that builtin profile — declared fields override, omitted fields keep the builtin default. Task `profiles` may additionally use arbitrary profile ids; `control.{mainProfile,explorerProfile,evaluatorProfile,metacogProfile}` binds one of them to each fixed protocol role, and SessionLoop validates that the profile's `role` matches. See `src/config/agent-loader.ts` and `src/session/session-loop.ts`.
- A task's `agents: ["name", ...]` array references `~/.peak/agents/<name>.json`; each agent may also bring its own `workers` (merged under the task's workers).
- Session name: `--session` > `task.session` > derived from `task.target` > derived from task filename.
- `~/.peak/config.json` baseline is merged between `defaultConfig()` and the task file.
- `ensurePeakLayout()` (called by `peak run`) idempotently creates `agents/`, `tasks/`, `sessions/`.

## Graph model

Graph state is session-local and is the source of truth:

- Projects
- Facts (`pending` -> `pass` / `deny`)
- Intents (`open` -> `claimed` -> `pass` / `deny`)
- Hints
- Directives
- Links
- Events
- SubagentRuns (`pending` -> `running` -> `completed` / `failed` / `cancelled`)
- Dead-end route hashes

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

Worker adapters are bottom-layer execution only. They must not own graph state or scheduling policy.

- `src/worker/agent-driver.ts` handles agent CLI/HTTP backends.
- `src/worker/api-driver.ts` handles direct model API providers.
- `src/worker/backends/` contains OpenCode, Codex, Claude Code, HTTP, and custom process adapters.
- `src/worker/providers/` contains direct model provider wiring.

Backends should stay thin: prompt in, text/process result out.

## Editing gotchas

- **Two different `WorkerRequest`/`WorkerResult` types exist.** `worker/worker-runtime.ts` (the agent-facing `WorkerPool` abstraction: `prompt`/`config`/`workerName`/`role`/`projectId`) vs `worker/base.ts` (the driver-internal contract: `worker`/`role`/`sessionDir`/`stdout`). They share names but not shape — `AgentDriverPool` hand-maps fields between them. Check which one a symbol refers to by import path.
- **`kind` taxonomy is inconsistent across layers.** `WorkerKind = "agent" | "api" | "mock"` in `agent/types.ts`; AGENTS.md prose and `workerCapabilities()` use `command`/`model`/`agent`/`api`. Don't assume one vocabulary.
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
