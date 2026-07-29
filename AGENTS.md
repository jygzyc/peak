# AGENTS.md

## Scope

Peak is a standalone TypeScript package and CLI for running generic, HTTP-native proof Graph projects. Keep Graph, scheduling, worker, federation, storage, and Web UI mechanisms domain-neutral. Domain behavior belongs in Skills.

Runtime requirements are ESM and Node.js `>=22.19.0`.

## Current Architecture

```text
AgentRuntime -> RuntimeScheduler -> ProjectLoop -> TaskExecutor
TaskExecutor -> GraphClient -> loopback HTTP -> GraphHttpServer
GraphHttpServer -> ProjectStoreRegistry -> private per-Project SQLite/Artifact stores
Optional Browser Web UI -> HTTP API -------> GraphHttpServer
TaskExecutor -> Plan | Supervise | Execute | Finalize -> WorkerRuntime
Plan -> current leaf Fact frontier + open Intents + Hints + pending Federation leaf FactRefs
WorkerRuntime -> WorkerDriver.execute
WorkerDriver -> Pi Agent SDK | CliWorkerDriver -> ProcessRunner -> Agent CLI
FederationBus -> leaf FactRef delivery recovered from each Project logs/main.log
```

The Graph is bound to `GraphHttpServer`: its HTTP API is the only live Graph protocol, including calls made by the in-process runtime. The Web UI is an optional, replaceable presentation client of that API, not part of the Graph protocol or a dependency of Graph state. The currently bundled dashboard is a distribution convenience. Workers receive a path to an immutable JSON Graph context, not a live Graph object.

## Non-Negotiable Boundaries

1. Do not bypass `GraphClient` for runtime Graph reads or writes.
2. Only `graph/http-server.ts` and `graph/project-store-registry.ts` may import `sqlite-store.ts` or `artifact-store.ts`.
3. Projects use UUID ids and independent `analysis.db` shards.
4. Cross-Project proof persists only `FactRef`; never copy source Fact entities or Artifacts into the target Project. A `FactRef` is an immutable hyperlink node with exactly `{projectId, factId, description}`; `description` must equal the referenced immutable Fact summary. Federation broadcasts the current leaf frontier as complete FactRefs: a new downstream Fact retires its consumed local source FactRefs from unhandled target pending queues, while already persisted target Graph references remain immutable.
5. Project completion is immediate and independent after a valid Goal proof. It does not wait for another Project or pending federation delivery.
6. Facts are immutable. Every ordinary Fact has a non-empty, trimmed description of at most 1 KiB UTF-8; it is a concise summary, while detailed content belongs in an Artifact. Intent descriptions are at most 2 KiB UTF-8. Hint content and other persisted short labels are at most 1 KiB UTF-8. The reserved `origin` and `goal` Fact descriptions use the maximum 4 KiB UTF-8 limit.
7. Active executions, cancellation, worker cooldowns, retained Agent sessions, reservations, and scheduling checkpoints stay in memory.
8. Workers never receive Graph/store instances, SQLite paths, Server URL/token, HTTP credentials, or `FederationBus`.
9. Board customization is Skill-only. Do not add configurable roles, workflows, custom prompts, permissions, provider credentials, or direct provider API clients.
10. The Pi Agent SDK is the sole in-process Agent integration. Do not add another model/provider SDK without an explicit architecture change.
11. Built-in prompts live in `src/runtime/prompts/`; Board files cannot override them.
12. Do not add compatibility layers for the removed Session/four-role architecture.
13. `graph/` must not import `ui/`; Runtime/CLI composition may inject the optional UI root handler into `GraphHttpServer`.
14. Every SDK or CLI Worker backend implements the same `WorkerDriver.execute()`/`dispose()` contract; `WorkerRuntime` must not branch on backend implementation style.

Do not recreate top-level `agent/`, `app/`, `server/`, `client/`, `session/`, or `task/` directories.

## Source Layout

```text
src/config/   Strict Board schema/defaults, configured path initialization, Board scaffolding, and Skill installation
src/graph/    Graph types/API/client/server, private stores, federation, and exports
src/ui/       Optional bundled dashboard presentation layer
src/project/  ProjectManager, ProjectLoop, and GraphSupervisor timing
src/runtime/  Runtime composition, scheduler, execution registry, contracts, contexts, prompts
src/worker/   Pi Agent SDK integration, Agent CLI drivers, resource selection, ProcessRunner
src/cli.ts    run/resume/serve/init/workers commands and process signal lifecycle
```

