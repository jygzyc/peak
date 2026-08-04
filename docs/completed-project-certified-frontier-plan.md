# Completed Project Certified Frontier 实施计划

> 状态：架构计划，尚未实施。本计划会改变“所有跨 Project source 都必须是 current leaf”这一不变量。

## 1. 问题

完成前常见的 Graph 形态是多个证据分支先汇总为一个最终 Fact，再由该 Fact 指向 `goal`。现有 Federation 只广播 current leaf，因此 completed Project 往往只发布一个最终摘要，无法有效复用其已认证的中间证据和独立结论。

## 2. 目标

- active Project 仍只发布 current leaf frontier；
- completed Project 发布不可变的 `certified proof frontier`；
- 目标 Project仍只持久化 `{projectId,factId,description}` FactRef；
- 不复制源 Fact、Artifact 或 Graph；
- 不允许未参与 Goal 证明的历史 Fact 进入 Federation；
- completed Project 的状态、Graph 和完成时点不受广播与下游消费影响。

## 3. 定义

### 3.1 Goal proof closure

从唯一 completion Intent 的 `from` 开始，沿“产生该本地 Fact 的 concluded Intent”反向遍历得到的本地 Fact/Intent 闭包。外部 FactRef 是闭包边界，只保留引用，不进入其他 Project 的 Graph 继续递归。

### 3.2 Certified proof frontier

从 Goal proof closure 中确定性选出的可复用本地 FactRef 集合：

1. completion Intent 的全部本地直接 source；
2. 每个多 source merge Intent 的本地输入 Fact；
3. 闭包内绑定 Artifact 的本地 Fact；
4. 去重后按 Graph 创建顺序稳定排序；
5. `origin`、`goal`、闭包外 Fact 和空泛中间节点不发布；
6. 每项仍是规范 `{projectId,factId,description}`。

最终汇总 Fact必须保留；merge 输入与 Artifact Fact用于补充独立证据。第一版不让 AI 选择发布集合，保证恢复和测试确定性。

## 4. Source 合法性规则

Server 将 source 校验拆分为：

```text
目标 Project 的本地 FactRef
  -> 必须是目标 Project current leaf

外部 active/stopped Project FactRef
  -> 必须是源 Project current leaf

外部 completed Project FactRef
  -> 必须属于源 Project certified proof frontier
```

所有路径继续校验 UUID、scope、Fact 存在性以及 description 与源 Fact 完全一致。普通 Intent 和 completion 都使用同一规则。已经持久化的 FactRef 保持不可变。

## 5. 模块改动

### 5.1 `graph/types.ts`

增加纯函数接口：

```typescript
certifiedProofFrontier(graph: ProjectGraph): Fact[]
isAdmissibleExternalFact(graph: ProjectGraph, factId: string): boolean
```

函数不访问 Store、Runtime 或 FederationBus。

### 5.2 `graph/project-store-registry.ts`

- 将 `validateLeafRefs()` 重构为 `validateSourceRefs()`；
- 本地引用继续校验 current leaf；
- 外部 completed 引用校验 certified frontier；
- 返回明确的 `409 FactRef is not an admissible source`；
- `/api/fact-refs/resolve` 只负责解析，不放宽 Intent 写入验证。

### 5.3 `graph/federation-bus.ts`

Registration 增加源 Project 状态和 publication kind：

```typescript
{ projectDir, scope, status, publication: "leaf" | "certified" }
```

发送日志增加版本化字段：

```json
{
  "type": "send_fact_reference",
  "publication": "certified",
  "frontierVersion": 1,
  "targetProjectId": "...",
  "projectId": "...",
  "factId": "...",
  "description": "..."
}
```

恢复仍由 source send 与 target receive 的差集完成。旧事件不隐式升级为 certified；第一版采用 hard cut，不增加旧语义兼容层。

### 5.4 `runtime/agent-runtime.ts`

启动 seed：

