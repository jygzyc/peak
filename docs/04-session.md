# 04 · Session 时序与调度（`src/session/`）

> 当前审计，2026-07-16。目录包含 `session-loop.ts`、`session-coordinator.ts`、`metacog-supervisor.ts`、`supervisor.ts`、`session-manager.ts`。旧的 ProjectLockManager 已删除。

## 单 session 主循环

每个 step 的确定顺序为：

```text
sweep leases
  -> consume directives
  -> publish local metacog outbox
  -> evaluate pending sibling broadcasts
  -> planner (when graph events require planning)
  -> explorer runs for explicitly dispatched open Intents
  -> evaluator runs for candidate Facts
  -> metacog review
  -> publish resulting outbox
  -> local/TaskGroup completion check
```

角色不直接互发消息。planner verdict inbox、失败次数、cooldown 和 broadcast wake 均由 Graph events 经 `SessionCoordinator` 重建；进程内只有 in-flight Promise、AbortController、heartbeat timer 和 context/session cache。

## 并发与排他

- `inFlightSteps` 合并同 Project 的进程内重入，不在 worker I/O 期间持 mutex。
- Intent claim 与 SubagentRun claim 都有持久 `ownerId/epoch/attempt/leaseExpiresAt`；heartbeat 丢失后旧 owner 不能提交。
- Explorer/Evaluator/Planner/Metacog 的结果提交由 Graph transaction + fencing token 保护。
- GlobalResourceGovernor 在 WorkerPool.execute 边界发 FIFO permit，限制实际 worker 调用，而非只限制 session tick。
- stop/pause/kill 会先改变持久状态、撤销 run/intent lease，再 abort 本地 worker；远端 coordinator 在 heartbeat 时发现 epoch/status 变化。

未发现两个互斥锁形成环路的传统死锁，因为核心路径不再持有项目锁等待外部 I/O。活性风险主要来自外部 WorkerPool 不遵守 AbortSignal；正式 backend 已传播 signal 并终止进程树，第三方 WorkerPool 必须遵守同一合同。

## 失败与活锁边界

- planner、explorer、candidate evaluator 和 broadcast evaluator 都使用持久事件计数与 profile retry 上限；达到上限后 Project 显式进入 `failed`。
- broadcast delivery 的单次失败标记为 `failed` 并可重试；达到 evaluator 上限后 session 失败，不会永久占住 TaskGroup 而继续空转。
- planner 空图轮询受 cooldown 限制；任何新 verdict、可执行 hint 或 relevant broadcast 都绕过 cooldown。
- TaskGroup 结束要求所有成员 finish-ready、无 pending/failed delivery、cursor 到同一 head，并以 generation CAS 原子提交。

## Federation 注册所有权

SessionLoop 保存当前 `{bus, sessionId, scope, projectId}` binding：相同 binding 不重复写；project id 从未知变为已知时只做一次更新；换 bus/session 会注销旧 membership。Metacog 只保存广播 source 元数据，不直接注册 FederationBus。

GlobalSupervisor 注册失败（例如 loop 已绑定另一个 governor）会回滚刚写入的 membership；unregister 通过 SessionLoop 清理 binding。未声明 scope 的 runtime 使用 session id 自隔离。

## 关闭

`SessionLoop.close()` 设置永久 closed 状态，abort 所有 active executions，等待所有 in-flight step 与 Metacog close，然后清理 federation binding。重复 close 返回同一个 Promise。Metacog close 会停止 timer、abort active worker 并等待所有 in-flight project。

## 余项

1. 多进程全局 permit 仍需数据库或外部协调器；当前 governor 只覆盖一个 Node 进程。
2. 逐提交点 kill/restart 矩阵仍需扩展到四角色和 outbox/delivery 的每个事务边界。
3. 大量 sibling broadcast 当前按 session 顺序评估；需要性能数据后再决定是否引入有界并行，不能牺牲 cursor 顺序。
