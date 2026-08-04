# Peak

Peak 是 HTTP 原生的分布式图（Graph）Agent 运行时。每个 **Project** 拥有一个独立的 UUID Graph 分片（SQLite + 内容寻址 Artifact）；Project 之间通过不可变 **`FactRef`** 超链接节点组成证明链，每个节点包含 `projectId`、`factId` 与源 Fact 的规范 `description`。Graph 与 HTTP Server 绑定，其 API 是唯一在线 Graph 协议。内置 Web UI 是可选的展示客户端，不是 Graph 依赖。

运行时要求：Node.js `>=22.19.0`（ESM）。

## 核心概念

- **Board** —— 包含 `task.json` 的目录：Project 集合与共享运行配置。它自身没有 Goal、Graph 或完成状态。
- **Project** —— 一张持久化 Graph（`origin` 与 `goal` 两个保留 Fact，加上由 Facts/Intents/Hints 组成的证明 DAG）。Fact 不可变；Plan AI 自主判断证明 DAG 应如何分支、深化、合并或完成。
- **Plan / Supervise / Execute / Finalize** —— 固定运行单元。Plan 决定下一步 Intent（或完成）；Supervise 审计并可每轮提交一个 Hint；Execute 执行一个原子 Intent 并产出恰好一个 Fact；Finalize 对失败的 Execute 恢复一次。
- **Artifact** —— Worker 不写文件、不分配 workspace。当 Fact 需要详细证据时，Execute 在合同内联返回文件内容（`filename`、`mediaType`、`content`）；Runtime 将其作为内容寻址 Artifact 存入 Project 分片 `artifacts/`。完成时，带内容化 `filename` 的 Artifact 会物化到 `task.json` 同目录——即最终 Goal 交付物。
- **Federation** —— 同 scope 的已注册 Project 交换当前叶 `FactRef`；目标只持久化超链接节点，绝不复制源 Fact 实体或 Artifact。

## 快速开始

```bash
npm install
npm run build

peak init ./my-board            # 脚手架一个带空 task.json 的 Board
peak run ./my-board             # 创建/附加 Project 并运行 Plan/Supervise/Execute
peak serve                      # 只提供持久化 Graph API + Web UI，不启动 Worker
```

`peak run` 会在后台启动 Runtime 与 HTTP Server，打印 PID、Web URL 和日志路径后返回。使用 `peak status` 查看状态，使用 `peak stop` 优雅关闭。`peak resume <project-uuid> [board]` 按 UUID 附加一个持久化 Project 并校验其 Goal。

运行前请配置并鉴权 `opencode`、`codex`、`pi` 或 `claude-code` 中的一种。每个 Worker 都是经统一 `ProcessRunner` 调起的 CLI 子进程；`pi` Worker 在运行时解析已安装的 `@earendil-works/pi-coding-agent` CLI 入口（Peak 自身不再内置 SDK），Worker 级的 Provider/模型配置通过 `env` 映射注入子进程环境。

## 一键真实运行

```bash
node scripts/run-example.mjs    # 无需参数
```

在当前目录新建 `.peak_test/` 作为隔离测试根，复制中文示例（`examples/ai_agent_zh`），直接运行安装版 `peak`。

## Board 配置（`task.json`）

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

- 顶层字段只能是 `board`、`workers`、可选 `scheduler`、可选 `phase`；unknown 字段被递归拒绝。
- `board` 有可选 `name`、可选 Skill 名称与非空 `projects` 数组——**没有 workspace**。
- 每个 Project 恰好为 `{id?, source, goal}`；`source` 直接成为不可变 `origin` Fact 描述。Project `id` 初始为空；首次 `run` 会把生成的 UUID 原子写回 `task.json`。非空 id（UUID）表示附加并复用持久化 Graph。
- 一个 Worker 是 `{type, model?, taskTypes, maxRunning, priority, env}`。`env` 携带 Worker 级环境变量（如 `ANTHROPIC_API_KEY`、`PI_MODEL`）合并进 CLI 子进程；没有自由形式的 `args` 字段。空 `model` 表示使用 Agent 工具默认模型。
- 至少一个 Worker 必须支持 `supervise`，至少一个必须支持 `execute`。`executeCapacity = sum(支持 execute 的 Worker 的 maxRunning)` 同时是 Plan 的 Intent 上限与 Execute 并发上限的唯一来源。
- Plan/Supervise 走独立通道，不占 Execute 容量；每个 Project 最多一个 Plan、一个 Supervise，由内存强制。
- Execute 默认接受最大 10 MiB 的 Artifact。高级配置仍可通过可选的 `phase.execute.maxArtifactBytes` 覆盖该限制。
- 阶段超时是固定运行时策略：Plan/Supervise 5 分钟、Execute 10 分钟、Finalize 2 分钟。

