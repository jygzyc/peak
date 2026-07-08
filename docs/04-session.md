# 04 · 会话运行时（`src/session/`）

> 审计范围：5 个文件——`session-loop.ts`（核心调度）、`supervisor.ts`（多会话监督）、`metacog-supervisor.ts`（壁钟 metacog）、`project-lock.ts`（项目级互斥）、`session-manager.ts`（会话存储定位）。
> 本层是 agent 的「心脏」：所有运行时调度、SubagentRun 生命周期、并发控制汇集于此。

---

## 4.1 `session-loop.ts`（483 行）— 单会话主循环

### 用途
**单 session 主循环**。驱动 project step：`directives → planner(MainAgent) → explorers(SubagentRunner) → evaluators(SubagentRunner) → chain resolution → termination`。文件头（1–8 行）明确：调度与 SubagentRun 生命周期在本文件，role-specific prompt 组装委托给 SubagentRunner。

### 关键导出
- `SessionLoop`（class）
- `StepResult`（union：stepped/idle/completed/failed）
- `RunOptions`（maxSteps/idlePollMs/onStep）

### 字段
- `locks: ProjectLockManager`（私有）+ `locks_`（readonly 别名，暴露给 MetacogSupervisor）
- `contextLedger: ContextLedger`、`sessionManager: WorkerSessionManager`、`promptLoader: PromptLoader`
- `stepVerdicts: Map<ProjectId, Array<...>>`（本 step 内 evaluator 裁决，喂下次 planner）
- `lastPlannerStep: Map<ProjectId, number>`（planner 冷却计数）

### 核心方法与流程
- **`step(projectId)`**：`locks.acquire` → `stepLocked`
- **`tick()`**：`sweepExpiredLeases` → `listProjects("active")` → `Promise.allSettled(step)`，异常降级为 `{type:"failed"}`
- **`run(projectId, options)`**：循环 step 直到 completed/failed 或达 maxSteps（**默认 100**）
- **`stepLocked`**：consumeDirectives → 状态检查 → maybeRunPlanner → dispatchExplorers → runEvaluators → resolveChains → checkTermination → 返回 stepped/idle/completed/failed
- **`consumeDirectives`**：按 kind（stop/pause/resume/hint/kill-intent/spawn-intent）执行
- **`maybeRunPlanner`**：判断 needsPlanning（intents 空 / 有 actionable hint / 有 reject/demote verdict）+ plannerCooldownSteps（默认 3）→ 跑 MainAgent + applyMainDecision，catch 吞错记 `planner.error` 事件
- **`dispatchExplorers`**：dead-end 预过滤 → 按 maxConcurrent(默认 3)/refillPerTick(默认 1)/explorer.maxActive 算 slots → `Promise.allSettled(runOneExplorer)`
- **`runOneExplorer`**：createSubagentRun → claimIntent → runSubagentWithText → chain/fact 分支 → addFact+concludeIntent；catch → failIntent+记 event
- **`runEvaluators`**：pendingCandidates → 各自 createSubagentRun → runSubagent → resolveFact + 记 stepVerdicts；catch → reject 兜底
- **`resolveChains`**：chained intents → waitMode all/any 判断 ready → resumeChainedIntent + 重新跑 explorer，enrichedContext 含子 intent 的 accepted facts
- **`checkTermination`**：状态检查 → maxSteps 超限→failed → stopGate（requireNoOpenIntents + minFactConfidence 均值）→completed → maxStagnation →paused

