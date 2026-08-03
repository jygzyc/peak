# Peak

Peak is an HTTP-native distributed Graph agent runtime. Each **Project** owns an independent UUID Graph shard (SQLite + content-addressed Artifacts); Projects compose proofs through immutable **`FactRef`** hyperlink nodes containing `projectId`, `factId`, and the canonical Fact `description`. The Graph is bound to the HTTP server, whose API is the only live Graph protocol. The bundled Web UI is an optional presentation client, not a Graph dependency.

Runtime requirements: Node.js `>=22.19.0` (ESM).

## Key concepts

- **Board** — a directory with `task.json`: a Project collection and shared run configuration. It has no Goal, Graph, or completion state of its own.
- **Project** — one persisted Graph (`origin` and `goal` Facts plus the proof DAG of Facts/Intents/Hints). Facts are immutable; a proof grows as a **multi-level DAG** — Plan prefers deepening established current leaves, with no fixed depth limit.
- **Plan / Supervise / Execute / Finalize** — the fixed runtime units. Plan decides next Intents (or completion); Supervise audits and may add one Hint per round; Execute performs one atomic Intent and returns exactly one Fact; Finalize resumes a failed Execute once.
- **Artifacts** — Workers never write files and are never allocated a workspace. When a Fact needs detailed evidence, Execute returns the file content inline (`filename`, `mediaType`, `content`); the Runtime stores it as a content-addressed Artifact in the Project shard's `artifacts/`. On completion, Artifacts carrying a content-based `filename` are materialized next to `task.json` — the final Goal deliverables.
- **Federation** — registered Projects in the same scope exchange current leaf `FactRef`s; targets persist only the hyperlink node, never the source Fact entity or Artifact.

## Quick start

```bash
npm install
npm run build

peak init ./my-board            # scaffold a Board with an empty task.json
peak run ./my-board             # create/attach Projects and run Plan/Supervise/Execute
peak serve                      # serve the persisted Graph API + Web UI, no workers
```

`peak run` prints every Project and the Web URL. The runtime and HTTP server remain available after a Project stops or completes; press `Ctrl+C` for a graceful shutdown. `peak resume <project-uuid> [board]` attaches one persisted Project and validates its Goal.

Configure and authenticate one of `opencode`, `codex`, `pi`, or `claude-code` before running. Pi workers run in-process through the Pi Agent SDK.

## One-click real run

```bash
node scripts/run-example.mjs    # no arguments
```

Creates `.peak_test/` in the current directory as an isolated test root, copies the Chinese example (`examples/ai_agent_safety_zh`) into it, and launches the installed `peak` directly.

## Board configuration (`task.json`)

```json
{
  "board": {
    "name": "my-board",
    "skills": ["my-skill"],
    "projects": [
      { "id": "", "name": "Main", "goal": "Describe what this Project must prove." }
    ]
  },
  "workers": [
    { "type": "pi", "model": "deepseek-v4-flash", "taskTypes": ["plan", "supervise"], "maxRunning": 1, "priority": 1, "args": [] },
    { "type": "pi", "model": "deepseek-v4-flash", "taskTypes": ["execute"], "maxRunning": 2, "priority": 1, "args": [] }
  ],
  "phase": {
    "plan": { "maxIntents": 10 },
    "supervise": { "intervalMs": 90000 },
    "execute": { "maxArtifactBytes": 10485760, "customProfiles": [] }
  }
}
```

- Top-level fields are exactly `board`, `workers`, optional `scheduler`, optional `phase`; unknown fields are rejected recursively.
- `board` has optional `name`, optional Skill names, and a non-empty `projects` array — there is **no workspace**.
- Project `id` starts empty; the first `run` atomically writes the generated UUID back to `task.json`. A non-empty id (UUID) attaches and reuses the persisted Graph.
- At least one Worker must support `supervise`. Empty `model` means the Agent tool default.
- Phase timeouts are fixed runtime policy: Plan/Supervise 45s, Execute 10 min, Finalize 2 min.

## CLI

```text
peak init [board-directory]          Scaffold a Board
peak run [board-directory]           Create/attach Projects and run until Ctrl+C
peak resume <project-uuid> [board]   Attach one persisted Project
peak serve [--port 8000]             Serve Graph API + Web UI, no workers
peak workers                         List supported Worker/task types
```

Common options: `--host` (non-loopback requires `--token`), `--port` (`0` = ephemeral), `--token`, `--peak-home`, `--no-install-skills`. On completion, `run` prints `[peak] deliverable: <path>` for each final Goal deliverable materialized next to `task.json`.

## Web UI

The dashboard is a self-contained HTML/CSS/JS client served at `GET /` (no Bearer required for the shell; all `/api/*` routes require the token). It polls Project state, renders Facts as nodes, Intents as directed edges, and Hints as independent nodes, and supports stop/resume, explicit reopen, adding Hints, pan/zoom/fit, and JSON snapshot export.

## Examples

- [`examples/ai_agent_safety`](examples/ai_agent_safety/README.md) — English: AI safety intelligence brief + Agent guardrail blueprint.
- [`examples/ai_agent_safety_zh`](examples/ai_agent_safety_zh/README.md) — 中文版（结构一致）.

## Build, test, release

```bash
npm run typecheck
npm run build        # modular dist + scripts/*.mjs syntax & consistency checks
npm test             # builds first, runs tests against dist/
npm run smoke        # CLI smoke: init/workers/--version
npm run pack         # esbuild single-file bundle + npm pack + manifest
```

- Version is read from the root `version` file (synced into `package.json` at pack time; drift is caught by `check-scripts`).
- Release notes: [`RELEASE.md`](RELEASE.md).
- CI (`.github/workflows/ci.yml`) runs typecheck/build/test/smoke/pack on Linux + Windows; tags `v*` trigger a GitHub Release with the packed tarball (`.github/workflows/release.yml`).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — architecture: design goals, module responsibilities, Graph model, runtime phases, scheduling, workers, federation, CLI, Web UI, security.
- [`docs/data-flow.md`](docs/data-flow.md) — data flow: data model and invariants, persistence layout, HTTP API, task-protocol JSON contracts, Board config schema, end-to-end flows.
- [`AGENTS.md`](AGENTS.md) — source layout and non-negotiable boundaries for contributors.
