# Peak 文档 / Peak Documentation

Peak 是基于分布式证明图（proof Graph）的通用 Agent 运行时：每个 Project 是独立 Graph 分片，Project 之间通过 `FactRef` 组成证明链；HTTP API 是 Graph 的唯一读写接口。

Peak is an HTTP-native distributed Graph agent runtime: each Project is an independent Graph shard; Projects compose proofs through `FactRef` hyperlink nodes; the HTTP API is the only live Graph protocol.

## 用户指南 / User guides

| 文档 | 内容 |
| --- | --- |
| [usage_zh.md](usage_zh.md) | **使用指南（中文）**：快速开始、一键真实运行、Board 配置、CLI 参考、Web UI、示例 |
| [usage.md](usage.md) | **Usage guide (English)**: quick start, one-click run, Board configuration, CLI reference, Web UI, examples |

## 参考与贡献者 / Reference & contributor

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | **架构说明**：总体架构、模块职责、Graph 模型概念、Runtime 阶段设计、调度、Worker、Federation、CLI 生命周期、Web UI、安全与一致性原则 |
| [data-flow.md](data-flow.md) | **数据流说明**：数据模型与不变量、持久化布局、HTTP API、任务协议 JSON 合同、调度/Worker 接口、Board 配置 schema、各操作端到端数据流 |
| [completed-project-certified-frontier-plan.md](completed-project-certified-frontier-plan.md) | **架构计划**：completed Project 发布已认证证明出口的规则、模块改动、Reopen 语义和测试计划 |
| [development_zh.md](development_zh.md) | **构建/测试/发布（中文）**：命令、版本同步、发布日志与 CI |
| [development.md](development.md) | **Build/test/release (English)**: commands, version sync, release notes, CI |

`architecture.md` 说明当前设计，`data-flow.md` 给出当前契约；带 `plan` 的文档明确描述尚未实施的架构变更。用户使用入口见 [../README.md](../README.md)。
