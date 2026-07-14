# 04 · 会话运行时（`src/session/`）

> 审计范围：5 个文件——`session-loop.ts`（核心调度，401 行）、`supervisor.ts`（多会话监督，95 行）、`metacog-supervisor.ts`（壁钟 metacog，152 行）、`project-lock.ts`（项目级互斥，53 行）、`session-manager.ts`（会话存储定位，77 行）。
> 本层是 agent 的「心脏」：所有运行时调度、SubagentRun 生命周期、并发控制汇集于此。

> ⚠️ 重要变更：**chain 机制已整体删除**（无 `resolveChains`、无 `chainedIntents`）；**maxSteps 默认改无界**（无 `DEFAULT_LIMITS`/`WorkflowConfig`/`stopGate`/`maxStagnation`）；**dispatchExplorers 起始新增每步 sweepExpiredLeases**；**runOneExplorer 接入 conclude fallback + token 估算改用 estimateContextTokens**；**evaluator 失败不再兜底 reject**。

---

## 4.1 `session-loop.ts`（401 行）— 单会话主循环

### 用途
**单 session 主循环**。驱动 project step：`directives → planner(MainAgent) → explorers(SubagentRunner) → evaluators(SubagentRunner) → termination`。文件头（1–8 行）明确：调度与 SubagentRun 生命周期在本文件，role-specific prompt 组装委托给 SubagentRunner。**不再有 chain resolution 步骤**——explorer 只返回 fact。

### 关键导出
- `SessionLoop`（class）
- `StepResult`（union：stepped/idle/completed/failed）
- `RunOptions`（maxSteps?/idlePollMs?/onStep?）—— maxSteps 可选，默认 `undefined`（无界）

### 字段（41–56 行）
- `locks: ProjectLockManager`（私有）+ `locks_`（readonly 别名，暴露给 MetacogSupervisor）
- `contextLedger: ContextLedger`、`sessionManager: WorkerSessionManager`、`promptLoader: PromptLoader`
- `stepVerdicts: Map<ProjectId, Array<{factId, verdict, intentId?}>>`（本 step 内 evaluator 裁决，喂下次 planner）
- `lastPlannerStep: Map<ProjectId, number>`（planner 冷却计数）

### 核心方法与流程
- **`step(projectId)`**（58–60 行）：`locks.acquire` → `stepLocked`
- **`tick()`**（62–71 行）：`sweepExpiredLeases` → `listProjects("active")` → `Promise.allSettled(step)`，异常降级为 `{type:"failed"}`
- **`run(projectId, options)`**（73–91 行）：`maxSteps = options.maxSteps`（**默认 `undefined` = 无界**，第 80 行）；循环 `for step=1; maxSteps===undefined || step<=maxSteps`（第 84 行）。注释（74–79 行）明确：这是无界探索/blackboard agent，终止是自然完成（planner 不产新 intent 且无在途 intent），metacog hint 是纠偏机制而非硬停止。idle 时 `sleep(idlePollMs ?? 50)`
- **`stepLocked`**（93–118 行）：
  ```
  sweepExpiredLeases
  → consumeDirectives
  → 状态检查（completed/stopped→completed；failed→failed；其它→idle）
  → factsBefore 计数
  → maybeRunPlanner
  → dispatchExplorers
  → runEvaluators
  → checkTermination（命中则 return）
  → factsAfter 计数，返回 stepped{intentsDispatched, factsAccepted}
  ```
  **注意：流程中无 chain resolution 步骤。**
- **`consumeDirectives`**（120–153 行）：按 kind（stop/pause/resume/hint/kill-intent/spawn-intent）执行；kill-intent 包 try/catch（intent 可能不存在）
- **`maybeRunPlanner`**（157–206 行）：needsPlanning = `isEmpty || hasActionableHint || hasRejectOrDemote`；plannerCooldownSteps 默认 3（来自 profile）；跑 MainAgent + applyMainDecision；catch 吞错记 `planner.error`
- **`dispatchExplorers`**（208–245 行）：
  - **起始 `this.graph.sweepExpiredLeases()`**（213 行）——在任何 claimed-slot 计数之前清扫过期 lease，使崩溃/放弃 worker 在同一步内释放槽位（镜像 Cairn 的 expire_workers-before-claim 模式，见 209–212 行注释）
  - dead-end 预过滤（`isDeadEnd` 命中→`failIntent(..., true)`，218–221 行）
  - 按 `maxConcurrent`(默认 3)/`refillPerTick`(默认 1) 算 `availableSlots = max(0, maxConcurrent - claimedCount)`、`slots = min(availableSlots, refillPerTick, dispatchable.length)`
  - `explorerProfile.maxActive` 二次裁剪 batch（235–241 行）
  - `Promise.allSettled(batch.map(runOneExplorer))`
