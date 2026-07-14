# 08 · 存储层（`src/graph/`）

> 审计范围：5 个文件——`graph.ts`（接口 + 工具函数，148 行）、`in-memory-graph.ts`（内存实现，679 行）、`sqlite-graph.ts`（SQLite 实现，807 行）、`federated-graph.ts`（跨会话只读检索，144 行）、`federation-bus.ts`（跨会话 insight 总线，80 行）。
> 本层定义全部状态操作契约与持久化。SessionLoop/stages 依赖 `Graph` 接口而非具体实现。

---

## 8.1 `graph.ts`（148 行）— Graph 接口 + 工具

### 用途
**所有存储后端共享的 Graph 接口**。定义 projects/facts/intents/hints/directives/links/events/leases/progress 的状态协议。SessionLoop 与 stages 依赖此接口，不依赖具体 in-memory/sqlite 实现（文件头 1–7 行）。

### 关键导出
- **Input 类型**：`HintInput`/`ProjectInput`/`FactInput`/`IntentInput`/`LinkInput`（38–78 行）
- **`Graph` 接口**（80–127 行）：覆盖 project/fact/intent/hint/directive/link/subagentRun/event/progress/transaction 十组能力：
  - project：`createProject`/`getProject`/`listProjects`/`updateProjectStatus`/`touchProject`
  - fact：`addFact`/`getFact`/`facts`/`pendingCandidates`/`resolveFact`
  - intent：`addIntent`/`getIntent`/`intents`/`claimIntent`/`releaseIntent`/`concludeIntent`/`failIntent`/`isDeadEnd`/`sweepExpiredLeases`
  - hint：`addHint`/`unconsumedHints`/`consumeHint`
  - directive：`addDirective`/`unconsumedDirectives`/`consumeDirective`
  - link：`addLink`/`links`
  - subagentRun：`createSubagentRun`/`updateSubagentRun`/`getSubagentRun`/`subagentRuns`
  - event：`logEvent`/`events`
  - `progress`/`transaction<T>`
  - **不再包含** `chainIntent`/`resumeChainedIntent`（已删除）。
- **工具函数**：`routeHash(description)`（djb2 哈希，`rh_` 前缀，129–136 行）、`now()`（ISO，138–140 行）、`newProjectId()`（`proj_` + 8 hex，142–144 行）、`newRunId()`（`run_` + 时间 + 随机，146–148 行）

### updateSubagentRun 的 Pick 类型（115–117 行）
`patch: Partial<Pick<SubagentRun, "status" | "outputSummary" | "errorMessage" | "factId" | "startedAt" | "finishedAt" | "usedDelta" | "usedConclude" | "inputTokens" | "outputTokens">>`——其中 **`usedConclude` 是新增字段**，允许调用方标记某次 subagent run 是否使用了 conclude 工具。

### routeHash 实现（129–136 行）
`normalized = description.toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,120)` → djb2 → `rh_${(h>>>0).toString(16)}`

### 审计要点
- ⚠️ **`Graph` 接口无 `close()`**：`SqliteGraph` 有 `close()`，但接口未声明——`AgentRuntime.close()` 不得不鸭子类型探测（见 [02-app.md](./02-app.md) §1）。应在接口加 `close?(): void`。
- ⚠️ **`getProject(idOrSession: string)`**：参数名 `idOrSession`，既接 projectId 也接 session 名——歧义 API，调用方需知道行为。SqliteGraph/InMemoryGraph 都是 `WHERE id=? OR session=?`。
- ⚠️ **`failIntent` 的 `recordDeadEnd?: boolean` + `killedBy?`**：默认 `recordDeadEnd=true`，调用方（decision-applier/session-loop）多处传 `false`（只记状态不记 dead-end），语义易混。
- ⚠️ **`routeHash` 的 djb2**：32 位哈希，碰撞概率存在；`slice(0,120)` 限长降低碰撞但未消除。dead-end 匹配碰撞会误判「是 dead-end」导致 intent 被跳过。
- ⚠️ **`newProjectId` 用 `Math.random`**：非加密随机，8 hex = 32 位，碰撞概率 ~1/4G；session 内 project 数少，OK，但并发多 session 理论可撞。
- ⚠️ **`newRunId` 含 `Date.now().toString(36)`**：同毫秒并发 + 4 hex 随机，碰撞概率低但存在。
- ✅ 接口集中、命名一致（`addX`/`getX`/`updateX`/`consumeX`）。
- ✅ Input 类型与实体类型分离，输入面清晰。
- ✅ chain 相关方法（`chainIntent`/`resumeChainedIntent`）已从接口彻底移除，`ChainRequest` 不再导入。

