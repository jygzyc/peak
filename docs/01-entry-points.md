# 01 · 入口层（`src/` 根目录）

> 审计范围：`src/index.ts`（包入口）、`src/cli.ts`（CLI）、`src/node-sqlite.d.ts`（类型声明）。
> 审计方法：逐文件 `Read` + `codegraph` 依赖分析。

---

## 1. `src/index.ts`（95 行）

### 用途
`peak` 包的 **公共 API 出口（barrel）**。不包含任何运行时逻辑，仅做 `export` 聚合，把散落在各子模块的对外类型/函数统一对外暴露。

### 职责
- 重导出整个对外类型面（`agent/types.js` 中的全部 protocol 类型）
- 重导出 Graph 接口与三个实现（InMemory / Sqlite / Federated）
- 重导出会话运行时（`SessionLoop`、`SessionManager`、监督者）
- 重导出配置加载（`loadConfig` / `defaultConfig` / `normalizeProfile` / `PromptLoader`）
- 重导出 worker 层（`AgentDriverPool` / `MockWorker` / `WorkerSessionManager`）
- 重导出 agent 协议层（`parseEnvelope` / `validateMainDecision` / `renderGraphView` / `buildDynamicContext` / `ContextLedger` / `tierFacts` / `runSubagent` / `MainAgent` / `applyMainDecision`）
- 重导出 HTTP server（`HttpServer`）和组合根（`AgentRuntime`）

### 关键导出
全部是 re-export，无自有符号。按来源分组（见源文件 6–94 行）。

### 依赖
无值依赖；纯类型/符号转出。被 `package.json` 的 `main`/`exports` 字段指向，是外部消费者（含 dist bundle）唯一入口。

### 审计要点
- ✅ 严格 barrel，零逻辑，符合「包入口应薄」惯例。
- ⚠️ **导出面与 `AGENTS.md` 中「Public commands are `run <config>`, `resume`, `status`, `workers`, `serve`」描述不一致**：`index.ts` 是 SDK 出口（无 CLI 命令概念），且 CLI 里也无 `serve`（见 §2），AGENTS.md 的承诺与实现有偏差。
- ⚠️ barrel 文件天然削弱 tree-shaking；若后续要做 SDK 子路径导出（如 `peak/graph`），当前 `package.json` 未做 `exports` 子路径映射。

### 跨文件观察
- `index.ts` 的导出清单是判断「公共 API 面」的唯一权威来源；审计其它模块时，凡未在此导出的符号均视为内部实现。

---

## 2. `src/cli.ts`（234 行，含 shebang）

### 用途
`peak` 命令行入口。基于 `commander` 构建命令树，解析参数后把运行时构造委托给 `app/agent-runtime.ts`。自身刻意保持 thin。

### 职责 / 命令树
| 命令 | 作用 | 关键选项 |
|---|---|---|
| `run <configPath>` | 从 `task.json` 起一个新任务 | `-s/--session`、`-P/--port`(默认 25429)、`--host`(默认 127.0.0.1)、`--no-http`、`--no-metacog`、`--mock`、`--max-steps` |
| `resume <session>` | 恢复已停止会话 | `-P/--port`、`--no-http` |
| `status <session>` | 打印 project 进度 | — |
| `workers` | 列出可用 worker backends/providers | — |
| `sessions` | 列出所有分析会话 | `--base-dir`(默认 `.peak-analysis`) |
| `search <query>` | 跨会话全文检索 facts | `--base-dir`、`--status`、`--min-confidence`、`--limit`(默认 50) |
| `init [dir]` | 生成最小 `task.json` 模板 | — |

`run` 的执行链：`loadConfig` → 构造 `workerPool`（`MockWorker` 或 `AgentDriverPool`）→ `new AgentRuntime(...)` → `createProject` → 可选 `startHttp` / `startMetacog` → `runtime.run()` → 打印 accepted facts。

`resume` 的执行链：`SessionManager(".peak-analysis")` → `open(session)` → 取 `projects[0]` → 置 `active` → `new SessionLoop` → 可选 `HttpServer` → `loop.run()`。

### 关键导出
无（脚本入口）。`program.parse()` 在模块加载时立即执行。

### 依赖
`commander`、`node:fs`、`node:path`；`AgentRuntime`、`loadConfig`、`InMemoryGraph`、`SqliteGraph`、`SessionManager`、`FederatedGraph`、`SessionLoop`、`HttpServer`、`AgentDriverPool`、`MockWorker`、`workerCapabilities`、`DEFAULT_LIMITS`、`defaultConfig`。

