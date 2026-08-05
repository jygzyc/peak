# Peak Release Notes / Peak 发布日志

This file holds the release notes for the **current version only**; the tag-triggered Release action (`.github/workflows/release.yml`) uses everything below the `---` separator verbatim as the GitHub Release body, and it ships inside the npm tarball. It is not a changelog — old entries are replaced, not appended. To release: bump the root `version` file (the single version source of truth, no `v` prefix), sync `package.json.version` to match, replace the notes below, then push a tag `vX.Y.Z` exactly equal to `version`; the action packs, verifies tag ↔ `version`, publishes the tarball to npm via Trusted Publishing (OIDC), and creates the GitHub Release.

本文件只保存**当前版本**的发布说明；tag 触发的 Release action 把 `---` 分隔线以下的内容原样用作 GitHub Release 正文，并随 npm tarball 发布。它不是 changelog——旧条目会被替换，而不是追加。发版方法：更新根目录 `version` 文件（唯一版本来源，不带 `v` 前缀），把 `package.json.version` 同步为相同值，替换下方说明，然后推送与 `version` 完全一致的 tag `vX.Y.Z`；action 会自动打包、校验 tag ↔ `version`、通过 Trusted Publishing（OIDC）发布到 npm 并创建 GitHub Release。

---

## 0.1.1 — 2026-08-05

首次发布 / First release.

### 中文

Peak 是 HTTP 原生的分布式证明图（proof Graph）Agent 运行时：围绕"起点已知、目标明确、路径未知"的问题，由 AI 在一张不可变 Fact / Intent 图上逐步构造从 source 到 goal 的证明。每个 Project 是独立的 UUID Graph 分片，Project 之间通过不可变 `FactRef` 超链接节点组成证明链。

核心能力：

- **证明图模型**：Fact（不可变结论，可绑定一个内容寻址 Artifact）、Intent（一次原子 DAG 转换，一条 open Intent 恰好产出一个 Fact）、Hint（不参与因果的图外输入）；HTTP API 是 Graph 的唯一读写协议；
- **阶段运行时**：Plan 规划下一步原子 Intent 或直接完成，Supervise 审视图并注入纠偏 Hint，Execute 执行单条 Intent；Execute 失败可经 Finalize 在同一 Worker session 内收尾一次；所有阶段输出严格 JSON 合同；
- **CLI Worker**：`pi` / `opencode` / `codex` / `claude-code` 经统一 `ProcessRunner` 调起，Worker 只收 prompt、不写文件、不接触 Graph；领域方法只通过 Skill 注入，保持运行时领域无关；
- **独立 Project 分片**：每 Project 一个 UUID 目录（私有 SQLite + 内容寻址 `artifacts/`），独立完成，完成时把最终交付物物化到 `out/` 目录；支持 gzip 归档导出/导入；
- **Federation**：同 scope 的 Project 之间只传递当前叶 `FactRef`（`projectId` / `factId` / 不可变 `description`），绝不复制源 Fact 或 Artifact；
- **可选 Web Dashboard**：实时图展示、Hint 输入、stop/resume/reopen、Artifact 预览与归档下载，仅为 HTTP API 的可替换客户端；
- **后台 CLI 生命周期**：`run` / `resume` / `serve` / `status` / `stop` / `export` / `import`，npm 全局安装后直接使用。

### English

Peak is an HTTP-native distributed proof-Graph agent runtime: for problems where the start and goal are known but the path is not, AI incrementally builds a proof from source to goal on an immutable Fact / Intent graph. Each Project is an independent UUID Graph shard, and Projects compose proof chains through immutable `FactRef` hyperlink nodes.

Highlights:

- **Proof-Graph model**: Facts (immutable conclusions, optionally bound to one content-addressed Artifact), Intents (one atomic DAG transition — each open Intent yields exactly one Fact), and Hints (non-causal external input); the HTTP API is the only live Graph protocol;
- **Phased runtime**: Plan proposes the next atomic Intents or completes, Supervise audits the graph and injects corrective Hints, Execute runs a single Intent; a failed Execute can be finalized once within the same worker session; every phase emits a strict JSON contract;
- **CLI workers**: `pi` / `opencode` / `codex` / `claude-code` launched through one shared `ProcessRunner` — workers receive only a prompt, never write files, and never touch the Graph; domain methods come from Skills only, keeping the runtime domain-neutral;
- **Independent Project shards**: one UUID directory per Project (private SQLite + content-addressed `artifacts/`), independent completion with final deliverables materialized under `out/`; portable gzip archive export/import;
- **Federation**: Projects in the same scope exchange only current-leaf `FactRef`s (`projectId` / `factId` / immutable `description`) — source Facts and Artifacts are never copied;
- **Optional web dashboard**: live graph view, Hint entry, stop/resume/reopen, Artifact preview and archive download — a replaceable client of the HTTP API;
- **Background CLI lifecycle**: `run` / `resume` / `serve` / `status` / `stop` / `export` / `import`, ready to use after a global npm install.