- **`runOneExplorer`**（247–304 行）：createSubagentRun → claimIntent(leaseMs) → `runSubagentWithText` → **解构 `{output, prompt, rawText, usedDelta, usedConclude}`**（264 行）→ `inputTokens = estimateContextTokens(prompt)`、`outputTokens = estimateContextTokens(rawText)`（275–276 行）→ **explorer 只接受 `output.kind === "fact"`**（278 行，否则抛 StageError）→ addFact + concludeIntent + updateSubagentRun（含 `usedDelta, usedConclude, inputTokens, outputTokens`）；catch → failIntent + 记 `explorer.error` event
- **`runEvaluators`**（306–368 行）：pendingCandidates → 各自 createSubagentRun → runSubagent → `output.kind === "verdict"` 校验 → `resolveFact` + 累计 stepVerdicts；**catch 不再 reject**（见 354–365 行注释）：evaluator 临时性错误（网络/超时/parse）只把 run 置 failed、记 `evaluator.error` event，**candidate 保持 candidate 状态**供后续 step 重试，避免错误 reject 污染 dead-end
- **`checkTermination`**（370–396 行）：
  ```
  project.status !== "active" → completed/stopped→completed; failed→failed; paused→idle
  否则：progress.openIntents === 0 → updateProjectStatus("completed") + log "project.completed_natural" → 返回 completed
  否则返回 undefined（继续 step）
  ```
  **自然完成条件仅 `openIntents === 0`**（第 386 行）。注释（379–384 行）明确：无深度上限、无 stop gate、无强制 stagnation pause；stagnation 触发的是 metacog 循环（发 hint 给 planner），planner 是终止的唯一裁决者。

### 审计要点
- ⚠️ **`run` 默认无界**（第 80 行 `maxSteps = undefined`）：循环直到自然完成或外部 stop/pause directive。这是设计意图（注释 74–79 行），但意味着若 planner 持续产新 intent 或 evaluator 持续失败导致 candidate 堆积，循环可能长跑——**唯一的硬停止是 directive stop 或 metacog 的 stop 输出**。`maxSteps` 仅作为显式可选安全网（调用方传入时才生效）。
- ⚠️ **`runOneExplorer` token 仍为粗估**（275–276 行）：`inputTokens` 与 `outputTokens` 都改用 `estimateContextTokens`（基于文本长度估算），不再是硬编码 0。但仍非真实 token 数（worker 层不回传 usage），quota/计费/审计**仍不可完全信赖**，只是不再恒为 0。
- ✅ **`runOneExplorer` 接入 conclude fallback**（264 行解构 `usedConclude`，294 行传入 updateSubagentRun）：SubagentRun 记录了是否走 conclude 通道，便于后续审计 context-compression 行为。
- ✅ **`runEvaluators` 失败处理已修正**：catch 不再 reject（354–365 行注释详述原因），candidate 保留待重试，避免 spurious reject 污染 dead-end 与 planner 决策。
- ⚠️ **`maybeRunPlanner` 死代码仍在**（178 行）：`if (!isEmpty && !hasActionableHint && !hasRejectOrDemote && inCooldown)`——条件 `!isEmpty && !hasActionableHint && !hasRejectOrDemote` 恰为 `!needsPlanning`，而上方 `if (!needsPlanning) return`（167–170 行）已拦截，**此分支永不可达**。
- ⚠️ **`dispatchExplorers` 的 maxActive 二次裁剪**（235–241 行）：`inFlight = Math.max(activeRuns, claimedCount)`——activeRuns（running SubagentRun）与 claimedCount（claimed intents）语义重叠但非恒等（claimed intent 可能 run 还未 running）。取 max 是保守限流（多限不少限），但若两者都高估则可能不必要地饿死 dispatch。
- ⚠️ **`dispatchExplorers` 两次 sweepExpiredLeases**：`tick()`（63 行）开头已 sweep 一次，`dispatchExplorers`（213 行）又 sweep 一次，`stepLocked`（97 行）也 sweep 一次。同一 step 内可能 sweep 三次，幂等但冗余调用（轻微性能，无正确性问题）。
- ⚠️ **`consumeDirectives` 的 stop/pause 在循环中 return**（126–132 行）：处理完一个 stop/pause directive 就 return，后续 directive 被忽略。
- ⚠️ **`stepVerdicts` 清空时机分散**：在 `maybeRunPlanner` 多处 `this.stepVerdicts.set(projectId, [])`（168、179、199 行）——语义是「planner 决策点清空」，但分散在三处易混淆；实际因死代码分支（179 行）不可达，真正生效的是 168 行（不跑 planner）与 199 行（跑完 planner）。
- ✅ `tick()` 用 `Promise.allSettled` + 异常降级，单 project 失败不拖垮其它。
- ✅ ProjectLockManager 串行化同 project step，避免 claim/conclude/resolve 竞态。
- ✅ dead-end 预过滤（`dispatchExplorers`）避免重复派发已知失败 intent。
- ✅ `dispatchExplorers` 起始 sweepExpiredLeases 使崩溃 worker 同步释放槽位，避免 dispatch 阻塞到下一 tick。

