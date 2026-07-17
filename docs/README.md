# Peak 整体架构

`peak` 是配置驱动的多 Agent 运行时。源码只实现调度、权限、合同、持久化和 Worker 适配；领域行为放在 task、profile、prompt、rules、knowledge 与 skills 中。

详细时序见 [data-flow.md](./data-flow.md)。

## 1. 组件与所有权

```text
SessionRuntimeFactory / AgentRuntime
├─ GlobalSupervisor
│  ├─ 调度多个 SessionLoop
│  └─ GlobalResourceGovernor：限制全局 Worker 并发
├─ HttpServer：统一 POST API 与 Dashboard
├─ FederationBus：持久化跨 session 广播与 TaskGroup 屏障
└─ SessionRuntime × N
   ├─ SqliteGraph：一个 session、一个 Project
   ├─ SessionLoop：planner、explorer、evaluator 调度
   ├─ MetacogSupervisor：纠偏、终审与广播
   └─ BaseAgent：角色调用与 JSON 审计
```

| 组件 | 负责 | 不负责 |
|---|---|---|
| `GlobalSupervisor` | 多 session 调度、TaskGroup 完成协调 | session 内规划、跨 session Graph 写入 |
| `SessionLoop` | 单 session 主循环、活动调用、运行时重试与防重 | 持久化单次 Agent 调用 |
| `SqliteGraph` | Fact、Intent 等分析语义状态 | Worker 调用、取消、并发计数 |
| `BaseAgent` | context/output/record JSON、prompt、合同验证、Worker 调用 | 直接读取或修改 Graph/SQLite |
| `HttpServer` | session Graph 的统一读模型、控制 API、Dashboard | 角色策略与第二套状态 |
| `FederationBus` | 广播、delivery、cursor、TaskGroup 屏障 | 直接改写任一 session Graph |
| Worker/backend | prompt 输入、结构化文本输出 | Graph、调度和业务状态 |

## 2. 核心边界

1. 每个 session 对应一个任务、一个 Project 和一个持久 `analysis.db`。
2. Graph 是 session 内分析状态的唯一真相源。
3. planner、explorer、evaluator、metacog 都继承 `BaseAgent`，不得获得数据库对象或数据库文件。
4. 角色只读取 server 按 profile 生成的 JSON 文件，只输出合同约束的 JSON。
5. 活动调用、所有权、重试计数、planner cooldown、`AbortController` 和并发计数只存在于运行时内存；`AgentRecord` 只是 Graph 外的 JSON 审计。
6. Intent 只持久化 `open/claimed/pass/deny` 任务状态，不保存 worker、lease、epoch、heartbeat 或超时；SessionLoop 启动时将遗留的 `claimed` 重新开放。
7. 跨 session 只传摘要和引用；广播必须经目标 session 的 evaluator 判断。
8. 第一版不提供 schema 迁移、兼容字段、内存数据库或临时数据库模式。

## 3. Graph 模型

Fact 是 DAG 节点，Intent 是从一组已验证 Fact 指向后续工作的有向超边。多 parent 关系只保存在 `intent_sets` 中。

```text
Fact:    candidate -> pass | deny | pending
Intent:  open -> claimed -> pass | deny
Project: active | paused | finish_proposed | exhausted | completed | failed | stopped
```

Graph 持久化：

- Project、Fact、Intent、`intent_sets`
- Hint、Directive、EndFact、任务状态变更 Event
- dead-end route hash 与任务进度计数

Graph 不持久化：

- Agent 调用、Worker 进程、取消控制器
- worker 所有权、lease/fencing、重试、cooldown、runtime 并发计数、活动 Promise
- prompt context/output 审计文件
- federation insight、delivery、cursor 与 TaskGroup 状态；它们只在 FederationBus 数据库中

## 4. 固定角色协议

Profile id 可以自定义并多开同一种角色，但协议角色只有四种，权限只能缩小，不能越过下表上限。

内置 system prompt 也恰好四个：`builtin:planner`、`builtin:explorer`、`builtin:evaluator`、`builtin:metacog`。它们只描述职责与边界；`BaseAgent` 根据本次调用的有效 contract 统一追加精确 JSON 结构，prompt 文件不再复制合同 schema。

