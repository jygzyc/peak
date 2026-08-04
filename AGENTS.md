# AGENTS.md

## Scope

Peak is a standalone TypeScript package and CLI for running generic, HTTP-native proof Graph projects. Keep Graph, scheduling, worker, federation, storage, and Web UI mechanisms domain-neutral. Domain behavior belongs in Skills.

Runtime requirements are ESM and Node.js `>=22.19.0`.

## Current Architecture

```text
AgentRuntime -> RuntimeScheduler -> ProjectLoop -> TaskExecutor
TaskExecutor -> GraphClient -> loopback HTTP -> GraphHttpServer
GraphHttpServer -> ProjectStoreRegistry -> private per-Project SQLite/Artifact stores
GraphHttpServer -> optional apiExtensions (Runtime injects /api/runtime/*)
Optional Browser Web UI -> HTTP API -------> GraphHttpServer
TaskExecutor -> Plan | Supervise | Execute | Finalize -> WorkerRuntime
Plan -> source + goal + complete current leaf Fact frontier + open Intents + unconsumed Hints + pending Federation leaf FactRefs
WorkerRuntime -> ProcessRunner -> pi | opencode | codex | claude CLI
FederationBus -> leaf FactRef delivery recovered from each Project logs/main.log
RuntimeStatus -> in-memory heartbeatAt/sequence -> /api/runtime/status
ExecutionRegistry -> in-flight execution snapshots -> /api/runtime/projects/{id}/executions
```

The Graph is bound to `GraphHttpServer`: its HTTP API is the only live Graph protocol, including calls made by the in-process runtime. The Web UI is an optional, replaceable presentation client of that API, not part of the Graph protocol or a dependency of Graph state. The currently bundled dashboard is a distribution convenience. Runtime assembles a phase-specific read-only Graph view through `GraphClient`, injects it into the built-in Prompt, and writes the same context as an immutable audit snapshot; workers never receive a live Graph object.

## Non-Negotiable Boundaries

1. Do not bypass `GraphClient` for runtime Graph reads or writes.
2. Only `graph/http-server.ts` and `graph/project-store-registry.ts` may import `sqlite-store.ts` or `artifact-store.ts`.
3. Projects use UUID ids and independent `analysis.db` shards.
4. Cross-Project proof persists only `FactRef`; never copy source Fact entities or Artifacts into the target Project. A `FactRef` is an immutable hyperlink node with exactly `{projectId, factId, description}`; `description` must equal the referenced immutable Fact summary. Federation broadcasts the current leaf frontier as complete FactRefs: a new downstream Fact retires its consumed local source FactRefs from unhandled target pending queues, while already persisted target Graph references remain immutable.
5. Project completion is immediate and independent after a valid Goal proof. It does not wait for another Project or pending federation delivery.
6. Facts are immutable and may reference one immutable content-addressed Artifact. Every ordinary Fact has a non-empty, trimmed, independently understandable description of at most 1 KiB UTF-8; detailed content may live in its optional Artifact. Intent descriptions are at most 2 KiB UTF-8. Hint content and other persisted short labels are at most 1 KiB UTF-8. The reserved `origin` and `goal` Fact descriptions use the maximum 4 KiB UTF-8 limit.
7. Active executions, cancellation, worker cooldowns, reservations, runtime heartbeat, and scheduling checkpoints stay in memory. Runtime liveness, in-flight execution snapshots, Intent running state, and Worker load never enter SQLite, Graph, Artifact, or export.
8. Workers never receive Graph/store instances, SQLite paths, Server URL/token, HTTP credentials, or `FederationBus`.
9. Board customization remains domain-neutral. Skills provide reusable domain methods; `task.json` may additionally define an optional `customProfile` for Plan and Supervise and multiple selectable `customProfiles` for Execute. A profile is `{description,prompt}`: the description tells the AI when injection applies, while the prompt augments but never replaces the built-in phase prompt or contract. Intent persists only the selected Execute profile description and digest; Fact, Hint, and FactRef never persist profiles. Do not add configurable roles, workflows, permissions, provider credentials, or direct provider API clients.
10. Every Worker is a CLI subprocess driven through one shared `ProcessRunner`. Do not add an in-process model/provider SDK, WorkerHost, Pi RPC, or resident Worker pool without an explicit architecture change.
11. Built-in prompts live in `src/runtime/prompts/`; Board files cannot override them. Built-in Plan, Supervise, Execute, and Finalize instructions stay extremely concise: they provide context, immutable boundaries, and the strict output contract while leaving execution choices and judgment to the AI.
12. Do not add compatibility layers for the removed Session/four-role architecture.
13. `graph/` must not import `ui/` or `runtime/`; Runtime/CLI composition may inject the optional UI root handler and authenticated `apiExtensions` into `GraphHttpServer`.
14. Each Worker backend is a stateless `WorkerProtocol` (`build`/`prepareSession`/`parse`) describing only CLI argv construction and output/session parsing; `WorkerRuntime` drives the single shared `ProcessRunner` uniformly for every protocol and must not branch on backend implementation style.

