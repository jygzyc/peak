# 03 · 协议层（`src/agent/`）

> 审计范围：11 个文件——`types.ts`、`contracts.ts`、`parse-envelope.ts`、`permissions.ts`、`main-agent.ts`、`decision-applier.ts`、`subagent-runner.ts`、`context-builder.ts`、`graph-view.ts`、`context-ledger.ts`、`fact-tiering.ts`。
> 本层是整个 agent 的「骨架」：定义数据模型、输出契约、权限模型、prompt 组装与统一执行引擎。不含调度循环（见 [04-session.md](./04-session.md)）。

---

## 3.1 `types.ts`（424 行）— 核心数据模型

### 用途
decx-agent 的 **领域中立数据模型**。graph-first：facts / intents / hints / directives / links / events / subagent runs / workers / workflow limits。文件头注释（1–12 行）明确：「roles 是纯字符串，源码除 builtin 默认值外不硬编码 role 名」。

### 关键导出（按语义分组）
- **ID 类型**：`ProjectId` / `FactId` / `IntentId` / `HintId` / `LinkId` / `DirectiveId` / `RunId` / `RoleId`（均为 `string` 别名）
- **枚举/字面量**：`ProjectStatus`、`FactStatus`（candidate/accepted/rejected/blocked）、`IntentStatus`（open/claimed/chained/done/failed）、`HintKind`（direction/warning/stop-explorer）、`RunStatus`、`DirectiveKind`、`Permission`（8 种）、`OutputContract`（6 种）、`GraphView`（4 种）、`WorkerKind`（agent/api/mock）、`ToolKind`
- **实体**：`Project`、`Fact`、`Intent`（含 `ChainState`/`lease`）、`Hint`、`Link`、`GraphEvent`、`Directive`、`SubagentRun`/`SubagentRunInput`
- **配置**：`WorkerConfig`、`RuntimeSpec`、`PromptSpec`、`ContextSpec`、`SubagentProfile`、`BuiltinProfiles`、`TaskConfig`、`ControlConfig`、`WorkflowConfig`
- **运行时**：`Verdict`、`Progress`、`ChainRequest`/`SubIntentSpec`
- **常量**：`BUILTIN_ROLES`、`DEFAULT_LIMITS`、`DEFAULT_METACOG_TRIGGERS`、`BUILTIN_PERMISSIONS`

### 审计要点
- ⚠️ **`WorkerKind = "agent" | "api" | "mock"`**：`AGENTS.md` 明确「The legacy `api` `WorkerKind` is gone; the `api` worker name still resolves to `model`」，但此处类型仍保留 `"api"`。文档与类型不一致（实际 worker 层用 `kind: "command"|"model"`，见 [05-worker-core.md](./05-worker-core.md)）。
- ⚠️ **`DEFAULT_LIMITS.maxSteps = 1000`** vs `SessionLoop.run` 默认 `maxSteps=100`（见 [04-session.md](./04-session.md)）——两套默认值，`run` 不读 `DEFAULT_LIMITS`。
- ⚠️ **`DEFAULT_METACOG_TRIGGERS.everySeconds = 60`** vs `defaultConfig()` 中 `everySeconds = 30`（见 [09-config.md](./09-config.md)）——又一处不一致。
- ⚠️ **`FactStatus` 用 `"candidate"` 而 `Progress.candidateFacts` 也是 candidate**，但 `MainAgent`/explorer 输出经 evaluator 后才进 accepted；`SubagentRun` 注释（192–199 行）说 explorer/evaluator/metacog 都是 run，但 `BUILTIN_PERMISSIONS` 中 explorer 只能 `write_candidate_fact`，evaluator 才能 `resolve_fact`——权限模型清晰。
- ⚠️ **`WorkerConfig.apiKey` 与 `apiKeyEnv` 并存**（248–249 行）：明文 apiKey 进配置文件是安全风险（应只允许 env）；`provider-presets.ts` 与 `task-config.ts` 如何处理见 [09-config.md](./09-config.md)。
- ⚠️ **`Intent.killedBy`** 含 `"lease-expired"`，但 `fact-tiering`/`context-builder` 渲染 intents 时不区分 killed 来源。
- ✅ `BUILTIN_PERMISSIONS` 注释（412–415 行）明确「自定义 profile 自声明」，单一真相源。
- ✅ `RoleId` 为自由 string + `BUILTIN_ROLES` 常量，符合「role 不硬编码」承诺。

