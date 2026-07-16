# Agent 协议层

> 当前实现审计，2026-07-16。核心源码只实现通用机制，领域行为由 profile、prompt、rules、knowledge 和 skills 提供。

## 固定角色与能力上限

| 角色 | 启动依据 | 输出合同 | 能力上限 |
|---|---|---|---|
| planner | 初始规划、Graph 变化、hint/directive、verdict、结束复核 | `main_decision` | 创建/失败 Intent、处理 Hint、启停 Explorer、提出 EndFact |
| explorer | planner 显式派发且成功 claim 的 Intent | `candidate_fact` | 处理 Intent、写 candidate Fact |
| evaluator | candidate Fact 或跨 session broadcast | `verdict` / `broadcast_assessment` | 改变 Fact、评估广播 |
| metacog | pass Fact、步数/时间/停滞 trigger、最终审查 | `hints` / `stop` | 写 Hint、读取 Graph、发送 Fact broadcast |

Profile 可以缩小权限、替换 worker/model/prompt/context 策略，但不能换成第五种协议角色，也不能扩大对应角色的 capability 上限。`PermissionChecker` 在图变更前执行检查，contract validator 在图写入前验证 envelope 形状。

## Prompt 注入链

```text
PromptLoader
  -> builtin or resolved external instructions/rules/knowledge/skills
SessionGraphReader
  -> consistent GraphContextSnapshot(graphSeq + contentHash)
materializeGraphContext
  -> immutable graph-context-<seq>-<contentHash>.json under session/artifacts/prompts/<runId>/
PromptBuilder
  -> static prompt + graph context + assignment + output contract
SubagentRun
  -> PromptManifest + prompt/artifact hashes + backend session id
```

Graph 只在 server 侧读取并编码为规范 snapshot JSON。角色 prompt 只包含 JSON 文件引用，不内联 Graph 内容，也不获得 Graph/SQLite 对象。artifact 使用独占中间文件、`sync`、原子 rename 和 SHA-256 复核。

## 输出与图写入

- `parseEnvelope` 只负责提取结构化 JSON envelope。
- 合同验证成功的角色输出先写入 `session/artifacts/roles/<runId>/output.json` 并记录 hash；控制面随后才可提交 Graph。
- `contracts.ts` 只保留被生产路径直接调用的 validator，没有并行注册表。
- planner 输出交给 `DecisionApplier`，所有动作经 permission 与 Graph 原子 API。
- Explorer/Evaluator/Metacog 结果通过带 owner/attempt/leaseEpoch 的 fenced commit 写回；过期 worker 的结果被丢弃。
- planner 显式返回空 `consumeHintIds` 表示本轮不消费，不存在隐式消费全部 Hint 的分支。

## Context 与 worker session

第一版每次角色调用都读取完整的规范 Graph snapshot，不维护跨 Run 的 delta checkpoint，也不复用旧 worker session。这样 artifact 自包含、hash 可独立校验，不会把正确性建立在外部会话仍保留隐式上下文之上。backend 返回的 session id 只作为本次 Run 的审计信息；explorer 的 conclude 兜底可在同一次调用内继续该会话。

`maxFacts` 和四种 `graphView` 直接限制可见内容；没有额外 fact tier、摘要缓存或 context rotation 状态机。

## 状态边界

- Intent：`open -> claimed -> pass | deny`。
- Fact：`candidate -> pass | deny | pending`；pending 只表示已评估但条件未齐。
- Run：`pending -> running -> completed | failed | cancelled`，并带 lease/fencing 身份。
- Project：只有 active 才允许角色提交；planner EndFact 是 session 结束提议，不等同 TaskGroup 已完成。

## 当前余项

1. 对每个角色的 spawn 前、执行中、commit 前做逐点 kill/reopen 故障矩阵。
2. 将两层同名 Worker request/result 类型改成不同名称。
3. 扩充不可信 prompt/Graph 内容的越权和注入测试。
