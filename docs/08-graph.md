# Graph 与 Federation

> 当前实现审计，2026-07-16。Graph 是 session 内唯一可写真相源；跨 session 只交换摘要和引用。

## Session-local Graph

每个 session 只使用落盘的 `SqliteGraph`，数据库固定在 session 状态目录；源码没有 `:memory:`、临时数据库或第二套 Graph 实现。Graph 保存 Project、Fact、Intent、`intent_sets`、Hint、Directive、EndFact、Event、dead-end、role coordinator cursor 和 federation outbox。跨 session 的 FederationBus 同样使用持久化 `federation.db`。

单次 Agent 调用不是分析图数据：活动 controller、取消和并发只存在于运行时内存；输入、输出和审计状态写入 `sessions/<session>/agents/<agentId>/` 的标准 JSON 文件。

一个 runtime 只允许一个 session/task/Project。Intent 的全部 parent Fact 只以 `intent_sets(project_id, intent_id, fact_id, ordinal)` 保存和读取，创建 Intent 与写入 parent 集合在同一事务中完成；不存在 JSON 镜像或第二套来源字段。

### 状态机

```text
Intent: open -> claimed -> pass | deny
Fact:   candidate -> pass | deny | pending
Project: active -> completed | stopped | failed | paused
```

关键角色结果通过 Graph 的原子方法提交：

- planner decision 与 intent dispatch request；
- Explorer candidate Fact + Intent terminal；
- Evaluator verdict + Fact terminal；
- Metacog hints/outbox；
- Intent 的 owner/attempt/leaseEpoch/heartbeat claim、renew 与 fenced commit。

SQLite 使用 WAL 和事务；Graph DB 只接受正式 `application_id + user_version=1`。文件已有用户表但标识不匹配时，在建表前拒绝打开。源码没有 schema migration、回填、双写或旧状态改写。

## Event 与恢复

Event seq 是 planner/evaluator/metacog 唤醒的持久游标。恢复时 coordinator 从 Graph 重建 verdict cursor、broadcast wake、retry/backoff 与 cooldown；未完成的进程内 Agent 调用不会被误当成 Graph 状态恢复。

Graph close 是显式生命周期的一部分。runtime 先 abort/join 角色执行，再关闭 Graph，避免 worker 在 SQLite 关闭后提交。

## 跨 session

`FederatedGraph` 只读打开多个 session DB，用于检索通过的 Fact、Intent 和 Event，不提供跨 session 写操作。

`FederationBus` 使用独立 SQLite 数据库，保存：

- TaskGroup generation 与 `expected/active/left/completed` 成员；
- insight/broadcast head；
- 每目标 session 的 delivery 状态与 cursor；
- session finish-ready 和 group completion CAS。

广播只能成为目标 session Evaluator 的输入，不能直接写成本地 pass Fact。`condition_satisfied` 只可引用已有 pending Fact。失败 delivery 受 profile retry 上限约束，耗尽后 session 显式失败，避免永久重试活锁。

未配置 `federation.scope` 时 scope 等于 session id，因此无关 session 不共享 TaskGroup。只有显式相同 scope 的 session 才进入同一完成屏障。

## TaskGroup 完成条件

完成必须同时满足：

1. 当前 generation 的预期成员均已注册并达到 finish-ready；
2. final metacog/outbox 已持久化；
3. 无 pending 或 failed delivery；
4. 每个成员 cursor 到达同一稳定 head；
5. `tryCompleteScope(scope, generation)` 的事务前后检查仍成立。

planner 的 EndFact 只是单 session 结束提议，不能绕过上述屏障。

## 当前余项

1. 对每个 SQL 写点做全有/全无故障注入矩阵。
2. 常驻 daemon 恢复 TaskGroup 到 runtime registry 的所有权映射。
3. 多进程部署需要外部或数据库级全局 resource permit。
