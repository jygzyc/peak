# 四类任务验收场景

> 日期：2026-07-15
> 目标：用四条独立端到端路径证明 `peak` 不只支持一种 App 案例，同时验证单 session、跨 session、深度分析和真实 workspace 实现。

## 1. 完成标准

| 场景 | 任务资产 | 自动验收 | 必须证明的结果 |
| --- | --- | --- | --- |
| 单 App 漏洞挖掘 | [`examples/app-vuln-analysis/tasks/single-app.json`](../examples/app-vuln-analysis/tasks/single-app.json) | [`single-app-vuln-acceptance.test.ts`](../tests/single-app-vuln-acceptance.test.ts) | 仅一个 session；入口与 sink/impact 分别验证；最终 HIGH Fact 由两个本地 pass parent 合成；EndFact、skill manifest 和静默屏障完成 |
| 两个 App、双 session 漏洞挖掘 | [`examples/two-app-vuln-analysis`](../examples/two-app-vuln-analysis/) | [`two-app-dual-session-vuln-acceptance.test.ts`](../tests/two-app-dual-session-vuln-acceptance.test.ts) | Sender/Receiver 是两个不同 workspace；Sender 敏感广播经 metacog/outbox/federation 到 Receiver evaluator；Receiver pending Fact 被条件补齐；外部 Fact 不复制为本地真相；两 session 到同一稳定 head 后完成 |
| idea 深入分析 | [`examples/idea-analysis`](../examples/idea-analysis/) | [`idea-analysis-acceptance.test.ts`](../tests/idea-analysis-acceptance.test.ts) | 问题/价值、技术可行性、隐私/交付风险独立成 Fact；三 parent synthesis Intent；最终建议包含边界、架构取舍和可证伪指标，而不是泛化脑暴 |
| 需求实现 | [`examples/requirement-implementation`](../examples/requirement-implementation/) | [`requirement-implementation-acceptance.test.ts`](../tests/requirement-implementation-acceptance.test.ts) | Explorer 的 cwd 是任务 workspace；真实文件被修改；Explorer 与 Evaluator 都执行产物；行为覆盖全部需求；原始 fixture 不被测试污染；通过后才创建 EndFact |

## 2. 场景边界

### 2.1 单 App 与双 App 不混算

原 [`13-app-vulnerability-federated-case.md`](./13-app-vulnerability-federated-case.md) 是“同一个 Android App 按入口/数据流拆成两个 session”，用于验证分工和恢复。新的双 App 场景包含两个独立 Manifest、包名、源码树和 workspace：

```text
app-sender
  private auth token -> unprotected implicit AUTH_TOKEN broadcast

               durable FactBroadcast
                         ↓ evaluator assessment

app-receiver
  exported receiver -> last_token -> WebView JavascriptInterface
```

Receiver 在 Sender 证据到达前只能把 sink Fact 置为 `pending`。广播只触发 `condition_satisfied`，不会在 Receiver Graph 中复制一个来源为 Sender 的 pass Fact。

### 2.2 idea 深入分析的深度判据

“深入”不是输出字数，而是图结构约束：

1. 问题/价值、可行性、风险必须由不同 Intent 独立分析；
2. evaluator 必须逐项验证它们是否引用输入 brief；
3. 综合建议必须用有序 `intent_sets` 引用三个 pass Fact；
4. EndFact 必须包含明确的 go/pivot/no-go、范围和可证伪指标。

当前 fixture 的结论是带约束的 GO：首期只做加密离线表单、幂等同步和人工冲突复核，推迟 AI omission detection；若 re-entry time 未改善 30% 或数据质量下降，则假设失败。

### 2.3 需求实现不能信任文本声明

验收把仓库 fixture 复制到临时目录，再让 Explorer callback 使用收到的 `request.cwd` 修改 `slug.mjs`。Explorer 写回 candidate Fact 前会加载并执行模块；Evaluator 再独立加载执行一次；测试结束前第三次验证行为，并确认仓库原始 fixture 仍是 `Not implemented`。因此以下情况不能通过：

- 只返回实现计划或代码块，没有改 workspace；
- 改错 session state 目录；
- Fact 声称测试通过，但产物不能执行；
- 只覆盖 happy path，遗漏 Unicode、空结果或非字符串输入。

## 3. 运行

聚焦四场景：

```powershell
npm run build
node --test tests/single-app-vuln-acceptance.test.ts tests/two-app-dual-session-vuln-acceptance.test.ts tests/idea-analysis-acceptance.test.ts tests/requirement-implementation-acceptance.test.ts
```

上述验收使用确定性的 MockWorker，但执行真实 SessionLoop、Graph、Evaluator、Metacog、FederationBus、TaskGroup barrier 和 workspace 文件 I/O。任务 JSON 本身配置 Codex backend，可在具备授权目标和本地 CLI 的环境中执行真实分析。App 场景仅用于仓库内授权静态 fixture，不安装 APK、不扫描外部目标、不执行利用。
