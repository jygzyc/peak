# decx-agent/src 代码审计文档

> 本目录是对 `decx-agent/src/` 全部 **53 个 TypeScript 文件** 的**逐文件用途分析与审计报告**，用于代码审计与重构决策。
> 审计方法：每个文件经 `Read` 行号化精读 + `codegraph`（callers/callees/node/query）交叉验证调用关系，**逐文件 读→分析→写文档** 循环执行（非全读完再写）。审计时点：2026-07-08，基于 `dev` 分支当前代码。

## 文档结构

按目录分册（10 册），每册包含该目录下每个文件的：**用途 / 职责 / 关键导出 / 依赖 / 审计要点（含 bug、风险、不一致、死代码）/ 跨文件观察**。

| 文档 | 范围 | 文件数 | 关键内容 |
|---|---|---|---|
| [01-entry-points.md](./01-entry-points.md) | `src/index.ts`, `src/cli.ts`, `src/node-sqlite.d.ts` | 3 | 包入口、CLI 命令树、SQLite 类型声明 |
| [02-app.md](./02-app.md) | `src/app/` | 2 | AgentRuntime 组合根、VERSION 死常量 |
| [03-agent.md](./03-agent.md) | `src/agent/` | 11 | 协议层：types/contracts/permissions/main-agent/decision-applier/subagent-runner/context-builder/graph-view/context-ledger/fact-tiering/parse-envelope |
| [04-session.md](./04-session.md) | `src/session/` | 5 | 运行时调度：SessionLoop/GlobalSupervisor/MetacogSupervisor/ProjectLockManager/SessionManager |
| [05-worker-core.md](./05-worker-core.md) | `src/worker/`（root） | 8 | WorkerPool 抽象、driver registry、MockWorker、AgentDriverPool、WorkerSessionManager |
| [06-worker-backends.md](./06-worker-backends.md) | `src/worker/backends/` | 8 | AgentBackend 实现：subprocess 基类、codex/claude/opencode-cli/opencode-http/process、registry、types |
| [07-worker-providers.md](./07-worker-providers.md) | `src/worker/providers/` | 3 | ModelProvider 实现：types、registry、ConfiguredProvider |
| [08-graph.md](./08-graph.md) | `src/graph/` | 5 | 存储层：Graph 接口、InMemoryGraph、SqliteGraph、FederatedGraph、FederationBus |
| [09-config.md](./09-config.md) | `src/config/` | 7 | 配置加载：default-config、task-config、profile-loader、prompt-loader、providers-config、provider-presets、utils |
| [10-server.md](./10-server.md) | `src/server/` | 2 | HTTP API + SSE + Dashboard（HttpServer + dashboard.html） |
| **合计** | | **54** | （53 .ts + dashboard.html） |

---

## 📊 审计关键发现汇总

### 🚨 严重 bug / 安全风险（建议立即修复）