### 审计要点
- 🚨 **版本号硬编码** `0.1.0`（第 33 行），与 `app/version.ts`、`package.json` 三处各写一份，极易漂移。建议从 `version.ts` 统一导入。
- 🚨 **大量未使用的 import**：`InMemoryGraph`、`SqliteGraph`、`SessionLoop`、`DEFAULT_LIMITS` 从未引用（死代码）；`MockWorker` 仅在 `--mock` 时构造，可改为按需动态 import。
- ⚠️ **`resume` 重复动态 import `HttpServer`**：第 21 行已静态 `import { HttpServer }`，第 127 行又 `await import("./server/http-server.js")`，多余。
- ⚠️ **`resume` 与 `run` 选项不对齐**：`resume` 无 `--mock`、无 `--no-metacog`，恢复会话时无法用 mock worker。
- ⚠️ **`resume` 仅取 `projects[0]`**：多 project session 其余被静默忽略。
- ⚠️ **baseDir 处理不一致**：`run`/`resume`/`status` 硬编码 `SessionManager(".peak-analysis")`，`sessions`/`search` 提供 `--base-dir`。路径相对 `process.cwd()`，跨目录行为不可预期。
- ⚠️ **`search` 的 `--status` 强转**（第 210 行）`as "accepted" | ...`：未校验合法性，非法值透传给 `FederatedGraph`。
- ⚠️ **`init` 直接 `writeFileSync`**：目标已存在会无提示覆盖。
- ⚠️ **`status`/`sessions` 无异常处理**：DB 损坏时未捕获异常。
- ⚠️ **无 `serve` 命令**：`AGENTS.md` 声明的 public commands 含 `serve`，但本文件无；文档与实现不一致。
- ⚠️ **无全局错误边界**：任一 `action` 抛错直接非 0 退出，无统一日志格式化。
- ✅ `run --mock` 与 `AgentDriverPool` 切换清晰；默认端口 25429 与 server 对齐。

### 跨文件观察
- `resume` 手动 `new SessionLoop(...)` 绕过 `AgentRuntime`，与 `run` 的「统一走 runtime」路径分叉 → 见 [02-app.md](./02-app.md)。
- `cli.ts` 直接 `new SessionManager(".peak-analysis")`，而 `PEAK_HOME` 重定向机制在 `peak-cli` 而非本包；本包的 baseDir 完全靠 CLI 字面量，与 AGENTS.md「`.peak/agent_tasks/`」默认路径也不一致（这里用的是 `.peak-analysis/`）。**两套路径约定并存，易混淆**。

---

## 3. `src/node-sqlite.d.ts`（14 行）

### 用途
为 Node.js 内置 `node:sqlite` 实验性模块提供 **环境类型声明（ambient declaration）**，使 TS 编译期可识别 `DatabaseSync` / `StatementSync`。

### 职责
- 声明 `declare module "node:sqlite"`
- 声明 `DatabaseSync` 类（`constructor` / `exec` / `prepare` / `close`）
- 声明 `StatementSync` 接口（`run` / `get` / `all`）及其返回类型

### 关键导出
`DatabaseSync`（class）、`StatementSync`（interface）。

### 依赖
无。

### 审计要点
- ⚠️ **类型精度不足**：`run(...params: unknown[])` 应为 `[...bindings: SupportedValueType]`（`null | number | bigint | string | Uint8Array`）。当前 `unknown[]` 放弃校验，`prepare(sql).run(someObject)` 编译能过但运行必崩。
- ⚠️ **`get`/`all` 返回 `Record<string, unknown>`**：列类型丢失；下游 `sqlite-graph.ts` 需大量 `as` 断言。建议泛型 `get<T>(...)`。
- ⚠️ **未声明 `StatementSync.prototype.reset`**（Node 22.5+ 实际存在），下游想用会 TS 报错。
- ⚠️ 当前未声明 `loadExtension` / `function` / `applyChangeset` 等；日后扩展会受阻（当前用不到，仅记录）。
- ✅ 作为单点声明，避免了到处 `// @ts-ignore`。

### 跨文件观察
- `node:sqlite` 是 Node 22.5+ 实验 API（需 `--experimental-sqlite`，高版本稳定）。本声明是 `sqlite-graph.ts`、`federated-graph.ts`、`session-manager.ts` 全部 SQLite 操作的类型基础 → 见 [08-graph.md](./08-graph.md)。

---

## 跨文件小结（本册）

1. **入口三处版本/路径硬编码**：`cli.ts` 的 `0.1.0`、`.peak-analysis`、`25429` 端口；建议集中到 `app/version.ts` + 配置。
2. **死 import 与重复 import** 集中在 `cli.ts`，是最易清理的卫生问题。
3. **`AGENTS.md` 与 `cli.ts` 不一致**：`serve` 命令文档声明但未实现——需统一。
4. 本册文件不含业务逻辑，所有真实行为在下游模块；审计重点在「入口契约是否准确暴露了下游能力」。
