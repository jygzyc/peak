# peak/src 代码审计文档

> 本目录是对 `peak/src/` 全部 **54 个 TypeScript 文件**（+ dashboard.html）的**逐文件用途分析与审计报告**，用于代码审计与重构决策。
> 审计方法：每个文件经 `Read` 行号化精读 + `codegraph`（callers/callees/node/query）交叉验证调用关系，**逐文件 读→分析→写文档** 循环执行（非全读完再写）。审计时点：2026-07-09（初版），2026-07-13 增补修订（codex stdin、pack prompt 打包、profile-loader tuning 字段、mock registerDefaults 等本次变更）。
>
> **本次更新摘要**：多册历史严重 bug 已修复并经源码复核——自定义 profile permissions 丢弃、anthropic 链路断裂、sessionReuse 协议不一致、maxSteps 默认值打架、evaluator 失败兜底 reject、metacog everySeconds 不一致、opencode-http 超时荒谬、conclude 死协议、session-manager 路径转义、codex argv prompt、pack 打包缺 prompt、profile-loader tuning 字段丢弃等均已清零。`npm test` 现有测试（299 passing）。详见下方「已修复项」与各册。

## 文档结构

按目录分册（10 册），每册包含该目录下每个文件的：**用途 / 职责 / 关键导出 / 依赖 / 审计要点（含 bug、风险、不一致、死代码）/ 跨文件观察**。

| 文档 | 范围 | 文件数 | 关键内容 |
|---|---|---|---|
| [01-entry-points.md](./01-entry-points.md) | `src/index.ts`, `src/cli.ts`, `src/node-sqlite.d.ts` | 3 | 包入口、CLI 命令树、SQLite 类型声明 |
| [02-app.md](./02-app.md) | `src/app/` | 2 | AgentRuntime 组合根、VERSION 死常量 |
| [03-agent.md](./03-agent.md) | `src/agent/` | 11 | 协议层：types/contracts/permissions/main-agent/decision-applier/subagent-runner/context-builder/graph-view/context-ledger/fact-tiering/parse-envelope（含 conclude 回退、chain 删除） |
| [04-session.md](./04-session.md) | `src/session/` | 5 | 运行时调度：SessionLoop/GlobalSupervisor/MetacogSupervisor/ProjectLockManager/SessionManager（路径转义已防御） |
| [05-worker-core.md](./05-worker-core.md) | `src/worker/`（root） | 8 | WorkerPool 抽象、driver registry、MockWorker、AgentDriverPool、WorkerSessionManager |
| [06-worker-backends.md](./06-worker-backends.md) | `src/worker/backends/` | 8 | AgentBackend 实现：subprocess 基类、codex/claude/opencode-cli/opencode-http/process、registry、types（各 backend 现均支持 resume） |
| [07-worker-providers.md](./07-worker-providers.md) | `src/worker/providers/` | 3 | ModelProvider 实现：types、registry、ConfiguredProvider（anthropic 链路已贯通） |
| [08-graph.md](./08-graph.md) | `src/graph/` | 5 | 存储层：Graph 接口、InMemoryGraph、SqliteGraph、FederatedGraph、FederationBus |
| [09-config.md](./09-config.md) | `src/config/` | 9 | 配置加载：default-config、task-config、profile-loader、prompt-loader、providers-config、provider-presets、utils、agent-loader、peak-home |
| [10-server.md](./10-server.md) | `src/server/` | 2 | HTTP API + SSE + Dashboard（HttpServer + dashboard.html） |
| **合计** | | **54 .ts + dashboard.html** | |

---

## 📊 审计关键发现汇总

### ✅ 已修复项（本次复核确认）

