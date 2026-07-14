# 05 · Worker 核心抽象（`src/worker/` 根）

> 审计范围：8 个根文件——`worker-runtime.ts`、`base.ts`、`registry.ts`、`agent-driver.ts`、`api-driver.ts`、`agent-driver-pool.ts`、`mock-worker.ts`、`session-manager.ts`。
> 本层定义 worker 执行抽象（`WorkerPool`）与具体 driver 注册表，是协议层调用 worker 的统一入口。`backends/`（子进程适配）与 `providers/`（模型 API）见后续册。
> 本次重审重点：**sessionId 已端到端打通**（pool → driver → backend），`conclude` 标志也在 conclude-fallback 路径中实际传递。两套同名 `WorkerRequest`/`WorkerResult` 类型依然并存，但**两者现在都携带 `sessionId`**。

---

## 5.1 `worker-runtime.ts`（69 行）— WorkerPool 抽象

### 用途
**Stage 与具体 worker 实现之间的抽象层**。Stage 不直接调子进程，只调 `WorkerPool.execute()`。这层间接使 Stage 成为 `(input, graph, workerPool)` 的纯函数，是 MockWorker 测试可行的前提（文件头 1–11 行）。

### 关键导出
- `WorkerRequest`（interface）：`prompt`/`config`/`workerName?`/`role?`/`projectId?`/`expectedPayload?`/`cwd?`/`maxOutputTokens?`/`sessionId?`/`conclude?`
- `WorkerResult`（interface）：`workerId`/`text`/`returncode`/`stderr?`/`sessionId?`/`timedOut?`
- `WorkerPool`（interface）：`execute`/`pickWorker`/`runningCount`
- `NullWorkerPool`（class）：永远失败的占位实现

### 新增/变更
- `WorkerRequest` 新增 `sessionId?: string`（26 行）与 `conclude?: boolean`（27–28 行，注释标注 "Marks this invocation as a conclude-phase call (force-summarize, no further work)"）。
- `WorkerResult` 新增 `sessionId?: string`（36 行）——使 pool 层能把 backend 提取的 sessionId 回传给调用方。

### 审计要点
- 🚨 **两套 `WorkerRequest`/`WorkerResult` 同名不同形依然存在**（见 §5.2）：本文件 `WorkerRequest` 含 `prompt/config/role/sessionId/conclude`，`base.ts` 含 `worker/role/sessionDir/sessionId/conclude`。**差异收敛但仍不同形**——值得注意的进展是：两者现在都携带 `sessionId` 与 `conclude`，session 复用链路在两个类型里都已建模。`agent-driver-pool.ts` 仍被迫手工字段映射（§5.5）。
- ⚠️ **`WorkerRequest.expectedPayload` 字段无任何调用点**——dead 字段（历史遗留，未随 sessionId 一并清理）。
- ⚠️ **`WorkerResult.timedOut?`** 字段：`backends/subprocess.ts` 的 invoke 在 close handler 会写 `timedOut: timedOut || undefined`（非超时为 undefined），但经 `AgentDriver`→`agent-driver-pool` 归一化时**未透传 timedOut**（pool 只取 stdout/returncode/stderr/sessionId），故 pool 层此字段仍是 dead。仅 subprocess backend 内部有效。
- ⚠️ **`pickWorker` 在 `WorkerPool` 接口声明，但无任何调用方**——接口方法死声明。`AgentDriverPool`/`MockWorker` 都实现了它，但 SessionLoop 直接用 `profile.runtime.workers?.[0]` 选 worker，不调 pool。
- ⚠️ **`NullWorkerPool` 仅被 `index.ts` re-export**，无实际消费——预留死代码。
- ✅ 抽象边界清晰，注释点明「为什么需要这层」。
- ✅ sessionId/conclude 入栈到顶层请求类型，符合「端到端打通」的设计目标。

### 跨文件观察
- 是协议层（`subagent-runner`）调用 worker 的唯一入口；`agent-driver-pool` 与 `mock-worker` 是两个实现。`base.ts` 的类型仅用于 driver 内部，与本文件类型并行存在是历史遗留，但 sessionId 字段已在两边对齐。

---

