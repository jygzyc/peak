# peak 代码审计文档

> 当前基线：2026-07-16。本文描述当前工作树；各分册中的历史缺陷若与本文或 [修改计划](./12-cairn-inspired-generic-graph-agent-plan.md) 冲突，以本文和计划的滚动进度账本为准。

## 阅读入口

| 文档 | 主题 |
|---|---|
| [target.md](./target.md) | 目标状态：GlobalSupervisor、每 session 四角色、图状态与 TaskGroup 结束条件 |
| [11-session-timing-federation-and-prompts.md](./11-session-timing-federation-and-prompts.md) | session 时序、角色协同、跨 session、恢复与 prompt 注入专题审计 |
| [12-cairn-inspired-generic-graph-agent-plan.md](./12-cairn-inspired-generic-graph-agent-plan.md) | 参考 Cairn 的取舍、当前实现账本与后续修改顺序 |
| [02-app.md](./02-app.md) | 组合根、资源所有权与关闭顺序 |
| [03-agent.md](./03-agent.md) | 类型、输出合同、权限、context 与 prompt 注入 |
| [04-session.md](./04-session.md) | SessionLoop、Metacog、GlobalSupervisor 与持久协调状态 |
| [05-worker-core.md](./05-worker-core.md) | WorkerPool、driver 映射、全局 permit 与外部 session id |
| [08-graph.md](./08-graph.md) | Graph、SQLite、FederatedGraph 与 FederationBus |
| [09-config.md](./09-config.md) | 第一版正式配置模型 |
| [10-server.md](./10-server.md) | 统一 session POST REST 与 Dashboard |

其余 `01`、`06`、`07`、`13`、`14` 分册分别记录入口、backend、provider 与验收案例。

## 当前架构结论

```text
SessionRuntimeFactory
  ├─ GlobalSupervisor + GlobalResourceGovernor + FederationBus
  ├─ one HttpServer
  └─ AgentRuntime(session) × N
       ├─ one Graph / one Project
       ├─ one SessionLoop / planner controller
       ├─ one MetacogSupervisor
       └─ short-lived Explorer/Evaluator SubagentRuns
```

- Graph 是 session 内唯一真相源；角色状态、lease、事件游标、单次 Run 的 worker session id 与 outbox 都持久化。
- Intent 是由 `intent_sets` 记录有序输入 Fact 集合的有向超边；Fact 状态为 `candidate/pass/deny/pending`。
- planner 显式创建 Intent 并决定是否派发 Explorer；Evaluator 是 candidate Fact 和跨 session broadcast 的验证门；Metacog 在 Fact 接受和最终审查时纠偏并通过 outbox 广播。
- 未显式配置 `federation.scope` 的 session 默认使用自身 session id，互不组成 TaskGroup；只有相同 scope 的关联 session 共享完成屏障。
- 角色 prompt 固定经过 `ServerSessionGraphReader → GraphContextSnapshot JSON → PromptBuilder(file reference) → output JSON`；角色不持有数据库对象，Run 保存输入/输出 artifact 与 prompt hash。

## 本轮审计已修复

1. `AgentRuntime.close()` 改为可等待的单向 shutdown：先从 supervisor 注销，再 abort/join SessionLoop 与 Metacog，停止 HTTP，最后关闭 Graph。
2. HTTP `start()` 正确 reject 端口占用和重复启动；`stop()` 主动关闭连接并复位状态；所有 `/api` 路由统一为 POST。
3. HTTP session binding 只依赖 session Graph，不再反向依赖 SessionLoop 或角色实现；server 从持久 TaskConfig 的 `profile.context` 生成职责范围 JSON，只有 metacog 拥有显式 `get_graph`。
4. Federation 注册由 SessionLoop 记录唯一 binding，重复注册幂等；Metacog 不再直接注册 bus；GlobalSupervisor 注册失败会回滚 membership。
5. standalone federation runtime 使用稳定 supervisor，不再在每次 `run()` 临时注册且遗留幽灵 session。
6. broadcast evaluator 重复失败达到 profile retry 上限后显式失败 session，避免 delivery 永久 `failed → retry` 的活锁。
7. 删除跨 Run worker session reuse、delta ContextCheckpoint、ContextLedger、WorkerSessionManager 和 fact tiering；每次角色调用只使用可独立审计的完整 snapshot artifact。
8. 删除第一版不使用的配置/协议面：`workflow`、`federation.group/enabled`、`control.metacogIntervalSeconds`、`CONTRACTS` 注册表、`NullWorkerPool`、`expectedPayload`、`supportsConclude`、`partialOutput` 和 `app/version.ts`。
9. WorkerRequest 现在要求 `workerName + role + projectId + cwd`，不再把缺失角色默认为 explorer；全局并发只接受正整数或 `Infinity`。
10. Graph/Federation SQLite 仅接受各自 `application_id + user_version=1` 的第一版正式 schema，不包含迁移、回填、双写或旧路由兼容。
11. supervisor 模式的 idle `run()` 由 runtime close signal 中断，关闭后所有启动/执行入口快速失败。
12. 持久 AgentRuntime 必须在构造前绑定唯一 session，拒绝 task/options 身份冲突，避免 Project 与 DB 目录分裂。
13. agent/task 名称拒绝路径成分，不能逃出 `PEAK_HOME`；providers 配置损坏或字段非法时 fail-fast。

## 仍需优先处理

1. 对 SQLite 每个事务提交点、outbox publish/delivery/ack、artifact 写入/rename/hash 做系统故障注入，而不只覆盖代表性 crash/reopen。
2. 常驻 daemon 从 `PEAK_HOME/sessions` 恢复 runtime registry、统一 HTTP 与 TaskGroup 所有权；当前 factory 只管理本进程创建的 runtime。
3. Linux/macOS CI 实测进程组 TERM→KILL、descendant 清理与文件锁行为；当前自动回归以 Windows 为主。
4. `worker-runtime.ts` 与 `worker/base.ts` 仍有两套同名 request/result 类型；它们分属 agent-facing 与 driver-internal 边界，后续应重命名而不是继续增加映射字段。
5. Codex/Claude 的危险权限开关仍是安全产品决策；领域 prompt/Graph 文本可能是不可信输入。

## 验证基线

- 源码：61 个 TypeScript 文件，45 个 `*.test.ts` 文件。
- `npm run typecheck`、`npm test`、`npm run smoke`、`npm run pack` 是交付门槛。
- 当前结果：393/393 测试通过；npm 包 SHA-256 为 `4b05d56074c87a88118939b93863f8db1be838249fa4aec5c13efd7ceedae549`。
- 本轮完整自动测试基线将在计划第 1.2 节持续更新；测试通过不能替代上述故障注入和跨平台证据。