### 跨文件观察
- 本文件是所有其它模块的类型根；任何字段重命名都会级联。`SubagentProfile` 是配置系统的核心形状，`task-config.ts`/`profile-loader.ts` 都围绕它展开。

---

## 3.2 `parse-envelope.ts`（161 行）— Worker 输出解析

### 用途
从 worker（LLM agent）的自由文本输出中**抽取 JSON envelope** `{ kind: string, data: unknown }` 并提供类型化访问器。被 `contracts.ts`、`subagent-runner.ts` 共享。

### 关键导出
- `StageError`（class，带 `stage` 字段）
- `WorkerEnvelope`（interface）
- `parseEnvelope(text, stage)`：主解析入口
- `expectKind(envelope, expected, stage)`：校验 kind 并返回 data
- 类型访问器：`asArray` / `asString` / `asOptionalString` / `asNumber`

### 解析策略（`extractBestJson`）
1. 先匹配 ```` ```json {...} ``` ```` 围栏块
2. 否则从最后一行往上扫，每行找 `{`，调用 `findJsonFromLine` 尝试闭合到 `}`，`JSON.parse` 验证
3. `validateJsonEnvelope` 校验结果含 `kind`(string) + `data`(defined)

### 审计要点
- ⚠️ **JSON 抽取是贪心启发式**：`findJsonFromLine` 取「第一个 `{` 到最后一个 `}`」，若 LLM 输出多个 JSON 块或 prose 含大括号，可能抽错。无 sandbox 隔离。
- ⚠️ **`extractBestJson` 围栏正则** `/```(?:json)?\s*(\{[\s\S]*?\})\s*```/` 用非贪婪 `\}`，多对象 JSON 会被截断到第一个 `}`。
- ⚠️ **`asNumber` 的 fallback** 允许 `confidence` 缺失时默认 0.7（见 `validateCandidateFact`），静默补默认值可能掩盖 LLM 漏字段。
- ✅ 错误统一 `StageError`，带 stage 上下文，便于定位是哪个 role 的输出炸了。
- ✅ 解析与契约校验分离，职责清晰。

### 跨文件观察
- 是 `contracts.ts` 全部 validator 的基础；解析稳健性直接决定整个 agent 是否能吃 LLM 的脏输出。

---

## 3.3 `contracts.ts`（149 行）— 输出契约校验

### 用途
为 6 种 `OutputContract` 各提供一个 validator，把 `WorkerEnvelope` 转成类型化 payload，shape 不符则抛 `StageError`。

### 关键导出
- 类型：`MainDecision`/`MainDecisionIntent`/`MainDecisionFail`、`CandidateFact`
- validator：`validateMainDecision`、`validateCandidateFact`、`validateVerdict`、`validateHints`、`validateStop`、`validateChain`
- `CONTRACTS`：`Record<OutputContract, (envelope, stage) => unknown>` 注册表

### 审计要点
- 🚨 **`validateMainDecision` 强制 `consumeHintIds: []`**（第 65 行）：planner 输出的 consumeHintIds 被**直接丢弃**，永远返回空数组。实际 hint 消费由 `MainAgent` 在 `main-agent.ts:78` 用 `input.hints.map(h => h.id)` 全量覆盖（见 §3.5）——**planner 无法选择性消费 hint，所有传入 hint 一律标 consumed**。这是 planner 自主性的重大缺口。
- ⚠️ **`validateMainDecision` 的 `parentFactIds` 从 `raw.from` 取**（第 50 行）：字段名不一致（输入 `from`，输出 `parentFactIds`），属隐式映射，文档/Prompt 需对齐。
- ⚠️ **`CONTRACTS.hints` 固定 `creator: "system"`**（第 145 行）：metacog 产出 hint 的 creator 被硬写成 `"system"`，丢失「哪个 metacog run 产出」的溯源。实际 `subagent-runner.ts:194` 调用时传 `profileId` 作 creator，但 `CONTRACTS` 注册表项绕过了那个路径。
- ⚠️ **`validateChain.waitMode` 默认 `"all"`**（第 135 行）：`data.waitMode === "any"` 才 any，其余（含拼写错误）一律 all，静默吞错。
- ⚠️ **`validateVerdict.requiredConditions` 过滤空串**（第 100 行）但 `decision` 字段大小写敏感强校验，LLM 输出 `"Accept"` 会抛错——对 LLM 输出严苛。
- ✅ 集中校验，stage 实现与 decision-applier 共享，无重复。

