# Peak

Peak is a configured distributed Graph agent runtime. Each Project owns a UUID directory and SQLite Graph shard. Projects reuse immutable Facts through `FactRef`; HTTP is the only Graph protocol.

## Run

```bash
npm install
npm run build
peak init ./my-task
peak run ./my-task/task.json
```

`peak run` prints the Web UI URL. The UI renders the live Fact/Intent DAG and is the entry point for user Hints. The runtime and Web server remain available after a Project stops or completes; press `Ctrl+C` to shut them down. To browse persisted Projects without starting workers, run `peak serve`.

Configure and authenticate one of `opencode`, `codex`, `pi`, or `claude-code` before running. Pi workers run in-process through the Pi Agent SDK and use the normal `~/.pi/agent` settings, models, and credentials.

## Task

```json
{
  "task": {
    "name": "example",
    "target": "Starting state",
    "goal": "Proven goal",
    "workspace": ".",
    "skills": ["example-skill"]
  },
  "workers": {
    "default": {
      "type": "pi",
      "taskTypes": ["plan", "supervise", "execute"],
      "maxRunning": 2,
      "priority": 1,
      "args": []
    }
  },
  "federation": { "scope": "optional-proof-scope" }
}
```

Task-local Skills live at `skills/<name>/SKILL.md`. Peak links them into the discovery directory used by the configured workers.

For a Pi worker, `model` accepts Pi's model reference syntax, including an optional thinking level such as `openai-codex/gpt-5.4:high`. Pi SDK workers do not accept CLI `args`; use an empty array or omit the field.

## Protocol

- **Plan** creates Intents, proves the Goal, or makes no change.
- **Supervise** periodically reviews the Graph and may add one Hint.
- **Execute** resolves one Intent into exactly one immutable Fact.
- **Finalize** is a same-session recovery phase for a timed-out or malformed Execute result.

Workers receive a path to an immutable Graph YAML snapshot and return one strict JSON object. They never receive Graph, SQLite, HTTP credentials, or Federation access.

The Web UI is served at `/`. API routes remain bearer-token protected when `--token` is configured; the UI asks for that token and keeps it in browser session storage.

## State

```text
~/.peak/projects/<uuid>/
├── analysis.db
├── artifacts/<sha256>
└── logs/
    ├── main.log
    └── graph-<timestamp>-<phase>.yaml
```

Long Fact details are content-addressed Artifacts. Every Fact and Intent still requires a non-empty description.

## Commands

```bash
peak init <directory>
peak run <task.json> [--project <title>] [--host <host>] [--port <port>] [--token <token>]
peak resume <project-uuid> <task.json>
peak serve [--host <host>] [--port <port>] [--token <token>] [--peak-home <directory>]
peak workers
```

## Validation

```bash
npm run typecheck
npm test
npm run smoke
npm run pack
```

See [`docs/plan.md`](docs/plan.md) and [`docs/data-flow.md`](docs/data-flow.md).
