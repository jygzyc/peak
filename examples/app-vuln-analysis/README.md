# Android App 图分析案例

这是一个仅分析仓库内自带、明确授权的本地 fixture 的 App 案例。它验证 `peak` 的通用图协议，而不是把 Android 或漏洞枚举硬编码进运行时。

- `tasks/single-app.json`：一个 App、一个 session，独立验证入口、sink/impact 和本地组合链。
- `tasks/entrypoints.json` + `tasks/dataflow.json`：同一个 App 按入口/数据流拆成两个 session，用于验证分工、federation 和 crash/reopen；它不等同于“两个不同 App”。真正的双 App 案例位于 [`../two-app-vuln-analysis`](../two-app-vuln-analysis/)。

- `app-entrypoints`：分析 Manifest、deep link 与入口 guard，证明外部可达性和攻击者控制。
- `app-dataflow`：分析 `DeepLinkActivity`、WebView 与 JS bridge，证明敏感 token 的读取路径；缺少入口证据时先产生 `pending` Fact。
- 两个 session 属于 `app-vuln-demo` scope。Metacog 只广播已通过 evaluator 的 Fact；目标 session 的 evaluator 决定广播是否相关或满足 pending 条件。
- TaskGroup 只有在两个 planner 都创建 EndFact、完成 final metacog、delivery 清空且 cursor 到达稳定 head 后才结束。

任务配置位于 `tasks/`，角色领域材料分别位于 `knowledge/`、`rules/` 与 `skills/`。所有 prompt 组件都会进入 `PromptManifest` 并记录 SHA-256。

预期结论：`peakdemo://open?url=https://evil-example.com/payload` 可到达导出的 Activity；`endsWith("example.com")` 错误接受该攻击者域名；页面在启用 JavaScript 且挂载 `TokenBridge` 后加载，页面脚本可读取本地认证 token。

fixture 仅用于静态分析与协议验收，不包含真实应用、凭据或外部目标。