## Graph Model and Persistence

A Board is a Project collection with no Goal or Graph of its own. `board.projects` is a non-empty array of `{id?, name, goal}`. `peak run` creates entries whose id is empty, atomically writes generated UUIDs back to `task.json`, and attaches entries with existing ids. `--project <name>` intentionally runs only one configured Project. Every Project receives a generated immutable origin description and its configured goal. A `FactRef` has exactly `projectId`, `factId`, and the referenced immutable Fact `description`; it is rendered as an independently understandable hyperlink node and is validated against the source Fact. A normal Intent has one or more `FactRef` sources and `to: null` while open; conclusion atomically creates one local Fact and fills `to`. Completion creates the single Intent targeting the current Project's `goal` and marks that Project `completed` in the same transaction.

Hints are independent Graph inputs. They may be added to active, stopped, or completed Projects, but adding a Hint does not resume or reopen a Project. Reopen must be explicit and records external feedback as a new Fact/Intent.

```text
~/.peak/projects/<uuid>/
├── analysis.db
├── artifacts/<sha256>
└── logs/
    ├── main.log
    └── graph-<monotonic-utc-timestamp>-<plan|supervise|execute|finalize>.json
```

SQLite contains only:

```text
project, artifacts, facts, intents, intent_sources, hints, counters
```

Do not add execution, lease, event, directive, verdict, dead-end, worker, session, or federation tables. Artifact bodies are content-addressed files; SQLite stores metadata and Fact references only. Unreferenced Artifacts are garbage-collected after the safety window.

Use `fileURLToPath()` for module URL paths. Validate UUIDs, hashes, workspace boundaries, symlinks, and Artifact sizes. Close SQLite handles before deleting test directories.

## Graph HTTP Server and Optional Web UI

- Graph behavior and persistence depend on the HTTP Server only; no Graph operation requires the Web UI.
- The UI reads and writes exclusively through the public HTTP API and may be omitted, replaced, or hosted separately.
- As a packaging convenience, Runtime/CLI inject the isolated `src/ui/` root handler so `GET /` serves `src/ui/dashboard.html`. A bare `GraphHttpServer` has no UI route. The HTML shell is intentionally reachable without bearer authentication so the browser can request a token.
- All `/api/*` routes require `Authorization: Bearer <token>` when `--token` is configured.
- Binding a non-loopback host requires a token.
- The dashboard is a self-contained HTML/CSS/JavaScript asset with no CDN dependency.
- It polls Project state, renders Facts as nodes, Intents as directed edges, and Hints as independent nodes.
- Human Hint entry is through the dashboard and writes `POST /api/projects/{id}/hints`; the creator defaults to `human:web` and is editable.
- The UI also exposes Project stop/resume, explicit reopen, details, pan/zoom/fit, and JSON snapshot export.
- UI changes must preserve token handling, auto-refresh, immutable Graph semantics, and mobile layout.

Lifecycle behavior:

- `peak run` creates or reattaches all configured Board Projects unless one Project name is selected, starts the Graph server and scheduler, prints every Project plus the Web URL, and remains alive after Projects become `stopped` or `completed`.
- `peak resume` attaches one persisted Project by UUID and validates its configured Goal; `--project <name>` resolves ambiguous goal matches.
- A Project UUID may appear in another Board to reuse the same Graph, but the same active Project must not be scheduled concurrently by multiple Runtime processes.
- They shut down only on `SIGINT`, `SIGTERM`, or a fatal monitor error. Shutdown stops scheduling, cancels executions, disposes retained Pi sessions, closes HTTP, then closes SQLite stores.
- `peak serve` starts the persisted Graph API, with no scheduler or workers, and also exposes the bundled optional UI; it remains alive until `SIGINT`/`SIGTERM`.
- Default ports are ephemeral (`0`) for `run`/`resume` and `8000` for `serve`.

## Runtime and Worker Behavior

