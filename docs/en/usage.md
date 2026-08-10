# Peak Usage Guide

This guide covers running Peak end to end: quick start, Board configuration, CLI reference, Web UI, and examples. For architecture and data-flow details, see [`../zh/architecture.md`](../zh/architecture.md) and [`../zh/data-flow.md`](../zh/data-flow.md) (Chinese); for build/test/release, see [`development.md`](development.md).

## Quick start

```bash
npm install
npm run build

peak init ./my-board            # scaffold a Board with an empty task.json
peak start ./my-board           # create/attach Projects and run Plan/Supervise/Execute
peak serve                      # serve the persisted Graph API + Web UI, no workers
```

`peak start` starts the runtime and HTTP server in the background, prints the PID, Web URL, and log path, then returns. Use `peak status` to inspect it and `peak stop [task-name]` for a graceful shutdown. `peak resume <project-uuid> [board]` attaches one persisted Project and validates its Goal.

Configure and authenticate one of `opencode`, `codex`, `pi`, or `claude-code` before running. Every Worker is a CLI subprocess driven through one shared `ProcessRunner`; the `pi` Worker resolves the installed `@earendil-works/pi-coding-agent` CLI entry at runtime (Peak itself no longer ships the SDK), and per-Worker provider/model configuration flows through the `env` map.

## One-click real run

```bash
node examples/ai_agent_zh/run.mjs    # no arguments
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
    "execute": { "customProfile": [] }
  }
}
```

- Top-level fields are exactly `board`, `workers`, optional `scheduler`, optional `phase`; unknown fields are rejected recursively.
- `board` has optional `name`, optional Skill names, and a non-empty `projects` array — there is **no workspace**.
- Each Project is exactly `{id?, source, goal}`. `source` becomes the immutable `origin` Fact description. Project `id` starts empty; the first `start` atomically writes the generated UUID back to `task.json`. A non-empty id (UUID) attaches and reuses the persisted Graph.
- Each `workers[]` entry combines the Worker definition `{type, model?, env}` with config-only routing metadata `{taskTypes, maxRunning, priority}`. `taskTypes` is consumed by Runtime routing and never passed into the Worker module. `env` carries per-Worker environment variables (e.g. `ANTHROPIC_API_KEY`, `PI_MODEL`) merged into the CLI subprocess; there is no free-form `args` field. Empty `model` means the Agent tool default.
- At least one configured route must include `supervise` and at least one must include `execute`. `executeCapacity = sum(maxRunning for routes containing execute)` is the single source of both the Plan Intent cap and the Execute concurrency limit.
- Plan/Supervise run on independent channels and never consume Execute capacity; per-Project "at most one Plan / one Supervise" is enforced in memory.
- Execute accepts Artifacts up to 10 MiB by default. Advanced configurations may override this with optional `phase.execute.maxArtifactBytes`.
- Phase timeouts are fixed runtime policy: Plan/Supervise 5 min, Execute 10 min, Finalize 2 min.

## CLI

```text
peak init [board-directory]          Scaffold a Board
peak start [board-directory]         Start Projects in the background
peak resume <project-uuid> [board]   Attach one Project in the background
peak serve [--port 8000]             Start Graph API + Web UI in the background
peak status                          Show background server status
peak stop [task-name]                Stop one task by name, or all tasks and the server when no task is named
peak export <project-uuid> [archive] Export a completed Project as .tar.gz
peak import <archive>                Import it into Peak home for another Board
peak workers                         List supported Worker/task types
```

Background output is written to `<peak-home>/server.log`; local process metadata is used only by `status` and `stop`. Common options: `--host`, `--port` (`0` = ephemeral), `--peak-home`, `--no-install-skills`. Peak's Graph API is public and has no built-in access-token layer. On completion, `start` prints `[peak] deliverable: <path>` for each final Goal deliverable materialized under the Project shard's `out/` directory (`~/.peak/projects/<uuid>/out/`).

`export` accepts only completed Projects and creates a portable archive containing `manifest.json` (including a ready-to-paste `board.projects` JSON block), `graph.json`, a consistent `project.db` snapshot, and every registered content-addressed Artifact. `import` verifies the database, Graph JSON, Artifact metadata/size/SHA-256, and restores the same UUID without overwriting an existing Project; use the printed JSON block in the destination Board's `task.json`.

## Web UI

The dashboard is a self-contained HTML/CSS/JS client served at `GET /`. It uses the public Graph API, polls Project state, renders Facts as nodes, Intents as directed edges, and Hints as independent nodes, and supports stop/resume, explicit reopen, adding Hints, pan/zoom/fit, JSON snapshots, and completed-Project archive download.

## Examples

- [`examples/ai_agent_safety`](../../examples/ai_agent_safety/README.md) — English: AI safety intelligence brief + Agent guardrail blueprint.
- [`examples/ai_agent_zh`](../../examples/ai_agent_zh/README.md) — 中文版.