Do not recreate top-level `agent/`, `app/`, `server/`, `client/`, `session/`, or `task/` directories.

## Source Layout

```text
src/config/   Strict Board schema/defaults, configured path initialization, Board scaffolding, and Skill installation
src/graph/    Graph types/API/client/server, private stores, federation, and exports
src/ui/       Optional bundled dashboard presentation layer
src/project/  ProjectManager, ProjectLoop, and GraphSupervisor timing
src/runtime/  Runtime composition, scheduler, execution registry, runtime status, contracts, contexts, prompts
src/worker/   Stateless CLI protocols (Pi/OpenCode/Codex/Claude Code), Worker selection, ProcessRunner
src/cli.ts    run/resume/serve/init/workers commands and process signal lifecycle
```

## Graph Model and Persistence

A Board is a Project collection with no Goal or Graph of its own. `board.projects` is a non-empty array of `{id?, source, goal}`. `peak run` creates entries whose id is empty, atomically writes generated UUIDs back to `task.json`, and attaches entries with existing ids. `--project <source>` intentionally runs only one configured Project. Every Project receives its configured `source` as the immutable `origin` description and its configured goal. A `FactRef` has exactly `projectId`, `factId`, and the referenced immutable Fact `description`; it is rendered as an independently understandable hyperlink node and is validated against the source Fact. A normal Intent has one or more current leaf `FactRef` sources and `to: null` while open; it represents one atomic, goal-directed DAG transition producing exactly one new Fact. Creating an Intent or completion from a historical non-leaf Fact is rejected. Conclusion atomically creates one local Fact with zero or one Artifact and fills `to`. Completion creates the single Intent from current leaves to the current Project's `goal` and marks that Project `completed` in the same transaction.

Hints are independent Graph inputs. They may be added to active, stopped, or completed Projects, but adding a Hint does not resume or reopen a Project. Reopen must be explicit and records external feedback as a new Fact reached from the completed Project's current local leaves, never from a historical root by default.

```text
~/.peak/projects/<uuid>/
├── analysis.db
├── artifacts/<sha256>
└── logs/
    ├── main.log
    └── graph-<YYYYMMDDTHHMMSS.XXX>-<8-hex-execution-id>-<plan|supervise|execute|finalize>.json
```

SQLite contains only:

```text
project, artifacts, facts, intents, intent_sources, hints, counters
```

Do not add execution, lease, event, directive, verdict, dead-end, worker, session, or federation tables. Artifact bodies are content-addressed files; SQLite stores metadata and Fact references only. Unreferenced Artifacts are garbage-collected after the safety window.

Use `fileURLToPath()` for module URL paths. Validate UUIDs, hashes, Artifact sizes, deliverable paths, and symlinks. Close SQLite handles before deleting test directories.

## Graph HTTP Server and Optional Web UI