ProjectLoop schedules, in order per tick, due Supervise work, needed Plan work, then open Intent execution, subject to global and per-Project slots. Plan receives only the current proof frontier: local leaf Facts that have not produced a later local Fact, open Intents, Hints, and pending Federation leaf FactRefs. Every available FactRef already contains the canonical `projectId`, `factId`, and `description`; Plan selects and returns that complete node without fetching, enriching, stripping, or rewriting it. The reserved `goal` is never a source leaf. A non-active Project cancels its active in-memory executions.

Worker selection filters by task support, `maxRunning`, and retry cooldown, then sorts by priority, current load, and name. Reservations prevent over-selection before execution starts.

- `pi`: runs in-process through `@earendil-works/pi-coding-agent`; uses an in-memory Pi `SessionManager`; supports Pi model references and thinking levels; rejects CLI `args`.
- `opencode`: runs `opencode run --format json`; does not currently support Finalize resume.
- `codex`: runs `codex exec --json` and supports resume from its thread id.
- `claude-code`: runs `claude -p --output-format json` with an explicit session id and supports resume.

Execute may invoke Finalize once after any failed, timed-out, or malformed output when execution started, was not externally cancelled, the Project/Intent is still active/open, and a resumable session exists. Pi Execute sessions retained for this path expire from memory after 10 minutes. Finalize returns the same Fact contract and never creates a separate Graph operation.

CLI subprocesses receive prompts through stdin, run in `board.workspace`, have bounded 10 MiB stdout/stderr capture, and are terminated as process trees on timeout/cancellation. Keep authentication and provider configuration owned by each Agent tool.

Worker contract parsing accepts the final fenced JSON block or outermost JSON object, then strictly rejects unknown/missing fields. Do not loosen the typed Plan/Supervise/Execute shapes.

## Config and Skills

Top-level configuration fields are exactly:

```text
board, workers, optional scheduler, optional phase
```

`board` contains only optional `name`, optional `workspace`, optional Skill names, and a non-empty `projects` array. Each Project contains exactly `id`, `name`, and `goal`; an omitted/empty id means create and persist one, while a UUID means attach and reuse. Project names and non-empty ids must be unique within a Board. `workers` is a non-empty array; Peak generates internal Worker identities. Empty Worker `model` means the Agent tool default. Board Projects share workspace, Skills, Workers, and scheduler limits while keeping independent UUID Graph shards and completion. Worker contexts include the full Board and identify the current Project.

Phase timeouts are fixed runtime policy and are not Board fields. Optional `phase` settings cover only Plan intent count, Supervise interval, and Execute Artifact size. Unknown fields are rejected recursively. At least one Worker must support `supervise`. Supported worker types are `opencode`, `codex`, `pi`, and `claude-code`; task types are `plan`, `supervise`, and `execute`.

`board.skills` is optional and contains Skill names only. For each configured Worker discovery directory, an already installed global `<name>/SKILL.md` is used directly. Only when that global Skill is absent does Peak require `<task-dir>/skills/<name>/SKILL.md` and create a temporary link:

- OpenCode and Pi discover `~/.agents/skills/<name>`.
- Claude Code discovers `~/.claude/skills/<name>`.
- Codex does not install Skills.
- Skill lifecycle is Board Runtime-scoped, not Project-scoped: one Board may manage multiple Projects, and temporary links remain until that Runtime shuts down.
- Pre-existing global Skills are never removed or overwritten.
- `peak init` does not create a `skills/` directory.

`loadTaskConfig()` is strict and side-effect free. Project UUID persistence is a separate atomic config operation used only after successful Project creation. All externally configured path resolution and initialization, Board scaffolding, UUID persistence, and Skill installation mechanisms live under `src/config/`. Skill initialization happens once when the Board Runtime starts unless `--no-install-skills` is used, and cleanup happens when that Runtime stops.

## Build, Tests, and Packaging

Tests import modular files from `dist/`, never directly from `src/`. `npm test` runs a clean TypeScript build first. HTTP/CLI tests must stop servers and close registries before removing temporary directories.

```bash
npm run typecheck
npm run build
npm test
npm run smoke
npm run pack
```

Run `npm run pack` last: its `prepack` phase replaces modular `dist/` with the production esbuild bundle, copies the UI to `dist/ui/`, copies runtime prompts, verifies `dist/cli.js workers`, and writes the tarball plus manifest under `dist-packages/`.
