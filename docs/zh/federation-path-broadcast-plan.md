# Federation leaf + path_abs 设计（已实施）

## 1. 目标

Federation 只向 Plan 提供其他 Project 的可复用结论，不把外部 Fact 写入目标 Graph，也不让 Worker 访问 Graph HTTP API。

广播单元固定为：

```ts
interface PathReference {
  projectId: string;
  leaf: FactRef;       // 完整 {projectId,id,description}
  pathAbs: string;     // artifacts/path_abs_<factId>
  segments: FactRef[][]; // 仅供 durable retirement 使用
}
```

## 2. path_abs 增量生成

内部 Analyze 复用 `plan` Worker 通道，固定 timeout 为 5 分钟，不增加 `TaskType`。

生成 Fact n 的 `artifacts/path_abs_<factId>` 时只输入：

1. 当前 Fact n 的完整 FactRef 与可选 Artifact 只读路径；
2. 每个直接前驱 Fact n-1 的完整 FactRef；
3. 对应前驱的 `path_abs_<factId>` 只读路径和已解析内容；origin 前驱的 pathAbs 为 null。

合并节点读取全部直接前驱。严格输出合同：

```json
{
  "pathOverview": "从 origin 到当前 Fact 的路径概述",
  "verifiedCore": ["已经验证的核心内容"]
}
```

文件是不可变 JSON，先写临时文件再原子 rename，并设置只读权限。已有合法文件直接复用；Worker 失败或输出无效时，使用当前 Fact description 与前驱概述生成同 shape 降级结果。

`TaskExecutor.syncPaths` 在 Runtime 启动和每次 Plan dispatch 前递归补齐当前 leaf 及其缺失前驱，然后广播当前 leaf。completed Project 使用 completion 的最终 source leaf。

## 3. PlanGraphView

Plan 上下文固定为：

```ts
interface PlanGraphView {
  projects: Record<string, {
    source: FactRef;
    goal: FactRef;
    leafFacts: ResolvedFactSource[];
    openIntents: OpenIntent[];
    unconsumedHints: Hint[];
  }>;
  external: Array<{
    factRef: FactRef;
    pathAbs: { inputPath: string; readOnly: true };
  }>;
  truncated: boolean;
  omitted: Record<string, number>;
}
```

当前 Project 的 source、goal、leaf、openIntents、unconsumedHints 全部位于 `projects[currentProjectId]` 下；不传 Project title。`external` 中 FactRef 必须完整，路径由 FederationBus 根据已注册 Project 根目录解析为绝对路径并验证：

- `pathAbs` 必须精确等于 `artifacts/path_abs_<leaf.id>`；
- projectId 与 FactRef.projectId 必须一致；
- 目标必须是普通文件且不是符号链接。

外部 leaf 仅供参考，不能进入 `intent.from`。

## 4. 持久投递

发送与接收事件继续写各 Project 的 `logs/main.log`。`segments` 只用于计算 `retires`：旧 leaf 成为新链路内部节点时，目标 pending 中的旧广播自动退休。FederationBus 不建表、不读 SQLite、不写 Graph。

## 5. 验收

- Analyze timeout 为 300000 ms；
- 线性路径中 Fact n 的 Analyze 输入包含 Fact n-1 的 pathAbs 与结构化内容；
- 合并节点包含全部直接前驱；
- Plan 当前内容按 projectId 包裹且没有 title；
- external 含完整 FactRef 与已校验绝对只读路径；
- active/completed Project 都广播当前最终 leaf；
- 缓存命中不重复调用 Worker；失败降级仍落盘；
- Graph API 公开访问，不存在 token 或 Worker Path API 旁路。