### 跨文件观察
- 被 in-memory-graph/sqlite-graph/federated-graph 实现，被几乎所有上层模块消费。是整个系统的状态契约根。

---

## 8.2 `in-memory-graph.ts`（679 行）— 内存实现

### 用途
**内存 Graph 实现**。测试与轻量运行时用。镜像 SQLiteGraph 行为（事务/lease/dead-end/directive/event/progress 计数）足够 loopestration 测试（文件头 1–7 行）。

### 关键导出
- `InMemoryGraph`（class，implements `Graph`）

### 状态结构（`InMemoryState`，50–71 行）
每个实体一个 `Map<ProjectId, Map<Id, Entity>>`，外加 `seqCounters`/`deadEnds`/`stagnationCounters`/`stepCounters`/各实体 `counters`/`snapshots`。

### 事务机制（584–604 行）
`isOuter = !inTx` → 外层 `cloneState()`（structuredClone）作快照 → fn 抛错则还原快照。内层事务不克隆（共用外层快照）。

### updateSubagentRun（504–524 行）
Pick 类型与 graph.ts 一致，含 `usedConclude`（507–509 行）。实现上 `Object.assign(run, patch)` 直接合并，再按 status 推导 `startedAt`/`finishedAt`。

### progress（559–580 行）
返回字段：`totalFacts`/`acceptedFacts`/`candidateFacts`/`rejectedFacts`/`blockedFacts`/`openIntents`/`claimedIntents`/`stepsExecuted`/`lastActivityAt`/`stagnationLevel`。**不再计算 `chainedIntents`**（与 types.ts 的 Progress 接口一致，该字段已删除）。

### 审计要点
- 🚨 **`snapshots: Map<ProjectId, unknown[]>` 字段死代码**（70、92 行）：定义并初始化，但**全文件无任何读取/写入点**——纯死字段，应删。
- ⚠️ **事务用 `structuredClone(this.state)`**（608–610 行）：每次外层事务全量深拷贝整个 state（所有 project 的 facts/intents/...）。大 session 性能灾难（O(总实体数) 每事务）。
- ⚠️ **事务回滚粒度**：内层事务抛错，外层 catch 还原整个快照——内层已做的部分改动全丢，符合事务语义；但内层事务若已 `logEvent`（push 进 events 数组），回滚也丢，OK。
- ⚠️ **`createProject` 幂等**（100–103 行）：`findProject(session)` 命中则返回 existing，不创建——但返回的 project 可能 status 已变，调用方（AgentRuntime.createProject）未必意识到是复用。
- ⚠️ **`addFact` 的 `stepDiscovered`**（185 行）：取 `stepCounters.get(projectId) ?? 0`——首次 addFact 时 stepCounter 还是 0（未 bumpStep），fact.stepDiscovered=0；concludeIntent 才 bumpStep。顺序导致首批 fact 的 stepDiscovered 都是 0。
- ⚠️ **`resolveFact` 的 `demote` 分支**（212–234 行）：`decision==="demote"` 也归入 accepted（`!== "reject" && !== "block"` → accepted），但清零 stagnation——demote 语义「降级但仍 accepted」？与 verdict 的 `demote` 含义需对齐。
- ⚠️ **`failIntent` 的 `wasDone` 判断**（323 行）：`wasDone = status==="done"`，若 done 后再 fail，不 bumpStep/bumpStagnation——但 done→failed 转换本身不记 dead-end？实际 `recordDeadEnd` 默认 true 仍记。
- ⚠️ **`sweepExpiredLeases` 全量扫所有 project 的 intents**（350–364 行）：O(总 intents)，且现在每 step 被调 3 次（tick/stepLocked/dispatchExplorers，见跨文件小结），频繁扫有成本。
- ⚠️ **`progress` 全量算**（559–580 行）：每次调都 `facts()`/`intents()`/`events()` 全量过滤——调用方（metacog/session-loop）频繁调 progress，性能差。
- ✅ 与 SQLiteGraph 行为对齐（事件、计数器、dead-end）。
- ✅ 事务回滚正确。
- ✅ chain 相关方法已删除，`ChainRequest` 不再导入，progress 不再算 chainedIntents。

