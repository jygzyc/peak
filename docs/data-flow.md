# Peak 数据流转

本文只说明数据如何进入角色、如何提交 Graph，以及如何跨 session 流动。组件职责见 [README.md](./README.md)。

## 1. Session 初始化

```text
task/agent/global config
  -> loadConfig + profile normalization
  -> SessionManager 创建或打开 sessions/<session>/analysis.db
  -> 创建/恢复 Project
  -> 组合 SessionLoop + MetacogSupervisor
  -> 注册到 GlobalSupervisor、HttpServer、FederationBus
```

task workspace 与 session 状态目录分离：Worker 的 `cwd` 是 workspace；Graph 和 Agent JSON 写入 session 目录。

## 2. 单次角色调用

四个角色共享同一条 `BaseAgent` 管线：

```text
SessionLoop / MetacogSupervisor 选择 profile 与 assignment
  -> SessionGraphReader 向 embedded/HTTP server 请求 profile-scoped snapshot
  -> server 从 Graph 生成 GraphContextSnapshot
  -> BaseAgent 写 agents/<agentId>/context.json
  -> PromptLoader 加载 system prompt、rules、knowledge、skills
  -> BaseAgent 根据有效 contract 生成唯一 JSON 输出说明
  -> PromptBuilder 拼接 system、文件引用、assignment、output contract
  -> Worker 执行
  -> parseEnvelope + contract validator
  -> BaseAgent 写 output.json，并将 record.json 标记 validated
  -> 控制面检查 profile permission
  -> Graph transaction 提交语义结果
  -> record.json 标记 applied
```

角色始终只看到 `context.json` 的文件引用和 prompt，不看到 Graph/SQLite。输出没有通过 JSON envelope 或合同验证时，不产生 Graph 变更，`record.json` 标记为 `failed`；取消时标记为 `cancelled`。

```text
AgentRecord: running -> validated -> applied | discarded
              └-----> failed | cancelled
```

AgentRecord 是审计流，不是 Graph 状态机。运行中的 `AbortController`、Promise 和并发计数不会落库。

## 3. SessionLoop 顺序

每个 step 按固定顺序推进：

```text
1. consume Directives
2. evaluate pending broadcasts
3. run planner（Graph 变化需要规划时）
4. dispatch explorers（仅派发被 planner 标记的 Intent）
5. run evaluators（处理 candidate Facts）
6. run metacog review，并直接持久化广播到 FederationBus
7. check local / TaskGroup completion
```

角色之间不直接发消息。Fact/Intent 状态、Hint、Directive 与 FederationBus delivery 是协调媒介；调用错误和重试只属于运行时。

## 4. Planner 数据流

```text
Graph snapshot + unconsumed Hints + recent Fact review results
  -> planner main_decision JSON
  -> PermissionChecker
  -> DecisionApplier transaction
     ├─ 创建 Intent + intent_sets
     ├─ 请求/停止 explorer dispatch
     ├─ deny Intent
     ├─ 消费指定 Hint
     └─ 创建 EndFact
```

planner 可以创建暂不派发的 open Intent；只有输出中明确请求 explorer，Intent 才能被 claim。EndFact 只是结束提议，不能绕过未完成工作和 TaskGroup 屏障。

## 5. Explorer 与 Intent

```text
open + dispatchRequested Intent
  -> Graph.claimIntent()
  -> claimed Intent
  -> SessionLoop 活动执行表持有 controller 和 execution key
  -> explorer 读取 Intent 与 parent pass Facts
  -> candidate_fact JSON
  -> permission: handle_intent + write_candidate_fact
  -> Graph transaction
     ├─ 新建 candidate Fact
     └─ Intent claimed -> pass，并关联 concludedFactId
```

Graph 不保存执行所有者或 lease。一个 SessionLoop 内由活动执行表防止重复执行；进程重启时，构造 SessionLoop 会把遗留的 `claimed` Intent 统一恢复为 `open`。

Worker/解析失败不会伪造 deny Fact 或 dead-end。达到 retry 上限时 Project 显式失败；未耗尽时释放 Intent 等待重试。

## 6. Evaluator 与 Fact

```text
candidate Fact + 来源 Intent/parent Facts
  -> evaluator review JSON（decision/reason/confidence/requiredConditions）
  -> permission: change_fact
  -> Graph transaction
     ├─ pass：成为后续 Intent 可引用的节点
     ├─ deny：记录 reviewer reason 与 dead-end
     └─ pending：保存 requiredConditions，等待条件满足
```

Evaluator 的 transport、parse 或 contract 错误不会自动 deny candidate Fact；Fact 保持 candidate 等待重试。

当新的 pass Fact 满足本地 pending Fact 的条件时，控制面可以重新激活该 Fact；跨 session 条件只能通过广播评估触发。

## 7. Metacog 与广播

Metacog 在 pass Fact、配置 trigger 或结束复核时运行：

```text
Graph snapshot
  -> hints / stop JSON
  -> create_hint permission
  -> Hint 写入 Graph
  -> planner 在后续 step 选择性消费
```

需要广播时，metacog 使用确定性 insight id 直接写入持久 `FederationBus`，再提交本地 Hint/review 任务状态。重复发布由 FederationBus 幂等处理，Graph 不保存投递状态。

## 8. 跨 Session 数据流

```text
source session pass Fact / pending condition / final summary
  -> FederationBus insight + target deliveries
  -> target session pendingForSession()
  -> target evaluator broadcast_assessment JSON
     ├─ relevant
     ├─ irrelevant
     └─ condition_satisfied(targetFactId)
  -> target Graph 记录评估或重新激活已有 pending Fact
  -> FederationBus acknowledge + cursor advance
```

广播只包含 summary、confidence、conditions 和 source refs。它不能直接创建目标 session 的 pass Fact；`condition_satisfied` 也只能引用目标 Graph 中已经存在的 pending Fact。

FederationBus 持久化：

- TaskGroup generation 与成员状态；
- insight、delivery 及其状态；
- 每个 session 的 cursor；
- finish-ready 与 group completion 状态。

## 9. TaskGroup 结束

```text
每个 planner 创建 EndFact
  -> 每个 metacog 完成 final review
  -> 所有 delivery 已 evaluated/irrelevant
  -> 所有 cursor == stable head
  -> FederationBus.tryCompleteScope(scope, generation)
  -> 各 Project completed
```

新成员、广播或新的 Graph 工作会使之前的结束提议失效或阻止提交。完成检查在 FederationBus transaction 中再次验证 generation 与水位。

## 10. Directive、取消与恢复

```text
POST /api/sessions/:sessionId/directives
  -> Directive 持久写入 Graph
  -> SessionLoop 消费
     ├─ stop：Project stopped + abort 活动调用
     ├─ pause：Project paused + abort 活动调用
     ├─ resume：Project active
     ├─ kill-intent：Intent deny + abort 对应 explorer
     └─ hint/spawn-intent：写入相应 Graph 状态
```

恢复只依赖 Graph 中的任务状态和 FederationBus 自己的 insight/delivery/cursor 水位。SessionLoop 的重试、cooldown、verdict inbox 和活动调用不会恢复；遗留 `claimed` Intent 会重新变为 `open`。调用 JSON 只用于审计，是否完成以 Graph transaction 是否提交为准。
