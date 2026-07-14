# 02 · 组合根（`src/app/`）

> 审计范围：`src/app/agent-runtime.ts`（运行时装配）、`src/app/version.ts`（版本常量）。
> 审计方法：逐文件 `Read` + `codegraph` 调用关系核查。

---

## 1. `src/app/agent-runtime.ts`（128 行）

### 用途
**运行时组合根（composition root）**。把 Graph 存储、WorkerPool、SessionLoop、MetacogSupervisor、HttpServer 装配成一个 `AgentRuntime` 对象，供 CLI（`run` 命令）与测试复用。本文件**只做接线（wiring），不含领域逻辑**——领域行为归 agent 阶段，graph 写入归 Graph 实现（见文件头注释 1–7 行）。

### 职责
- 读取 `AgentRuntimeOptions`，决定 baseDir / host / port / workerPool / 是否起 HTTP / 是否起 metacog
- 在构造期创建：`SessionManager`、`Graph`（按 `baseDir` 是否传入决定 Sqlite vs InMemory）、`WorkerPool`（默认 `AgentDriverPool`）、`SessionLoop`、可选 `MetacogSupervisor`、可选 `HttpServer`
- 对外提供：`createProject`、`step`/`run`/`tick`（转调 `SessionLoop`）、`startMetacog`/`stopMetacog`、`startHttp`/`stopHttp`、`addDirective`、`close`

### 关键导出
- `AgentRuntimeOptions`（interface）：`baseDir?`、`host?`、`port?`、`workerPool?`、`useHttp?`、`useMetacogSupervisor?`
- `AgentRuntime`（class）：上述字段均为 `readonly` 暴露；`projects` 为 `private`

### Graph 实现选择逻辑（第 45–50 行）
```
if (options.baseDir)  → sessionManager.open(session)   // 持久化 SqliteGraph
else                  → new InMemoryGraph()             // 纯内存
```
**仅凭 `options.baseDir` 是否传入**决定持久化。`cli.ts` 的 `run` 命令总是传 `baseDir=sessionDir`，因此走持久化路径；但若调用方传了 `baseDir` 却 `config.task.session` 为空，`session` 会退化为 `"default"`。

### 依赖
`SessionManager`、`InMemoryGraph`、`AgentDriverPool`、`SessionLoop`、`MetacogSupervisor`、`HttpServer`；类型：`TaskConfig`、`DirectiveInput`、`ProjectId`、`Graph`、`ProjectInput`、`WorkerPool`、`RunOptions`、`StepResult`。

### 审计要点
- 🚨 **`projects` Map 是死字段**（第 36、85 行）：`createProject` 写入 `this.projects.set(project.id, ...)`，但**全文件无任何读取点**，codegraph 也确认无外部消费。纯内存泄漏式记录，应删除或改为对外暴露「已创建 project 列表」的访问器。
- 🚨 **`close()` 的 graph 关闭是鸭子类型 hack**（第 124–125 行）：`const g = this.graph as unknown as { close?: () => void }`——绕过 `Graph` 接口签名去探测 `close`。`Graph` 接口（见 [08-graph.md](./08-graph.md)）未声明 `close`，但 `SqliteGraph`/`SessionManager` 有。应在 `Graph` 接口加 `close?(): void` 可选方法，消除 `as unknown as`。
- ⚠️ **`createProject` 的 `sessionDir` 回退到 `process.cwd()`**（第 72 行）：`this.sessionManager?.sessionDir(session) ?? process.cwd()`——但 `sessionManager` 在构造期必定赋值（非 null），`?.` 永远走前半。`?? process.cwd()` 是不可达分支。
- ⚠️ **`createProject` 的 `configPath` 回退**（第 80 行）：`input.configPath ?? join(sessionDir, "task.json")`——若 `input.configPath` 未传，回退到 `sessionDir/task.json`，但该文件未必存在；下游 `resume` 会读 `project.taskConfig`（来自 DB），不读此路径，所以仅作展示用，但语义易误。
- ⚠️ **`useHttp`/`useMetacogSupervisor` 默认值语义反转**：`options.useHttp !== false`（默认起 HTTP）而非 `options.useHttp === true`。CLI 用 `--no-http` 关闭，语义一致；但 SDK 调用方若传 `useHttp: undefined` 也会起 server，需文档明示。
- ⚠️ **构造期同步创建 `HttpServer`/`MetacogSupervisor` 但不启动**：`startHttp`/`startMetacog` 需显式调用；`close()` 会 `stopHttp()` 但 `close` 不 `await`（`void this.stopHttp()`）——server 关闭是异步的，`close()` 返回后 server 可能还在监听端口。
- ⚠️ **`HttpServer` 构造参数 `sessionLoop`**（第 60 行）：传入 `this.sessionLoop`，但 [10-server.md](./10-server.md) 会指出 `HttpServer` 实际并不使用该参数做 loop 操作（持有但未用）。
- ✅ 组合根模式清晰，构造期不做 IO（除 `SessionManager` 构造），`start*` 显式异步。
- ✅ `AgentRuntime` 字段全 `readonly`，对外可读不可改，封装良好。

