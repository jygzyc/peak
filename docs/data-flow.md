# Peak 数据流转

本文只描述 Task、角色 JSON、Graph 和跨 Session 数据如何流动。组件所有权见 [README.md](./README.md)。

## 1. 创建 Session

```text
当前目录 task.json
  -> loadConfig
     ├─ 读取 task / agent / workers / scheduler / federation
     ├─ agent 缺省：加载原生四角色
     └─ agent=<name>：加载当前目录 <name>.json
  -> 初始化任务 Skill
     ├─ 校验 skills/<name>/SKILL.md
     ├─ OpenCode / Pi：链接到 ~/.agents/skills/<name>
     └─ Claude Code：链接到 ~/.claude/skills/<name>
  -> SessionManager 生成随机 UUID
  -> 写 ~/.peak/sessions/.session.yaml
  -> 创建 sessions/<uuid>/analysis.db 与 logs/
  -> 创建 Project
  -> 注册 SessionLoop、MetacogSupervisor、HttpServer、GlobalSupervisor
```

`task.json` 所在目录承载 task.json、Agent JSON 与 Skill 源目录；`task.workspace` 只决定 Worker 工作目录。它们都不承载 Session 状态。Skill 软链接只用于 Worker 发现，任务 Skill 的唯一源仍是 task 目录。

## 2. 一次角色执行

```text
SessionLoop / MetacogSupervisor 选择角色配置与 Worker
  -> Server 按 profile.context 读取 Graph
  -> 生成标准 GraphContextSnapshot
  -> logs/<timestamp>-<role>-context.json
  -> PromptBuilder 拼接
     ├─ 原生 system prompt
     ├─ 定制 prompt / knowledge / rules / skills
     ├─ context JSON 文件引用
     ├─ 当前任务说明与 tools 列表
     └─ 固定输出合同
  -> BaseAgent 将完整输入交给角色绑定的 Worker
  -> BaseWorker 选择配置模型并执行 OpenCode / Codex / Pi / Claude Code
  -> Worker 返回统一 result
  -> 解析 JSON envelope 并验证合同
  -> logs/<同一 timestamp>-<role>-output.json
  -> 检查角色固定权限
  -> 提交 Graph transaction
  -> 追加 logs/main.log
```

context 在 Worker 前落地；output 只有通过合同验证才落地。Worker 失败、取消或输出无效时，不写 output、不修改 Graph。没有第三个 record 文件，也没有 Run/Invocation 状态机。

`main.log` 每行是一个 JSON 对象，记录时间、role、operation 以及受影响的 Fact/Intent 等标识。它是图操作历史，不是第二份状态源。

## 3. SessionLoop 顺序

```text
1. 处理 Directive
2. 评估待处理的跨 Session 广播
3. 必要时运行 planner
4. 派发 planner 指定的 open Intent
5. evaluator 审查 candidate Fact
6. metacog 纠偏、终审并发布广播
7. 检查本 Session / 同 scope Session 是否完成
```

角色之间不直接传消息；本地协作通过 Fact、Intent、Hint、Directive，跨 Session 协作通过广播摘要和引用。

## 4. Planner

```text
Graph snapshot + 未消费 Hint + 最近 Fact 审查结果
  -> planner main_decision JSON
  -> 权限检查
  -> 创建/派发/停止/失败 Intent
  -> 消费指定 Hint
  -> 或创建 EndFact
  -> main.log
```

EndFact 是结束提议，不能绕过未完成的 Intent、candidate Fact、metacog 终审或跨 Session 广播。

## 5. Explorer

```text
open + dispatchRequested Intent
  -> Graph: open -> claimed
  -> SessionLoop 内存保存 AbortController 和执行 key
  -> 选择 explorer_gather / explorer_analysis 等配置
  -> 对应 Worker 读取 context JSON 与 workspace
  -> candidate_fact JSON
  -> Graph transaction
     ├─ 创建 candidate Fact
     └─ Intent: claimed -> pass
  -> main.log
```

Graph 的 `claimed` 仅是任务占位，不记录 Worker、lease 或 heartbeat。进程重启后遗留的 `claimed` 统一恢复为 `open`。传输或解析失败不会伪造 deny/dead-end；重试计数只在当前进程内。

## 6. Evaluator

```text
candidate Fact + 来源 Intent / parent Facts
  -> evaluator verdict JSON
  -> Graph transaction
     ├─ pass：成为后续 Intent 可引用节点
     ├─ deny：记录原因与 dead-end
     └─ pending：保存 requiredConditions
  -> main.log
```

无效输出不会自动否决 Fact；candidate 保持待审。后续本地 pass Fact 或经过 evaluator 的跨 Session 广播可以满足 pending 条件。

## 7. Metacog

```text
每一个 pass Fact / 结束复核
  -> metacog context JSON
  -> hints 或 stop JSON
  -> Hint 写入本地 Graph
  -> pass Fact 必须发布 {sessionId, factId, reason}
  -> 发送记录追加到本 Session logs/main.log
```

metacog 不直接访问数据库。控制面以 `sessionId + factId` 去重；同一轮出现多个 pass Fact 时逐个审查、逐个广播，不存在定时触发或最终摘要广播。

## 8. 跨 Session 广播

```text
来源 Session 的 pass Fact
  -> metacog 发布 {sessionId, factId, reason}
  -> 来源 logs/main.log 记录 send_fact_broadcast
  -> FederationBus 按引用读取来源 pass Fact
  -> 目标 evaluator 读取广播引用、原因和来源 Fact
  -> broadcast_assessment JSON
     ├─ relevant
     ├─ irrelevant
     └─ condition_satisfied(targetFactId)
  -> 目标 logs/main.log 记录 receive_fact_broadcast
  -> 必要时重新激活目标已有 pending Fact
```

广播不会把来源 Fact 复制进目标 Graph，也不能直接创建目标 pass Fact。`analysis.db` 没有 federation 表，也没有独立 `federation.db`；进程重启后，FederationBus 根据各 Session 的 `main.log` 重建已发送和已接收集合。

## 9. 完成

```text
每个 planner 创建 EndFact
  -> 每个 metacog 完成最终审查
  -> 所有本地工作结束
  -> 每个相关广播均已被其他 Session 接收处理
  -> GlobalSupervisor 将同 scope Projects 标记 completed
```

TaskGroup 成员就是同 scope 下实际注册的 UUID Session，不在 Task 文件中预填成员 ID。

## 10. 恢复

```text
peak resume [name|uuid]
  -> 无参数时读取 sessions/.session.yaml
  -> 打开 sessions/<uuid>/analysis.db
  -> 从 analysis.db 恢复 Project / Fact / Intent / Hint / Directive
  -> 从 logs/main.log 恢复广播发送/接收集合
  -> 从原 Task workspace 重新校验并安装 Skill 软链接
  -> claimed Intent 恢复 open
  -> 重建内存调度状态
```

重试、cooldown、活动 Worker、取消控制器不会恢复。context/output 与 `main.log` 是历史记录；任务真相仍以 `analysis.db` 为准。