### 跨文件观察
- 被 `AgentRuntime`（无 baseDir 时 new）、测试构造。`structuredClone` 是 Node 17+ 全局，符合 Node 22.5 要求。

---

## 8.3 `sqlite-graph.ts`（807 行）— SQLite 实现

### 用途
**SQLite 持久化 Graph 实现**。projects/facts/intents/hints/directives/links/events/counters/leases/dead-ends 全持久化，支持 resumable agent run。是 CLI/runtime session 的生产状态存储（文件头 1–7 行）。

### 关键导出
- `SqliteGraph`（class，implements `Graph`）

### Schema（23–171 行）
`PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON`；11 张表：projects/facts/intents/intent_sources/hints/directives/links/subagent_runs/events/dead_ends/meta；3 索引（runs project_status/profile、events project）。

### subagent_runs 表与 used_conclude（122–146 行）
表含 `used_delta INTEGER`（136 行）与 **`used_conclude INTEGER`（137 行，新增列）**。另有 `input_tokens`/`output_tokens` 两列。两索引：`idx_runs_project_status`、`idx_runs_project_profile`。

### migrate（183–194 行）
两条 ALTER TABLE 试错式迁移：
1. `facts ADD COLUMN required_conditions_json`（185 行）
2. `subagent_runs ADD COLUMN used_conclude INTEGER`（190 行，新增）

均靠 `duplicate column name` 异常判断已迁移。无版本号管理。

### intents 表的 chain_json 列（67 行）
⚠️ **`chain_json TEXT` 列仍保留在 schema 中**（为不破坏既有 db 文件），但：
- `intentFromRow`（723–742 行）**不再读取该列**——已删除 `chainJson`/`chain` 解析逻辑。
- `addIntent` 的 INSERT 语句不写该列。
- `chainIntent`/`resumeChainedIntent` 方法已删除。

即 `chain_json` 是**遗留死列**：无人写、无人读，仅为兼容旧库而存在。`ChainRequest` 导入已移除。

### intent_sources 表（80–86 行）
未变。`addIntent`（333–336 行）双写 json 与 sources 表；`intentFromRow`（727 行）优先 sources 表，空才回退 json。

### updateSubagentRun（548–583 行）
动态拼 SET 子句。**新增 `usedConclude` 处理**（566 行）：`patch.usedConclude !== undefined` 时 `sets.push("used_conclude = ?"); params.push(patch.usedConclude ? 1 : 0)`。`usedDelta` 同理（565 行）。`startedAt`/`finishedAt` 用 `COALESCE` 保证只设一次。

### runFromRow（784–807 行）
**新增读取 `used_conclude`**（800 行）：`row.used_conclude !== undefined && row.used_conclude !== null ? Boolean(row.used_conclude) : undefined`。`usedDelta`/`inputTokens`/`outputTokens` 同模式。

### intentFromRow（723–742 行）
映射 intents 表行为 Intent 对象。**不读 `chain_json`**。读取字段：id/projectId/description/creator/parentFactIds（sources 优先）/status/parentIntentId/lease/priority/createdAt/concludedAt/concludedFactId/failureReason/killedBy。

### 事务（641–655 行）
`inTx` 标志防重入；外层 `BEGIN`/`COMMIT`/`ROLLBACK`。

