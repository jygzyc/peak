# 10. Unified Session Server 与 Dashboard

> 当前实现审计，2026-07-16。Server 是 session-local Graph 的统一观测和控制边界，不是第二个状态源。

## 10.1 组成与所有权

- `SessionRuntimeFactory` 持有一个 `HttpServer`，所有 session runtime 向它注册 `{ sessionId, projectId, graph, taskGroupScope }`。
- `AgentRuntime` 独立使用 HTTP 时也必须先创建 Project，再向 server 注册 session；`HttpServer` 不接受单 Graph 构造回退。
- `GlobalSupervisor` 持有共享 `FederationBus`，server 通过它提供 TaskGroup generation、成员状态、broadcast head/cursor 与 pending delivery 只读视图。
- 每个 Graph 仍然只属于一个 session；server 聚合响应，不合并不同 session 的 Fact/Intent。
- 注册时验证 Project 属于该 session。Server 不依赖 SessionLoop 或任何角色实现；profile 权限来自 Project 中持久化的 TaskConfig，控制指令先写入 Graph，由 SessionLoop 消费。

## 10.2 正式 API

| 方法 | 路径 | 含义 |
|---|---|---|
| POST | `/api/sessions` | session、project、状态与 TaskGroup 摘要 |
| POST | `/api/sessions/:sessionId` | Project、Fact、Intent、EndFact、Hint、Directive、Run 与 progress |
| POST | `/api/sessions/:sessionId/graph/snapshot` | 按 profile 权限、view/throughSeq 读取一致性 Graph snapshot |
| POST | `/api/sessions/:sessionId/facts` | 当前 session 的 Facts |
| POST | `/api/sessions/:sessionId/intents` | 当前 session 的 Intents；parent 顺序来自 `intent_sets.ordinal` |
| POST | `/api/sessions/:sessionId/end-facts` | 当前和 superseded EndFacts |
| POST | `/api/sessions/:sessionId/runs` | 可按 status/profile 过滤的 SubagentRuns |
| POST | `/api/sessions/:sessionId/events` | 按 event seq 增量读取事件 |
| POST | `/api/sessions/:sessionId/directives` | 注入可审计控制指令 |
| POST | `/api/task-groups` | TaskGroup 列表 |
| POST | `/api/task-groups/:scope` | generation、成员、cursor/head 与 delivery 状态 |

所有 `/api` 接口统一使用 POST；只有 Dashboard HTML 本身通过 `GET /` 获取。不存在 SSE、基于 project id 的平行路由或请求失败后转读另一种状态格式的分支。

## 10.3 Graph context 请求链

角色执行前的动态上下文路径固定为：

```text
HttpSessionGraphReader (HTTP) / ServerSessionGraphReader (embedded server)
  -> POST snapshot(sessionId, profileId, projectId, throughSeq)
  -> GraphContextSnapshot(contentHash)
  -> immutable graph-context-<seq>-<contentHash>.json
  -> PromptBuilder(file reference + assignment + output-contract)
  -> validated role output.json
  -> permission-checked Graph commit + SubagentRun provenance
```

Server 根据 session 中的真实 `profile.context` 生成角色所需视图，不接受客户端自报 view。只有 metacog 的显式能力包含 `get_graph`；其他角色读取的是 server 主动生成的职责范围 JSON，而不是 Graph API。两种 reader 使用同一 snapshot 编码。输入和输出 artifact 都以标准 JSON 写入 session 目录；Run 保存 graph seq、输入/输出 artifact hash、PromptManifest、最终 prompt hash 与 backend session id。

## 10.4 安全边界

- 默认只绑定 `127.0.0.1`。
- 非 loopback 绑定必须配置 token。
- 控制端点在配置 token 后要求 Bearer 或 `x-peak-token`，使用定时安全比较。
- request body 上限 1 MiB。
- Dashboard 响应带 CSP 与 `nosniff`。
- Graph/模型文本通过 `esc` 写入 DOM，动态 CSS class 通过 `safeClass` 收敛。
- Dashboard 通过 POST 周期刷新 session、Graph 和 event read model。

## 10.5 当前余项

1. 常驻 server 启动时扫描持久 session 目录并重建 runtime registry。
2. 对 snapshot 截断、artifact rename/hash、HTTP 中断等提交点做表驱动故障注入。
3. 在 Dashboard 增加 owner/epoch、PromptManifest 组件 hash 与 terminal reason 的细粒度运维视图。

`start()` 会拒绝重复启动和端口占用，并在失败后复位为可再次启动状态；`stop()` 关闭 listener 和连接并复位 port/token。注销 session 只删除 server binding。

这些余项不改变正式 API 和 Graph 真相边界。