| 历史发现 | 状态 | 复核依据 |
|---|---|---|
| 自定义 profile permissions 被丢弃 | ✅已修复 | `profile-loader.ts:108-113` 现读取 `raw.permissions` 数组（过滤白名单），仅未声明时回退 builtin。详见 [09-config.md §9.3](./09-config.md)。 |
| anthropic provider 链路断裂 | ✅已修复 | `provider-presets.ts` 的 `ProviderPreset` 加 `kind?`/`headers?`，anthropic preset 带 `kind:"anthropic"`；`initProvidersFile`/`presetToUserConfig`/`listKnownProviders` 全部透传 kind；`configured.ts:35` 因 `kind ?? "openai"` 命中 anthropic 分支调 `createAnthropic`。详见 [09-config.md §9.5/§9.6](./09-config.md)、[07-worker-providers.md §7.3](./07-worker-providers.md)。 |
| sessionReuse 协议三层不一致 | ✅已修复 | `opencode-http.ts:40-41` 现复用传入 `sessionId`（不再每次新建）；`codex.ts:24`/`claude.ts:19`/`opencode-cli.ts:20` 均在 `sessionId` 存在时加 `--resume`/`--session`。所有 builtin backend 现支持 resume。详见 [06-worker-backends.md](./06-worker-backends.md)。 |
| maxSteps 默认值三重打架 | ✅已移除 | `WorkflowConfig`/`DEFAULT_LIMITS`/`mergeWorkflow` 全部删除，改由 `SchedulerConfig`（`scheduler: { maxConcurrent, refillPerTick, workerLeaseMs }`）+ 自然终止（`openIntents===0`）。旧 `workflow.limits.{maxConcurrent,refillPerTick,workerLeaseMs}` 仍向后兼容映射，maxSteps 等被忽略。详见 [09-config.md §9.2](./09-config.md)、[03-agent.md §3.1](./03-agent.md)。 |
| evaluator 失败兜底 reject | ✅已修复 | `session-loop.ts:354-365` evaluator 抛错时不再 `resolveFact(..., reject)`，改为 `updateSubagentRun(status:"failed")` + `logEvent("evaluator.error")`，fact 保留 candidate 待后续重试。详见 [04-session.md §4.1](./04-session.md)。 |
| metacog everySeconds 默认值不一致 | ✅已修复 | `DEFAULT_METACOG_TRIGGERS.everySeconds` 统一为 30（types.ts:404），`defaultConfig()` metacog profile 展开同一常量，control.metacogIntervalSeconds 取同一常量。详见 [09-config.md §9.1](./09-config.md)。 |
| token 计量全错（outputTokens=0） | ✅已修复 | `session-loop.ts:275-276` 现用 `estimateContextTokens(prompt)` 算 inputTokens、`estimateContextTokens(rawText)` 算 outputTokens（不再硬编码 0）。仍为 `length/4` 粗估，但双向都有值。详见 [04-session.md §4.1](./04-session.md)。 |
| opencode-http 超时 = maxTokens×1000 | ✅已修复 | `opencode-http.ts:13,67` 现用 `DEFAULT_TIMEOUT_MS = 300_000`（5 分钟），`input.config.timeoutMs ?? DEFAULT_TIMEOUT_MS`——不再把 token 数当毫秒。详见 [06-worker-backends.md §6.7](./06-worker-backends.md)。 |
| conclude/partialOutput/supportsConclude 死协议 | ✅conclude 已上线 | `conclude: true` 标志已贯穿 worker-runtime → base → agent-driver → agent-driver-pool → subprocess；`PromptSpec.concludeFile` → `normalizePrompt` 解析 → explorer 默认启用 → subagent-runner 触发回退。`supportsConclude`/`partialOutput` 仍为未消费的可选能力提示，但 conclude 主路径已 live。详见 [03-agent.md §3.7](./03-agent.md)、[09-config.md §9.3](./09-config.md)。 |
| session-manager 路径转义 + delete 误删 | ✅已修复 | `session-manager.ts:32-37` 现调 `safeSessionName(sessionId)`（`utils.ts:43` 新增 `..` 折叠）+ `relative(baseDir, dir)` 检查双重防御，越界抛错。baseDir 默认取 `peak-home.sessionsDir()`。详见 [04-session.md §4.5](./04-session.md)、[09-config.md §9.7](./09-config.md)。 |
| `safeSessionName` 生产零调用 + 不防 `..` | ✅已修复 | `session-manager.ts:13,32` 已 import 并调用；`utils.ts:43` 新增 `.replace(/\.{2,}/g, ".")` 折叠 `..`。详见 [09-config.md §9.7](./09-config.md)。 |
| codex backend prompt 经 argv 传递 | ✅已修复 | `codex.ts` 的 `buildArgv` 改走 stdin（`argv.push("-")` + `input: prompt`），不再 `argv.push("--", prompt)`。Windows cmd.exe 下超长 prompt 经 argv 会被截断/引号转义失败（实测 `spawn cmd.exe ENOENT`，planner steps=0）。与 opencode-cli 的 stdin 方案一致。详见 [06-worker-backends.md §6.4](./06-worker-backends.md)。 |
| `npm run pack` 产出的 bundle 缺 builtin prompts | ✅已修复 | `pack.mjs` 新增 "copy builtin prompts" 步骤（`cpSync` 到 `dist/agent/prompts/`）；`prompt-loader.ts` 的 `DIST_ROOT` 改探测式（tsc dev 布局 `dist/config/` → `dist/`，esbuild 扁平 bundle `dist/index.js` → `dist/`），旧逻辑把扁平 bundle 的 DIST_ROOT 算到包外导致 builtin prompt 全部解析失败。`pack.mjs` spawn 加 `shell: process.platform === "win32"` 修复 Windows ENOENT。详见 [09-config.md §9.4](./09-config.md)、[05-worker-core.md](./05-worker-core.md)。 |
| profile-loader 丢弃 cooldownSteps/triggers 等 tuning 字段 | ✅已修复 | `normalizeProfile` 现读取 `cooldownSteps`/`triggers`（经 `normalizeTriggers`）/`sessionReuse`/`maxOutputTokens`/`promptCache`。过往这些字段虽在 `SubagentProfile` 类型声明、`defaultConfig` 设值，但 `loadConfig → normalizeProfile` 静默丢弃，task.json 里写不生效。现与 agent-loader.ts 的 `applyTuning` 字段集对齐。详见 [09-config.md §9.3](./09-config.md)。 |
| chain 机制相关全部发现 | ✅已移除 | `ChainState`/`ChainRequest`/`SubIntentSpec`/`Intent.chain`/`enrichedContext`/`isResume`/`"chained"` 状态整体删除；`relevanceScope` 的 `"chain"` 更名为 `"linked"`；`OutputContract` 的 `chain` 删除。详见 [03-agent.md](./03-agent.md) 头注。 |
| planner 对 hint 消费零控制权 | ✅已修复 | `contracts.validateMainDecision` 透传 `consumeHintIds`，`MainAgent` 仅在 planner 未声明时回退到「消费 actionable hint」。详见 [03-agent.md §3.3/§3.5](./03-agent.md)。 |

