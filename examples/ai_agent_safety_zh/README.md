# AI 智能体安全看板（中文版）

本示例与 `ai_agent_safety` 结构完全一致，仅内容为中文，包含两个相关但互不重叠的项目：

1. **最新 AI 安全情报**：产出一份精简的简报，严格包含五项带来源发现和三条跨领域趋势。
2. **AI 智能体护栏设计**：为 HTTP 原生、可调用工具的智能体产出一份统一实施蓝图，并包含一张验收标准表。

两个示例共同演示 Peak 的**深度优先规划**：每个证明长成**多层级 DAG**，而不是从 `origin` 一次铺开的单层树。Plan 必须让每个新 Intent 都从当前叶 Fact 出发，优先深化既有研究线（范围界定、证据采集、交叉核验、细化、汇总），而不是从 `origin` 开新分支。**深度不受限制**——一条线可以延伸到 Goal 所需任意层级；只有广度有界，避免示例无限铺开。

两个项目互不声明依赖，也不规定复用哪些结果。看板自身没有 Goal 或 Graph，每个项目有独立的 UUID Graph 与完成条件。运行时仅把符合条件的跨项目证据作为候选 `FactRef` 超链接节点暴露；每个节点包含 `projectId`、`factId` 和不可变的 Fact `description`，是否采用由 AI 依据当前项目 Goal 自行判断。源 Fact 实体与 Artifact 始终留在各自的项目分片里。

项目 `id` 初始为空。首次 `peak run` 时，Peak 创建每个项目并把 UUID 原子写回 `task.json`；后续运行按 UUID 接入并复用已有 Graph。另一个看板可引用相同 UUID 以复用同一项目，但同一活跃项目不得被多个运行时进程并发调度。

本示例同时演示 task 内按 phase 注入的可选 `customProfile`：

- 一个范围界定 profile 在采集证据前固定交付物契约与证据规则；
- 一个 profile 用于当前一手研究或标准证据；
- 一个 profile 用于具体事件分析；
- 一个 profile 用于可实施的护栏与控制设计；
- 一个汇总 profile 只合并现有叶 Fact 产出最终有界交付物；
- 唯一的 Supervise profile 仅审计会阻碍完成的证据缺陷。

每个 profile 的 `description` 用于告诉 Plan 何时应注入其 prompt；Plan 只在 Intent 上持久化所选 description 与其签名，Fact 不保存 profile。每次 Plan 都会看到 Source、Goal、完整的当前叶 Fact、全部 open Intent、未消费 Hint 和 pending 外部叶 FactRef，并优先深化最相关的当前叶再开新分支。

本示例的 worker 路由（与英文版一致，所选模型均支持中文）：

- 一个使用 `deepseek-v4-flash` 的 Pi worker 负责 Plan 与 Supervise；
- 第二个使用相同模型的 Pi worker 负责 Execute，最多并发执行四个任务。

统一使用一个已鉴权的后端，使示例更容易复现，同时仍会覆盖阶段路由、深度优先规划和 Execute 并发预留。

```bash
npm run build
node dist/cli.js run examples/ai_agent_safety_zh
```

运行前请先完成 Pi 鉴权。项目状态存储在 `PEAK_HOME/projects/<uuid>/`。Worker 不被分配 workspace、不写任何文件：当 Fact 需要详细证据时，Execute 合同内联返回文件内容，Runtime 将其作为内容寻址 Artifact 存入 Project 分片的 `artifacts/` 目录。完成时，Runtime 把带内容化 `filename` 的汇总 Artifact（例如 `ai-safety-intelligence-brief.md` 或 `guardrail-blueprint.md`）物化到 `task.json` 同目录——这些就是预期最终交付物。