### 跨文件观察
- 是整个 agent 的调度中枢；被 `agent-runtime.ts`、`cli.ts`（resume）构造。`MetacogSupervisor` 通过 `locks_` 共享同一 ProjectLockManager，确保 metacog 与主循环不并发改同一 project。
- **不再读 `DEFAULT_LIMITS`/`WorkflowConfig`**——这些概念已从本文件移除。scheduler/maxConcurrent/workerLeaseMs 全部来自 `config.scheduler ?? DEFAULT_SCHEDULER`（types.ts:395，maxConcurrent=3、refillPerTick=1、workerLeaseMs=300_000）。

---

## 4.2 `supervisor.ts`（95 行）— 全局多会话监督

### 用途
**进程级多 session 控制器**。文件头（1–17 行）强调：多任务调度**不应**用单一全局 MainAgent，而是 N 个 session-local SessionLoop 各自有 planner/metacog；GlobalSupervisor 只做注册/注销、全局 tick、全局并发配额、FederationBus 持有。不拥有 per-session planning。

### 关键导出
- `GlobalSupervisor`（class）
- `RegisteredSession`、`GlobalTickResult`、`GlobalSupervisorOptions`

### 方法
- `register(id, loop)` / `unregister(id)` / `get(id)` / `listSessions()`
- `tick()`（72–88 行）：`Promise.allSettled(sessions.map(({id,loop}) => loop.tick()))`，取每个 loop 的 `stepResults[0]`，降级为 `{type:"idle", reason:"no active projects"}`
- `stepSession(sessionId, projectId)`

### 审计要点
- 🚨 **`globalMaxConcurrent` 仍是死字段**（41、45 行）：构造期读取 `options.globalMaxConcurrent ?? Infinity` 存为 readonly，但 **`tick()` 完全不用它限制并发**——直接 `Promise.allSettled(active.map(...))` 全并发。文件头宣称「Enforce a global worker concurrency quota across all sessions」**未实现**。注意：`config/task-config.ts` 仍解析 `globalMaxConcurrent` 配置项（226 行）、`agent/types.ts` 仍声明该字段（378 行），但本类从未消费——配置到运行时存在断链。
- ⚠️ **`tick()` 取 `stepResults[0]`**（第 77 行）：每个 session 只报告第一个 project 的 step 结果，多 project session 的其余结果被丢弃，审计/监控不完整。
- ⚠️ **`register` 重复 id 抛错**（49–51 行），但 `unregister` 不校验存在性，`get`/`listSessions` 也不报已注销。
- ⚠️ **`federationBus` 默认 new 但无注册/触发**：构造期 `new FederationBus()`（44 行），但本文件不向 bus publish 任何事件；FederationBus 的消费者需自行接线（见 [08-graph.md](./08-graph.md)）。
- ✅ 设计正确：session-local 隔离 + 全局协调分离，避免单点 planner 瓶颈。