### 跨文件观察
- `CONTRACTS` 注册表存在但 `subagent-runner.ts` 的 `validateOutput` **没有用 `CONTRACTS`**，而是自己 `switch(envelope.kind)` 直接调各 validator——`CONTRACTS` 注册表实际仅被 `index.ts` 导出，**运行时无消费方**，是死代码（仅 `CONTRACTS.main_decision` 等被 re-export）。

---

## 3.4 `permissions.ts`（53 行）— 权限检查

### 用途
`PermissionChecker` 封装一个 `SubagentProfile.permissions`，decision-applier 在每次 graph 副作用前 `require(perm)`。

### 关键导出
- `PermissionChecker`（class）：`has` / `require` / `requireAny` / `role`
- `PermissionDeniedError`（class）

### 审计要点
- ✅ 实现极简、纯内存 Set，无副作用。
- ⚠️ **`requireAny` 空数组直接 return**（第 33 行）：`requireAny()` 无参调用静默通过，调用方可能误以为做了检查。
- ⚠️ **`requireAny` 报错只提 `permissions[0]`**（第 35 行）：丢失其它被检权限信息。
- ⚠️ **`permissions ?? []`**（第 19 行）：profile 未声明 permissions 时不报错而是空集，所有 `require` 都会抛——这是 fail-closed，OK，但调用方未必意识到。

### 跨文件观察
- 是 `decision-applier` 的守门人；与 `BUILTIN_PERMISSIONS` 配合定义了 role 能力边界。

---

## 3.5 `main-agent.ts`（83 行）— Planner 包装

### 用途
session-local **planner 包装**。委托 `runSubagent` 做 prompt 组装/worker 执行/校验，返回 `MainDecision + PermissionChecker` 给 SessionLoop 喂给 DecisionApplier。文件头（7–11 行）强调 planner 无 phase，始终收同样 prompt 形状。

### 关键导出
- `MainAgent`（class）、`MainAgentContext`、`MainAgentRunInput`、`MainAgentResult`

### 审计要点
- 🚨 **自动全量消费 hints**（第 77–79 行）：`if (input.hints?.length) output.decision.consumeHintIds = input.hints.map(h => h.id)`——**无论 planner 输出什么**，传入的 hints 全部标 consumed。叠加 `contracts.ts` 丢弃 planner 自身 consumeHintIds（§3.3），结果：planner 对「消费哪些 hint」毫无控制权。若 planner 想忽略某 hint 留待后续，不可能。
- ⚠️ **`mainProfileId` 默认 `"planner"`**（第 49 行），但取自 `config.control?.mainProfile`——若 control 未配，回退到 `"planner"` key，要求 `config.profiles.planner` 必须存在，否则抛 `StageError`。
- ⚠️ **`runSubagent` 调用传 `hints` 与 `recentVerdicts` 两次**：一次给 `plannerExtra(input.hints, input.recentVerdicts)` 拼 prompt，一次作为顶层字段传入（62–64 行）——后者用于 context-builder，前者用于 promptExtra，语义重复但来源一致。
- ✅ 返回 `PermissionChecker` 与决策绑定，调用方必须显式带上权限才能 apply。

### 跨文件观察
- 被 `session-loop.ts` 的 `maybeRunPlanner` 调用（codegraph 确认）。

---

## 3.6 `decision-applier.ts`（88 行）— 决策落地