- Graph behavior and persistence depend on the HTTP Server only; no Graph operation requires the Web UI.
- The UI reads and writes exclusively through the public HTTP API and may be omitted, replaced, or hosted separately.
- As a packaging convenience, Runtime/CLI inject the isolated `src/ui/` root handler so `GET /` serves `src/ui/dashboard.html`. A bare `GraphHttpServer` has no UI route. The HTML shell is intentionally reachable without bearer authentication so the browser can request a token.
- All `/api/*` routes require `Authorization: Bearer <token>` when `--token` is configured.
- Binding a non-loopback host requires a token.
- The dashboard is a self-contained HTML/CSS/JavaScript asset with no CDN dependency.
- It polls Project state, renders Facts as nodes, Intents as directed edges, and Hints as independent nodes. Intent UI state is one of `open`, `running`, or `concluded`: an open Intent with a matching in-flight Execute shows `running`; otherwise it shows `open` until its target Fact exists, then `concluded`. The runtime heartbeat drives a page-level `runtime online` / `runtime offline` badge; when the heartbeat is stale the execution overlay is cleared and unconcluded Intents fall back to `open`.
- In addition to the Graph API, the Dashboard polls two read-only Runtime endpoints: `GET /api/runtime/status` (`runtimeId`, `startedAt`, `heartbeatAt`, `sequence`, `schedulerRunning`, `heartbeatWindowMs`) and `GET /api/runtime/projects/{id}/executions` (immutable in-flight execution snapshots with `executionId`, `projectId`, `kind`, `intentId`, `workerName`, `processId`, `startedAt`, `deadlineAt`). Graph snapshot export never includes the Runtime overlay.
- `GraphHttpServer` exposes a generic authenticated `apiExtensions` hook; Runtime/CLI inject the two Runtime extensions at the composition root. `graph/` depends only on the `ApiExtension` type, never on runtime modules.
- Human Hint entry is through the dashboard and writes `POST /api/projects/{id}/hints`; the creator defaults to `human:web` and is editable.
- The UI also exposes Project stop/resume, explicit reopen, details, pan/zoom/fit, and JSON snapshot export.
- UI changes must preserve token handling, auto-refresh, immutable Graph semantics, Runtime overlay semantics, and mobile layout.

Lifecycle behavior:

- `peak run` creates or reattaches all configured Board Projects unless one Project source is selected, starts the Graph server and scheduler as a detached background process, prints its PID/Web URL/log path, and returns. `peak status` reports the registered background process; `peak stop` terminates it and its Worker subprocesses. The Server remains alive after Projects become `stopped` or `completed`. Completion is recorded in the server log together with each materialized deliverable path.
- `peak resume` attaches one persisted Project by UUID and validates its configured Goal; `--project <source>` resolves ambiguous goal matches and also starts in the background.
- A Project UUID may appear in another Board to reuse the same Graph, but the same active Project must not be scheduled concurrently by multiple Runtime processes.
- They shut down only through `peak stop`, `SIGINT`, `SIGTERM`, or a fatal monitor error. Shutdown stops scheduling, cancels and awaits in-flight process cleanup, stops the Runtime heartbeat, closes HTTP, then closes SQLite stores.
- `peak serve` starts the persisted Graph API as a detached background process, with no scheduler or workers, and also exposes the bundled optional UI; manage it with `peak status/stop`. It does not inject Runtime extensions, so `/api/runtime/*` is absent and the Dashboard treats that as a normal runtime-offline downgrade.
- `peak export` accepts only a completed Project and writes a portable gzip tarball containing a Board Project JSON block, full Graph JSON, a consistent `analysis.db` snapshot, and all registered content-addressed Artifacts. `peak import` verifies those components, preserves the UUID, and never overwrites an existing Project.
- `peak init` scaffolds a Board directory with an empty `task.json`; `peak workers` lists supported Worker and task types.
- Default ports are ephemeral (`0`) for `run`/`resume` and `8000` for `serve`.

## Runtime and Worker Behavior

ProjectLoop runs three independent channels per tick: due Supervise, needed Plan, and open Intent Execute. Plan and Supervise never consume Execute capacity, so a Worker with `maxRunning: 1` that supports all three phases can run one Plan, one Supervise and one Execute at once, but never two Executes; per-Project "at most one Plan / one Supervise" is enforced by the in-memory ExecutionRegistry, not by Worker capacity. `executeCapacity = sum(maxRunning for Workers whose taskTypes includes "execute")` is the single source of Execute-concurrency budget and of the maximum Intents Plan may create in one round. Plan receives the immutable source and goal plus the budgeted current-state view: local leaf Facts, open Intents, unconsumed Hints, and pending Federation leaf FactRefs, with explicit truncation metadata. Every available FactRef already contains the canonical `projectId`, `factId`, and `description`; Plan selects and returns that complete node without fetching, enriching, stripping, or rewriting it. New Intents and completion may use only those admissible sources; the reserved `goal` is never a source. Plan AI independently chooses branching, deepening, merging, and completion. Runtime prompts do not prescribe a fixed reasoning strategy; Runtime enforces only source admissibility, one-Fact atomic transitions, strict output shape, and the `executeCapacity` limit. A non-active Project cancels its active in-memory executions.

