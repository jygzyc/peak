# Peak 整体架构

`peak` 的唯一运行单元是 Session：一个 Task、一个 UUID、一个 Project、一个 `analysis.db`。源码只实现调度、权限、合同、持久化和 Worker 适配；领域角色与 Skill 来自当前 Task workspace。

详细时序见 [data-flow.md](./data-flow.md)。

## 组件

```text
GlobalSupervisor
├── 管理多个 UUID Session
├── 协调同 scope Session 的结束
└── 共享进程内 FederationBus 协调器

SessionRuntime
├── SessionLoop            单 Session 调度与内存执行状态
├── MetacogSupervisor      纠偏、终审、广播
├── HttpServer             POST API、Graph snapshot、Graph 写入边界
├── SqliteGraph            Session 任务状态
└── BaseAgent              context → prompt → Worker → output JSON
```

| 组件 | 负责 | 不负责 |
|---|---|---|
| `GlobalSupervisor` | 多 Session 调度、全局 Worker 并发、结束协调 | Session 内规划 |
| `SessionLoop` | 选择角色、并发、取消、重试 | 持久化执行控制状态 |
| `HttpServer` | 按角色生成图快照、统一 POST 读模型、校验后提交图操作 | 角色策略 |
| `SqliteGraph` | 当前 Session 的任务状态 | Worker、重试、进程所有权 |
| `BaseAgent` | 落地 context/output、构造 prompt、调用 Worker、验证合同 | 读取或修改数据库 |
| `BaseWorker` | 配置 CLI 模型、执行 Agent 输入、归一化 result | Prompt 策略、Graph、调度、模型 SDK |
| `FederationBus` | 跨 Session 查询、广播、评估和完成协调 | 独立数据库、跨 Session Graph 写入 |

## 硬边界

1. planner、explorer、evaluator、metacog 都不得获得 Graph、SQLite 对象或数据库文件。
2. Server 从 Graph 生成角色范围内的 JSON；角色读取文件引用并返回 JSON。
3. 输出先落地，再检查固定合同与权限，最后提交 Graph，并把操作追加到 `main.log`。
4. `analysis.db` 只保存任务状态。活动 Worker、取消、重试、cooldown 和并发只在内存。
5. 不存在临时/内存数据库或独立 `federation.db`；执行历史只写入 `logs/`。
6. 第一版不迁移旧 schema，不兼容旧配置。

## 配置边界

Task 文件位于当前项目目录：

```text
task          target / goal / name? / workspace?
agent         一个同目录 <name>.json 引用，可省略
workers       当前任务的 Worker 定义
scheduler     maxConcurrent / refillPerTick
federation    scope
```

Task 不内嵌角色配置。Agent 配置包与 `task.json` 同目录；其 `roles` 中可声明任意 profile ID，但每项必须归属四种协议角色之一。可以同时声明 `explorer_gather`、`explorer_analysis`，并绑定不同 Worker。

每个角色项可配置：

```text
role
worker | workers
prompt.instructions / knowledge / rules
tools / skills
context
maxActive / cooldownSteps / retry
```

Worker 定义只包含：

```text
type       opencode | codex | pi | claude-code
model      可选，直接传给对应 CLI 的 --model
args       可选的额外 CLI 参数
timeoutMs  可选执行超时
```

四个实现都继承 `BaseWorker`。BaseAgent 负责把角色 prompt、tools、Skill 名称、context 和输出合同组装为输入；BaseWorker 负责公共进程执行，四个子类只实现命令构造和 result 解析。每次调用都是独立执行，不复用 Worker CLI 内部会话。Peak 不加载 Provider 配置，不调用模型 SDK。

Skill 配置必须位于 `skills/<name>/SKILL.md`，角色只填写纯名称。Task 初始化时，OpenCode/Pi 的 Skill 链接到 `~/.agents/skills/<name>`，Claude Code 链接到 `~/.claude/skills/<name>`；Codex 暂不安装。软链接幂等更新，但不覆盖已有真实目录。

权限和输出合同不能由 Agent 文件覆盖：

| 角色 | 合同 | 权限上限 |
|---|---|---|
| planner | `main_decision` | `create_intent`、`fail_intent`、`handle_hint`、`create_subagent_explorer`、`stop_subagent_explorer`、`create_end_fact` |
| explorer | `candidate_fact` | `handle_intent`、`write_candidate_fact` |
| evaluator | `verdict` / 广播评估 | `change_fact`、`receive_fact_broadcast` |
| metacog | `hints` / `stop` | `create_hint`、`get_graph`、`send_fact_broadcast` |

## Session 与目录

Session 显示名用于人类识别；目录键始终是随机 UUID。`~/.peak/sessions/.session.yaml` 只记录当前激活的名称和 UUID。
日志文件名中的 `<role>` 使用 Agent 包内的角色 ID，因此多开的 explorer 可直接区分。

```text
workspace/
├── task.json
├── <task-agent>.json
└── skills/
    ├── skill-1/SKILL.md
    └── skill-2/SKILL.md

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

## Graph

Fact 是 DAG 节点，Intent 是边，多 parent 关系在 `intent_sets` 中。

```text
Fact:    candidate -> pass | deny | pending
Intent:  open -> claimed -> pass | deny
Project: active | paused | finish_proposed | completed | failed | stopped
```

Graph 保存：Project、Fact、Intent、intent_sets、Hint、Directive、EndFact、Link、任务事件、dead-end 和进度。

Graph 不保存：执行所有者、lease、heartbeat、重试、cooldown、Worker Session、token、prompt、context/output 文件内容或进程状态。重启时遗留的 `claimed` Intent 恢复为 `open`。

## Server

所有 `/api/**` 接口都是 POST；仅 Dashboard 页面使用 `GET /`。

- `POST /api/sessions`
- `POST /api/sessions/:uuid`
- `POST /api/sessions/:uuid/graph/snapshot`
- `POST /api/sessions/:uuid/{facts,intents,end-facts,events}`
- `POST /api/sessions/:uuid/directives`
- `POST /api/task-groups`

Server 使用 UUID 校验 Session 与 Project 绑定。非 loopback 监听必须提供 token。

## 跨 Session 与结束

同一 `federation.scope` 下、Supervisor 实际注册的 Session 构成一组。每个 `pass Fact` 都触发 metacog，并产生一条 `{sessionId, factId, reason}` 广播。发送与接收历史写入各自 Session 的 `logs/main.log`；`FederationBus` 从这些日志恢复进程内队列，不拥有数据库，也不写入任何 Session Graph。

一组任务完成必须同时满足：

- 每个 planner 已创建 EndFact；
- 每个 Session 无未完成 Intent、candidate Fact 或活动角色执行；
- 每个 metacog 已完成最终审查；
- 所有广播已被其他相关 Session 评估。

## 验证

```bash
npm run typecheck
npm test
npm run smoke
npm run pack
```
