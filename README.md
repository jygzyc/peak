# Peak

Peak is an HTTP-native distributed Graph agent runtime. Each **Project** owns an independent UUID Graph shard (SQLite + content-addressed Artifacts); Projects compose proofs through immutable **`FactRef`** hyperlink nodes containing `projectId`, `factId`, and the canonical Fact `description`. The Graph is bound to the HTTP server, whose API is the only live Graph protocol. The bundled Web UI is an optional presentation client, not a Graph dependency.

Runtime requirements: Node.js `>=22.19.0` (ESM).

## Key concepts

- **Board** — a directory with `task.json`: a Project collection and shared run configuration. It has no Goal, Graph, or completion state of its own.
- **Project** — one persisted Graph (`origin` and `goal` Facts plus the proof DAG of Facts/Intents/Hints). Facts are immutable; Plan AI independently decides how the proof DAG should branch, deepen, merge, or complete.
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

`peak run` starts the runtime and HTTP server in the background, prints the PID, Web URL, and log path, then returns. Use `peak status` to inspect it and `peak stop` for a graceful shutdown. `peak resume <project-uuid> [board]` attaches one persisted Project and validates its Goal.

Configure and authenticate one of `opencode`, `codex`, `pi`, or `claude-code` before running. Every Worker is a CLI subprocess driven through one shared `ProcessRunner`; the `pi` Worker resolves the installed `@earendil-works/pi-coding-agent` CLI entry at runtime (Peak itself no longer ships the SDK), and per-Worker provider/model configuration flows through the `env` map.

## One-click real run

```bash
node scripts/run-example.mjs    # no arguments
```

Creates `.peak_test/` in the current directory as an isolated test root, copies the Chinese example (`examples/ai_agent_zh`) into it, and launches the installed `peak` directly.

## Board configuration (`task.json`)

```json
{
  "board": {
    "name": "my-board",
    "skills": ["my-skill"],
    "projects": [
      { "id": "", "source": "Describe the source material or starting state.", "goal": "Describe what this Project must prove." }
    ]
  },
  "workers": [
    { "type": "pi", "model": "deepseek-v4-flash", "taskTypes": ["plan", "supervise"], "priority": 1 },
    { "type": "pi", "model": "deepseek-v4-flash", "taskTypes": ["execute"], "maxRunning": 2, "priority": 1 }
  ],
  "phase": {
    "supervise": { "intervalMs": 90000 },
    "execute": { "customProfiles": [] }
  }
}
```

- Top-level fields are exactly `board`, `workers`, optional `scheduler`, optional `phase`; unknown fields are rejected recursively.
- `board` has optional `name`, optional Skill names, and a non-empty `projects` array — there is **no workspace**.
- Each Project is exactly `{id?, source, goal}`. `source` becomes the immutable `origin` Fact description. Project `id` starts empty; the first `run` atomically writes the generated UUID back to `task.json`. A non-empty id (UUID) attaches and reuses the persisted Graph.
- A Worker is `{type, model?, taskTypes, maxRunning, priority, env}`. `env` carries per-Worker environment variables (e.g. `ANTHROPIC_API_KEY`, `PI_MODEL`) merged into the CLI subprocess; there is no free-form `args` field. Empty `model` means the Agent tool default.
- At least one Worker must support `supervise` and at least one must support `execute`. `executeCapacity = sum(maxRunning for execute Workers)` is the single source of both the Plan Intent cap and the Execute concurrency limit.
- Plan/Supervise run on independent channels and never consume Execute capacity; per-Project "at most one Plan / one Supervise" is enforced in memory.
- Execute accepts Artifacts up to 10 MiB by default. Advanced configurations may override this with optional `phase.execute.maxArtifactBytes`.
- Phase timeouts are fixed runtime policy: Plan/Supervise 5 min, Execute 10 min, Finalize 2 min.

## CLI

```text
peak init [board-directory]          Scaffold a Board
peak run [board-directory]           Start Projects in the background
peak resume <project-uuid> [board]   Attach one Project in the background
peak serve [--port 8000]             Start Graph API + Web UI in the background
peak status                          Show background server status
peak stop                            Stop the server and Worker subprocesses
peak export <project-uuid> [archive] Export a completed Project as .tar.gz
peak import <archive>                Import it into Peak home for another Board
peak workers                         List supported Worker/task types
```

Background output is written to `<peak-home>/server.log`; local process metadata is used only by `status` and `stop`. Common options: `--host` (non-loopback requires `--token`), `--port` (`0` = ephemeral), `--token`, `--peak-home`, `--no-install-skills`. On completion, `run` prints `[peak] deliverable: <path>` for each final Goal deliverable materialized next to `task.json`.

`export` accepts only completed Projects and creates a portable archive containing `manifest.json` (including a ready-to-paste `board.projects` JSON block), `graph.json`, a consistent `analysis.db` snapshot, and every registered content-addressed Artifact. `import` verifies the database, Graph JSON, Artifact metadata/size/SHA-256, and restores the same UUID without overwriting an existing Project; use the printed JSON block in the destination Board's `task.json`.

## Web UI

The dashboard is a self-contained HTML/CSS/JS client served at `GET /` (no Bearer required for the shell; all `/api/*` routes require the token). It polls Project state, renders Facts as nodes, Intents as directed edges, and Hints as independent nodes, and supports stop/resume, explicit reopen, adding Hints, pan/zoom/fit, JSON snapshots, and completed-Project archive download.

## Examples

- [`examples/ai_agent_safety`](examples/ai_agent_safety/README.md) — English: AI safety intelligence brief + Agent guardrail blueprint.
- [`examples/ai_agent_zh`](examples/ai_agent_zh/README.md) — 中文版.

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
- [`docs/completed-project-certified-frontier-plan.md`](docs/completed-project-certified-frontier-plan.md) — planned certified proof publication for completed Projects.
- [`AGENTS.md`](AGENTS.md) — source layout and non-negotiable boundaries for contributors.
