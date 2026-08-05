# Peak

Peak is an HTTP-native distributed Graph agent runtime. Each **Project** owns an independent UUID Graph shard (SQLite + content-addressed Artifacts); Projects compose proofs through immutable **`FactRef`** hyperlink nodes containing `projectId`, `factId`, and the canonical Fact `description`. The Graph is bound to the HTTP server, whose API is the only live Graph protocol. The bundled Web UI is an optional presentation client, not a Graph dependency.

![Peak result](docs/assets/result.png)

Runtime requirements: Node.js `>=22.19.0` (ESM).

## Key concepts

- **Board** — a directory with `task.json`: a Project collection and shared run configuration. It has no Goal, Graph, or completion state of its own.
- **Project** — one persisted Graph (`origin` and `goal` Facts plus the proof DAG of Facts/Intents/Hints). Facts are immutable; Plan AI independently decides how the proof DAG should branch, deepen, merge, or complete.
- **Plan / Supervise / Execute / Finalize** — the fixed runtime units. Plan decides next Intents (or completion); Supervise audits and may add one Hint per round; Execute performs one atomic Intent and returns exactly one Fact; Finalize resumes a failed Execute once.
- **Artifacts** — Workers never write files and are never allocated a workspace. When a Fact needs detailed evidence, Execute returns the file content inline; the Runtime stores it as a content-addressed Artifact. On completion, deliverable Artifacts are materialized under the Project shard's `out/` directory.
- **Federation** — registered Projects in the same scope exchange current leaf `FactRef`s; targets persist only the hyperlink node, never the source Fact entity or Artifact.

## Quick start

```bash
npm install
npm run build

peak init ./my-board            # scaffold a Board with an empty task.json
peak run ./my-board             # create/attach Projects and run Plan/Supervise/Execute
peak serve                      # serve the persisted Graph API + Web UI, no workers
```

Configure and authenticate one of `opencode`, `codex`, `pi`, or `claude-code` before running. Full usage details live in the docs.

## Documentation

User guides (English / 中文):

- [`docs/usage.md`](docs/usage.md) — English usage guide: quick start, Board configuration, CLI reference, Web UI, examples.
- [`docs/usage_zh.md`](docs/usage_zh.md) — 中文使用指南：快速开始、Board 配置、CLI 参考、Web UI、示例。

Reference and contributor docs:

- [`docs/architecture.md`](docs/architecture.md) — architecture: design goals, module responsibilities, Graph model, runtime phases, scheduling, workers, federation, CLI, Web UI, security.
- [`docs/data-flow.md`](docs/data-flow.md) — data flow: data model and invariants, persistence layout, HTTP API, task-protocol JSON contracts, Board config schema, end-to-end flows.
- [`docs/development.md`](docs/development.md) — build, test, and release workflow.
- [`docs/development_zh.md`](docs/development_zh.md) — 构建、测试与发布工作流（中文）。
- [`AGENTS.md`](AGENTS.md) — source layout and non-negotiable boundaries for contributors.

## License

GPL-3.0 — see [`LICENSE`](LICENSE).