Every phase Graph view has a fixed 256 KiB UTF-8 budget and reports deterministic `truncated` and `omitted` metadata. Execute resolves each source to its canonical local Artifact `inputPath` with `readOnly: true`; it never downloads or copies source files and verifies their size and SHA-256 before and after worker execution. Workers are never allocated a workspace and never write files: when a result needs a file, Execute returns the full content inline in the contract (`filename`, `mediaType`, `content`), the Runtime uploads it to the Project Artifact store, and the resulting Fact binds the content-addressed Artifact. The optional content-based `filename` is never a graph node id; on completion the Runtime materializes each completion-source Artifact that has a `filename` next to `task.json`. Runtime execution IDs are random eight-character lowercase hexadecimal values checked against the in-memory registry; Finalize reuses its Execute ID. Persisted timestamps use the local wall clock format `YYYYMMDDTHHMMSS.XXX` without a timezone suffix.

Worker selection filters by task support and retry cooldown; for Execute it also enforces `maxRunning`, then sorts by priority, current Execute load, and name. Reservations prevent over-selection before Execute starts; Plan and Supervise reservations do not count toward `maxRunning`.

- `pi`: resolves the installed `@earendil-works/pi-coding-agent` CLI entry via `createRequire` and launches it through `process.execPath` (never depends on `pi` being on PATH); runs `--mode json`, an isolated `--session-dir` under the Project shard, optional `--session <id>` for Finalize resume, and `--model <config.model>`; parses the `session` header and the last `agent_end` assistant text from the JSONL stream; supports Pi model references via `config.model`.
- `opencode`: runs `opencode run --format json`; does not currently support Finalize resume.
- `codex`: runs `codex exec --json` and supports resume from its thread id.
- `claude-code`: runs `claude -p --output-format json` with an explicit session id and supports resume.

Execute may invoke Finalize once after any failed, timed-out, or malformed output when execution started, was not externally cancelled, the Project/Intent is still active/open, and a resumable session exists. The captured session id is replayed as the CLI resume argument; Finalize reuses the Execute execution id. Finalize returns the same Fact contract and never creates a separate Graph operation.

Plan and Supervise dispatches run their worker up to three total attempts per dispatch with a short fixed delay: an attempt is retried only when it started and was not externally cancelled, so transient provider failures, timeouts, and malformed JSON output are absorbed before the phase is reported failed. Retry counts and delay are fixed runtime policy (not Board fields). Finalize itself is not retried; Execute keeps its single Finalize resume path.

CLI subprocesses receive prompts through stdin, run in the Board directory, have bounded 10 MiB stdout/stderr capture, and are terminated as process trees on timeout/cancellation. Keep authentication and provider configuration owned by each Agent tool.

Worker contract parsing accepts the final fenced JSON block or outermost JSON object, then strictly rejects unknown/missing fields. Do not loosen the typed Plan/Supervise/Execute shapes.

## Config and Skills

Top-level configuration fields are exactly:

```text
board, workers, optional scheduler, optional phase
```

`board` contains only optional `name`, optional Skill names, and a non-empty `projects` array. Each Project contains exactly `id`, `source`, and `goal`; an omitted/empty id means create and persist one, while a UUID means attach and reuse. Project sources and non-empty ids must be unique within a Board. `workers` is a non-empty array; Peak generates internal Worker identities. A Worker is `{type, model?, taskTypes, maxRunning, priority, env}`: `model` optionally selects the Agent tool model, `env` is a per-Worker environment map merged into the CLI subprocess env, and there is no free-form `args` field. Board Projects share Skills, Workers, and scheduler limits while keeping independent UUID Graph shards and completion. Worker contexts contain only the current phase's assembled Graph view rather than the full Board. There is no Board workspace: Fact Artifacts live only in the Project shard's `artifacts/` directory, and the final Goal deliverable is materialized next to `task.json` using its content-based filename.

Phase timeouts are fixed runtime policy and are not Board fields. Optional `phase` settings cover one Plan `customProfile`, Supervise interval plus one `customProfile`, and Execute Artifact size plus `customProfiles[]`. There is no `phase.plan.maxIntents` field; the Plan Intent cap equals `executeCapacity`. The `scheduler` object contains only `maxRunningProjects` and `intervalMs`; `maxConcurrent`, `maxProjectConcurrent`, and `refillPerTick` are not configurable. Unknown fields are rejected recursively. At least one Worker must support `supervise` and at least one must support `execute`. Supported worker types are `opencode`, `codex`, `pi`, and `claude-code`; task types are `plan`, `supervise`, and `execute`.

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