## CLI

```text
peak init [board-directory]          Scaffold a Board
peak run [board-directory]           在后台启动 Projects
peak resume <project-uuid> [board]   在后台附加一个 Project
peak serve [--port 8000]             在后台启动 Graph API + Web UI
peak status                          查看后台 Server 状态
peak stop                            停止 Server 与 Worker 子进程
peak export <project-uuid> [archive] 将已完成 Project 导出为 .tar.gz
peak import <archive>                导入 Peak home，供其他 Board 复用
peak workers                         List supported Worker/task types
```

后台输出写入 `<peak-home>/server.log`；本地进程元数据仅供 `status` 和 `stop` 使用。常用选项：`--host`（非 loopback 必须 `--token`）、`--port`（`0` = 临时端口）、`--token`、`--peak-home`、`--no-install-skills`。完成时 `run` 会为物化到 `task.json` 同目录的每个最终交付物打印 `[peak] deliverable: <path>`。

`export` 只接受 completed Project。归档包含 `manifest.json`（内含可直接加入 `board.projects` 的 JSON 区块）、`graph.json`、一致性的 `analysis.db` 快照和全部已注册的内容寻址 Artifact。`import` 会校验数据库、Graph JSON、Artifact 元数据/大小/SHA-256，以原 UUID 恢复且绝不覆盖已有 Project；随后把命令输出的 JSON 区块放入目标 Board 的 `task.json` 即可复用。

## Web UI

Dashboard 是自包含的 HTML/CSS/JS 客户端，从 `GET /` 提供（shell 不需要 Bearer；所有 `/api/*` 路由需要 token）。它轮询 Project 状态，把 Fact 渲染为节点、Intent 渲染为有向边、Hint 渲染为独立节点，并支持停止/恢复、显式 reopen、添加 Hint、平移/缩放/适配、JSON 快照以及 completed Project 完整归档下载。

## 示例

- [`examples/ai_agent_safety`](examples/ai_agent_safety/README.md) —— 英文：AI 安全情报简报 + Agent 护栏蓝图。
- [`examples/ai_agent_zh`](examples/ai_agent_zh/README.md) —— 中文版。

## 构建、测试与发布

```bash
npm run typecheck
npm run build        # 模块化 dist + scripts/*.mjs 语法与一致性校验
npm test             # 先构建，再针对 dist/ 运行测试
npm run smoke        # CLI 冒烟：init/workers/--version
npm run pack         # esbuild 单文件 bundle + npm pack + manifest
```

- 版本号以根目录 `version` 文件为准（打包时同步进 `package.json`；漂移由 `check-scripts` 拦截）。
- 发布日志（中英双语）：[`RELEASE.md`](RELEASE.md)。
- CI（`.github/workflows/ci.yml`）在 Linux + Windows 上运行 typecheck/build/test/smoke/pack；tag `v*` 触发 GitHub Release 并上传打包 tarball（`.github/workflows/release.yml`）。

## 文档

- [`docs/architecture.md`](docs/architecture.md) —— 架构说明：设计目标、模块职责、Graph 模型、Runtime 阶段、调度、Worker、Federation、CLI、Web UI、安全。
- [`docs/data-flow.md`](docs/data-flow.md) —— 数据流说明：数据模型与不变量、持久化布局、HTTP API、任务协议 JSON 合同、Board 配置 schema、端到端数据流。
- [`docs/completed-project-certified-frontier-plan.md`](docs/completed-project-certified-frontier-plan.md) —— completed Project 已认证证明出口的待实施计划。
- [`AGENTS.md`](AGENTS.md) —— 源码布局与贡献者不可越界的边界。