### 用途
把 `MainDecision` 翻译成 **graph 写操作**，全部包在单个 `graph.transaction` 内，任一权限失败则回滚。**不调 worker**（文件头 8–9 行）。

### 关键导出
- `applyMainDecision(ctx)`：返回 `DecisionApplierResult`（intentsCreated/intentsFailed/hintsConsumed/concluded）
- `ApplyDecisionContext`、`DecisionApplierResult`、`VerdictTrigger`（接口）

### 执行逻辑
1. `createIntents`：`require("create_intent")` → 查 `isDeadEnd` → `addIntent`
2. `failIntents`：`require("fail_intent")` → `failIntent(..., false, "planner")`，catch 吞错（intent 已 concluded）
3. `consumeHintIds`：`decision.consumeHintIds.length > 0 ? ... : (ctx.hintIdsToConsume ?? [])` → `consumeHint`，catch 吞错
4. `concludeRun`：`require("conclude_run")` → `updateProjectStatus("completed")`

### 审计要点
- 🚨 **权限检查在循环内、事务内**（第 43、58 行）：`permissions.require(...)` 在 `graph.transaction(() => { for... })` 内抛 `PermissionDeniedError` 会触发回滚——但若第一个 intent 已 `addIntent` 成功、第二个触发 `require("create_intent")` 失败（理论上同权限不会中途失败，因为 `require` 是幂等 Set 查询）。实际 `require` 对同一权限不会中途变失败，所以「中途权限失败回滚」场景**不可达**，事务的原子性保证主要防御的是 graph 实现自身的异常。
- ⚠️ **`consumeHintIds` 三元回退**（第 66 行）：`decision.consumeHintIds.length > 0 ? decision.consumeHintIds : (ctx.hintIdsToConsume ?? [])`——配合 §3.5 的「MainAgent 全量覆盖 consumeHintIds」，`ctx.hintIdsToConsume` 这个分支**实际不可达**（decision.consumeHintIds 永远非空）。`hintIdsToConsume` 是死参数。
- ⚠️ **`failIntent(..., false, "planner")`** 第二参 `false` 含义不明（看 graph 接口应为 `force?` 或 `by?`），硬编码布尔降低可读性。
- ⚠️ **catch 吞错无日志**（第 63、70 行）：`failIntent`/`consumeHint` 抛错被静默吞，debug 困难。
- ⚠️ **`VerdictTrigger` 接口导出但本文件未用**（第 84–88 行）：预留给 evaluator 路径，当前 dead export。
- ✅ 事务原子性设计正确；dead-end 预查（`isDeadEnd`）避免重复无谓 intent。

### 跨文件观察
- 被 `session-loop.ts:maybeRunPlanner` 调用；与 `MainAgent` 配对（MainAgent 产 decision + permissions，applier 落地）。

---

## 3.7 `subagent-runner.ts`（286 行）— 统一执行引擎

### 用途
**所有 subagent profile 的通用执行引擎**。取代旧的四个硬编码 stage 文件（planner/explorer/evaluator/metacog）。role 无关：组装 prompt（role preamble + 动态 graph context + role-specific extra）→ 调 worker → 解析 envelope → 按 contract 校验。调用方（SessionLoop/MainAgent/MetacogSupervisor）提供 `promptExtra` 并对返回的 discriminated union 模式匹配。

### 关键导出
- `runSubagent(req): Promise<SubagentOutput>`
- `runSubagentWithText(req): Promise<SubagentRunWithTextResult>`（含 rawText/prompt/usedDelta）
- `SubagentRunRequest`、`SubagentOutput`（6 种 kind 的 union）、`SubagentRunWithTextResult`
- promptExtra 构造器：`plannerExtra` / `explorerExtra` / `evaluatorExtra` / `metacogExtra`

