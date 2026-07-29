# AI 智能体安全看板（中文版）

本示例与 `ai_agent_safety` 结构完全一致，仅内容为中文，包含两个相关但互不重叠的项目：

1. **最新 AI 安全情报**：收集并分析当前 AI 安全研究、事件、标准、政策与工程实践，产出带来源的摘要。
2. **AI 智能体护栏设计**：产出可落地的 AI 智能体护栏建设方案。

两个项目互不声明依赖，也不规定复用哪些结果。看板自身没有 Goal 或 Graph，每个项目有独立的 UUID Graph 与完成条件。运行时仅把符合条件的跨项目证据作为候选 `FactRef` 超链接节点暴露；每个节点包含 `projectId`、`factId` 和不可变的 Fact `description`，是否采用由 AI 依据当前项目 Goal 自行判断。源 Fact 实体与 Artifact 始终留在各自的项目分片里。

项目 `id` 初始为空。首次 `peak run` 时，Peak 创建每个项目并把 UUID 原子写回 `task.json`；后续运行按 UUID 接入并复用已有 Graph。另一个看板可引用相同 UUID 以复用同一项目，但同一活跃项目不得被多个运行时进程并发调度。

本示例的 worker 路由（与英文版一致，所选模型均支持中文）：

- Pi + `zai-coding-cn/glm-5.2` 负责 Plan 与 Supervise；
- Codex（`model` 留空）作为低优先级的 Plan 兜底，使用其默认模型；
- OpenCode + `minimax/MiniMax-M3` 负责 Execute。

```bash
npm run build
node dist/cli.js run examples/ai_agent_safety_zh
```

运行前请先完成所用 Agent 工具的鉴权。项目状态存储在 `PEAK_HOME/projects/<uuid>/`。