## 5.2 `base.ts`（35 行）— Driver 内部类型

### 用途
**底层 driver 注册表契约**，被 `AgentDriver`/`ApiDriver` 使用。注释（1–6 行）明确：agent-facing 的 `WorkerPool` 抽象在 `worker-runtime.ts`，这里是 lower-level。

### 关键导出
- `WorkerRequest`（interface）：`worker`/`role`/`projectId`/`sessionDir`/`prompt`/`intentId?`/`cwd?`/`config?`/`sessionId?`/`conclude?`
- `WorkerResult`（interface）：`worker`/`returncode`/`stdout`/`stderr`（非可选）/`sessionId?`
- `WorkerDriver`（interface）：`name`/`execute(request)`

### 新增/变更
- `WorkerRequest` 新增 `sessionId?: string`（19 行）与 `conclude?: boolean`（20–21 行，注释同 §5.1）。
- `WorkerResult` 新增 `sessionId?: string`（29 行）。

### 审计要点
- 🚨 **与 `worker-runtime.ts` 同名冲突**（见 §5.1）：`registry.ts` `export type { WorkerDriver, WorkerRequest, WorkerResult } from "./base.js"` re-export，但 `index.ts` 也 re-export `worker-runtime.ts` 的同名类型——**公共 API 面有两套同名类型**，消费者 import 时必须看路径才能区分。好消息：两套现在都带 `sessionId`/`conclude`，session 链路在两层都建模完整。
- ⚠️ **`WorkerRequest.role` 字段**：`agent-driver-pool.ts` 调 `executeWorker` 时硬编码 `role: "explorer"`（见 §5.5），丢失真实 role（planner/evaluator/metacog）。注意：本类型与 worker-runtime.ts 都新增了 `role?`，但 pool 仍不透传真实 role。
- ⚠️ **`WorkerRequest.intentId`** 字段 driver 内部不消费（backend 只收 prompt+config+cwd+sessionId+conclude）——dead 字段。
- ⚠️ **`WorkerResult.stderr` 非可选**，但 `AgentDriver.execute` 用 `result.stderr ?? ""`（§5.4）——说明 backend 返回的 stderr 可能 undefined，类型不匹配。
- ✅ 体积小，职责单一。
- ✅ sessionId/conclude 已补全，与 §5.1 字段对齐。

### 跨文件观察
- 被 `registry.ts`/`agent-driver.ts`/`api-driver.ts` 使用；`agent-driver-pool.ts` 不直接用，只通过 `executeWorker` 间接。

---

## 5.3 `registry.ts`（61 行）— Driver 注册表

### 用途
**worker 配置 → driver 实例的分发桥**。从 task config 或 builtin 解析命名 worker，按 `WorkerKind` 调对应 factory，暴露能力元数据给 CLI/status。

### 关键导出
- `executeWorker(request)`：解析 config → 选 factory → `factory.execute`。request 现携带 `sessionId`/`conclude`，透传到 driver。
- `knownWorkers(configured)`：合并 builtin + configured worker 名
- `workerCapabilities()`：返回 `{workers, driverKinds, agentBackends, modelProviders}`
- `WORKERS`：builtin worker 名列表
- re-export `WorkerDriver`/`WorkerRequest`/`WorkerResult`（from base.ts）

### 内部结构
- `DRIVER_FACTORIES: Partial<Record<WorkerKind, DriverFactory>>`：仅 `agent`/`api` 两项
- `BUILTIN_WORKER_CONFIGS`：claude-code/codex/opencode/api 四个

