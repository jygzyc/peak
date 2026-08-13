# Peak

Peak is an HTTP-native distributed Graph agent runtime. Each **Project** owns an independent UUID Graph shard (SQLite + content-addressed Artifacts); Projects compose proofs through immutable **`FactRef`** hyperlink nodes containing `projectId`, `id`, and the canonical Fact `description`. The Graph is bound to the HTTP server, whose API is the only live Graph protocol. The bundled Web UI is an optional presentation client, not a Graph dependency.

Runtime requirements: Node.js `>=22.19.0` (ESM).

## Key concepts

- **Board** — a directory with `task.json`: a Project collection and shared run configuration. It has no Goal, Graph, or completion state of its own.
- **Project** — one persisted Graph (`origin` and `goal` Facts plus the proof DAG of Facts/Intents/Hints). Facts are immutable; Plan AI independently decides how the proof DAG should branch, deepen, merge, or complete.
- **Plan / Supervise / Execute / Finalize** — the fixed runtime units. Plan decides next Intents (or completion); Supervise audits and may add one Hint per round; Execute performs one atomic Intent and returns exactly one Fact; Finalize resumes a failed Execute once.
- **Artifacts** — Workers never write files and are never allocated a workspace. When a Fact needs detailed evidence, Execute returns the file content inline; the Runtime stores it as a content-addressed Artifact. On completion, deliverable Artifacts are materialized under the Project shard's `out/` directory.
- **Joint Plan Federation** — before Plan, Server exposes every same-Task peer's current leaf Paths and Runtime recursively reuses or completes their Path Abstracts; the target Graph never imports a remote Fact as a local Intent source.

## Quick start

```bash
npm install
npm run build          # core CLI + Graph server (UI compilation is separate)
npm run build:ui       # optional: bundle + typecheck the Web UI dashboard

peak init ./my-board            # scaffold a Board with an empty task.json
peak serve --port 8000          # independent persisted Graph API + Web UI
peak start ./my-board --graph-url http://127.0.0.1:8000  # prepare and start background Dispatch
# or: peak prepare ./my-board --graph-url http://127.0.0.1:8000
#     peak dispatch ./my-board --graph-url http://127.0.0.1:8000
```

Configure and authenticate one of `opencode`, `codex`, `pi`, or `claude-code` before running. Full usage details live in the docs.

## Documentation

User guides (English / 中文):

- [`docs/en/usage.md`](docs/en/usage.md) — English usage guide: quick start, Board configuration, CLI reference, Web UI, examples.
- [`docs/zh/usage.md`](docs/zh/usage.md) — 中文使用指南：快速开始、Board 配置、CLI 参考、Web UI、示例。

Reference and contributor docs:

- [`docs/zh/architecture.md`](docs/zh/architecture.md) — 架构：设计目标、模块职责、Graph 模型、Runtime 阶段、调度、Worker、Federation、CLI、Web UI、安全。
- [`docs/en/architecture.md`](docs/en/architecture.md) — architecture boundaries, Graph model, Runtime phases, Workers, and Federation.
- [`docs/zh/data-flow.md`](docs/zh/data-flow.md) — 数据流：数据模型与不变量、持久化布局、HTTP API、任务协议 JSON 合同、Board 配置 schema、端到端数据流。
- [`docs/en/data-flow.md`](docs/en/data-flow.md) — data model, persistence, HTTP API, phase contracts, and end-to-end flows.
- [`docs/en/development.md`](docs/en/development.md) — build, test, and release workflow.
- [`docs/zh/development.md`](docs/zh/development.md) — 构建、测试与发布工作流（中文）。

## License

GPL-3.0 — see [`LICENSE`](LICENSE).
