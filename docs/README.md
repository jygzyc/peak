# Peak 文档 / Peak Documentation

Peak 是基于分布式证明图（proof Graph）的通用 Agent 运行时：每个 Project 是独立 Graph 分片，Project 之间通过 `FactRef` 组成证明链；HTTP API 是 Graph 的唯一读写接口。

Peak is an HTTP-native distributed Graph agent runtime: each Project is an independent Graph shard; Projects compose proofs through `FactRef` hyperlink nodes; the HTTP API is the only live Graph protocol.

文档按语言分目录存放：中文在 [`zh/`](zh/)，英文在 [`en/`](en/)。按内容分为三类：**开发与用法、架构、数据流**。

Docs are organized by language: Chinese in [`zh/`](zh/), English in [`en/`](en/), and by three content categories: **Development & Usage, Architecture, Data Flow**.

## 1. 开发与用法 / Development & Usage

| 语言 | 文档 | 内容 |
| --- | --- | --- |
| 中文 | [zh/usage.md](zh/usage.md) | 使用指南：快速开始、一键真实运行、Board 配置、CLI 参考、Web UI、示例 |
| 中文 | [zh/development.md](zh/development.md) | 构建/测试/发布：命令、版本同步、发布日志与 CI |
| English | [en/usage.md](en/usage.md) | Usage guide: quick start, one-click run, Board configuration, CLI reference, Web UI, examples |
| English | [en/development.md](en/development.md) | Build/test/release: commands, version sync, release notes, CI |

## 2. 架构 / Architecture

| 语言 | 文档 | 内容 |
| --- | --- | --- |
| 中文 | [zh/architecture.md](zh/architecture.md) | 核心架构：设计目标、模块职责、Graph 模型、Runtime 阶段、调度、Worker、Federation、CLI、Web UI、安全与一致性 |
| 中文 | [zh/federation-path-broadcast-plan.md](zh/federation-path-broadcast-plan.md) | Federation 设计（已实施）：leaf + path_abs 广播、持久投递、Plan 外部视图 |
| 中文 | [zh/docker-parallel.md](zh/docker-parallel.md) | Docker 并行化方案（已落地）：per-task 容器、外部图模式、镜像与凭据、task 管理界面 |
| 中文 | [zh/completed-project-certified-frontier-plan.md](zh/completed-project-certified-frontier-plan.md) | 架构计划（尚未实施）：completed Project 发布已认证证明出口的规则与模块改动 |

## 3. 数据流 / Data Flow

| 语言 | 文档 | 内容 |
| --- | --- | --- |
| 中文 | [zh/data-flow.md](zh/data-flow.md) | 数据模型与不变量、持久化布局、HTTP API、任务协议 JSON 合同、调度/Worker 接口、Board 配置 schema、各操作端到端数据流 |

`zh/architecture.md` 说明当前设计，`zh/data-flow.md` 给出当前契约；带 `plan` 的文档明确描述尚未实施的架构变更。用户使用入口见 [../README.md](../README.md)。