1. **自定义 profile permissions 被丢弃**（`config/profile-loader.ts:95-97`）—— `normalizePermissions` 仅查 `BUILTIN_PERMISSIONS`，**完全忽略 `raw.permissions`**。自定义 role（如 `android-source-finder`）拿不到任何权限，decision-applier 全部 `require` 失败。与 AGENTS.md「custom profiles declare their own」承诺直接冲突。详见 [09-config.md §9.3](./09-config.md)。
2. **anthropic provider 链路断裂**（`config/provider-presets.ts` + `config/providers-config.ts` + `worker/providers/configured.ts`）—— `ProviderPreset` interface 无 `kind` 字段，anthropic preset 无 `kind`；`initProvidersFile`/`presetToUserConfig` 复制时也不带 `kind`/`headers`；最终 `ConfiguredProvider` 因 `kind ?? "openai"` 走 createOpenAI 调 Anthropic API，**必然失败**。详见 [07-worker-providers.md §7.3](./07-worker-providers.md) 与 [09-config.md §9.6](./09-config.md)。
3. **codex / claude backend 默认禁用审批与沙箱**（`worker/backends/codex.ts:19`、`claude.ts:17`）—— `--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions`。LLM 输出（含 graph 中 attacker-controlled 的 fact/intent description）可触发任意系统调用，叠加 `subprocess.ts` 的 PATH 劫持 + 全 env 透传，构成 **prompt injection → RCE** 链。详见 [06-worker-backends.md](./06-worker-backends.md)。
4. **HTTP server 无认证**（`server/http-server.ts`）—— 本地多用户/同机任意进程可通过 `POST /api/projects/:id/directives` 控制 agent 行为（stop/pause/kill-intent/spawn-intent），与 §3 叠加放大 RCE 面。详见 [10-server.md §10.1](./10-server.md)。
5. **session-manager 路径转义 + delete 误删**（`session/session-manager.ts:25,47-50,60-63`）—— `join(baseDir, sessionId)` 不防 `../`，`open("../evil")` 会在 baseDir 父目录建 db；`delete("../evil")` 的 `rmSync(recursive, force)` 可删任意目录。`config/utils.ts` 的 `safeSessionName` 本应防护但**生产零调用**且本身不防 `.`。详见 [04-session.md §4.5](./04-session.md) 与 [09-config.md §9.7](./09-config.md)。
6. **dashboard innerHTML XSS**（`server/dashboard.html:326,329` 等）—— graph 的 fact/intent description 来自 LLM 输出（可能被 prompt injection 控制），经 `innerHTML` 渲染可执行脚本；HTML 无 CSP。详见 [10-server.md §10.2](./10-server.md)。
7. **planner 对 hint 消费零控制权**（`agent/contracts.ts:65` + `agent/main-agent.ts:77-79`）—— `validateMainDecision` 丢弃 planner 的 consumeHintIds 返回空数组，`MainAgent` 再用 `input.hints.map(h=>h.id)` 全量覆盖；prompt 还告诉 planner 可以 ignore hint（欺骗）。详见 [03-agent.md §3.3/§3.5](./03-agent.md)。

### ⚠️ 重要不一致

1. **maxSteps 默认值三重打架**：`SessionLoop.run`(默认 100) vs `checkTermination`(`DEFAULT_LIMITS.maxSteps`=1000) vs `defaultConfig().workflow.limits.maxSteps`(1000)。`run` 循环 100 步退出，checkTermination 的 maxSteps 分支近乎不可达。详见 [04-session.md §4.1](./04-session.md)。
2. **metacog everySeconds 默认值不一致**：`defaultConfig`(30) vs `DEFAULT_METACOG_TRIGGERS`(60) vs `MetacogSupervisor.DEFAULT_METACOG_INTERVAL_MS`(30s)。详见 [04-session.md §4.3](./04-session.md)、[09-config.md §9.1](./09-config.md)。
3. **两套同名 `WorkerRequest`/`WorkerResult` 类型**（`worker/worker-runtime.ts` vs `worker/base.ts`），字段完全不同（`text`/`stderr?` vs `stdout`/`stderr`），`AgentDriverPool` 被迫手工字段映射。公共 API 面有两套同名类型。详见 [05-worker-core.md §5.1/§5.2](./05-worker-core.md)。
4. **token 计量全错**（`session/session-loop.ts:265`）—— `runOneExplorer` 的 `outputTokens = 0` 硬编码，`inputTokens = prompt.length/4` 粗估；SubagentRun 的 token 字段不可信，影响 quota/计费/审计。详见 [04-session.md §4.1](./04-session.md)。
5. **sessionReuse 协议三层不一致**（`worker/session-manager.ts` vs `subagent-runner` vs backends）—— `WorkerSessionManager` 假设复用，`SubagentRunner` 在 sessionReuse 时 acquire+传 sessionId，但 `opencode-http` 每次新建 session 忽略传入 sessionId，`codex`/`claude`/`opencode-cli` 无 `--resume`。**sessionReuse 对所有 builtin backend 无效**。详见 [06-worker-backends.md 跨文件小结](./06-worker-backends.md)。
6. **evaluator 失败兜底 reject**（`session/session-loop.ts:355-358`）—— evaluator 抛错（网络/超时）时直接 `resolveFact(..., {decision:"reject"})`，临时性错误被记为 fact rejected，污染 dead-end 与 planner 决策。详见 [04-session.md §4.1](./04-session.md)。
7. **`stringValue` 同名不同义三处**：`config/utils.ts`（单参 trim）、`config/task-config.ts`（双参 dot-path 不 trim）——重复定义且签名不同。详见 [09-config.md §9.2/§9.7](./09-config.md)。
8. **opencode-http 超时 = maxTokens×1000**（`worker/backends/opencode-http.ts:63`）—— 把 token 数当毫秒，maxTokens=4096 → 4096 秒超时，数值荒谬。详见 [06-worker-backends.md §6.7](./06-worker-backends.md)。
9. **`GlobalSupervisor.globalMaxConcurrent` 死字段**（`session/supervisor.ts:41,45`）—— 构造期读取但 `tick()` 完全不用它限制并发，承诺的「全局并发配额」未实现。详见 [04-session.md §4.2](./04-session.md)。
10. **`AgentDriverPool` 硬编码 `role:"explorer"` + 丢失 `apiKey`**（`worker/agent-driver-pool.ts:41,21-35`）—— 所有调用标 explorer（丢失 role 上下文）；重组 backendConfig 漏 `apiKey` 字段。详见 [05-worker-core.md §5.5](./05-worker-core.md)。