### 审计要点
- 🚨 **`run` 默认 `maxSteps = 100`**（第 75 行），与 `DEFAULT_LIMITS.maxSteps = 1000`（types.ts）严重不一致。`cli.ts` 的 `run` 命令传 `opts.maxSteps ?? config.workflow.limits.maxSteps`，若用户未传 `--max-steps` 且 config 也未设，走 `RunOptions.maxSteps` 默认 100。`checkTermination` 里却用 `limits.maxSteps ?? DEFAULT_LIMITS.maxSteps`(1000) 判超限——**两处 maxSteps 来源不同**：`run` 循环用 100，`checkTermination` 用 1000。实际效果：循环 100 步退出，但 checkTermination 的 maxSteps 分支几乎不可达。
- 🚨 **`runOneExplorer` 的 `outputTokens = 0` 硬编码**（第 265 行）：`SubagentRun.outputTokens` 永远是 0；`inputTokens` 用 `prompt.length/4` 粗估。token 计量全错，影响 quota/计费/审计。`runSubagentWithText` 的 `result` 未携带真实 token 数（worker 层不回传）。
- 🚨 **`resolveChains` 不释放 lease on retry**：`claimIntent` 后若 `runSubagent` 抛错，catch 里 `failIntent`，但若 `output.kind === "chain"` 再次 `chainIntent`，原 lease 未显式释放（依赖 sweepExpiredLeases 兜底）。
- ⚠️ **`maybeRunPlanner` 的 needsPlanning 与 cooldown 逻辑重叠**：第 162 行 `needsPlanning = isEmpty || hasActionableHint || hasRejectOrDemote`；第 173 行 `if (!isEmpty && !hasActionableHint && !hasRejectOrDemote && inCooldown)`——条件 `!isEmpty && !hasActionableHint && !hasRejectOrdemote` 恰好是 `!needsPlanning`，而上面 `if (!needsPlanning)` 已 return。**此 if 永远为 false，是死代码**。
- ⚠️ **`dispatchExplorers` 的 `batch` 被 `explorerProfile.maxActive` 二次裁剪**（224–230 行）：`inFlight = Math.max(activeRuns, claimedCount)`——取两者大值，但 activeRuns（running 的 SubagentRun）与 claimedCount（claimed intents）语义重叠，取 max 可能重复计数。
- ⚠️ **`runEvaluators` 失败兜底 reject**（355–358 行）：evaluator 抛错时直接 `resolveFact(..., {decision:"reject"})`——** evaluator 临时性错误（网络/超时）会被记为 fact rejected**，污染 fact 生命周期（rejected 进 dead-end，影响后续 planner 决策）。应改为保留 candidate 状态或单独的 error 状态。
- ⚠️ **`resolveChains` 的 enrichedContext 只收 accepted 子 fact**（390–392 行）：failed 子 intent 的结论被丢弃，chain 复跑时 explorer 看不到「某子方向已失败」。
- ⚠️ **`stepVerdicts` 只在 planner 跑后清空**（164、174、194 行）：若 planner 不跑（cooldown），stepVerdicts 累积；但 `maybeRunPlanner` 进入即读 `stepVerdicts.get`，跨 step 累积可能导致 planner 看到陈旧 verdicts。实际 `!needsPlanning` 分支也 set 空数组，OK；但 needsPlanning 为 true 且 inCooldown 死代码分支也 set 空——逻辑混乱。
- ⚠️ **`consumeDirectives` 的 stop/pause 在循环中 return**（122、127 行）：处理完一个 stop/pause directive 就 return，后续 directive 被忽略。
- ⚠️ **`checkTermination` 的 stopGate.minFactConfidence**（457–462 行）：用 accepted facts 的**均值** confidence 判断，少数低置信 fact 会被高置信淹没；且 `accepted.length === 0` 时跳过检查（不阻止完成）。
- ⚠️ **`DEFAULT_LEASE_MS = 300_000`（5 分钟）**（第 40 行）硬编码，与 `DEFAULT_LIMITS.workerLeaseMs = 300_000` 一致但重复定义。
- ✅ `tick()` 用 `Promise.allSettled` + 异常降级，单 project 失败不拖垮其它。
- ✅ ProjectLockManager 串行化同 project step，避免 claim/chain/resolve 竞态。
- ✅ dead-end 预过滤（`dispatchExplorers`）避免重复派发已知失败 intent。

### 跨文件观察
- 是整个 agent 的调度中枢；被 `agent-runtime.ts`、`cli.ts`（resume）构造。`MetacogSupervisor` 通过 `locks_` 共享同一 ProjectLockManager，确保 metacog 与主循环不并发改同一 project。
- `DEFAULT_LIMITS` 在本文件多处作 fallback（214、215、447、469），但 `run` 的 maxSteps 不读它——**默认值使用不统一**。

---

## 4.2 `supervisor.ts`（96 行）— 全局多会话监督

