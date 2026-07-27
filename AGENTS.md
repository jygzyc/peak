# AGENTS.md

## Scope

Peak is a standalone TypeScript package and CLI for running generic, HTTP-native proof Graph projects. Keep Graph, scheduling, worker, federation, storage, and Web UI mechanisms domain-neutral. Domain behavior belongs in Task Skills.

Runtime requirements are ESM and Node.js `>=22.19.0`.

## Current Architecture

```text
Browser Web UI -----------------------------> GraphHttpServer
AgentRuntime -> RuntimeScheduler -> ProjectLoop -> TaskExecutor
TaskExecutor -> GraphClient -> loopback HTTP -> GraphHttpServer
GraphHttpServer -> ProjectStoreRegistry -> private per-Project SQLite/Artifact stores
TaskExecutor -> Plan | Supervise | Execute | Finalize -> WorkerRuntime
WorkerRuntime -> PiDriver -> Pi Agent SDK
WorkerRuntime -> OpenCode/Codex/Claude Code drivers -> ProcessRunner -> Agent CLI
FederationBus -> FactRef delivery recovered from each Project logs/main.log
```

The HTTP API is the only live Graph protocol, including calls made by the in-process runtime. Workers receive a path to an immutable YAML Graph context, not a live Graph object.

## Non-Negotiable Boundaries

1. Do not bypass `GraphClient` for runtime Graph reads or writes.
2. Only `graph/http-server.ts` and `graph/project-store-registry.ts` may import `sqlite-store.ts` or `artifact-store.ts`.
3. Projects use UUID ids and independent `analysis.db` shards.
4. Cross-Project proof persists only `FactRef`; never copy source Facts or Artifacts into the target Project.
5. Project completion is immediate and independent after a valid Goal proof. It does not wait for another Project or pending federation delivery.
6. Facts are immutable. Every Fact and Intent has a non-empty, trimmed description of at most 16 KiB UTF-8.
7. Active executions, cancellation, worker cooldowns, retained Agent sessions, reservations, and scheduling checkpoints stay in memory.
8. Workers never receive Graph/store instances, SQLite paths, Server URL/token, HTTP credentials, or `FederationBus`.
9. Task customization is Skill-only. Do not add configurable roles, workflows, custom prompts, permissions, provider credentials, or direct provider API clients.
10. The Pi Agent SDK is the sole in-process Agent integration. Do not add another model/provider SDK without an explicit architecture change.
11. Built-in prompts live in `src/runtime/prompts/`; Task files cannot override them.
12. Do not add compatibility layers for the removed Session/four-role architecture.

Do not recreate top-level `agent/`, `app/`, `server/`, `client/`, `session/`, or `task/` directories.

## Source Layout

```text
src/config/   Strict Task schema/defaults and Task Skill initialization
src/graph/    Graph types/API/client/server, private stores, federation, exports, dashboard
src/project/  ProjectManager, ProjectLoop, and GraphSupervisor timing
src/runtime/  Runtime composition, scheduler, execution registry, contracts, contexts, prompts
src/worker/   Pi Agent SDK integration, Agent CLI drivers, resource selection, ProcessRunner
src/cli.ts    run/resume/serve/init/workers commands and process signal lifecycle
```

## Graph Model and Persistence

A Project starts with immutable `origin` and `goal` Facts. A normal Intent has one or more `FactRef` sources and `to: null` while open; conclusion atomically creates one local Fact and fills `to`. Completion creates the single Intent targeting the current Project's `goal` and marks the Project `completed` in the same transaction.

Hints are independent Graph inputs. They may be added to active, stopped, or completed Projects, but adding a Hint does not resume or reopen a Project. Reopen must be explicit and records external feedback as a new Fact/Intent.

```text
~/.peak/projects/<uuid>/
├── analysis.db
├── artifacts/<sha256>
└── logs/
    ├── main.log
    └── graph-<monotonic-utc-timestamp>-<plan|supervise|execute|finalize>.yaml
```

SQLite contains only:

```text
project, artifacts, facts, intents, intent_sources, hints, counters
```

Do not add execution, lease, event, directive, verdict, dead-end, worker, session, or federation tables. Artifact bodies are content-addressed files; SQLite stores metadata and Fact references only. Unreferenced Artifacts are garbage-collected after the safety window.