- active/stopped Project：发布 current ordinary leaf Facts；
- completed Project：计算并发布 certified proof frontier；
- 所有 Project 注册完成后再 seed，避免注册顺序导致漏发；
- completed target 可以出现在 delivery 日志中，但不调度、不自动 reopen。

### 5.5 `runtime/task-executor.ts`

- Plan view 继续只提供完整 FactRef，不向 FactRef 增加 publication 字段；
- active leaf 与 completed certified 的合法性由 Server 判断，Plan 输出仍原样返回 FactRef；
- 写入前重读并通过 Server 做最终 admissibility 校验；
- active source 发生 supersession 时重做 Plan；completed certified source 不会 supersede。

## 6. 完成与 Reopen

### 6.1 完成

completion transaction 提交后计算 certified frontier，并在 transaction 成功后广播。广播失败不回滚 Project completion；`main.log` 和启动 seed负责恢复。

### 6.2 Reopen

Reopen 后源 Project 不再是 certified publication：

1. 从各目标未处理 pending 队列退休该 Project 的 certified refs；
2. 已经持久化到目标 Graph 的 FactRef 不删除；
3. 新的 active frontier按 leaf 规则发布；
4. 其他 Project 新建 Intent 时不能再引用已失去 certified 资格的历史 Fact。

已经合法创建的 open Intent保持不可变并允许 conclude，避免 Reopen 破坏既有目标 Graph。

## 7. 预算与降噪

- publication 生成不由 256 KiB Prompt 预算决定；
- pending 进入 Plan view 后仍受统一 Graph view 预算约束；
- certified frontier 设置固定数量上限前必须先证明不会丢失关键 Artifact Fact；第一版不增加静默数量截断；
- 若 frontier 本身超过预算，Plan view 必须通过 `truncated/omitted.pendingFactRefs` 明示；
- 不广播 closure 中所有 Fact，避免把完整历史退化为消息总线。

## 8. HTTP、UI 与导出

- 不增加新的 Graph entity 或 SQLite 表；
- Graph export 保持原始不可变 Graph，不保存 Runtime pending；
- Project archive不保存 Federation delivery，但导入并附加后可从 Graph 重新计算 certified frontier；
- UI 对 external Fact 节点可增加 `certified` 展示标签，但不能改变引用语义；
- `/api/projects/:id` 与 Artifact API 不变。

## 9. 测试计划

必须覆盖：

1. 单最终 Fact 的 completed Project仍发布最终 Fact；
2. merge proof 发布最终 Fact、merge 输入和闭包内 Artifact Fact；
3. 闭包外历史 Fact 不发布；
4. target 可从 certified historical Fact 创建 Intent；
5. active source 的 historical Fact仍被拒绝；
6. description mismatch、跨 scope 和 goal source仍被拒绝；
7. 重启从日志恢复且不重复投递；
8. 导入 archive 后重新生成相同 certified frontier；
9. completed source 不等待 target，也不因 delivery reopen；
10. Reopen 退休未处理 certified refs，但不删除已持久化引用；
11. 并发 complete/reopen/Intent create 保持事务边界；
12. Graph snapshot 和 archive不包含 pending overlay。

## 10. 实施顺序

1. 为 proof closure/frontier 写纯函数和单元测试；
2. 修改 Server source admissibility 校验；
3. 版本化 Federation send event 和恢复逻辑；
4. 修改 Runtime seed、completion publication 与 Reopen retirement；
5. 更新 Plan view 与预算测试（FactRef shape 保持不变）；
6. 更新 UI certified 标签；
7. 更新 architecture/data-flow/AGENTS；
8. 依次运行 typecheck、build、test、smoke，最后运行 pack。

## 11. 完成条件

- completed Project 可稳定发布 Goal proof 内的多个可复用 Fact；
- active Project 仍不能发布或引用历史非叶 Fact；
- 跨 Project 持久化仍只有完整 FactRef；
- 不新增 Federation/运行态数据库表；
- Reopen、重启、导入和并发写入均不产生悬空或非法引用。
