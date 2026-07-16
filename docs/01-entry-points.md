# 入口与公共 API

> 当前实现审计，2026-07-16。本文只描述第一版正式入口。

## CLI

`src/cli.ts` 是薄组合入口，正式命令为：

| 命令 | 作用 |
|---|---|
| `run <configPath>` | 加载 task config，创建/重开 session Graph，组合 `AgentRuntime` 并运行 |
| `resume <session>` | 从持久 Project 的 `taskConfig` 重建同一组合根并继续 |
| `status <session>` | 读取本地 Graph 状态与 progress |
| `workers` | 输出可用 backend/provider 能力 |
| `sessions` | 列出本地 session |
| `search <query>` | 通过只读 `FederatedGraph` 搜索多个 session |
| `init [dir]` | 生成第一版 task config |
| `agents` / `tasks` | 列出 `PEAK_HOME` 下的配置条目 |

`run` 和 `resume` 都通过 `AgentRuntime` 创建 `SessionLoop`、planner controller、MetacogSupervisor 和 Graph；不再维护一条独立的恢复调度路径。session 状态目录与 task/workspace 目录分离，task config 的绝对路径写入 Project，prompt 相对路径在加载配置时解析。

单 CLI 进程可选用持久 `FederationBus`。多 session 服务应使用 `SessionRuntimeFactory`，由它持有一个 `GlobalSupervisor` 和一个统一 `HttpServer`。

## SDK barrel

`src/index.ts` 按边界导出：

- Graph 接口、InMemory/SQLite 实现、FederatedGraph 与 FederationBus；
- config、PromptLoader、PromptBuilder 和 builtin prompt；
- WorkerPool、AgentDriverPool、MockWorker 与资源治理；
- contract、permission、context artifact 与 Subagent runner；
- SessionLoop、MetacogSupervisor、GlobalSupervisor；
- AgentRuntime 与 SessionRuntimeFactory。

公共 API 不导出已删除的注册表、迁移器或占位 runtime。两个同名 `WorkerRequest/WorkerResult` 仍分别存在于 agent-facing 与 driver-internal 边界，后续应重命名以减少误用，但不应把两层合同合并。

## 进程与资源所有权

```text
CLI / SDK caller
  -> AgentRuntime or SessionRuntimeFactory
      -> SessionLoop / Metacog / HTTP
      -> Graph
      -> optional external Supervisor/FederationBus
```

- `AgentRuntime.close()` 是幂等、单向、可等待的终态操作。
- runtime 自建的资源由 runtime 关闭；外部注入的 supervisor/bus 仍由调用方关闭。
- factory 只在自己创建 supervisor 时关闭其 FederationBus。
- 关闭开始后，runtime 的创建、执行、调度、prompt 注入和 HTTP 启动入口全部快速失败。

## 当前余项

1. 常驻 daemon 需要从 `PEAK_HOME/sessions` 恢复 factory registry 与统一 HTTP binding。
2. CLI 的版本号仍应最终从 `package.json` 单一读取。
3. HTTP 模式的进程级 SIGINT/SIGTERM 优雅退出还需形成自动测试。