### 执行流程（`runSubagentWithText`）
1. 取 project / workerName（`workerNameOverride ?? profile.runtime.workers?.[0] ?? profile.runtime.worker`）
2. `PromptLoader.load(profile.prompt)`，若 `!fromConfig` 抛错
3. 若 `sessionReuse`：用 `contextLedger.computeDelta`，delta 则发 deltaBlock，否则全量 `buildDynamicContext`
4. prompt = `[preamble, contextBlock, promptExtra].filter(Boolean).join("\n\n")`
5. `workerPool.execute({ prompt, config, workerName, projectId, maxOutputTokens, sessionId })`
6. `returncode !== 0` 抛 `StageError`
7. 若 ledger + session：`ledger.sync(...)`
8. `parseEnvelope` → `validateOutput`（按 `CONTRACT_KIND_MAP` 校验 kind 合法性后 switch）

### `CONTRACT_KIND_MAP`（第 163–168 行）
- `main_decision` → `["decisions"]`
- `candidate_fact` → `["fact", "chain"]`
- `verdict` → `["verdict"]`
- `hints` → `["hints", "stop"]`

### 审计要点
- ⚠️ **`sessionId` 透传条件**（第 141–143 行）：`useSession && req.sessionManager ? req.sessionManager.get(projectId, req.profileId)?.sessionId : undefined`——`get` 可能返回 undefined，则 sessionId 为 undefined，worker 层按不复用处理，**静默降级**无日志。
- ⚠️ **`profile.runtime.workers?.[0] ?? profile.runtime.worker`**（第 88 行）：workers 数组只取第一个，无负载均衡/轮询——多 worker 配置形同虚设。
- ⚠️ **`returncode !== 0` 时 `result.stderr ?? "no stderr"`**：worker 失败信息可能为空，debug 困难。`result.text`（LLM 输出）在失败时被丢弃，未纳入错误信息。
- ⚠️ **`validateHints(envelope, stage, profileId)`**（第 194 行）：creator 传 `profileId`，但 `CONTRACTS.hints` 注册表项写死 `"system"`（§3.3）——两条路径 creator 语义不同。
- ⚠️ **ledger.sync 只在 `ledger && useSession` 时调**（第 153 行）：但 `computeDelta` 在首次（无 entry）时返回 `isDelta: false`，runner 走全量 contextBlock，却**仍会 sync**——首次调用就把全量记进 ledger，后续 delta 判断基准正确。逻辑自洽但隐晦。
- ⚠️ **`plannerExtra` 的 hint 文案**（218–221 行）要求 planner「create/fail/ignore」hint，但 §3.5 证明 planner 的选择被无视——**prompt 骗了 LLM**。
- ✅ discriminated union `SubagentOutput` 设计优雅，调用方模式匹配清晰。
- ✅ `runSubagentWithText` 暴露 rawText/prompt，便于 debug 与测试。

### 跨文件观察
- 是连接协议层（contracts/parse-envelope）与 worker 层（workerPool）的唯一桥梁。所有 role 都过这里。

---

## 3.8 `context-builder.ts`（134 行）— 动态上下文组装

### 用途
按 `ContextSpec` + 当前 graph 状态，产出渲染好的 graph-view section。调用方（SubagentRunner）在其前拼接静态 role preamble。

### 关键导出
- `buildDynamicContext(options): string`
- `estimateContextTokens(text): number`（粗估 `length/4`）
- `isContextNearFull(text, threshold=8000): boolean`
- `BuildContextOptions`（interface）

### 逻辑
- `relevanceScope === "chain"` 时：`collectRootFactIds`（从 intent.parentFactIds / candidate.parentIntent / enrichedContext）→ `filterRelevantFacts`（沿 links BFS 2 跳）+ 兜底 recent 5
- 否则全量 accepted
- 委托 `renderGraphView(input, viewOptions)`

### 审计要点
- ⚠️ **`filterRelevantFacts` 的 BFS**（96–108 行）：`for hop in maxHops` 每跳都 `[...relevant]` 作 frontier 遍历**全部 links**，复杂度 O(maxHops × links × frontier)；大 graph 性能差。
- ⚠️ **`filterRelevantFacts` 兜底 recent 5**（113–117 行）：若链上相关 fact 数 < 全量，补最近 5 条；但「最近」按 `allFacts.slice(-5)` 即插入序，非 createdAt。
- ⚠️ **`estimateContextTokens` 的 4 char/token** 是英文 prose 经验值，中文/代码场景偏差大；仅作 metacog rotate 信号，影响有限。
- ⚠️ **`isContextNearFull` 默认 8000** 与模型 context window 无关联，硬编码阈值。
- ✅ chain scope 的 root 收集覆盖了 intent/candidate/enriched 三种来源。