### 用途
**进程级多 session 控制器**。文件头（1–17 行）强调：多任务调度**不应**用单一全局 MainAgent，而是 N 个 session-local SessionLoop 各自有 planner/metacog；GlobalSupervisor 只做注册/注销、全局 tick、全局并发配额、FederationBus 持有。不拥有 per-session planning。

### 关键导出
- `GlobalSupervisor`（class）
- `RegisteredSession`、`GlobalTickResult`、`GlobalSupervisorOptions`

### 方法
- `register(id, loop)` / `unregister(id)` / `get(id)` / `listSessions()`
- `tick()`：`Promise.allSettled(sessions.map(({id,loop}) => loop.tick()))`，取每个 loop 的 `stepResults[0]`，降级为 `{type:"idle", reason:"no active projects"}`
- `stepSession(sessionId, projectId)`

### 审计要点
- 🚨 **`globalMaxConcurrent` 是死字段**（第 41、45 行）：构造期读取 `options.globalMaxConcurrent ?? Infinity` 存为 readonly，但 **`tick()` 完全不用它限制并发**——直接 `Promise.allSettled(active.map(...))` 全并发。文件头宣称「Enforce a global worker concurrency quota across all sessions」**未实现**。`config/utils.ts` 的 `safeSessionName` 也不防 `..`。
- ⚠️ **`tick()` 取 `stepResults[0]`**（第 77 行）：每个 session 只报告第一个 project 的 step 结果，多 project session 的其余结果被丢弃，审计/监控不完整。
- ⚠️ **`register` 重复 id 抛错**（49–51 行），但 `unregister` 不校验存在性，`get`/`listSessions` 也不报已注销。
- ⚠️ **`federationBus` 默认 new 但无注册/触发**：构造期 `new FederationBus()`，但本文件不向 bus publish 任何事件；FederationBus 的消费者需自行接线（见 [08-graph.md](./08-graph.md)）。
- ✅ 设计正确：session-local 隔离 + 全局协调分离，避免单点 planner 瓶颈。

### 跨文件观察
- 被 `index.ts` 导出但**当前无内部消费者**（`AgentRuntime` 不用它，`cli.ts` 也不用）——是为「多 session serve 模式」预留，但该模式未实现（见 [01-entry-points.md](./01-entry-points.md) 的 serve 命令缺失）。

---

## 4.3 `metacog-supervisor.ts`（141 行）— 壁钟 metacog 循环

### 用途
**壁钟驱动的 metacognition 循环**，独立于 SessionLoop 的 step 节奏。用 `setInterval` 定期跑 metacog profile，追踪 active SubagentRun，遵守 maxActive 防过spawn。

### 关键导出
- `MetacogSupervisor`（class）
- `DEFAULT_METACOG_INTERVAL_MS = 30_000`（模块常量）

### 字段与方法
- `timer`/`running`/`intervalMs`/`promptLoader`/`contextLedger`/`sessionManager`
- `start()`：置 running，立即 tick 一次，`setInterval(tick, intervalMs)`
- `stop()`：清 timer
- `runOnce()`：手动触发一次（供测试/外部调度）
- `tick()`：`listProjects("active")` → 各自 `runForProject`
- `runForProject`：`locks.acquire` → 算 shouldRun（stagnation/everySteps/idle-and-has-facts）→ maxActive 限流 → createSubagentRun → runSubagent → hints/stop 分支；catch 记 event

### shouldRun 触发条件（第 76–79 行）
```
stagnationLevel >= stagnationTrigger(默认3)
|| (stepsExecuted > 0 && stepsExecuted % everySteps(默认5) === 0)
|| (openIntents===0 && chainedIntents===0 && candidateFacts===0 && acceptedFacts>0)
```