### 🪦 死代码 / 未实现预留

1. **`config/utils.ts` 整文件生产零消费**（`isRecord`/`stringValue`/`stringArray`/`positiveInt`/`safeSessionName`/`utcnow`/`parseJson` 仅被测试用）—— 详见 [09-config.md §9.7](./09-config.md)。
2. **`app/version.ts` 的 `VERSION` 常量从未被 import**（`cli.ts` 自写一份 0.1.0，`package.json` 第三份）—— 详见 [02-app.md §2.2](./02-app.md)。
3. **`app/agent-runtime.ts` 的 `projects` Map**—— `createProject` 写入但全文件无读取点。详见 [02-app.md §2.1](./02-app.md)。
4. **`graph/federation-bus.ts` 的 `publishInsight` 无生产调用方**—— 跨会话 insight 总线搭好但「accept fact → publish」链路未接线。详见 [08-graph.md §8.5](./08-graph.md)。
5. **`graph/in-memory-graph.ts` 的 `snapshots` 字段** + **`graph/context-ledger.ts` 的 `LedgerEntry.lastSyncStep`**—— 定义/写入但从不读取。详见 [08-graph.md §8.2](./08-graph.md)、[03-agent.md §3.10](./03-agent.md)。
6. **`agent/fact-tiering.ts` 的 `cold` 层**—— `tierFacts` 永远返回 `cold: []`，三层模型只用 hot/warm。详见 [03-agent.md §3.11](./03-agent.md)。
7. **`worker/backends/types.ts` 的 `conclude`/`partialOutput`/`supportsConclude`** + **`worker/providers/types.ts` 的 `ModelCallResult.session`**—— 协议预留零实现。详见 [06-worker-backends.md §6.1](./06-worker-backends.md)、[07-worker-providers.md §7.1](./07-worker-providers.md)。
8. **`worker/worker-runtime.ts` 的 `expectedPayload`/`timedOut`/`pickWorker`/`NullWorkerPool`**—— 接口方法/字段无调用方。详见 [05-worker-core.md §5.1](./05-worker-core.md)。
9. **`worker/registry.ts` 的 `DRIVER_FACTORIES` 缺 `mock` kind**—— MockWorker 走旁路不经 executeWorker。详见 [05-worker-core.md §5.3](./05-worker-core.md)。
10. **`server/http-server.ts` 的 `sessionLoop` 构造参数**—— 持有但完全未用。详见 [10-server.md §10.1](./10-server.md)。
11. **`session/session-manager.ts` 的 `openReadOnly`**—— 无调用方，且名不副实（实际可写）。详见 [04-session.md §4.5](./04-session.md)。
12. **`session/session-loop.ts` 的 `maybeRunPlanner` inCooldown 分支**—— 条件恒假，不可达。详见 [04-session.md §4.1](./04-session.md)。
13. **`cli.ts` 多个未使用 import**（`InMemoryGraph`/`SqliteGraph`/`SessionLoop`/`DEFAULT_LIMITS`）+ `resume` 重复动态 import `HttpServer`。详见 [01-entry-points.md §2](./01-entry-points.md)。
14. **`agent/contracts.ts` 的 `CONTRACTS` 注册表**—— 被 `index.ts` re-export 但运行时无消费（subagent-runner 自己 switch）。详见 [03-agent.md §3.3](./03-agent.md)。

### 🔁 重复 / 冗余