### 跨文件观察
- 被 `subagent-runner` 调用；`renderGraphView` 来自 `graph-view.ts`。

---

## 3.9 `graph-view.ts`（207 行）— Graph 视图渲染

### 用途
按 `GraphView`（full/focused/evidence-only/summary）策略把 graph 子集渲染成 prompt section。`maxFacts` 封顶（裁最旧的），`includeDeadEnds`/`includeProgress` 开关。

### 关键导出
- `renderGraphView(input, options): string`
- `GraphViewInput`、`GraphViewOptions`

### 渲染策略
- **full**：progress（可选）→ accepted（>15 走 tiering，否则 cap maxFacts）→ blocked(10) → rejected(10) → intents(open/claimed/chained) → hints → recentVerdicts
- **focused**：ctx = accepted + enriched（>15 tiering，否则 cap 50）→ rejected dead-ends(10)
- **evidence-only**：仅 `evidence.length>0` 的 accepted（cap 30），含 evidence 缩进
- **summary**：progress 或计数 + recent verdicts(5)

### 审计要点
- ⚠️ **`TIER_THRESHOLD = 15` 硬编码**（第 18 行）：与 `fact-tiering` 的 `warmMaxFacts=20`/`compressThreshold=30` 不在一个语义层，易混。
- ⚠️ **`cap` 裁最旧**（第 56–59 行）：`items.slice(items.length - max)`——依赖 acceptedFacts 已按时间排序，但 `graph.facts(projectId, "accepted")` 是否保证序取决于 Graph 实现（sqlite-graph 按 createdAt，in-memory 按 push 序）。
- ⚠️ **`renderSummary` 的 `_options`** 未用（第 168 行），summary 模式忽略 maxFacts/includeDeadEnds/includeProgress（除 progress 间接用）。
- ⚠️ **focused 模式不渲染 intents/hints/verdicts**：与 full 信息量差异大，profile 选 focused 会丢失大量上下文。
- ✅ 四种视图清晰分层；tiering 集成点合理。

### 跨文件观察
- `tierFacts`/`renderTieredFacts` 来自 `fact-tiering.ts`；被 `context-builder` 调用。

---

## 3.10 `context-ledger.ts`（172 行）— Delta 账本

### 用途
按 `(projectId, profileId)` 记录每个 worker session 已见过的 fact/intent/verdict 集合，下次只发 delta。文件头（7–17 行）宣称「稳态步骤约 90% token 缩减」。

### 关键导出
- `ContextLedger`（class）：`get`/`computeDelta`/`sync`/`reset`/`resetProject`
- `LedgerEntry`、`DeltaResult`

### Delta 逻辑（`computeDelta`）
- 无 entry → `fullResult`（isDelta:false）
- 有 entry → 算 newAccepted/newRejected/newIntents/newVerdicts；若 `deltaItems/totalItems > deltaThreshold(0.3)` → fullResult；若 deltaItems=0 && newVerdicts=0 → 「No changes」；否则拼 deltaBlock

### 审计要点
- ⚠️ **`verdictSig = factId:decision`**（第 170 行）：同一 fact 被 evaluator 多次裁决（accept 后又 reject？理论上不会）会被判为已知；且不含 `reason`，reason 变化不触发 delta。
- ⚠️ **`totalItems` 不含 candidate facts**（第 74 行）：只算 accepted+rejected+intents，candidate 变化不在 delta 基准——但 explorer 关心 candidate？实际 candidate 由 evaluator 消费，explorer 不看，OK。
- ⚠️ **`sync` 用 `progress.stepsExecuted` 作 `lastSyncStep`**（第 136 行），但 `LedgerEntry` 的 `lastSyncStep` 字段**从不被读取**——dead field。
- ⚠️ **内存账本无持久化**：进程重启 ledger 全丢，重启后首次调用必走 fullResult。SqliteGraph 持久化但 ledger 不持久，长任务重启代价高。
- ⚠️ **`resetProject` 用前缀 `${projectId}::`**（第 146 行）：若 projectId 含 `::` 会误删——projectId 是 `newProjectId()` 生成的，需确认不含 `::`。
- ✅ 30% 阈值回退全量，避免 delta 累积膨胀。

