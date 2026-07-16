# Worker Backend

> 当前实现审计，2026-07-16。Backend 只负责“prompt 输入、进程/HTTP 调用、原始响应输出”，不拥有 Graph 或调度策略。

## 合同

`AgentBackend.invoke()` 接收 `prompt/config/cwd/conclude/sessionId/signal`，返回 `text/returncode/stderr/sessionId/timedOut/aborted`。结构化 CLI backend 必须实现严格的 `extractResponseText`；不能把日志、诊断或未知 JSON 当作模型结果。

第一版不存在未接线的 capability 标志或 partial-output 字段。conclude 是否启用由 profile 的 `prompt.concludeFile` 决定；session 能否复用由实际返回的 session id 决定。

## Subprocess 边界

`SubprocessBackend` 使用 Node `spawn`，默认：

- `shell: false`、隐藏 Windows 窗口；
- prompt 通过 stdin，避免命令行泄露、Windows 长度限制和 shell 字符解释；
- stdout/stderr 有上限；
- timeout 与 AbortSignal 都会终止子进程；
- POSIX 先 SIGTERM、宽限后 SIGKILL；Windows 直接调用 `taskkill /T /F` 清理进程树；
- `.cmd/.bat` 只通过受控 `cmd.exe /d /s /c` 包装，动态 prompt 不进入 argv。

Codex、Claude Code、OpenCode CLI 都解析各自声明的 JSON/NDJSON 事件格式并提取 session id。OpenCode HTTP 使用 HTTP body 与 AbortSignal；custom process backend 仍必须遵守统一返回合同。

## Session 连续性

上层把 backend session id 写入 SubagentRun 作为审计信息。跨 Run 不复用外部会话；只有同一次 explorer 调用的 conclude 兜底会继续首轮返回的 session id。

## 安全与稳定性结论

- 正式 backend 都传播 AbortSignal，runtime shutdown 可取消其 worker。
- driver 要求完整 `workerName/role/projectId/cwd`，不推断缺失角色。
- backend 的危险权限开关是明确的安全产品决策；不能把不可信 Graph 文本放入 shell argv。
- 第三方 WorkerPool 若忽略 AbortSignal 且永不 settle，安全关闭只能等待它，仍可能表现为阻塞。

## 当前余项

1. Linux/macOS CI 实测进程组及 descendant 的 TERM→KILL 行为。
2. 对 CLI 版本变化导致的 JSON event schema 漂移建立真实集成测试。
3. 评估 Codex/Claude 危险权限模式的可配置安全策略。