### 审计要点
- 🚨 **`migrate()` 用 ALTER TABLE 试错**（183–194 行）：靠 `duplicate column name` 异常判断已迁移——脆弱：其它错误（如 disk I/O）会被 `if (!/duplicate/i.test) throw` 正确抛出，但迁移逻辑本身无版本号管理，新增列都要加一条 ALTER。`used_conclude` 是最新一条。无 `meta` 版本记录。
- 🚨 **`chain_json` 列遗留**（67 行）：schema 保留但全链路无人读写（intentFromRow 不读、addIntent 不写、chain 方法已删）。建议在后续 schema 清理中移除，或显式标注「deprecated, do not use」。
- ⚠️ **`nextId` 用 `COUNT(*)`**（671–674 行）：`SELECT COUNT(*) FROM table WHERE project_id=?` + 1 作新 id 序号——删除记录后会重用 id，导致 id 冲突（f001 被删后再 addFact 会再生成 f001，但旧 f001 可能仍在 events 引用）。应用 AUTOINCREMENT 或 meta 计数器。
- ⚠️ **`events` 表 AUTOINCREMENT seq 跨 project 共享**（148 行）：`seq INTEGER PRIMARY KEY AUTOINCREMENT`，全局自增——`events(projectId, sinceSeq)` 用 `seq > sinceSeq` 过滤，但 sinceSeq 是 per-project 的最后 seq，跨 project 的 seq 间隙会导致 LIMIT 提前截断或返回其它 project 的 event？实际 `WHERE project_id=? AND seq>?` 已限 project，OK；但 `progress.lastActivityAt` 取 `events ORDER BY seq DESC LIMIT 1` 是 per-project，OK。
- ⚠️ **`addFact` 读 `steps:${projectId}` meta 作 stepDiscovered**（257–258 行）：与 in-memory 一致，首批 fact stepDiscovered=0。
- ⚠️ **`transaction` 防重入但无 SAVEPOINT**（642 行）：`if (inTx) return fn()`——内层事务直接执行不另开 savepoint，内层抛错会 ROLLBACK 整个外层事务（符合语义），但内层无法独立回滚。
- ⚠️ **`facts`/`intents` 等查询 `ORDER BY created_at, id`**：与 in-memory 的插入序基本一致，但 created_at 是 ISO 字符串字典序——若多 fact 同毫秒，靠 id 二级排序（f001<f002），OK。
- ⚠️ **`findProject` 用 `WHERE id=? OR session=?`**（689–692 行）：若传入字符串恰好同时匹配某 project 的 id 和另一 project 的 session，返回顺序未定义（SQLite 取首行）——歧义 API（见 §8.1）。
- ⚠️ **`intent_sources` 表与 `parent_fact_ids_json` 冗余**（80–86、333–336、727 行）：addIntent 同时写 json 和 intent_sources 表；intentFromRow 优先用 sources 表，空才回退 json——双写双读，维护负担。
- ⚠️ **`progress` 多次全表扫**（619–637 行）：facts/all + intents/all 各一次 SELECT status——可合并为 GROUP BY，减少往返。**不再算 chainedIntents**。
- ⚠️ **`sweepExpiredLeases`**（425–434 行）：单次扫 `WHERE status='claimed' AND lease_expires_at < ?`，逐行 UPDATE 回 open + logEvent。每 step 被调 3 次（见跨文件小结）。
- ⚠️ **无连接池/单连接**：`DatabaseSync` 单连接，WAL + busy_timeout 5000ms 应对并发；多 session 各自开 db 文件，OK。
- ⚠️ **`close()` 存在但 Graph 接口未声明**（见 §8.1）。
- ✅ WAL + busy_timeout + foreign_keys 三 PRAGMA 设置正确。
- ✅ 索引覆盖高频查询路径（runs 按 project+status/profile）。
- ✅ prepared statement 复用（run/get/all 包装）。
- ✅ row mapper 完整，JSON 字段解析健壮（`?? "[]"` 兜底）。
- ✅ `used_conclude` 从 schema→migrate→update→runFromRow 全链路贯通。

### 跨文件观察
- 被 `SessionManager.open`（生产）、测试（sqlite.test.ts）构造。是唯一持久化实现，承载所有真实 session 数据。

---

## 8.4 `federated-graph.ts`（144 行）— 跨会话只读检索

