# peak

`peak` 是一个配置驱动的多 Agent 运行时。每个任务创建一个 UUID Session，并在该 Session 的 `analysis.db` 中维护 Fact/Intent 任务图。Task、Agent 配置和任务 Skill 都放在当前 workspace，Session 状态单独持久化到 `~/.peak/sessions/`。

完整说明见 [整体架构](./docs/README.md) 和 [数据流转](./docs/data-flow.md)。

## 快速开始

```bash
npm install
npm run build
peak run examples/task.json --no-http
```

默认 Worker 是 OpenCode；`--mock` 用内置响应验证完整 planner → explorer → evaluator 流程。

```bash
peak run <task.json>              # 创建 UUID Session 并执行当前目录下的任务文件
peak resume [session-name|uuid]   # 默认恢复 .session.yaml 中的当前 Session
peak status [session-name|uuid]
peak sessions
peak search <query>
peak workers
```

常用选项：`--session <name>`、`--mock`、`--no-http`、`--port`、`--host`。Metacog 是每个 pass Fact 广播的必经机制，不能禁用。

## Task 文件

最小 Task 使用原生四角色和默认 OpenCode Worker：

```json
{
  "task": {
    "target": "app.apk",
    "goal": "分析安全问题"
  }
}
```

Task 可以选择一个可复用 Agent 配置包，并定义其中角色引用的 Worker：

```json
{
  "task": {
    "name": "app-audit",
    "target": "app.apk",
    "goal": "证明或排除可利用漏洞",
    "workspace": "."
  },
  "agent": "app_vulnhunt",
  "workers": {
    "fast": { "type": "opencode", "model": "anthropic/claude-sonnet" },
    "deep": { "type": "codex", "model": "gpt-5.5-codex" }
  },
  "scheduler": { "maxConcurrent": 4, "refillPerTick": 4 },
  "federation": { "scope": "app-suite" }
}
```

Task 顶层只接受：

- `task`：必需的 `target`、`goal`，以及可选 `name`、`workspace`。
- `agent`：Task 同目录 `<name>.json` 的单个配置包；省略即使用原生角色。
- `workers`：当前任务可使用的底层 Worker。
- `scheduler`：并发资源参数，不是 workflow。
- `federation.scope`：相关 Session 的广播与完成边界。

旧的 `profiles`、`agents` 数组、`control`、`task.session`、`workflow` 均会被拒绝，不提供兼容读取。

Session 显示名取值为：`--session` > `task.name` > 从 `task.target` 推导 > Task 文件所在目录名。真实目录始终使用随机 UUID；当前激活项写入 `~/.peak/sessions/.session.yaml`。

## Workspace 任务结构

一个 Task 完整保存在当前 workspace：

```text
workspace/
├── task.json
├── app_vulnhunt.json
└── skills/
    ├── decx-cli/SKILL.md
    └── app-vulnhunt/SKILL.md
```

`task.agent: "app_vulnhunt"` 读取同目录的 `app_vulnhunt.json`。Agent 文件可以一次定义四个初始协议角色，也可以多开同类角色并为其分配不同 Worker：

```json
{
  "roles": {
    "planner_vulnhunt": {
      "role": "planner",
      "worker": "deep",
      "prompt": {
        "instructions": "先拆攻击面，再拆数据流。",
        "knowledge": ["knowledge/android.md"],
        "rules": ["rules/evidence.md"]
      },
      "skills": ["decx-cli", "app-vulnhunt"],
      "tools": [],
      "context": { "graphView": "full", "maxFacts": 120 }
    },
    "explorer_gather": {
      "role": "explorer",
      "worker": "fast",
      "tools": ["read", "grep"]
    },
    "explorer_analysis": {
      "role": "explorer",
      "worker": "deep",
      "skills": ["app-vulnhunt"]
    },
    "evaluator": { "worker": "deep" },
    "metacog": { "worker": "deep" }
  }
}
```

自定义 ID 必须声明 `role`；`planner`、`explorer`、`evaluator`、`metacog` 这四个原生 ID 可省略它。未定制的协议角色自动使用原生配置。Agent 文件可配置 prompt、tools、Skill 名称、context、Worker 和执行参数，但不能覆盖角色权限或输出合同。Skill 必须使用小写字母、数字和连字符命名，禁止填写文件路径。

角色到 Worker 的引用必须能在 Task 的 `workers` 中找到。多个 explorer 角色会按 Intent 稳定分配；一个角色也可使用 `workers: ["fast", "deep"]` 声明可选 Worker 池。

`peak run` 和 `peak resume` 会从 `workspace/skills/<name>/SKILL.md` 验证任务 Skill，并创建目录软链接：

- OpenCode、Pi：`~/.agents/skills/<name>`
- Claude Code：`~/.claude/skills/<name>`
- Codex：当前 Task 初始化不安装，因为本版未定义其目标目录。

相同链接可重复初始化；错误的旧软链接会重建，但不会覆盖用户已有的真实目录。

## 固定角色协议

| 角色 | 输出 | 能力 |
|---|---|---|
| planner | `main_decision` | 创建/失败 Intent、派发/停止 explorer、处理 Hint、创建 EndFact |
| explorer | `candidate_fact` | 处理一个 Intent、提交 candidate Fact |
| evaluator | `verdict` / `broadcast_assessment` | 将 Fact 变为 pass/deny/pending、评估广播 |
| metacog | `hints` / `stop` | 纠偏、读取 Server 生成的图视图、广播已审查结果 |

权限与合同由协议固定。角色只读取 Server 落地的 context JSON，只输出合同 JSON，不获得 Graph、SQLite 句柄或数据库路径。

## 持久目录

```text
~/.peak/
└── sessions/
    ├── .session.yaml
    └── <uuid>/
        ├── analysis.db
        └── logs/
            ├── <timestamp>-<role>-context.json
            ├── <timestamp>-<role>-output.json
            └── main.log
```

- `analysis.db` 只保存当前 Session 的任务状态，不保存广播或广播评估。
- context/output 是每次角色执行的标准 JSON 历史。
- 文件名中的 `<role>` 是 Agent 包内的角色 ID，例如 `explorer_gather`。
- `main.log` 是 JSONL，追加记录角色输出经权限和合同校验后造成的 Graph 操作，以及统一广播的发送/接收记录。
- Session 执行历史只有上述 `logs/` 文件，不创建独立 `federation.db`。

## Worker

所有正式 Worker 都继承 `BaseWorker`。Agent 的 prompt、tools、skills 和 context 由 `BaseAgent` 组装；Worker 只选择模型、执行对应 CLI，并返回统一 result。

| `type` | CLI |
|---|---|
| `opencode` | `opencode run --format json -` |
| `codex` | `codex exec --json -` |
| `pi` | `pi --mode json -p` |
| `claude-code` | `claude -p --output-format json` |

Worker 只接受 `type`、可选 `model`、`args` 和 `timeoutMs`。模型会通过各 CLI 的 `--model` 参数传递；登录、凭据和 Provider 由 CLI 自身配置。Peak 不提供 API Worker、HTTP Worker、Provider 文件或模型 SDK 接入。`BaseWorker` 是以后扩展执行器的接口，但 Task JSON 第一版只接受上述四种类型。

## 验证

```bash
npm run typecheck
npm test
npm run smoke
npm run pack
```