### 审计要点
- ⚠️ **`DRIVER_FACTORIES` 缺 `mock` kind**：`WorkerKind = "agent" | "api" | "mock"`，但 factory 只注册 `agent`/`api`。`MockWorker` 走旁路（直接实现 `WorkerPool`，不经 `executeWorker`）——`mock` kind 若进 config 会走 `unsupported worker kind` 分支。
- ⚠️ **`executeWorker` 返回 `Promise<WorkerResult> | WorkerResult`**（同步或异步混返）：调用方 `agent-driver-pool.ts` 用 `Promise.resolve(executeWorker(...))` 包一层兼容，但 `factory(...).execute(...)` 实际都是 async，混返签名徒增复杂度。
- ⚠️ **`resolveWorkerConfig`**（59–61 行）：`configured ?? BUILTIN_WORKER_CONFIGS[worker]`——优先用调用方传入的 config（即 task.json 的），找不到才回退 builtin。但 `agent-driver-pool.ts` 传入的 `backendConfig` 是手工重组的，已丢失 `apiKey`/`args` 等字段（见 §5.5）。
- ⚠️ **`workerCapabilities` 给 CLI `workers` 命令用**，返回 `driverKinds: Object.keys(DRIVER_FACTORIES)` = `["agent","api"]`，与 AGENTS.md 宣称的 `kind: "command"|"model"` 术语不一致（实际 WorkerKind 仍是 agent/api/mock）。
- ✅ `executeWorker` 用 `{...request, config}` 展开（43 行），sessionId/conclude 自然透传到 driver，无需额外改 registry。
- ✅ `knownWorkers` 用 Set 去重，合并 builtin 与 configured。

### 跨文件观察
- 被 `agent-driver-pool.ts`（executeWorker）与 `cli.ts`（workerCapabilities）调用。是 worker 抽象与具体 driver 的唯一耦合点。session/conclude 透传靠 spread，无需 registry 显式参与。

---

## 5.4 `agent-driver.ts`（55 行）— 命令/agent 后端 driver

### 用途
**命令/agent 后端 driver**。解析配置的 backend，用 prompt 调用，归一化结果到 `WorkerDriver` 契约。不拥有调度或 graph 状态（文件头 1–7 行）。

### 关键导出
- `AgentDriver`（class，implements `WorkerDriver`）

### 执行逻辑（`execute`）
1. `resolveBackend()`：`transport==="http"` → 找 `${backend}-http` httpBackend；否则找 `backend ?? name`；再否则 `config.command` → `new ProcessBackend()`；都没则 undefined
2. `backend.invoke({prompt, config, cwd, sessionId, conclude})`（27–33 行）——**现在透传 sessionId 与 conclude**
3. 归一化 `{worker, returncode, stdout: result.text, stderr: result.stderr ?? "", sessionId: result.sessionId}`（35–42 行）——**现在回传 sessionId**

### 新增/变更
- invoke 入参新增 `sessionId: request.sessionId`（31 行）与 `conclude: request.conclude`（32 行）。
- 归一化结果新增 `sessionId: result.sessionId`（40 行）。

### 审计要点
- ⚠️ **`resolveBackend` 的 http 探测**（45–47 行）：`getAgentBackend(\`${backend ?? name}-http\`)`——拼 `-http` 后缀找 http backend，但若 `backend` 已是 `opencode-http` 会拼成 `opencode-http-http`，找不到。命名约定脆弱。
- ⚠️ **`config.command` 回退 `ProcessBackend`**（第 52 行）：`ProcessBackend` 是泛型子进程后端，但 `getAgentBackend` 找不到时才用，且回退后**不校验 command 合法性**，直接 invoke 会在 backend 内报错。
- ⚠️ **`result.stderr ?? ""`**：backend 返回的 `AgentBackend.invoke` 结果 `stderr` 可能 undefined（与 `base.ts` 的 `WorkerResult.stderr` 非可选矛盾），这里兜底空串。
- ⚠️ **无 timeout/重试**：`backend.invoke` 卡死会永久阻塞，依赖 backend 内部超时（见 [06-worker-backends.md](./06-worker-backends.md)）。
- ✅ **sessionId/conclude 双向透传正确**：入参把 request.sessionId/conclude 交给 backend，结果把 backend.sessionId 回传给 pool。是 session 复用链路的关键一环。
- ✅ backend 解析顺序清晰（http → 注册 → process 回退）。

### 跨文件观察
- 被 `registry.ts` 的 `DRIVER_FACTORIES.agent` 构造；`ProcessBackend`/`getAgentBackend` 来自 `backends/registry.ts`。session 链路：pool(request.sessionId) → driver → backend(input.sessionId) → backend(result.sessionId) → driver → pool(result.sessionId)。

---

## 5.5 `agent-driver-pool.ts`（95 行）— 生产 WorkerPool

