# AI 智能体安全看板（中文版）

本示例运行两个相互独立的领域项目：

1. **最新 AI 安全情报**：产出一份供工程与治理决策使用的当前情报简报。
2. **AI 智能体护栏设计**：为 HTTP 原生、可调用工具的智能体产出一份可实施的安全蓝图。

每个 Project 的 Goal 只声明最终结果。`board.skills` 安装并允许 `ai-agent-safety-zh` Skill，每个阶段的 Custom Profile 再通过 `customProfile.skills` 显式选择它。只有当前 Plan、Supervise 或 Execute profile 选中的 Skill 名称会进入对应 Worker Prompt；Finalize 继承已选 Execute profile。所选名称记录在本地 `graph-*.json` 的 `customProfile.skills` 下，快照不包含顶层 Skills 或 Worker 配置。

该 Skill 负责规定领域方法，包括证据选择、来源核验、事件分析、威胁与控制记录、质量门槛、文档结构和文件交付。Custom Profile 仅在当前工作涉及论文或标准、事件调查、威胁建模、控制设计或最终编辑时补充针对性指导。

领域配置不规定任务如何拆分，也不规定任务之间的依赖。Peak 根据 Goal 和可用上下文自行分析并组织工作。

## 预期交付物

- `ai-safety-intelligence-brief.md`
- `guardrail-blueprint.md`

中间工作通常只返回精简结果，不生成文件。最终交付时，Worker 按 Skill 要求返回完整 Markdown 正文、文件名和 `text/markdown` 媒体类型；Peak 负责存储内容并把文件物化到 `task.json` 同目录，Worker 不直接写文件。

## 运行

两个 Worker 均通过 Pi Agent SDK 使用 `deepseek-v4-flash`。先完成 Pi 鉴权，再执行：

```bash
npm run build
node examples/ai_agent_zh/run.mjs
```

脚本会在隔离目录中启动独立 Server、准备全部 Project ID 并运行 Dispatch，不修改仓库中的示例。后续运行复用隔离目录中已持久化的 UUID。