### 🚨 严重 bug / 安全风险（仍存，建议立即修复）

1. **codex / claude backend 默认禁用审批与沙箱**（`worker/backends/codex.ts:20`、`claude.ts:18`）—— `--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions`。LLM 输出（含 graph 中 attacker-controlled 的 fact/intent description）可触发任意系统调用，叠加 `subprocess.ts` 的 PATH 劫持 + 全 env 透传，构成 **prompt injection → RCE** 链。详见 [06-worker-backends.md](./06-worker-backends.md)。
2. **HTTP server 无认证**（`server/http-server.ts`）—— 本地多用户/同机任意进程可通过 `POST /api/projects/:id/directives` 控制 agent 行为（stop/pause/kill-intent/spawn-intent），与 §1 叠加放大 RCE 面。详见 [10-server.md §10.1](./10-server.md)。
3. **dashboard innerHTML XSS**（`server/dashboard.html`，15 处 innerHTML）—— graph 的 fact/intent description 来自 LLM 输出（可能被 prompt injection 控制），经 `innerHTML` 渲染可执行脚本；HTML 无 CSP。详见 [10-server.md §10.2](./10-server.md)。

> 注：过往「自定义 profile permissions 丢弃」「anthropic 链路断裂」「session-manager 路径转义」三个严重项均已修复（见上方已修复表），现仅剩 backend 危险开关、HTTP 无认证、dashboard XSS 三项安全风险。

