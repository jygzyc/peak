# Peak Usage Guide

This guide covers running Peak end to end: quick start, Board configuration, CLI reference, Web UI, and examples. For architecture and data-flow details, see [`../zh/architecture.md`](../zh/architecture.md) and [`../zh/data-flow.md`](../zh/data-flow.md) (Chinese); for build/test/release, see [`development.md`](development.md).

## Quick start

```bash
npm install
npm run build

peak init ./my-board            # scaffold a Board with an empty task.json
peak serve --port 8000          # independent persisted Graph API + Web UI, no workers
peak prepare ./my-board --graph-url http://127.0.0.1:8000   # create and persist all Project IDs
peak dispatch ./my-board --graph-url http://127.0.0.1:8000  # independent Dispatch process
```

Server and Dispatch are always separate processes. `peak start ... --graph-url ...` is only the background Dispatch entry and never embeds a Server; `peak dispatch` runs in the foreground.

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
    "plan": { "customProfile": { "description": "Plan with the Task method.", "prompt": "Build the next evidence step.", "skills": ["my-skill"] } },
    "supervise": { "intervalMs": 90000, "customProfile": { "description": "Review the proof.", "prompt": "Find concrete proof gaps.", "skills": ["my-skill"] } },
    "execute": { "customProfile": [{ "description": "Perform the work.", "prompt": "Collect verified evidence.", "skills": ["my-skill"] }] }
  }
}
```

`board.skills` is the Task-wide install/allow list. Each `customProfile.skills` must be a unique subset of it, and only the active Plan, Supervise, or Execute profile is injected into that Worker prompt. Finalize inherits the selected Execute profile and Skills. Analyze is a fixed internal recursive mechanism: it has no profile, Skills, or Task configuration. The immutable `graph-*.json` snapshot records selected names only under `customProfile.skills`; it does not persist a top-level Skill list, Worker configuration, the rendered prompt, or Worker output.

- Top-level fields are exactly `board`, optional `execution`, `workers`, optional `scheduler`, and optional `phase`; unknown fields are rejected recursively.
- `board` has optional `name`, optional Skill names, and a non-empty `projects` array; it contains neither execution settings, a Server address, nor a workspace.
- Each Project is exactly `{id?, source, goal}`. Run `peak prepare` before foreground `peak dispatch`; background `peak start` performs the same preparation automatically. Before sharding with `--project`, every Project UUID must already be fixed so multiple Dispatch processes never race to rewrite `task.json`.
- Each `workers[]` entry combines the Worker definition `{type, model?, env}` with config-only routing metadata `{taskTypes, maxRunning, priority}`. `taskTypes` is consumed by Runtime routing and never passed into the Worker module. `env` carries optional per-Worker environment variables (e.g. `PI_MODEL`) merged into the CLI subprocess; there is no free-form `args` field. Empty `model` means the Agent tool default. Docker reuses the CLI configuration directories already present on the host; API keys do not need to be configured in `task.json`.
- At least one configured route must include `supervise` and at least one must include `execute`. `executeCapacity = sum(maxRunning for routes containing execute)` is the single source of both the Plan Intent cap and the Execute concurrency limit.
- Plan/Supervise run on independent channels and never consume Execute capacity; per-Project "at most one Plan / one Supervise" is enforced in memory.
- Execute accepts Artifacts up to 10 MiB by default. Advanced configurations may override this with optional `phase.execute.maxArtifactBytes`.
- Phase timeouts are fixed runtime policy: Plan/Supervise 5 min, Execute 10 min, Finalize 2 min.
- `execution` is exactly `{mode, networkMode?}`. `mode` is `local` (default) or `docker`; Docker creates one long-lived container per Project, and engine/image unavailability falls the whole Task back to local. `networkMode` maps to Docker `--network`. See [container/AUTH.md](../../container/AUTH.md).

## CLI

```text
peak init [board-directory]          Scaffold a Board
peak start [board-directory]         Connect to --graph-url and start a background Dispatch
peak prepare [board-directory]       Create missing Projects and fix the complete UUID set
peak dispatch [board-directory]      Run Task Projects against an external Server
peak resume <project-uuid> [board]   Attach one Project in the background
peak serve [--port 8000]             Start Graph API + Web UI in the background
peak status                          Show background server status
peak stop [task-name]                Stop one task by name, or all tasks and the server when no task is named
peak export <project-uuid> [archive] Export a completed Project as .tar.gz
peak import <archive>                Import it into Peak home for another Board
peak image pull [--force]            Pull the current version's task image ahead of startup
peak workers                         List supported Worker/task types
```

Background output is written to `<peak-home>/server.log`; local process metadata is used only by `status` and `stop`. `--host/--port` belong only to `peak serve`; `start/dispatch/resume` require `--graph-url`. Peak's Graph API is public and has no built-in access-token layer.

`export` accepts only completed Projects and creates a portable archive containing `manifest.json` (including a ready-to-paste `board.projects` JSON block), `graph.json`, a consistent `project.db` snapshot, every content-addressed Artifact, and `path_abs_<factId>` for every current leaf. `import` verifies the database, Graph JSON, Artifact and Path Abstract sets/sizes/SHA-256, then restores the same UUID without overwriting an existing Project. Adding the printed block to a destination Task lets Joint Plan reuse every leaf Path Abstract directly and Analyze only missing entries.

## Web UI

The dashboard is a self-contained HTML/CSS/JS client served at `GET /`. It uses the public Graph API, polls Project state, renders Facts as nodes, Intents as directed edges, and Hints as independent nodes, and supports stop/resume, explicit reopen, adding Hints, pan/zoom/fit, JSON snapshots, and completed-Project archive download.

## Examples

- [`examples/ai_agent_safety`](../../examples/ai_agent_safety/README.md) — English: AI safety intelligence brief + Agent guardrail blueprint.
- [`examples/ai_agent_zh`](../../examples/ai_agent_zh/README.md) — 中文版.
