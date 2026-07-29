# Peak

Peak is a configured distributed Graph agent runtime. Each Project owns a UUID directory and SQLite Graph shard. The runtime exposes eligible cross-Project Facts as immutable `FactRef` hyperlink nodes containing `projectId`, `factId`, and the canonical Fact `description`; the AI decides whether they are relevant to the current Project Goal. The Graph is bound to the HTTP server, whose API is the only Graph protocol. The Web UI is an optional presentation client, not a Graph dependency.

## Run

```bash
npm install
npm run build
peak init ./my-board
peak run ./my-board              # starts every configured Project
```

Board directory arguments point to a directory containing `task.json` and default to the current directory. `peak run` prints the bundled Web UI URL. This optional UI renders the live Fact/Intent DAG and provides a convenient client for submitting Hints through the API; it may be omitted or replaced without changing Graph behavior. The runtime and Graph HTTP server remain available after a Project stops or completes; press `Ctrl+C` to shut them down. To browse persisted Projects without starting workers, run `peak serve`.

Configure and authenticate one of `opencode`, `codex`, `pi`, or `claude-code` before running. Pi workers run in-process through the Pi Agent SDK and use the normal `~/.pi/agent` settings, models, and credentials.

## Board

```json
{
  "board": {
    "name": "ai-agent-safety",
    "workspace": ".",
    "projects": [
      { "id": "", "name": "Latest AI Safety Intelligence", "goal": "Collect and analyze current AI safety evidence." },
      { "id": "", "name": "AI Agent Guardrail Design", "goal": "Produce an actionable AI Agent guardrail construction plan." }
    ]
  },
  "workers": [
    {
      "type": "pi",
      "model": "zai-coding-cn/glm-5.2",
      "taskTypes": ["plan", "supervise"],
      "maxRunning": 1,
      "priority": 1,
      "args": []
    },
    {
      "type": "opencode",
      "model": "minimax/MiniMax-M3",
      "taskTypes": ["execute"],
      "maxRunning": 2,
      "priority": 2,
      "args": []
    }
  ],
  "phase": {
    "plan": { "maxIntents": 3 },
    "supervise": { "intervalMs": 60000 },
    "execute": { "maxArtifactBytes": 104857600 }
  }
}
```

A Board has no Goal or Graph. `board.projects` is a non-empty array of `{id, name, goal}` Projects, each with independent persistence and completion. On first run, an empty `id` causes Peak to create the Project and atomically write its UUID back to `task.json`. Later runs attach that UUID and reuse its Facts and Artifacts. The same UUID may be referenced by another Board when intentionally sharing a Project; do not schedule one active Project from multiple Runtime processes concurrently.

Projects registered in the same running Board expose eligible immutable proof only as candidate `FactRef` values. Each FactRef is an independently understandable hyperlink node `{projectId, factId, description}` whose description must exactly match the referenced immutable Fact. Federation is frontier-based: every newly concluded Fact is broadcast while it is a leaf, replaces its consumed local source FactRefs in unhandled target queues, and only current ordinary leaf Facts from attached Projects are broadcast at startup. Earlier Facts that already produced later local Facts are omitted because the downstream Facts represent the more credible current proof state. Source Fact entities and Artifacts are never copied; the immutable summary is part of the FactRef. Use `--project <name>` to run only one configured Project.

`workers` is an ordered array. Peak generates internal Worker identities, filters by `taskTypes`, then selects by ascending `priority`, current load, and identity. An empty `model` selects the Agent tool's own default model. Optional `phase` settings cover Plan intent count, Supervise interval, and Execute Artifact size; `scheduler` may still override global scheduling limits.

`board.skills` is optional. For each configured Worker, Peak first checks that Worker's global discovery directory (`~/.agents/skills/<name>` or `~/.claude/skills/<name>`). An existing global Skill is used directly. If it is absent, Peak links Board-local `skills/<name>/SKILL.md` into that directory for the Board Runtime lifetime, then removes only that temporary link when the Board Runtime shuts down. Individual Project stop/completion does not change the Skill installation. `peak init` does not create a `skills/` directory. Plan, Supervise, Execute, and Finalize timeouts are runtime policy and are not configurable in the Board JSON.

For a Pi worker, `model` accepts Pi's model reference syntax, including an optional thinking level such as `openai-codex/gpt-5.4:high`. Pi SDK workers do not accept CLI `args`; use an empty array or omit the field.

## Protocol

- **Plan** reads only the current proof frontier—leaf Facts, open Intents, Hints, and pending Federation leaf FactRefs—then selects complete `{projectId, factId, description}` references to create Intents, prove the Goal, or make no change. A leaf Fact may be correct while still requiring additional prerequisites.
- **Supervise** periodically reviews the Graph and may add one Hint.
- **Execute** resolves one Intent into exactly one immutable Fact.
- **Finalize** is a same-session recovery phase for a failed, timed-out, or malformed Execute result.

Workers receive a path to an immutable Graph JSON snapshot and return one strict JSON object. They never receive Graph, SQLite, HTTP credentials, or Federation access.

The optional bundled Web UI is served at `/` as a packaging convenience and uses the same HTTP API as any other client. API routes remain bearer-token protected when `--token` is configured; the UI asks for that token and keeps it in browser session storage.

## State

```text
~/.peak/projects/<uuid>/
├── analysis.db
├── artifacts/<sha256>
└── logs/
    ├── main.log
    └── graph-<timestamp>-<phase>.json
```

An ordinary Fact description is a concise, independently understandable summary limited to 1 KiB UTF-8. Detailed analysis, evidence, tables, and reports belong in content-addressed Artifacts. Intent descriptions are limited to 2 KiB; Hint content and persisted short labels to 1 KiB. The reserved `origin` and `goal` descriptions use the maximum 4 KiB UTF-8 limit.

## Commands

```bash
peak init [board-directory]
peak run [board-directory] [--project <configured-name>] [--host <host>] [--port <port>] [--token <token>]
peak resume <project-uuid> [board-directory] [--project <configured-name>]
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

Architecture and design principles: [`docs/architecture.md`](docs/architecture.md).
Interface definitions and data flow: [`docs/interfaces.md`](docs/interfaces.md).