### ⚠️ 重要不一致（仍存）

1. **两套同名 `WorkerRequest`/`WorkerResult` 类型**（`worker/worker-runtime.ts` vs `worker/base.ts`），字段完全不同（`text`/`stderr?` vs `stdout`/`stderr`），`AgentDriverPool` 被迫手工字段映射。公共 API 面有两套同名类型。详见 [05-worker-core.md §5.1/§5.2](./05-worker-core.md)。
2. **`stringValue` 同名不同义两处**：`config/utils.ts`（单参 trim）vs `config/task-config.ts`（双参 dot-path 不 trim）。task-config 仍未 import utils.ts，自定义了一份。详见 [09-config.md §9.2/§9.7](./09-config.md)。
3. **`GlobalSupervisor.globalMaxConcurrent` 死字段**（`session/supervisor.ts:41,45`）—— 构造期读取但 `tick()`（72–76 行）完全不用它限制并发，承诺的「全局并发配额」未实现。详见 [04-session.md §4.2](./04-session.md)。
4. **`AgentDriverPool` 硬编码 `role:"explorer"` + 丢失 `apiKey`**（`worker/agent-driver-pool.ts`）—— 所有调用标 explorer（丢失 role 上下文）；重组 backendConfig 漏 `apiKey` 字段。详见 [05-worker-core.md §5.5](./05-worker-core.md)。
5. **`agent-loader.mergePrompt` 漏 `concludeFile`**（`config/agent-loader.ts:137-145`）—— patch 合并 prompt 时只处理 file/rules/knowledge/instructions，不透传 `concludeFile`，agent 想覆盖 conclude 回退会失效。详见 [09-config.md §9.8](./09-config.md)。
6. **`WorkerKind = "agent" | "api" | "mock"`** 与 AGENTS.md「legacy `api` WorkerKind is gone」表述不一致（types.ts 仍保留 `"api"`）。详见 [03-agent.md §3.1](./03-agent.md)。

> 注：过往「maxSteps 三重打架」「metacog everySeconds 不一致」「token 计量全错」「opencode-http 超时荒谬」「sessionReuse 三层不一致」「evaluator 兜底 reject」均已修复（见已修复表）。

### 🪦 死代码 / 未实现预留（仍存）

