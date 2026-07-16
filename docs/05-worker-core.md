# 05 · Worker 核心边界（`src/worker/`）

> 当前审计，2026-07-16。Worker adapter 只负责“prompt in、structured text/process result out”，不拥有 Graph 或调度策略。

## 两层合同

`worker-runtime.ts` 是 agent-facing `WorkerPool`：

- WorkerRequest 必须包含 `prompt/config/workerName/role/projectId/cwd`；可带 sessionId、conclude、signal。
- WorkerResult 返回 text、returncode、stderr、sessionId、timedOut、aborted。
- 缺少角色 provenance 的请求会被 AgentDriverPool 拒绝，不再默认为 explorer 或伪造 project/cwd。

`worker/base.ts` 是 driver-internal 合同，字段名为 worker/sessionDir/stdout。AgentDriverPool 明确映射两层字段。两套类型职责不同但同名容易误导，后续应重命名为 `PoolWorkerRequest` 与 `DriverRequest`；不应合并成一个同时服务两层的大接口。

## 选择与全局配额

- `selectProfileWorker` 调 WorkerPool.pickWorker；AgentDriverPool 优先未运行 worker，并对候选做 round-robin。
- AgentDriverPool 在 execute 前后维护 per-project running 集合，finally 保证错误时清理。
- GlobalResourceGovernor 包装 WorkerPool.execute，以 FIFO permit 限制实际外部调用；quota 只接受正整数或 Infinity，排队请求 abort 后立即从队列移除。

## 外部 worker session

每次 Agent 调用都收到完整 Graph artifact，不跨调用 resume 外部 worker session。backend 返回的 session id 会写入 `agents/<agentId>/record.json`；只有同一次 explorer 调用的 conclude 兜底会把该 id 传回 backend。第一版没有 session cache、delta checkpoint 或 rotation manager。

## 已删除的死协议

`NullWorkerPool`、WorkerRequest.expectedPayload、AgentBackend.supportsConclude、BackendInvokeInput.partialOutput 均无生产语义，第一版不保留。`timedOut` 与 `aborted` 已端到端透传，因此保留。

## 余项

1. 对每个 backend 做真实 resume/invalid-session/rotation 集成测试；当前已有 OpenCode 真实任务与结构化输出测试，Claude/Codex 仍主要是 adapter 测试。
2. Linux/macOS 验证进程组和 descendant 清理。
3. 明文 apiKey 配置与 Codex/Claude bypass 权限开关仍需安全策略收口。
