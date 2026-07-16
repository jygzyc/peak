# 02 · 组合根与资源所有权（`src/app/`）

> 当前审计，2026-07-16。`src/app/` 只有 `agent-runtime.ts` 与 `session-runtime-factory.ts`；未使用的 `version.ts` 已删除。

## AgentRuntime

一个 `AgentRuntime` 绑定一个 session、一个持久化 SQLite Graph、一个 Project、一个 SessionLoop 和可选的 session-local Metacog/HTTP adapter。构造前必须确定 session，不存在内存或临时数据库回退。

构造只完成装配；`createProject()` 建立 Project、HTTP binding 和 supervisor registration。显式传入 `GlobalSupervisor` 时复用其 bus/governor；只传 `FederationBus` 时创建稳定的 runtime-local supervisor。`run()` 不再创建临时 supervisor。

未配置 `federation.scope` 时，scope 在 `createProject(session)` 时确定为 session id，因此两个无关联 session 不会落入共同的 `default` TaskGroup。

### 关闭时序

`close(): Promise<void>` 是幂等终态：

```text
unregister from GlobalSupervisor
  -> unregister session HTTP binding
  -> SessionLoop.close(): abort + join planner/explorer/evaluator/metacog
  -> HttpServer.stop(): close streams/connections/listener
  -> Graph.close()
```

Graph 接口正式声明可选 `close()`，不再用鸭子类型探测。关闭信号会中断 supervisor 模式的 idle `run()`；关闭开始后 create/step/run/tick/metacog/directive/HTTP start 均快速失败。

持久 runtime 在构造前必须绑定唯一 session。`task.session` 与 `options.sessionId` 冲突会直接拒绝，不会先打开默认 DB 再创建另一个 session 的 Project。

## SessionRuntimeFactory

Factory 是多 session 生产组合根：共享一个 GlobalSupervisor、GlobalResourceGovernor、FederationBus 和可选 HttpServer，每次 `create()` 异步返回一个完整注册的 `AgentRuntime`。

- `closeSession(id)`：从统一 HTTP registry 移除该 session，再等待 runtime 完整关闭。
- `close()`：终态关闭 HTTP、并行关闭所有 runtime；仅当 supervisor 由 factory 自己创建时，最后关闭其 FederationBus。
- 构造失败会等待 runtime cleanup 后再抛错，不保留 fire-and-forget 关闭任务。

## 当前风险

1. Factory 不是 daemon：进程重启后不会自动扫描磁盘并重建 registry。
2. `createProject()` 的 Graph 写入早于部分外部注册；factory 会清理资源，但 SQLite 中已创建的 Project 是可恢复状态，不是事务性“撤销创建”。常驻服务需明确 create-session 的幂等请求 id 与恢复响应。
3. 外部传入 supervisor/bus 的生命周期仍由调用方负责，factory 只注销自己创建的 session。