1. 三处版本硬编码（`package.json` / `app/version.ts` / `cli.ts`）。
2. `stringValue` 同名不同义（`config/utils.ts` vs `config/task-config.ts`）。
3. `FederatedGraph` 直连 `new DatabaseSync` 绕过 `SessionManager.openReadOnly`（职责重叠）。
4. `cli.ts` `resume` 命令重复 dynamic import `HttpServer`（顶部已静态 import）。
5. `SqliteGraph` 的 `intent_sources` 表与 `parent_fact_ids_json` 双写双读。

---

## 🗺️ 推荐审计顺序

1. **第一优先级（架构理解）**：
   - [03-agent.md](./03-agent.md) — 协议层是骨架，先理解 types/contracts/permissions
   - [04-session.md](./04-session.md) — SessionLoop 是核心调度器，所有运行时行为汇集于此
   - [08-graph.md](./08-graph.md) — Graph 接口定义所有状态操作契约

2. **第二优先级（执行路径）**：
   - [05-worker-core.md](./05-worker-core.md) — WorkerPool 抽象层
   - [06-worker-backends.md](./06-worker-backends.md) — 实际 backend（含安全风险点）
   - [03-agent.md §3.7 subagent-runner](./03-agent.md) — 串起协议与 worker 的引擎

3. **第三优先级（配置与边界）**：
   - [09-config.md](./09-config.md) — 配置加载（含 2 个严重 bug）
   - [01-entry-points.md](./01-entry-points.md) — CLI 入口
   - [10-server.md](./10-server.md) — HTTP API（含安全风险）

4. **第四优先级（辅助）**：
   - [02-app.md](./02-app.md) — 组合根
   - [07-worker-providers.md](./07-worker-providers.md) — Provider 层

---

## 📈 文件规模与测试覆盖

| 目录 | 文件数 | 总行数 | 单元测试 |
|---|---|---|---|
| `src/`（root） | 3 | ~340 | 仅 cli help 测试 |
| `src/app/` | 2 | ~135 | ✅ agent-runtime.test.ts |
| `src/agent/` | 11 | ~1900 | ⚠️ 仅 subagent-runner / decision-applier 有测试 |
| `src/session/` | 5 | ~830 | ❌ 无 |
| `src/worker/`（root） | 8 | ~540 | ❌ 无 |
| `src/worker/backends/` | 8 | ~370 | ❌ 无 |
| `src/worker/providers/` | 3 | ~160 | ❌ 无 |
| `src/graph/` | 5 | ~1900 | ✅ sqlite.test.ts / federation-bus.test.ts |
| `src/config/` | 7 | ~720 | ⚠️ 仅 config-utils.test.ts（测死代码） |
| `src/server/` | 2 (.ts) | ~600 | ❌ 无 |
| **合计** | **53 .ts** | **~7100** | 覆盖率约 15-20% |

**测试覆盖建议优先级**：
1. `SessionLoop` 全分支测试（核心调度无测试是最高风险）
2. `agent/contracts.ts` + `parse-envelope.ts`（协议正确性基础）
3. `config/profile-loader.ts`（含 permissions bug）
4. `config/task-config.ts` mergeConfig 全字段（含 anthropic kind 丢失）
5. `session/project-lock.ts` + `session-manager.ts`（并发与路径安全基础）

---

## 📝 审计方法说明

- 所有源码通过 `Read` 工具逐文件读取（行号化），结合 `codegraph`（`callers`/`callees`/`node`/`query`/`files`）探索调用关系与依赖
- 审计索引建立时 codegraph 对旧目录结构过期，已执行 `codegraph sync` 重建（123 文件变更）确保调用图准确
- **每个文件均独立 读→分析→写文档 循环**（非批量读完再写），保证每册基于读取时点的真实代码
- 标记级别：
  - 🚨 = 严重 bug 或安全风险，建议立即修复
  - ⚠️ = 重要不一致或潜在问题，建议排期修复
  - ✅ = 设计良好或符合最佳实践
- 文档基于审计时点（2026-07-08，`dev` 分支）的代码状态，后续代码变更需重新审计对应文件
- 跨册关联问题（如 anthropic kind 跨 config/providers 两层）在各册「跨文件小结」与「跨文件观察」互相引用

---

## 🔗 相关文档

- 仓库根 [AGENTS.md](../../AGENTS.md) — 仓库整体指引
- [`decx-agent/AGENTS.md`](../AGENTS.md) — decx-agent 包指引
- [`decx-agent/README.md`](../README.md) — 用户文档
