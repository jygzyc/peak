# Peak 使用指南

本指南覆盖 Peak 的端到端使用：快速开始、Board 配置、CLI 参考、Web UI 与示例。架构与数据流细节见 [`architecture.md`](architecture.md) 与 [`data-flow.md`](data-flow.md)；构建/测试/发布见 [`development_zh.md`](development_zh.md)。

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
node examples/ai_agent_zh/run.mjs    # 无需参数
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

后台输出写入 `<peak-home>/server.log`；本地进程元数据仅供 `status` 和 `stop` 使用。常用选项：`--host`（非 loopback 必须 `--token`）、`--port`（`0` = 临时端口）、`--token`、`--peak-home`、`--no-install-skills`。完成时 `run` 会为物化到 Project shard `out/` 目录（`~/.peak/projects/<uuid>/out/`）的每个最终交付物打印 `[peak] deliverable: <path>`。

`export` 只接受 completed Project。归档包含 `manifest.json`（内含可直接加入 `board.projects` 的 JSON 区块）、`graph.json`、一致性的 `analysis.db` 快照和全部已注册的内容寻址 Artifact。`import` 会校验数据库、Graph JSON、Artifact 元数据/大小/SHA-256，以原 UUID 恢复且绝不覆盖已有 Project；随后把命令输出的 JSON 区块放入目标 Board 的 `task.json` 即可复用。

## Web UI

Dashboard 是自包含的 HTML/CSS/JS 客户端，从 `GET /` 提供（shell 不需要 Bearer；所有 `/api/*` 路由需要 token）。它轮询 Project 状态，把 Fact 渲染为节点、Intent 渲染为有向边、Hint 渲染为独立节点，并支持停止/恢复、显式 reopen、添加 Hint、平移/缩放/适配、JSON 快照以及 completed Project 完整归档下载。

## 示例

- [`examples/ai_agent_safety`](../examples/ai_agent_safety/README.md) —— 英文：AI 安全情报简报 + Agent 护栏蓝图。
- [`examples/ai_agent_zh`](../examples/ai_agent_zh/README.md) —— 中文版。
