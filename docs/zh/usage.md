# Peak 使用指南

本指南覆盖 Peak 的端到端使用：快速开始、Board 配置、CLI 参考、Web UI 与示例。架构与数据流细节见 [`architecture.md`](architecture.md) 与 [`data-flow.md`](data-flow.md)；构建/测试/发布见 [`development.md`](development.md)。

## 快速开始

```bash
npm install
npm run build

peak init ./my-board            # 脚手架一个带空 task.json 的 Board
peak serve --port 8000          # 独立持久化 Graph API + Web UI，不启动 Worker
peak prepare ./my-board --graph-url http://127.0.0.1:8000   # 创建并持久化全部 Project ID
peak dispatch ./my-board --graph-url http://127.0.0.1:8000  # 独立 Dispatch 进程
```

`peak serve` 与 Dispatch 始终是不同进程。`peak start ... --graph-url ...` 只是后台 Dispatch 入口，不会内嵌 Server；`peak dispatch` 在前台运行。使用 `peak status` 查看状态，使用 `peak stop [task-name]` 优雅关闭。

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
    "plan": { "customProfile": { "description": "使用 Task 方法规划。", "prompt": "规划下一条证据步骤。", "skills": ["my-skill"] } },
    "supervise": { "intervalMs": 90000, "customProfile": { "description": "复核证明。", "prompt": "寻找具体证明缺口。", "skills": ["my-skill"] } },
    "execute": { "customProfile": [{ "description": "执行工作。", "prompt": "收集已验证证据。", "skills": ["my-skill"] }] }
  }
}
```

`board.skills` 是 Task 级安装/允许列表。每个 `customProfile.skills` 必须是其中无重复的子集，运行时只把当前 Plan、Supervise 或 Execute profile 选中的 Skills 注入对应 Worker prompt。Finalize 继承已选 Execute profile 及其 Skills。Analyze 是固定的内部递归机制，不提供 profile、Skills 或任何 Task 配置。不可变 `graph-*.json` 快照只在 `customProfile.skills` 下记录本次选中的 Skill 名称，不持久化顶层 Skill 列表、Worker 配置、完整渲染 Prompt 或 Worker 输出。

- 顶层字段只能是 `board`、可选 `execution`、`workers`、可选 `scheduler`、可选 `phase`；unknown 字段被递归拒绝。
- `board` 有可选 `name`、可选 Skill 名称与非空 `projects` 数组——不包含执行设置、Server 地址或 workspace。
- 每个 Project 恰好为 `{id?, source, goal}`；`source` 直接成为不可变 `origin` Fact 描述。前台 `peak dispatch` 前先运行 `peak prepare`；后台 `peak start` 会自动执行同等准备。使用 `--project` 水平拆分前，所有 Project 必须已有 UUID，避免多个 Dispatch 并发改写 `task.json`。
- 每个 `workers[]` 配置项由 Worker 定义 `{type, model?, env}` 和仅属于配置层的路由元数据 `{taskTypes, maxRunning, priority}` 组成。`taskTypes` 只供 Runtime 路由使用，不会传入 Worker 模块。`env` 携带可选的 Worker 级环境变量（如 `PI_MODEL`）并合入 CLI 子进程；没有自由形式的 `args` 字段。空 `model` 表示使用 Agent 工具默认模型。Docker 直接复用主机已有的 CLI 配置目录，无需在 `task.json` 中设置 API key。
- 至少一个配置路由必须包含 `supervise`，至少一个必须包含 `execute`。`executeCapacity = sum(包含 execute 的路由的 maxRunning)` 同时是 Plan 的 Intent 上限与 Execute 并发上限的唯一来源。
- Plan/Supervise 走独立通道，不占 Execute 容量；每个 Project 最多一个 Plan、一个 Supervise，由内存强制。
- Execute 默认接受最大 10 MiB 的 Artifact。高级配置仍可通过可选的 `phase.execute.maxArtifactBytes` 覆盖该限制。
- 阶段超时是固定运行时策略：Plan/Supervise 5 分钟、Execute 10 分钟、Finalize 2 分钟。
- `execution` 恰好为 `{mode, networkMode?}`。`mode` 为 `local`（默认）或 `docker`；Docker 为每个 Project 创建一个长驻容器，容器引擎或镜像不可用时整个 Task 回退 local。`networkMode` 映射到 Docker `--network`。详见 [container/AUTH.md](../../container/AUTH.md)。

## CLI

```text
peak init [board-directory]          Scaffold a Board
peak start [board-directory]         连接 --graph-url，在后台启动 Dispatch
peak prepare [board-directory]       创建缺失 Project 并固定完整 UUID 集合
peak dispatch [board-directory]      连接外部 Server 并运行 Task Projects
peak resume <project-uuid> [board]   在后台附加一个 Project
peak serve [--port 8000]             在后台启动 Graph API + Web UI
peak status                          查看后台 Server 状态
peak stop [task-name]                停止指定 task，未指定时停止全部 task 与 Server
peak export <project-uuid> [archive] 将已完成 Project 导出为 .tar.gz
peak import <archive>                导入 Peak home，供其他 Board 复用
peak image pull [--force]            提前拉取当前版本的任务镜像
peak workers                         List supported Worker/task types
```

后台输出写入 `<peak-home>/server.log`；本地进程元数据仅供 `status` 和 `stop` 使用。`--host/--port` 只属于 `peak serve`，`start/dispatch/resume` 必须提供 `--graph-url`。Peak 的 Graph API 对外公开，不内置访问 token 层。

`export` 只接受 completed Project。归档包含 `manifest.json`（内含可直接加入 `board.projects` 的 JSON 区块）、`graph.json`、一致性的 `project.db` 快照、全部内容寻址 Artifact，以及每个当前 leaf 的 `path_abs_<factId>`。`import` 会校验数据库、Graph JSON、Artifact 和 Path Abstract 的集合/大小/SHA-256，以原 UUID 恢复且绝不覆盖已有 Project；随后把命令输出的 JSON 区块放入目标 Task，Joint Plan 即可直接复用全 leaf Path Abstract，只有缺失项才 Analyze。

## Web UI

Dashboard 是自包含的 HTML/CSS/JS 客户端，从 `GET /` 提供并直接使用公开 Graph API。它轮询 Project 状态，把 Fact 渲染为节点、Intent 渲染为有向边、Hint 渲染为独立节点，并支持停止/恢复、显式 reopen、添加 Hint、平移/缩放/适配、JSON 快照以及 completed Project 完整归档下载。

## 示例

- [`examples/ai_agent_safety`](../../examples/ai_agent_safety/README.md) —— 英文：AI 安全情报简报 + Agent 护栏蓝图。
- [`examples/ai_agent_zh`](../../examples/ai_agent_zh/README.md) —— 中文版。