Use `fileURLToPath()` for module URL paths. Validate UUIDs, hashes, workspace boundaries, symlinks, and Artifact sizes. Close SQLite handles before deleting test directories.

## HTTP Server and Web UI

- `GET /` serves `src/graph/dashboard.html`. The HTML shell is intentionally reachable without bearer authentication so the browser can request a token.
- All `/api/*` routes require `Authorization: Bearer <token>` when `--token` is configured.
- Binding a non-loopback host requires a token.
- The dashboard is a self-contained HTML/CSS/JavaScript asset with no CDN dependency.
- It polls Project state, renders Facts as nodes, Intents as directed edges, and Hints as independent nodes.
- Human Hint entry is through the dashboard and writes `POST /api/projects/{id}/hints`; the creator defaults to `human:web` and is editable.
- The UI also exposes Project stop/resume, explicit reopen, details, pan/zoom/fit, and YAML snapshot export.
- UI changes must preserve token handling, auto-refresh, immutable Graph semantics, and mobile layout.

Lifecycle behavior:

- `peak run` and `peak resume` start the Graph server and scheduler, print the Web URL, and remain alive after the watched Project becomes `stopped` or `completed`.
- They shut down only on `SIGINT`, `SIGTERM`, or a fatal monitor error. Shutdown stops scheduling, cancels executions, disposes retained Pi sessions, closes HTTP, then closes SQLite stores.
- `peak serve` starts only the persisted Graph UI/API, with no scheduler or workers, and remains alive until `SIGINT`/`SIGTERM`.
- Default ports are ephemeral (`0`) for `run`/`resume` and `8000` for `serve`.

## Runtime and Worker Behavior

ProjectLoop schedules, in order per tick, due Supervise work, needed Plan work, then open Intent execution, subject to global and per-Project slots. A non-active Project cancels its active in-memory executions.

Worker selection filters by task support, `maxRunning`, and retry cooldown, then sorts by priority, current load, and name. Reservations prevent over-selection before execution starts.

- `pi`: runs in-process through `@earendil-works/pi-coding-agent`; uses an in-memory Pi `SessionManager`; supports Pi model references and thinking levels; rejects CLI `args`.
- `opencode`: runs `opencode run --format json`; does not currently support Finalize resume.
- `codex`: runs `codex exec --json` and supports resume from its thread id.
- `claude-code`: runs `claude -p --output-format json` with an explicit session id and supports resume.

Execute may invoke Finalize once after timeout or malformed successful output only when execution started, was not externally cancelled, the Project/Intent is still active/open, and a resumable session exists. Pi Execute sessions retained for this path expire from memory after 10 minutes. Finalize returns the same Fact contract and never creates a separate Graph operation.

CLI subprocesses receive prompts through stdin, run in `task.workspace`, have bounded 10 MiB stdout/stderr capture, and are terminated as process trees on timeout/cancellation. Keep authentication and provider configuration owned by each Agent tool.

Worker contract parsing accepts the final fenced JSON block or outermost JSON object, then strictly rejects unknown/missing fields. Do not loosen the typed Plan/Supervise/Execute shapes.

## Config and Skills

Top-level Task fields are exactly:

```text
task, workers, optional scheduler, optional tasks, optional federation
```

Unknown fields are rejected recursively. At least one Worker must support `supervise`. Supported worker types are `opencode`, `codex`, `pi`, and `claude-code`; task types are `plan`, `supervise`, and `execute`.

Skills are names resolving to `<task-dir>/skills/<name>/SKILL.md`:

- OpenCode and Pi link to `~/.agents/skills/<name>`.
- Claude Code links to `~/.claude/skills/<name>`.
- Codex does not install Skills.
- Never overwrite a real destination file or directory.

`loadTaskConfig()` is strict and side-effect free. Skill initialization happens when a Project is registered unless `--no-install-skills` is used.

## Build, Tests, and Packaging

Tests import modular files from `dist/`, never directly from `src/`. `npm test` runs a clean TypeScript build first. HTTP/CLI tests must stop servers and close registries before removing temporary directories.

```bash
npm run typecheck
npm run build
npm test
npm run smoke
npm run pack
```

Run `npm run pack` last: its `prepack` phase replaces modular `dist/` with the production esbuild bundle, copies `dashboard.html` to `dist/dashboard.html`, copies runtime prompts, verifies `dist/cli.js workers`, and writes the tarball plus manifest under `dist-packages/`.