### 用途
**生产环境 `WorkerPool` 实现**，包装 `AgentDriver`/`AgentBackend`/`ModelProvider` 机制。Stage 调 `WorkerPool.execute()`，本 pool 翻译为 backend 调用。含 worker-pool 语义（pickWorker/runningCount）、异构引擎偏好（轮换已配 worker）、per-project running 跟踪（文件头 1–9 行）。

### 关键导出
- `AgentDriverPool`（class，implements `WorkerPool`）

### 字段
- `runningPerProject: Map<ProjectId, Set<string>>`
- `workerCallCounter: number`（用于生成 `agent-N` worker 名）

### execute 逻辑（19–61 行）
1. 从 `request.config` 手工重组 `backendConfig`（`kind: config.kind==="mock"?"agent":...`）
2. `workerName = request.workerName ?? \`agent-${counter++}\``
3. `markRunning` → `executeWorker({worker, role:"explorer", projectId, sessionDir: cwd??cwd, prompt, config, cwd, sessionId, conclude})` → `unmarkRunning`（40–52 行）——**现在透传 sessionId 与 conclude**
4. 归一化 `{workerId, text: result.stdout, returncode, stderr, sessionId}`（54–60 行）——**现在回传 sessionId**

### 新增/变更
- 传给 executeWorker 的 request 新增 `sessionId: request.sessionId`（48 行）与 `conclude: request.conclude`（49 行）。
- 归一化结果新增 `sessionId: result.sessionId`（59 行）。

### 审计要点
- 🚨 **`role: "explorer"` 硬编码**（第 42 行）：所有调用（planner/explorer/evaluator/metacog）都标 `role:"explorer"`，**丢失真实 role 上下文**，影响 backend 的审计/计费/role-aware 行为（若 backend 按 role 分流）。`request` 已带 `role?`（§5.1），但 pool 未透传，是源头缺失。
- 🚨 **`backendConfig` 手工重组丢失字段**（21–36 行）：只挑 `backend/transport/command/args/model/baseUrl/apiKeyEnv/password/provider/maxTokens/temperature/timeoutMs`——**丢失 `apiKey`**（types.ts WorkerConfig 的明文 apiKey 字段）。若 task.json 用 `apiKey` 而非 `apiKeyEnv`，driver 拿不到密钥。
- ⚠️ **`maxTokens: request.maxOutputTokens ?? config.maxTokens`**：profile 的 `maxOutputTokens` 覆盖 config，合理；但重组的 `backendConfig` 覆盖了原 config 的 maxTokens，后续 `ApiDriver` 用 `this.config.maxTokens`——实际拿到的是重组值，链路对但隐晦。
- ⚠️ **`kind: config.kind === "mock" ? "agent" : (config.kind as "agent"|"api")`**（第 22 行）：把 `mock` 强转 `agent`，但 registry 无 mock factory，mock kind 进 executeWorker 会报 unsupported——`MockWorker` 走旁路不进这里，此分支**实际不可达**。
- ⚠️ **`workerName = request.workerName ?? \`agent-${counter}\`**`（第 38 行）：若调用方不传 workerName，生成 `agent-0`/`agent-1`...，但 `executeWorker` 内 `resolveWorkerConfig("agent-0", config)` 找不到 builtin `agent-0`，只能靠传入的 config——命名与解析脱节。
- ⚠️ **`pickWorker` 实现存在但无调用方**（见 §5.1）：异构引擎偏好逻辑（63–75 行）是死代码。
- ⚠️ **`Promise.resolve(executeWorker(...))`**（第 40 行）：包 Promise.resolve 是为兼容 `executeWorker` 的同步/异步混返（§5.3），但 `finally` 在 `Promise.resolve(...)` 上而非原始返回——若 executeWorker 同步抛错，finally 不执行，running 标记泄漏。应改为 `await executeWorker(...)` 或 `.then(...).finally(...)`。
- ✅ **sessionId/conclude 透传 + sessionId 回传完整**：是 session 复用链路的顶端入口，与 §5.4 driver 闭环正确。
- ✅ `runningPerProject` 跟踪 + `markRunning`/`unmarkRunning` 对称。