1. **`app/version.ts` 的 `VERSION` 常量从未被 import**（`cli.ts` 自写一份 0.1.0，`package.json` 第三份）—— 详见 [02-app.md §2.2](./02-app.md)。
2. **`app/agent-runtime.ts` 的 `projects` Map**—— `createProject` 写入但全文件无读取点。详见 [02-app.md §2.1](./02-app.md)。
3. **`graph/federation-bus.ts` 的 `publishInsight` 无生产调用方**—— 跨会话 insight 总线搭好但「accept fact → publish」链路未接线。详见 [08-graph.md §8.5](./08-graph.md)。
4. **`graph/in-memory-graph.ts` 的 `snapshots` 字段** + **`graph/context-ledger.ts` 的 `LedgerEntry.lastSyncStep`**—— 定义/写入但从不读取。详见 [08-graph.md §8.2](./08-graph.md)、[03-agent.md §3.10](./03-agent.md)。
5. **`agent/fact-tiering.ts` 的 `cold` 层**—— `tierFacts` 永远返回 `cold: []`，三层模型只用 hot/warm。详见 [03-agent.md §3.11](./03-agent.md)。
6. **`worker/backends/types.ts` 的 `supportsConclude`/`partialOutput`**—— 可选能力提示字段，定义但无 backend 消费（conclude 主路径经 `conclude: true` flag 工作，不依赖这两个字段）。详见 [06-worker-backends.md §6.1](./06-worker-backends.md)。
7. **`worker/worker-runtime.ts` 的 `expectedPayload`/`timedOut`/`pickWorker`/`NullWorkerPool`**—— 接口方法/字段无生产调用方（`NullWorkerPool` 仅被 `index.ts` re-export）。详见 [05-worker-core.md §5.1](./05-worker-core.md)。
8. **`worker/registry.ts` 的 `DRIVER_FACTORIES` 缺 `mock` kind**—— MockWorker 走旁路不经 executeWorker。详见 [05-worker-core.md §5.3](./05-worker-core.md)。
9. **`server/http-server.ts` 的 `sessionLoop` 构造参数**—— 持有但完全未用。详见 [10-server.md §10.1](./10-server.md)。
10. **`session/session-manager.ts` 的 `openReadOnly`**—— 无调用方，且名不副实（实际可写）。详见 [04-session.md §4.5](./04-session.md)。
11. **`session/session-loop.ts` 的 `maybeRunPlanner` inCooldown 分支**—— `needsPlanning` 为真要求 `isEmpty || hasActionableHint || hasRejectOrDemote`，故 `!isEmpty && !hasActionableHint && !hasRejectOrDemote` 恒假，`inCooldown` 分支不可达。详见 [04-session.md §4.1](./04-session.md)。
12. **`agent/contracts.ts` 的 `CONTRACTS` 注册表**—— 被 `index.ts` re-export 但运行时无消费（subagent-runner 自己 switch）。详见 [03-agent.md §3.3](./03-agent.md)。

> 注：过往「`config/utils.ts` 整文件生产零消费」「`safeSessionName` 不防 `..`」已修复（safeSessionName 现被 session-manager 调用且补了 `..` 折叠）；「conclude/partialOutput/supportsConclude 死协议」中 conclude 主路径已上线（仅剩 supportsConclude/partialOutput 两提示字段未消费）；cli.ts 的 `DEFAULT_LIMITS`/`InMemoryGraph` 死 import 已随 DEFAULT_LIMITS 删除与 import 清理消失。

### 🔁 重复 / 冗余（仍存）

1. 三处版本硬编码（`package.json` / `app/version.ts` / `cli.ts`）。
2. `stringValue` 同名不同义（`config/utils.ts` vs `config/task-config.ts`）。
3. `FederatedGraph` 直连 `new DatabaseSync` 绕过 `SessionManager.openReadOnly`（职责重叠）。
4. `SqliteGraph` 的 `intent_sources` 表与 `parent_fact_ids_json` 双写双读。

---

## 🗺️ 推荐审计顺序

1. **第一优先级（架构理解）**：
   - [03-agent.md](./03-agent.md) — 协议层是骨架，先理解 types/contracts/permissions（含 conclude 回退、chain 删除后的新形状）
   - [04-session.md](./04-session.md) — SessionLoop 是核心调度器，所有运行时行为汇集于此
   - [08-graph.md](./08-graph.md) — Graph 接口定义所有状态操作契约

2. **第二优先级（执行路径）**：
   - [05-worker-core.md](./05-worker-core.md) — WorkerPool 抽象层
   - [06-worker-backends.md](./06-worker-backends.md) — 实际 backend（含安全风险点，各 backend 现支持 resume）
   - [03-agent.md §3.7 subagent-runner](./03-agent.md) — 串起协议与 worker 的引擎（含 conclude 回退）

3. **第三优先级（配置与边界）**：
   - [09-config.md](./09-config.md) — 配置加载（含新增 agent-loader/peak-home，历史严重 bug 已清零）
   - [01-entry-points.md](./01-entry-points.md) — CLI 入口
   - [10-server.md](./10-server.md) — HTTP API（含安全风险）