### 跨文件观察
- `cli.ts` 的 `resume` 命令**绕过 `AgentRuntime`**，直接 `new SessionLoop(...)`——说明 `AgentRuntime` 未覆盖 resume 场景（不能从已有 session 重建 runtime），是组合根的设计缺口。
- `MetacogSupervisor` 构造需要 `sessionLoop.locks_`（第 56 行），用 trailing underscore 暴露「半私有」字段，说明 SessionLoop 与 MetacogSupervisor 耦合较紧 → 见 [04-session.md](./04-session.md)。
- codegraph 显示 `AgentRuntime` 调用方：`cli.ts`、`index.ts`（re-export）、`tests/agent-runtime.test.ts`（仅一个测试文件）。测试覆盖存在，但仅覆盖构造与 createProject。

---

## 2. `src/app/version.ts`（9 行）

### 用途
`peak` 包的**版本常量**。文件头注释（1–6 行）声称「读取仓库根 version 文件，使 agent 与 Peak 报告同一版本」。

### 职责
导出 `VERSION = "0.1.0"` 常量。

### 关键导出
- `VERSION: string`（const，值 `"0.1.0"`）

### 依赖
无。

### 审计要点
- 🚨 **注释撒谎**：文件头说「Reads the repository root version file at build/runtime」，但实现是**硬编码字符串**，根本不读 `version` 文件。注释与实现严重不符。
- 🚨 **`VERSION` 从未被任何文件 import**（codegraph 确认：`src/`、`tests/` 全局仅 `version.ts:8` 一处出现 `VERSION`）。`cli.ts` 第 33 行另写一份 `0.1.0`，`package.json` 第三份。**三处版本各写各的**，且 `version.ts` 这份完全是死代码。
- ⚠️ 文件头注释承诺的「与 Peak 统一版本」机制完全未实现（Peer 的版本在仓库根 `version` 文件，由 Gradle 读取）。

### 跨文件观察
- 这是「死文件 + 撒谎注释」的典型，建议要么真正实现「读 version 文件」并被 `cli.ts` 引用，要么删除。

---

## 跨文件小结（本册）

1. **`AgentRuntime` 是组合根但被 `resume` 绕过** → 设计缺口，建议给 `AgentRuntime` 加 `static resume(sessionManager, session)` 工厂。
2. **两处鸭子类型 hack**：`close()` 探测 graph.close、`sessionLoop.locks_` 半私有暴露——都指向「接口未声明完整能力」的根因，应在 `Graph`/`SessionLoop` 接口层补齐。
3. **`projects` Map + `VERSION` 常量**：两处纯死代码，零成本删除项。
4. 本册是「装配」而非「行为」，审计重点在「接线是否正确、资源生命周期是否对称」——目前 `close()` 不 await 异步关闭、`HttpServer` 持有未用的 `sessionLoop` 都是生命周期瑕疵。