### 跨文件观察
- 是 `subagent-runner` 的默认 workerPool（`AgentRuntime` 不传 workerPool 时 `new AgentDriverPool()`）。`cli.ts --mock` 时换 `MockWorker`。sessionId 从协议层（subagent-runner 的 conclude-fallback）→ pool → driver → backend 全程透传。

---

## 5.6 `mock-worker.ts`（99 行）— 测试用 WorkerPool

### 用途
**仅测试用的 `WorkerPool` 实现**。按正则匹配 prompt 返回预设响应，无匹配则失败。所有 Stage 单测与 e2e pipeline 测试用它（文件头 1–11 行）。**新增**：`registerDefaults()` 为 CLI `--mock` 提供一个自洽的端到端 demo 场景。

### 关键导出
- `MockWorker`（class，implements `WorkerPool`）

### 方法
- `register(pattern, response, returncode=0)`：unshift 进 entries（后注册优先）
- **`registerDefaults()`**：注册一个 canned 场景，驱动 builtin 循环跑通——planner 产一个 intent（首轮）/ concludeRun（二轮），explorer 产 fact，evaluator accept。按 builtin prompt 头匹配（`automated planning module` / `# Explorer Role` / `Evaluator Role`），是 runtime 机制（非业务语义）。
- `reset()`：清 entries + callLog
- `calls()`：返回 callLog
- `execute(request)`：遍历 entries，首个匹配返回；无匹配 returncode=1
- `pickWorker`/`runningCount`/`markRunning`：与 AgentDriverPool 类似

### 审计要点
- ⚠️ **`register` 用 `unshift`**（第 26 行）：后注册的模式优先匹配，便于测试覆盖默认；但无文档说明，易误以为是 push。`registerDefaults` 注册的 planner entry 靠最后 register 赢得匹配优先级（planner 的 full-view prompt 会回显 intent 描述，会被 explorer 正则误匹配，故需 planner 在前）。
- ⚠️ **`callLog` 不限大小**：长测试会内存增长；测试场景 OK。
- ⚠️ **`markRunning` 存在但 `execute` 不调**（对比 AgentDriverPool 在 execute 内 markRunning）：MockWorker 的 `runningPerProject` 永远空，`pickWorker`/`runningCount` 形同虚设——与生产实现行为不一致，测试用 mock 验证并发逻辑会失真。
- ⚠️ **`execute` 未回传 sessionId**：MockWorker 返回 `{workerId:"mock", text, returncode}` / `{...stderr}`，不读 request.sessionId 也不回填 result.sessionId——session 复用路径在 mock 下不可测。测试若需验 sessionId 透传需自行扩展。
- ⚠️ **`response` 可为函数**（`ResponseSpec`）：函数可返回 `string | Promise<string>`，但无 async 错误隔离——函数抛错会冒泡到 `execute` 调用方。
- ✅ **`registerDefaults` 是机制**：与 AGENTS.md「source implements mechanism only」一致——它是 WorkerPool 的一个 ready-made 场景方法，不含业务语义。`cli.ts --mock` 调用它驱动 demo。
- ✅ 极简，测试友好（`register` 链式返回 this）。
- ✅ callLog 暴露，便于断言 prompt 内容。

### 跨文件观察
- 被 `cli.ts --mock`（现调 `new MockWorker().registerDefaults()`）、`AgentRuntime`（options.workerPool）、测试构造。绕过 `registry.ts`/`executeWorker` 直连。

---

## 5.7 `session-manager.ts`（76 行）— Worker 会话复用管理

### 用途
**per-(project, profile) 的可复用 worker 会话跟踪**。`sessionReuse` 开启时，runner 先问此 manager 要现有 session，后端（opencode-http/codex --resume/claude --resume/opencode --session）保留对话上下文，runner 发 delta-only prompt。manager 自身 transport 无关，只映射 key→opaque sessionId（文件头 1–11 行）。

### 关键导出
- `WorkerSessionManager`（class）
- `WorkerSession`（interface：`sessionId`/`createdAt`/`callCount`/`lastUsedAt`）

### 方法
- `key(projectId, profileId)` = `${projectId}::${profileId}`
- `get`/`acquire(factory)`（不存在则 factory 建，callCount++）/`rotate(factory)`（强制新建覆盖）
- `release`/`releaseProject`（前缀删）/`list`