### 跨文件观察
- 被 `subagent-runner` 在 `sessionReuse === true` 时使用；与 `WorkerSessionManager` 配合实现 session 复用。

---

## 3.11 `fact-tiering.ts`（122 行）— Fact 分层压缩

### 用途
把 accepted facts 分 hot/warm/cold 三层，按层不同压缩级别渲染。hot（`hotSteps` 内）全描述+evidence；warm（`warmMaxFacts` 内）ID+60 字截断；cold 仅 ID。warm 超 `compressThreshold` 时最旧一批压成「Findings Summary」。

### 关键导出
- `tierFacts(facts, currentStep, options?): TieredFacts`
- `renderTieredFacts(tiered): string`
- `DEFAULT_TIER_OPTIONS`（hotSteps:10, warmMaxFacts:20, compressThreshold:30）
- `TierOptions`、`TieredFacts`

### 审计要点
- 🚨 **`cold` 层永远是空数组**（第 48、74 行）：`tierFacts` 返回 `{ hot, warm: warmResult, cold: [], summary }`——三层模型实际只用 hot/warm，cold 是**预留死代码**。`renderTieredFacts` 也无 cold 渲染分支。
- ⚠️ **`factStep` 回退**（77–80 行）：`step >= 0` 用 `fact.stepDiscovered`，否则 `fallback - offset`（offset = `sorted.length - i`）——插入序逆推，与真实 step 可能偏差大。
- ⚠️ **排序用 `createdAt.localeCompare`**（第 50 行）：依赖 ISOTime 字符串字典序=时间序，要求 createdAt 严格 ISO8601 同格式（含时区）；若 Graph 实现格式不一会乱序。
- ⚠️ **`compressThreshold(30) > warmMaxFacts(20)`**：warm 超 30 才压缩到留 20，即 warm 在 20–30 时不压缩——阈值关系隐晦。
- ✅ 压缩块「Findings summary (N earlier facts): ...」信息密度高。
- ✅ `factSummary` 含 evidence 计数，压缩不丢元数据。

### 跨文件观察
- 被 `graph-view.ts` 的 `renderFull`/`renderFocused` 在 facts > TIER_THRESHOLD(15) 时调用。

---

## 跨文件小结（本册）

1. **🚨 Hint 消费链路断裂**：`contracts.validateMainDecision` 丢弃 planner 的 consumeHintIds（返回空数组）→ `MainAgent` 全量覆盖 → `decision-applier` 的 `hintIdsToConsume` 回退分支不可达。**planner 对 hint 消费零控制权**，且 prompt 还告诉 planner 可以 ignore hint（欺骗）。这是协议层最严重的语义 bug。
2. **🚨 三套默认值常量**：`DEFAULT_LIMITS`（maxSteps 1000）+ `DEFAULT_METACOG_TRIGGERS`（everySeconds 60）+ `defaultConfig()`（everySeconds 30, SessionLoop maxSteps 100）——数值打架，见 04/09 册。
3. **🪦 死代码清单**：`tierFacts.cold`、`LedgerEntry.lastSyncStep`、`VerdictTrigger` 导出、`CONTRACTS` 注册表运行时无消费、`WorkerKind="api"`。
4. **prompt ↔ 协议失信**：多处 promptExtra 文案承诺 LLM 的能力（如 planner ignore hint、verdict 大小写）被协议层静默吞或严苛校验。
5. **性能隐患**：`filterRelevantFacts` 的 O(hops×links×frontier)；ledger 无持久化。
6. 本册是审计核心，建议优先修 §1（hint 链路）与 §2（默认值统一）。
