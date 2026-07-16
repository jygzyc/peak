# 已归档：Cairn 参考设计计划

这份计划已由 [target.md](./target.md) 的第一版目标取代，不再作为实现依据。旧计划把单次角色执行建模为 Graph 中的 `SubagentRun`，混淆了分析状态与运行控制，因此已删除其详细 schema、lease 和迁移方案。

当前边界只有三层：

1. Graph 持久化 session 的分析语义：Fact、Intent、Hint、Directive、EndFact、Event、dead-end、coordinator cursor 和 federation outbox。
2. SessionLoop 与 MetacogSupervisor 在内存中持有活动调用、AbortController、并发计数；只有 Intent claim 需要持久 lease 和 fencing。
3. BaseAgent 将每次调用的 `context.json`、`output.json`、`record.json` 写到 `sessions/<session>/agents/<agentId>/`，用于审计但不参与 Graph 状态流转。

跨 session 的 FederationBus 继续使用独立持久 SQLite，只传递摘要和引用，不允许跨 session Graph 写入。