### 用途
**跨多 session 的只读联邦查询**。打开各 session 本地 SQLite graph，检索 accepted facts 或 intents，**不合并写状态**。用于跨 session 上下文；所有 mutation 必须经 owning session graph（文件头 1–7 行）。

### 关键导出
- `FederatedGraph`（class）
- `FederatedFact`/`FederatedIntent`/`FederatedEvent`（含 sessionId）、`SearchOptions`

### 方法
- `searchFactsAcrossSessions(sessionIds, opts)`（39–78 行）：逐 session 打开 db，拼 SQL（status/source/minConfidence/LIKE query），LIMIT，关 db
- `searchIntentsAcrossSessions(sessionIds, query?, limit)`（80–113 行）
- `recentEventsAcrossSessions(sessionIds, limit)`（115–139 行）：各 session 取 limit，合并后按 seq 排序再截 limit
- `allSessions()`（141–143 行）

### 审计要点
- 🚨 **`new DatabaseSync(info.dbPath)` 直连 db 文件**（45、85、120 行）：绕过 `SessionManager.openReadOnly`（§4.5），重复了「打开 session db」逻辑。SessionManager 有 `openReadOnly`（死方法），FederatedGraph 不用它——**职责重叠 + 绕过封装**。若 SqliteGraph schema 变更，FederatedGraph 的裸 SQL 可能失效。
- ⚠️ **LIKE `%${query}%` 注入风险低但语义弱**（52 行）：query 含 `%`/`_` 会被当通配符；且无 FTS，纯子串匹配，中文/特殊字符检索效果差。
- ⚠️ **`recentEventsAcrossSessions` 各 session 取 limit 再合并**（122、138 行）：若 3 个 session 各取 100，合并 300 再按 seq 排序截 limit——但 seq 是各 db 内 AUTOINCREMENT（§8.3），**跨 session 的 seq 不可比**（session A 的 seq=500 与 session B 的 seq=500 无时间关系）。按 seq 排序跨 session 无意义，应按 timestamp 排序。
- ⚠️ **每个 session 开/关 db**：无连接复用，频繁检索开销大；finally close 确保释放，OK。
- ⚠️ **`searchIntentsAcrossSessions` 的 `parentFactIds` 从 json 解析**（100 行）：不读 intent_sources 表（与 SqliteGraph.getIntents 不同），若 sources 表与 json 不一致，联邦检索结果与 session 内查询结果不符。
- ⚠️ **无并发**：sessionIds 串行处理，多 session 慢；可用 Promise.all 但 DatabaseSync 是同步 API。
- ✅ 只读承诺清晰（文件头）。
- ✅ FederatedFact/FederatedIntent 带 sessionId 溯源。

### 跨文件观察
- 被 `cli.ts`（`search` 命令）、`index.ts`（re-export）、测试构造。是 CLI 跨 session 搜索的唯一实现。

---

## 8.5 `federation-bus.ts`（80 行）— 跨会话 insight 总线

### 用途
**跨会话 insight 传播总线**。session 内同步走 Graph events（真相源）；本 bus 只做 CROSS-SESSION 传播：某 session 接受高价值 fact / 记 dead-end / 产出值得 surfacing 的 hint 时，发布 `GlobalInsight`（摘要 + 引用，非完整 fact body）。其它 session 只读消费，可转成本地 Hint/Intent，**不得直接写外部 fact 进自己 accepted 集**（文件头 1–13 行）。

### 关键导出
- `FederationBus`（class）
- `GlobalInsight`/`GlobalInsightRef`/`GlobalInsightListener`
- `MAX_GLOBAL_INSIGHTS = 500`（34 行）

### 方法
- `publishInsight(source, summary, confidence)`（45–60 行）：counter++，push + 超 500 截断，emit "insight"
- `subscribeInsights(listener): () => void`（62–65 行）
- `recentInsights(limit=50)`（67–69 行）/`insightsForSession(sessionId, limit=50)`（71–75 行，排除自己 session 来源）/`clear()`（77–79 行）