| 角色 | 触发 | 输出合同 | 能力上限 |
|---|---|---|---|
| planner | 初始规划、Graph 变化、Hint、Verdict、结束复核 | `main_decision` | `create_intent`、`fail_intent`、`handle_hint`、`create_subagent_explorer`、`stop_subagent_explorer`、`create_end_fact` |
| explorer | planner 派发并成功 claim Intent | `candidate_fact` | `handle_intent`、`write_candidate_fact` |
| evaluator | candidate Fact 或收到广播 | `verdict` / `broadcast_assessment` | `change_fact`、`receive_fact_broadcast` |
| metacog | pass Fact、配置 trigger、最终审查 | `hints` / `stop` | `create_hint`、`get_graph`、`send_fact_broadcast` |

每个 profile 绑定：

```text
role
runtime      worker / workers / model / provider
prompt       file / instructions / rules / knowledge / skills
context      graphView / maxFacts / relevance policy
permissions  capability 子集
output       contract
maxActive / cooldownSteps / triggers / maxOutputTokens / retry
```

`control.*Profile` 将自定义 profile 绑定到四个协议槽。Agent 配置文件是 builtin slot 的 patch，不是另一套角色模型。

## 5. 持久目录

```text
PEAK_HOME/
├─ config.json
├─ providers.json
├─ agents/<name>.json
├─ tasks/<name>.json
├─ federation.db
└─ sessions/<session>/
   ├─ analysis.db
   └─ agents/<agentId>/
      ├─ context.json
      ├─ output.json
      └─ record.json
```

`context.json` 和 `output.json` 是一次角色调用的标准输入/输出；`record.json` 保存 profile、role、Worker、hash、artifact 和状态。它们可审计，但不参与 Graph 状态流转。

## 6. Server

所有 `/api` 接口使用 POST；只有 Dashboard 页面使用 `GET /`。

| API | 用途 |
|---|---|
| `POST /api/sessions` | session 摘要 |
| `POST /api/sessions/:sessionId` | session Graph 详情 |
| `POST /api/sessions/:sessionId/graph/snapshot` | 按 profile 生成 Graph snapshot |
| `POST /api/sessions/:sessionId/{facts,intents,end-facts,events}` | Graph 读模型 |
| `POST /api/sessions/:sessionId/directives` | 注入控制指令 |
| `POST /api/task-groups` | TaskGroup 列表 |
| `POST /api/task-groups/:scope` | TaskGroup 状态 |

Server 默认绑定 loopback；非 loopback 必须配置 token。Server 不依赖角色实现，也不维护 Graph 的副本。

## 7. 配置与 Worker

`TaskConfig` 顶层结构：

```text
task        target、goal、session/name/workspace
profiles    profile 定义
workers     agent/api/mock Worker 配置
scheduler   maxConcurrent 与 refillPerTick
control     四个协议槽和全局并发绑定
federation  scope 与预期 members
agents      可复用 Agent patch 名称
```

配置合并顺序为 `defaultConfig() <- PEAK_HOME/config.json <- task.json`。相对 prompt 路径按其声明文件解析。`workflow` 不属于第一版 schema。

角色执行必须使用能够读取 session JSON 的 agent/mock Worker；直接 API Worker 不满足这个文件边界，会被拒绝。backend 保持 `prompt in -> structured text out`，不得拥有 Graph 或调度策略。

## 8. 结束条件

planner 通过 EndFact 提出 session 结束。完成前必须满足：

- 没有 open/claimed Intent、candidate Fact 或活动 Agent 调用；
- planner 的进程内 verdict inbox 已清空；
- metacog 已完成最终审查；
- 若属于 TaskGroup，所有成员均 finish-ready，所有 delivery 已处理，所有 cursor 到达稳定 head。

## 9. 代码入口与验证

核心入口：

- `src/app/agent-runtime.ts`、`src/app/session-runtime-factory.ts`
- `src/session/session-loop.ts`、`src/session/supervisor.ts`
- `src/agent/base-agent.ts`
- `src/graph/graph.ts`、`src/graph/sqlite-graph.ts`
- `src/server/http-server.ts`

交付检查：

```bash
npm run typecheck
npm test
npm run smoke
npm run pack
```