### 审计要点
- ⚠️ **`DEFAULT_METACOG_INTERVAL_MS = 30_000`**（30s）与 `DEFAULT_METACOG_TRIGGERS.everySeconds = 60`（types.ts，60s）、`defaultConfig().metacog.everySeconds = 30`（config）——**三处壁钟默认值**。本文件 `intervalMs = intervalMs ?? (cfg ? cfg*1000 : DEFAULT_METACOG_INTERVAL_MS)`：cfg 来自 `config.workflow.metacog.triggers.everySeconds`，若 config 用 defaultConfig 则 30s，与 DEFAULT 一致；但若 config 未设 metacog 又未传 intervalMs，走 DEFAULT 30s。整体混乱。
- ⚠️ **`start()` 立即 tick 一次**（第 43 行）：构造后第一次 tick 在 step 0，可能 `stepsExecuted===0` 不满足触发，但若 idle 条件满足（无 intents 且有 facts）会跑——新 project 刚 createProject 就可能触发 metacog，浪费 worker。
- ⚠️ **`runForProject` 的 `output.kind` 非 hints/stop 时**（127–132 行）：记 `outputSummary: "unexpected kind: ..."` 但**不更新 project 状态也不加 hint**——metacog 返回 `verdict`/`fact`/`decisions`/`chain` 时静默忽略。
- ⚠️ **`locks` 共享 SessionLoop 的 ProjectLockManager**：metacog 与主循环 step 串行，但 metacog 内 `runSubagent` 是长任务（LLM 调用），会阻塞主循环 step 直到 metacog 跑完——**壁钟循环可能拖慢 step 节奏**。应考虑 metacog 用独立锁或不持锁。
- ⚠️ **`maxActive` 默认 1**（第 87 行）：同一 project 同时只能有 1 个 running metacog run，合理；但跨 project 并发不受限（`Promise.allSettled` 全跑）。
- ⚠️ **无错误重试/退避**：metacog 失败仅记 event，下次 tick 照常触发，可能反复失败。
- ✅ `runOnce` 暴露，便于测试与外部触发。
- ✅ `stop` 幂等（`if (this.timer)`）。

### 跨文件观察
- 被 `AgentRuntime` 构造（当 `useMetacogSupervisor !== false`）并共享 `sessionLoop.locks_`。与 SessionLoop 的 `stepVerdicts` 无共享——metacog 看不到本 step 的 verdicts（只能从 graph 读 history）。

---

## 4.4 `project-lock.ts`（54 行）— 项目级互斥

### 用途
**单 project 串行、跨 project 并行**的互斥锁。Graph 写操作（claim/chain/resolve）假设同 project 无并发修改。

### 关键导出
- `ProjectLockManager`（class）：`acquire<T>(projectId, fn): Promise<T>`、`pendingCount(projectId): number`

### 实现机制
基于 Promise 链：`chains: Map<ProjectId, Promise<unknown>>` 串起同一 project 的 fn；`pending` 计数用于诊断。注释（19–21 行）明确**不支持同异步链重入**。

### 审计要点
- ⚠️ **不支持重入**（注释 19–21 行）：若 fn 内部又 `acquire(同 projectId)`，会死锁（等自己 release）。当前调用方（SessionLoop.step、MetacogSupervisor.runForProject）不会重入，但无防护。
- ⚠️ **`acquire` 的 `previous.then(() => next)`**（第 32 行）：链条存储的是「previous 完成后等 next」；若 fn 抛错，finally 里 release() 解 next，链条继续——错误隔离 OK。但若 fn 永不 resolve（worker 卡死），整个 project 链永久阻塞，无超时。
- ⚠️ **`pending.delete`/`chains.delete` 时机**（40–45 行）：`remaining <= 0` 才删，但 `chains.delete` 在 finally——若多个 acquirer 并发，最后一个才删，中间态 chains 持有已完成的 Promise，内存 OK（GC 友好）。
- ⚠️ **无 projectId 合法性校验**：任意 string 可作 key，与 `session-manager.ts` 的路径转义风险叠加（见 §4.5）。
- ✅ 实现极简，纯 Promise 无 native 锁依赖。
- ✅ `pendingCount` 提供诊断接口。

### 跨文件观察
- 被 SessionLoop（`step`）和 MetacogSupervisor（`runForProject`）共享实例（通过 `locks_`），确保 metacog 与主循环对同 project 互斥。是并发正确性的基石。

---

## 4.5 `session-manager.ts`（64 行）— 会话存储定位

### 用途
session → 文件系统位置的映射。创建/打开 SQLite graph 文件，列出/删除 session。**只做定位与生命周期**，运行时状态仍 per-session。

### 关键导出
- `SessionManager`（class）
- `SessionInfo`（interface）

