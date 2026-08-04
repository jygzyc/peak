# Peak Release Notes / Peak 发布日志

The version source of truth is the `version` file at the repo root. For each release: bump `version`, sync `package.json.version`, and add an entry at the top of this file.

版本号以仓库根目录 `version` 文件为准。每次发版：更新 `version` 文件、同步 `package.json.version`、在本文件顶部新增一条记录。

---

## 0.1.0 — 2026-08-03

### 中文

首个可运行版本：HTTP 原生分布式证明图（proof Graph）Agent 运行时。

**核心能力**

- 每个 Project 一张独立持久化 Graph 分片（SQLite + 内容寻址 Artifact），Project 间通过不可变 `FactRef` 组成证明链；
- 固定 Plan / Supervise / Execute / Finalize 运行单元，Plan 深度优先、深度不限，证明长成多层级 DAG；
- HTTP API 是 Graph 唯一在线读写协议（`GraphClient` 走 loopback HTTP），可选自包含 Web UI Dashboard；
- FederationBus 通过各 Project `logs/main.log` 恢复/投递叶 FactRef，目标只保存超链接节点、不复制源实体；
- 阶段定制只通过 `customProfile`（Plan/Supervise 各一，Execute 多个），Intent 持久化 description 与签名，Fact 不携带 profile；
- Skill 安装（全局优先、Board-local 临时链接）、原子 UUID 回写、`peak run/resume/serve/init/workers` CLI。

**关键设计决策**

- **无 workspace**：Worker 不写文件、不分配目录；需要文件的 Fact 结果由 Execute 合同内联返回 `{filename, mediaType, content}`，Runtime 上传到 Project `artifacts/`（内容寻址）；
- **最终交付物物化**：Project 完成时把带 `filename` 的 completion source Artifact 写到 `task.json` 同目录，文件与内容基于实际分析、不含 i001/f001 图节点编号；
- Worker 只接收按阶段组装的只读 Graph JSON（渲染进 Prompt，快照另存 `logs/graph-*.json`），不接触 store/凭据/URL；
- 阶段超时是固定运行时策略：Plan/Supervise 45s、Execute 10min、Finalize 2min；execution ID 为 8 位十六进制，Finalize 复用 Execute ID。

**工程与发布**

- `npm run build` / `npm test` / `npm run smoke` / `npm run pack`（esbuild 单文件 bundle + manifest）；
- 构建期校验 `scripts/*.mjs` 语法与引用一致性（`scripts/check-scripts.mjs`），版本一致性（`version` ↔ `package.json`）；
- `examples/ai_agent_zh/run.mjs` 一键真实启动：当前目录 `.peak_test` 测试根，复制中文示例，运行安装版 `peak`；
- GitHub Actions：PR/主分支 CI（typecheck/build/test/smoke/pack，Linux + Windows），tag 触发 Release（打包并上传 tarball）。

**已知问题**

- 真实运行中 Supervise 可能过度注入 Hint，导致 Guardrail 类目标无限深挖、迟迟不完成（需收紧 supervise 的 noop 约束）；
- CLI Worker（opencode/codex/claude-code）未做全量端到端验证；Pi SDK 为唯一进程内集成。

### English

First runnable release: an HTTP-native distributed proof-Graph agent runtime.

**Core capabilities**

- Each Project owns an independent persisted Graph shard (SQLite + content-addressed Artifacts); Projects compose proofs through immutable `FactRef` hyperlink nodes.
- Fixed Plan / Supervise / Execute / Finalize runtime units; Plan is depth-first with no fixed depth limit, growing each proof as a multi-level DAG.
- The HTTP API is the only live Graph protocol (`GraphClient` goes through loopback HTTP); a self-contained Web UI Dashboard is optional.
- FederationBus recovers/delivers leaf FactRefs through each Project's `logs/main.log`; targets persist only the hyperlink node, never the source entity.
- Phase customization only through `customProfile` (one each for Plan/Supervise, many for Execute); Intents persist the description and its digest, Facts never carry profiles.
- Skill installation (global-first, Board-local temporary links), atomic UUID write-back, and the `peak run/resume/serve/init/workers` CLI.

**Key design decisions**

- **No workspace**: Workers never write files and are never allocated a directory; when a Fact needs a file, Execute returns the content inline (`filename`, `mediaType`, `content`) and the Runtime stores it as a content-addressed Artifact in the Project's `artifacts/`.
- **Materialized final deliverables**: on completion, Artifacts that carry a `filename` are written next to `task.json`; files and content are based on actual analysis and never contain i001/f001 graph node ids.
- Workers receive only the phase-assembled read-only Graph JSON (rendered into the Prompt; a snapshot is also saved to `logs/graph-*.json`) and never touch stores, credentials, or URLs.
- Phase timeouts are fixed runtime policy: Plan/Supervise 45s, Execute 10 min, Finalize 2 min; execution ids are 8 lowercase hex, and Finalize reuses the Execute id.

**Engineering & release**

- `npm run build` / `npm test` / `npm run smoke` / `npm run pack` (esbuild single-file bundle + manifest).
- Build-time validation of `scripts/*.mjs` syntax and referenced assets (`scripts/check-scripts.mjs`), plus version consistency (`version` file ↔ `package.json`).
- `examples/ai_agent_zh/run.mjs` one-click real launch: creates `.peak_test/` in the current directory, copies the Chinese example, and runs the installed `peak`.
- GitHub Actions: PR/main CI (typecheck/build/test/smoke/pack on Linux + Windows); `v*` tags trigger a Release uploading the packed tarball.

**Known issues**

- In real runs Supervise may over-inject Hints, causing Guardrail-style Goals to keep deepening indefinitely instead of completing (needs a stricter supervise noop contract).
- CLI workers (opencode/codex/claude-code) are not fully verified end-to-end; the Pi SDK is the only in-process integration.