### 审计要点
- ⚠️ **`acquire` 的 `callCount`/`lastUsedAt` 仅自增/更新，无消费者**：类似 `ContextLedger.lastSyncStep`，这些字段当前只写不读（subagent-runner 只 `get(...)?.sessionId`）——预留统计字段。
- ⚠️ **无 session 过期/淘汰**：长任务里 sessions Map 无限增长，`releaseProject` 仅在显式调用时清。
- ⚠️ **`rotate` 覆盖不释放旧 session**（50–60 行）：直接 set 新 session，旧 sessionId 在 backend 侧仍可能存活（如 opencode-http 的服务端 session），资源泄漏。
- ⚠️ **`releaseProject` 前缀匹配 `${projectId}::`**：与 `ContextLedger.resetProject` 同款，projectId 含 `::` 会误删。
- ✅ **sessionReuse 假设现已与 backend 对齐**：之前「manager 假设复用但 backend 不支持 resume」的矛盾已解决——codex/claude 支持 `--resume`，opencode-cli 支持 `--session`，opencode-http 支持复用现有 sessionId（见 [06-worker-backends.md](./06-worker-backends.md)）。manager 的 acquire 复用路径对所有 builtin backend 成立。
- ✅ key 设计清晰，rotate/release 接口完备。

### 跨文件观察
- 被 `SessionLoop`/`MetacogSupervisor` 各自 `new` 一个实例（独立），传给 `subagent-runner`。与 `ContextLedger` 配合：ledger 管「已见内容」，sessionManager 管「会话句柄」。sessionId 从这里流出 → subagent-runner → pool.request.sessionId → driver → backend。

---

## 跨文件小结（本册）

1. **🚨 两套同名 `WorkerRequest`/`WorkerResult` 类型并存**（`worker-runtime.ts` vs `base.ts`），字段仍不同形，`agent-driver-pool` 被迫手工映射，公共 API 面有两套同名类型。**进展**：两套现在都携带 `sessionId?` 与 `conclude?`，session 复用链路在两个类型里都建模完整。仍建议统一或重命名（如 `PoolRequest` vs `DriverRequest`）。
2. **✅ sessionId 端到端打通**：pool（`request.sessionId`）→ driver（透传到 `backend.invoke({sessionId})`）→ backend（codex/claude `--resume`、opencode-cli `--session`、opencode-http 复用 sessionId）→ 结果回传（`result.sessionId` → driver → pool）。session 复用管道从「断的脚手架」变为可用。
3. **✅ conclude 标志端到端透传**：pool/driver/base/runtime 四层 request 类型都新增 `conclude?`，driver 透传到 `backend.invoke({conclude})`。配合 [06](./06-worker-backends.md) 的 `BuildArgvOptions.conclude`，conclude-fallback 路径（runSubagentWithText）已激活，不再是死协议。
4. **🚨 `AgentDriverPool` 丢失 `apiKey` + 硬编码 `role:"explorer"`**：重组 backendConfig 漏字段（apiKey 丢失）+ role 上下文丢失（request 已带 role? 但 pool 不透传）。
5. **🪦 仍存的死代码**：`expectedPayload`、pool 层的 `timedOut`（subprocess 内部有效但被 pool 归一化丢弃）、`pickWorker`（无调用）、`NullWorkerPool`（仅 re-export）、`DRIVER_FACTORIES` 缺 mock、`MockWorker.markRunning` 不被 execute 调、`MockWorker.execute` 不透传 sessionId。
6. **⚠️ WorkerKind 术语不一致**：代码 `agent/api/mock`，AGENTS.md 称 `command/model`，`workerCapabilities` 输出 `agent/api`——三处口径不一。
7. **⚠️ `executeWorker` 同步/异步混返** + `Promise.resolve(...)` 包裹方式让同步抛错绕过 finally，running 标记可能泄漏。
8. 本册是 worker 抽象层，审计重点在「抽象边界是否干净」——最脏的仍是两套同名类型与字段重组丢失；但 session 复用与 conclude 透传两块**已从「预留」转为「可用」**，是本轮最大改善。