### 跨文件观察
- 被 `index.ts` 导出但**当前无内部消费者**（`AgentRuntime` 不用它，`cli.ts` 也不用）——是为「多 session serve 模式」预留，但该模式未实现（见 [01-entry-points.md](./01-entry-points.md) 的 serve 命令缺失）。

---

## 4.3 `metacog-supervisor.ts`（152 行）— 壁钟 metacog 循环

### 用途
**壁钟驱动的 metacognition 循环**，独立于 SessionLoop 的 step 节奏。用 `setInterval` 定期跑 metacog profile，追踪 active SubagentRun，遵守 maxActive 防过 spawn。

### 关键导出
- `MetacogSupervisor`（class）
- `DEFAULT_METACOG_INTERVAL_MS`（模块常量，19–21 行）——由 `DEFAULT_METACOG_TRIGGERS.everySeconds * 1000` 推导（= 30000ms）

### 字段与方法
- `timer`/`running`/`intervalMs`/`promptLoader`/`contextLedger`/`sessionManager`
- `start()`（48–53 行）：置 running，立即 tick 一次，`setInterval(tick, intervalMs)`
- `stop()`（55–61 行）：清 timer
- `runOnce()`（67–70 行）：手动触发一次（供测试/外部调度）
- `tick()`（72–76 行）：`listProjects("active")` → 各自 `runForProject`
- `runForProject`（78–151 行）：`locks.acquire` → 算 shouldRun → maxActive 限流 → createSubagentRun → runSubagent → hints/stop 分支；catch 记 `metacog.error`
- 构造器（31–46 行）：intervalMs 解析顺序为 `intervalMs 参数 → metacogProfile.triggers.everySeconds*1000 → DEFAULT_METACOG_INTERVAL_MS`。**从 per-profile triggers 读取**，无全局 workflow block

### shouldRun 触发条件（92–95 行）
```
progress.stagnationLevel >= stagnationTrigger(默认3)
|| (stepsExecuted > 0 && stepsExecuted % everySteps(默认5) === 0)
|| (openIntents === 0 && candidateFacts === 0 && acceptedFacts > 0)
```
> 注意：第三项为自然完成检测——当无 open intent、无 pending candidate、且有 accepted facts 时跑 metacog（让 metacog 在项目即将自然完成前做最后审视）。**chainedIntents 已从条件中移除**。

### 审计要点
- ⚠️ **`start()` 立即 tick 一次**（51 行）：构造后第一次 tick 在 step 0，可能 `stepsExecuted===0` 不满足前两条触发；但若第三条满足（无 intents 且有 facts）会跑——新 project 刚 createProject 时一般 acceptedFacts=0 故不触发，OK。
- ⚠️ **`runForProject` 的 `output.kind` 非 hints/stop 时**（139–144 行）：记 `outputSummary: "unexpected kind: ..."` 但**不更新 project 状态也不加 hint**——metacog 返回 `verdict`/`fact`/`decisions` 等非预期类型时静默忽略。
- ⚠️ **`locks` 共享 SessionLoop 的 ProjectLockManager**（79 行 `this.locks.acquire`）：metacog 与主循环 step 串行，但 metacog 内 `runSubagent` 是长任务（LLM 调用），会阻塞主循环 step 直到 metacog 跑完——**壁钟循环可能拖慢 step 节奏**。应考虑 metacog 用独立锁或不持锁。
- ⚠️ **`maxActive` 默认 1**（99 行）：同一 project 同时只能有 1 个 running metacog run，合理；但跨 project 并发不受限（`Promise.allSettled` 全跑）。
- ⚠️ **无错误重试/退避**：metacog 失败仅记 event（148 行），下次 tick 照常触发，可能反复失败。
- ✅ intervalMs 解析链清晰（参数 → profile triggers → 模块默认），与 `DEFAULT_METACOG_TRIGGERS.everySeconds=30`（types.ts:404）一致，**无默认值打架问题**（旧版 30s/60s/30s 三处不一致已消除）。
- ✅ `runOnce` 暴露，便于测试与外部触发。
- ✅ `stop` 幂等（`if (this.timer)`）。