### 审计要点
- 🚨 **`publishInsight` 无生产调用方**（codegraph 确认：仅 federation-bus.test.ts 与 supervisor.test.ts 调用）——**bus 存在但无人在 session 接受 fact / 记 dead-end 时 publish**。文件头承诺的「accept high-value fact → publish」链路未实现。FederationBus 是预留基础设施。
- ⚠️ **`emitter.setMaxListeners(100)`**（42 行）：硬编码上限，超 100 订阅者告警；多 session 场景可能不够。
- ⚠️ **`insights` 数组 + `MAX_GLOBAL_INSIGHTS=500`**：内存 ring buffer，进程重启全丢；`publishedAt` 是 `Date.now()`（ms 数值，非 ISO）。
- ⚠️ **`insightsForSession` 用 `source.sessionId !== sessionId`**（73 行）：排除自己，但若多 session 同 id（路径转义/默认 session 名冲突）会误排除。
- ⚠️ **无去重**：同一 fact 被多次 publish 会产生多个 insight。
- ⚠️ **`clear()` 无防护**：清空不影响已订阅 listener，但 `recentInsights` 立即空。
- ✅ EventEmitter 标准模式，subscribe 返回 unsubscribe 函数。
- ✅ ring buffer 防内存膨胀。

### 跨文件观察
- 被 `GlobalSupervisor`（默认 `new FederationBus()` 持有，但 supervisor 不 publish）、`index.ts`（re-export）、测试使用。设计完备但未接线。

---

## 跨文件小结（本册）

1. **🚨 FederationBus / FederatedGraph 的跨会话能力「半实现」**：Bus 的 publishInsight 无生产调用方（accept fact 时不 publish）；FederatedGraph 的 `recentEvents` 跨 session 按 seq 排序无意义（各 db seq 独立）。跨会话联邦是「架构已搭、行为未接」。
2. **🪦 死代码 / 遗留**：
   - `InMemoryGraph.snapshots` 字段（定义初始化但全文件无读写）。
   - `SqliteGraph` 的 `chain_json TEXT` 列（schema 保留以兼容旧库，但 `intentFromRow` 不读、`addIntent` 不写、chain 方法已删——纯遗留死列）。
   - `SessionManager.openReadOnly`（被 FederatedGraph 绕过）。
3. **➕ 新增 `usedConclude` 全链路**：graph.ts 接口 Pick 类型 → InMemoryGraph.updateSubagentRun → SqliteGraph（schema `used_conclude` 列 + migrate ALTER + updateSubagentRun SET + runFromRow 读取）贯通。用于标记 subagent run 是否使用了 conclude 工具。
4. **🗑️ chain 机制已彻底移除**：`chainIntent`/`resumeChainedIntent` 从 Graph 接口、InMemoryGraph、SqliteGraph 三处删除；`ChainRequest`/`ChainState` 类型不再导入；`Intent.chain` 字段不存在；`Progress.chainedIntents` 字段从 types.ts 及两个 progress() 实现中删除。唯一残留是 SqliteGraph schema 的 `chain_json` 列（见 §2）。
5. **⚠️ `nextId` 用 COUNT(*) 会重用删除的 id**：删除后 id 冲突，events 引用悬空。
6. **⚠️ `Graph` 接口缺 `close()`**：导致 AgentRuntime 鸭子类型 hack。
7. **⚠️ 性能**：InMemoryGraph 事务全量 structuredClone、progress/events/facts 多次全表扫——长 session 性能衰减。
8. **⚠️ `sweepExpiredLeases` 每 step 调 3 次**：session-loop.ts 在 `tick`（63 行）、`stepLocked`（97 行）、`dispatchExplorers`（213 行）三处各调一次。dispatchExplorers 处有注释说明「expire-before-claim」以释放崩溃 worker 占用的 slot。逻辑正确，但 InMemoryGraph 实现是全量扫所有 project 的 intents，频繁调用有成本。
9. **⚠️ schema 双写**：intent_sources 表与 parent_fact_ids_json 冗余，FederatedGraph 只读 json，与 SqliteGraph.getIntents（优先 sources 表）结果可能不符。
10. 本册是数据完整性根基，建议优先修 §5（id 生成）、§6（close 进接口）、§7（progress 性能）。
