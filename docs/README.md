# Peak 文档

Peak 是基于分布式证明图（proof Graph）的通用 Agent 运行时：每个 Project 是独立 Graph 分片，Project 之间通过 `FactRef` 组成证明链；HTTP API 是 Graph 的唯一读写接口。文档只保留两个部分：

## 文档

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | **架构说明**：总体架构、模块职责、Graph 模型概念、Runtime 阶段设计、调度、Worker、Federation、CLI 生命周期、Web UI、安全与一致性原则 |
| [data-flow.md](data-flow.md) | **数据流说明**：数据模型与不变量、持久化布局、HTTP API、任务协议 JSON 合同、调度/Worker 接口、Board 配置 schema、各操作端到端数据流 |

两份文档互为补充：`architecture.md` 说明「为什么这样设计」，`data-flow.md` 给出「具体契约与数据如何流转」。