### 方法
- `sessionDir(id)` / `dbPath(id)`：路径拼接（`baseDir/id/analysis.db`）
- `info(id)`：返回 `{sessionId, dbPath, dir, exists}`（exists 查 db 文件）
- `listSessions()`：扫 baseDir 子目录，过滤含 `analysis.db` 的
- `open(id)`：`mkdirSync(recursive)` + `new SqliteGraph(dbPath)`（读写）
- `openReadOnly(id)`：不 mkdir，db 不存在抛错，`new SqliteGraph`（注释说只读，实际 SqliteGraph 无只读模式）
- `delete(id)`：`rmSync(recursive, force)`

### 审计要点
- 🚨 **路径转义漏洞**（第 25、47–50 行）：`sessionDir = join(baseDir, sessionId)`——若 sessionId 含 `../`，`join` 会规范成 baseDir 之外的路径。`open("../evil")` 会在 baseDir 父目录建 `evil/analysis.db`；`delete("../evil")` 会删 baseDir 父目录下的 evil。叠加 `config/utils.ts` 的 `safeSessionName` 不防 `..`（见 [09-config.md](./09-config.md)），**外部输入（CLI --session、directive）可路径穿越**。
- ⚠️ **`openReadOnly` 名不副实**（53–58 行）：注释与文件头（1–7 行）说「只读」，但实现是 `new SqliteGraph(info.dbPath)`——SqliteGraph 构造不区分读写（见 [08-graph.md](./08-graph.md)），返回的 Graph 可写。且 `openReadOnly` 无调用方（codegraph 确认），是死方法。
- ⚠️ **`open` 覆盖已有 session 无提示**：`mkdirSync(recursive)` 对已存在目录无操作，`new SqliteGraph` 打开已有 db——语义是「打开」，但方法名 `open` 易与「新建」混淆。实际 SqliteGraph 会复用已有表（CREATE IF NOT EXISTS），OK。
- ⚠️ **`delete` 无确认/无保护**：`rmSync(recursive, force)` 直接删整个 session 目录，误删风险高；且若 sessionId 转义到关键路径（见上），可删任意目录。
- ⚠️ **`listSessions` 不区分文件名前缀**：只检查 `analysis.db` 存在，若目录名是 `default`、`.config` 等也会被列为 session。
- ⚠️ **`SessionInfo.exists` 只查 dbPath**：dir 存在但 db 不存在时 exists=false，但 `open` 会 mkdir+建 db——`info` 与 `open` 的 exists 语义不对称。
- ✅ 极简，职责单一（定位 + 生命周期）。

### 跨文件观察
- 被 `AgentRuntime`、`cli.ts`（多处）、`FederatedGraph`（构造时 new 用于 openReadOnly，但 openReadOnly 死方法 → FederatedGraph 实际用 `open`？需核实 [08-graph.md](./08-graph.md)）。
- 路径转义 + delete 的组合是本层最严重安全风险。

---

## 跨文件小结（本册）

1. **🚨 maxSteps 默认值三重不一致**：`run`(100) vs `checkTermination`(DEFAULT_LIMITS 1000) vs `DEFAULT_LIMITS`(1000)——实际循环 100 步退出，checkTermination 的 maxSteps 分支近乎死代码。必须统一。
2. **🚨 token 计量全错**：`runOneExplorer` 的 `outputTokens=0` 硬编码 + `inputTokens=length/4` 粗估 → SubagentRun 的 token 字段不可信，影响 quota/计费。
3. **🚨 路径转义 × 误删**：`session-manager` 的 `join(baseDir, sessionId)` 无 `..` 防护 + `delete` 的 rmSync recursive force，外部输入可路径穿越并删任意目录。
4. **🚨 GlobalSupervisor.globalMaxConcurrent 死字段**：承诺的全局并发配额未实现。
5. **⚠️ evaluator 失败兜底 reject**：临时性错误被记为 fact rejected，污染 dead-end 与 planner 决策。
6. **⚠️ 多处壁钟/触发器默认值打架**：metacog interval 30s/60s/30s 三处。
7. **死代码**：`maybeRunPlanner` 的 inCooldown 分支（不可达）、`openReadOnly`（无调用）、`globalMaxConcurrent`（不读）。
8. 本册是审计第二核心（仅次于协议层），建议优先修 §1/§2/§3。