### 跨文件观察
- 被 `AgentRuntime` 构造（当 `useMetacogSupervisor !== false`）并共享 `sessionLoop.locks_`。与 SessionLoop 的 `stepVerdicts` 无共享——metacog 看不到本 step 的 verdicts（只能从 graph 读 history）。

---

## 4.4 `project-lock.ts`（53 行）— 项目级互斥

### 用途
**单 project 串行、跨 project 并行**的互斥锁。Graph 写操作（claim/conclude/resolve）假设同 project 无并发修改。

### 关键导出
- `ProjectLockManager`（class）：`acquire<T>(projectId, fn): Promise<T>`、`pendingCount(projectId): number`

### 实现机制
基于 Promise 链：`chains: Map<ProjectId, Promise<unknown>>` 串起同一 project 的 fn；`pending` 计数用于诊断。注释（19–21 行）明确**不支持同异步链重入**。

### 审计要点
- ⚠️ **不支持重入**（注释 19–21 行）：若 fn 内部又 `acquire(同 projectId)`，会死锁（等自己 release）。当前调用方（SessionLoop.step、MetacogSupervisor.runForProject）不会重入，但无防护。
- ⚠️ **`acquire` 的 `previous.then(() => next)`**（第 32 行）：链条存储的是「previous 完成后等 next」；若 fn 抛错，finally 里 release() 解 next，链条继续——错误隔离 OK。但若 fn 永不 resolve（worker 卡死），整个 project 链永久阻塞，**无超时**。
- ⚠️ **`pending.delete`/`chains.delete` 时机**（39–46 行）：`remaining <= 0` 才删，但 `chains.delete` 在 finally——若多个 acquirer 并发，最后一个才删，中间态 chains 持有已完成的 Promise，内存 OK（GC 友好）。
- ⚠️ **无 projectId 合法性校验**：任意 string 可作 key，与 `session-manager.ts` 的会话定位无关联（projectId 与 sessionId 是不同命名空间）。
- ✅ 实现极简，纯 Promise 无 native 锁依赖。
- ✅ `pendingCount` 提供诊断接口。

### 跨文件观察
- 被 SessionLoop（`step`）和 MetacogSupervisor（`runForProject`）共享实例（通过 `locks_`），确保 metacog 与主循环对同 project 互斥。是并发正确性的基石。

---

## 4.5 `session-manager.ts`（77 行）— 会话存储定位

### 用途
session → 文件系统位置的映射。创建/打开 SQLite graph 文件，列出/删除 session。**只做定位与生命周期**，运行时状态仍 per-session。

### 关键导出
- `SessionManager`（class）
- `SessionInfo`（interface）

### 方法
- `sessionDir(id)`（26–39 行）：路径拼接 + **双层路径穿越防护**（见下）
- `dbPath(id)`（41–43 行）：`join(sessionDir(id), "analysis.db")`
- `info(id)`（45–49 行）：返回 `{sessionId, dbPath, dir, exists}`（exists 查 db 文件）
- `listSessions()`（51–58 行）：扫 baseDir 子目录，过滤含 `analysis.db` 的
- `open(id)`（60–64 行）：`mkdirSync(recursive)` + `new SqliteGraph(dbPath)`（读写）
- `openReadOnly(id)`（66–71 行）：不 mkdir，db 不存在抛错，`new SqliteGraph`（注释说只读，实际 SqliteGraph 无只读模式）
- `delete(id)`（73–76 行）：`rmSync(recursive, force)`

### 路径穿越防护（26–39 行）
`sessionDir` 做了两层防护：
1. **第一层 `safeSessionName(sessionId)`**（来自 `config/utils.ts:39`）：`replace(/[^A-Za-z0-9._-]+/g, "-")` 规范化非法字符、`replace(/\.{2,}/g, ".")` 将 `..` 折叠为 `.`（破坏 `../` 穿越）、`replace(/^-+|-+$/g, "")` 去首尾 dash、空则返回 `"session"`。
2. **第二层 `relative()` 包含性检查**（34–37 行）：`rel = relative(baseDir, dir)`，若 `rel.startsWith("..")` 或 `resolve(baseDir, rel) !== dir` 则抛 `refusing session id outside base directory`。