4. **第四优先级（辅助）**：
   - [02-app.md](./02-app.md) — 组合根
   - [07-worker-providers.md](./07-worker-providers.md) — Provider 层（anthropic 链路已贯通）

---

## 📈 文件规模与测试覆盖

| 目录 | 文件数 | 总行数 | 单元测试 |
|---|---|---|---|
| `src/`（root） | 3 | ~391 | 仅 cli help 测试 |
| `src/app/` | 2 | ~139 | ✅ agent-runtime.test.ts |
| `src/agent/` | 11 | ~1887 | ✅ contracts / parse-envelope / permissions / subagent-runner / subagent-run / decision-applier / context-builder / context-ledger / fact-tiering |
| `src/session/` | 5 | ~778 | ✅ session-loop（directives/planner-skip/termination）/ supervisor / metacog-supervisor / session-manager / session-manager-fs / project-lock |
| `src/worker/`（root） | 8 | ~539 | ✅ agent-driver-pool |
| `src/worker/backends/` | 8 | ~457 | ❌ 无 |
| `src/worker/providers/` | 3 | ~158 | ❌ 无（provider-config 测配置加载） |
| `src/graph/` | 5 | ~1858 | ✅ sqlite / graph / federation-bus |
| `src/config/` | 9 | ~1098 | ✅ config-utils / profile-loader / task-config / provider-config / agent-loader / peak-home |
| `src/server/` | 2 (.ts) + dashboard.html | ~602 | ✅ http-server |
| **合计** | **54 .ts + 1 html** | **~7481 .ts + 412 html** | **33 个测试文件，299 passing** |

**测试现状**：`npm test` 输出 `tests 299 / pass 299 / fail 0`（2026-07-13 复核）。`SessionLoop` 现有 directives/planner-skip/termination 三组测试，过往「核心调度无测试是最高风险」已缓解。本次新增 codex backend argv/stdin 测试（`codex-backend.test.ts`）、mock registerDefaults 测试（`mock-worker.test.ts`）、vulnhunt 验收测试（`vulnhunt-acceptance.test.ts`）。仍有覆盖空白的重点：worker backends（claude/opencode-http 等无单元测试）、worker providers（configured.ts 无测试）。

**测试覆盖建议优先级**：
1. `worker/backends/` 各 backend 的 argv 构造与 resume/sessionId 透传（安全相关，目前零覆盖）
2. `worker/providers/configured.ts` 的 openai/anthropic 分支与 kind 透传（anthropic 链路修复后需回归）
3. `config/agent-loader.ts` mergePrompt 漏 concludeFile 的回归测试（见 §不一致 5）
4. `session/session-loop.ts` conclude 回退触发与 evaluator 失败保留 candidate 的路径

---

## 📝 审计方法说明

- 所有源码通过 `Read` 工具逐文件读取（行号化），结合 `codegraph`（`callers`/`callees`/`node`/`query`/`files`）探索调用关系与依赖
- 审计索引建立时 codegraph 对旧目录结构过期，已执行 `codegraph sync` 重建确保调用图准确
- **每个文件均独立 读→分析→写文档 循环**（非批量读完再写），保证每册基于读取时点的真实代码
- 标记级别：
  - 🚨 = 严重 bug 或安全风险，建议立即修复
  - ⚠️ = 重要不一致或潜在问题，建议排期修复
  - ✅ = 设计良好、符合最佳实践，或历史问题已修复
- 文档基于审计时点（2026-07-09 初版，2026-07-13 增补修订）的代码状态，已逐条复核源码确认历史发现的修复状态（非猜测）。后续代码变更需重新审计对应文件
- 跨册关联问题（如 anthropic kind 跨 config/providers 两层）在各册「跨文件小结」与「跨文件观察」互相引用

---

## 🔗 相关文档

- 仓库根 [AGENTS.md](../../AGENTS.md) — 仓库整体指引
- [`peak/AGENTS.md`](../AGENTS.md) — peak 包指引
- [`peak/README.md`](../README.md) — 用户文档