> 评估：**路径穿越已被有效防护**。`safeSessionName` 单独使用时对边界 case（如空字节、Unicode 规范化）可能有遗漏，但第二层 `relative()` 检查是真正的 backstop——即使 `safeSessionName` 漏过某种构造，只要 `resolve` 结果在 baseDir 之外就会抛错。注释（29–31 行）明确该机制的存在目的。这是相比旧版本（裸 `join(baseDir, sessionId)`）的实质安全改进。

### 审计要点
- ✅ **路径穿越已双层防护**（safeSessionName + relative 包含性检查，34–37 行）：`open("../evil")` 会被折叠+拒绝，不再能创建/删除 baseDir 之外的目录。`delete` 的 rmSync recursive force 因此也被约束在 baseDir 内，安全风险大幅降低。
- ⚠️ **`openReadOnly` 名不副实且为死方法**（66–71 行）：注释与文件头（1–7 行）说「只读」，但实现是 `new SqliteGraph(info.dbPath)`——SqliteGraph 构造不区分读写（见 [08-graph.md](./08-graph.md)），返回的 Graph 可写。且全仓 grep 确认**无调用方**（`openReadOnly` 在 src/ 中除定义外无引用），是死方法。
- ⚠️ **`open` 覆盖已有 session 无提示**：`mkdirSync(recursive)` 对已存在目录无操作，`new SqliteGraph` 打开已有 db——语义是「打开」，但方法名 `open` 易与「新建」混淆。实际 SqliteGraph 会复用已有表（CREATE IF NOT EXISTS），OK。
- ⚠️ **`delete` 无确认/无保护**：`rmSync(recursive, force)` 直接删整个 session 目录，误删风险高（虽已限制在 baseDir 内）。
- ⚠️ **`listSessions` 不区分文件名前缀**：只检查 `analysis.db` 存在，若目录名是 `default`、`.config` 等也会被列为 session。
- ⚠️ **`SessionInfo.exists` 只查 dbPath**：dir 存在但 db 不存在时 exists=false，但 `open` 会 mkdir+建 db——`info` 与 `open` 的 exists 语义不对称。
- ✅ 极简，职责单一（定位 + 生命周期）。

### 跨文件观察
- 被 `AgentRuntime`、`cli.ts`（多处）构造。
- 安全风险相比旧版本（路径穿越 × 误删组合）已基本消除；剩余风险为 `openReadOnly` 死方法可能误导调用方以为得到只读视图。

---

## 跨文件小结（本册）

1. **⚠️ `run` 默认无界循环**：`maxSteps = undefined`（session-loop.ts:80），仅靠自然完成（openIntents===0）或外部 directive stop / metacog stop。这是设计意图，但缺少兜底——若 planner 持续产新 intent 或 evaluator 持续失败导致 candidate 堆积，循环可能长跑。建议至少为 unbounded 模式提供停滞监控/告警。
2. **⚠️ token 仍为粗估**：`runOneExplorer` 的 inputTokens/outputTokens 都改用 `estimateContextTokens`（275–276 行），不再是硬编码 0；但仍非真实 token（worker 层不回传 usage），quota/计费/审计不可完全信赖。需在 worker 层回传真实 usage 才能根治。
3. **✅ 路径穿越已防护**：`session-manager.sessionDir` 双层防护（safeSessionName 折叠 `..` + relative 包含性检查），相比旧版裸 join 是实质安全改进。
4. **🚨 GlobalSupervisor.globalMaxConcurrent 死字段**：承诺的全局并发配额未实现，且 config 层仍解析该字段造成配置到运行时断链。
5. **✅ evaluator 失败处理已修正**：catch 不再 reject，candidate 保留待重试，避免污染 dead-end。
6. **死代码**：`maybeRunPlanner` 的 inCooldown 分支（session-loop.ts:178，永不可达）、`openReadOnly`（session-manager.ts:66，无调用方）、`globalMaxConcurrent`（supervisor.ts:41，不读）。
7. **重复 sweepExpiredLeases**：tick→stepLocked→dispatchExplorers 三处 sweep，幂等但冗余（轻微性能）。
8. 本册是审计第二核心（仅次于协议层）。chain 机制删除后复杂度显著降低，主循环流程清晰；建议优先修 §1（无界循环的兜底）与 §4（globalMaxConcurrent 断链）。
