# Peak 数据流

本文描述数据如何进入 Peak、经过 Runtime 和 Worker、写入 Graph，并在 Project 之间形成只读引用。架构边界见 [架构](architecture.md)。

## 1. 核心数据

```typescript
type ProjectStatus = "active" | "stopped" | "completed";

interface FactRef {
  projectId: string;
  id: string;
  description: string;
}

interface Fact {
  id: string;
  description: string;
  artifact: ArtifactRef | null;
  createdAt: string;
}

interface Intent {
  id: string;
  from: FactRef[];
  to: FactRef | null;
  description: string;
  hintIds: string[];
  customProfile: string | null;
  customProfileDigest: string | null;
}

interface Hint {
  id: string;
  content: string;
  creator: string;
  consumedByIntentId: string | null;
}

interface PathAbstract {
  factRef: FactRef;
  pathOverview: string;
  verifiedCore: string[];
}
```

主要不变量：

- Fact 不可修改；普通 Fact description 必填且不超过 UTF-8 1 KiB。
- FactRef 三个字段必须完整，description 必须与源 Fact 相同。
- Intent source 必须是当前 Project 的当前本地 leaf，不能是 `goal`。
- 一个普通 Intent 只产生一个新 Fact；一个 Project 最多一个 completion Intent。
- Hint 不参与因果边，可在创建 Intent 或 completion 时原子消费。
- Fact 最多绑定一个不可变单文件 Artifact；Artifact 不能替代 Fact description。

## 2. 持久化

```text
~/.peak/projects/<projectId>/
├── project.db
├── artifacts/
│   ├── <sha256>
│   └── path_abs_<factId>
├── out/
├── logs/
│   ├── main.log
│   └── graph-<timestamp>-<executionId>-<phase>.json
└── .tmp/
```

- `project.db` 保存 Project、Fact、Intent、source、Hint、Artifact 元数据和计数器。
- `artifacts/<sha256>` 保存内容寻址的 Artifact body。
- `artifacts/path_abs_<factId>` 保存结构化 Path Abstract。
- `out/` 保存 completed Project 的最终交付物，可由 Artifact 重建。
- `logs/main.log` 是验证后 Graph operation、Federation 事件和 Runtime 事件（`worker_started`/`worker_completed`/`worker_timeout`/`worker_failed`/`worker_cancelled`、`execution_target_released`、phase 重试与失败）的 NDJSON 日志。
- `graph-*.json` 是不可变阶段上下文快照；其中用 `{description,skills,digest}` 记录已选 profile，但不保存顶层 Skills、Worker 配置、完整渲染 Prompt 或 Worker 输出。
- `.tmp/` 是 Worker 唯一临时读写目录，不进入归档，Project 不再 active 后清理。

每个 Project 是独立 Graph shard，不共享 Project SQLite。Server 在不进入归档的 `.projects.json` 中保存 Project 调度租约及 heartbeat/expiry；其余 Runtime 状态、进程、session、reservation 和 cooldown 不持久化。

## 3. Graph HTTP API

HTTP 是唯一在线 Graph 协议。主要路由：

| 领域 | 路由 |
| --- | --- |
| Project | `GET/POST /api/projects`、`GET/DELETE /api/projects/:id`、`PUT /api/projects/:id/status` |
| Fact | `GET /api/projects/:id/facts/:factId`、`POST /api/fact-refs/resolve` |
| Intent | `POST /api/projects/:id/intents`、`POST .../intents/:intentId/conclude` |
| Hint | `POST /api/projects/:id/hints` |
| Lifecycle | `POST /api/projects/:id/complete`、`POST /api/projects/:id/reopen` |
| Artifact | `POST /api/projects/:id/artifacts`、`GET/HEAD .../artifacts/:sha256` |
| Path Abstract | `GET/POST /api/projects/:id/path-abstracts/:factId` |
| Federation | `POST /api/federation/publish|pending|consume` |
| Project lease | `POST/PUT/DELETE /api/projects/:id/registration`（领取/心跳/释放） |
| Export | `GET /api/projects/:id/export?format=json|timeline|archive` |

所有 JSON 输入严格拒绝 unknown/missing field。普通 JSON body 上限为 1 MiB；Artifact 单独流式限额。Graph API 不包含 token 校验。

`GraphClient` 只是 HTTP client，不提供绕过 Server 校验的本地路径。Dispatch 的短期 execution 状态只存在于自身内存，不伪装成 Server Graph API。

## 4. Board 配置流

```json
{
  "board": {
    "name": "example",
    "skills": ["example-skill"],
    "projects": [
      { "id": "", "source": "Input", "goal": "Expected outcome" }
    ]
  },
  "workers": [
    {
      "type": "pi",
      "model": "",
      "taskTypes": ["plan", "supervise"],
      "maxRunning": 1,
      "priority": 1,
      "env": {}
    },
    {
      "type": "pi",
      "model": "",
      "taskTypes": ["execute"],
      "maxRunning": 2,
      "priority": 1,
      "env": {}
    }
  ]
}
```

加载过程：

1. `loadTaskConfig()` 严格校验并冻结配置；Task 不携带 Server 地址。
2. Dispatch 通过 `--graph-url` 连接独立 `peak serve`。
3. 完整 Task Dispatch 可顺序创建缺失 Project 并回写 UUID；`--project` 分片启动要求所有 UUID 已固定。
4. 第一个 Project lease 把 Task 的完整 UUID 集合固定到 `.projects.json`，后续成员集合不一致会被拒绝。
5. `id` 已存在时附加原 Project并校验 goal；Runtime 为每个所领取 Project 建立独立 `ProjectLoop`。

`taskTypes`、`maxRunning` 和 `priority` 只供 Runtime `WorkerPool` 路由。进入 Worker 模块的配置只有 `{type,model?,env}`。

## 5. 阶段上下文与输出合同

所有阶段先生成 256 KiB 内的只读上下文和 `graph-*.json` 快照，再把它渲染进 Prompt。快照包含阶段与 execution 溯源、预算内 context、配置和渲染 Prompt 的摘要，以及当前 profile 的 `{description,skills,digest}` 元数据；`skills` 不会成为顶层字段，`workers[]` 的路由配置也不会复制进快照。Worker 返回的最后一个 fenced JSON 或最外层 JSON 对象会被提取，随后进行严格 shape 校验。

### 5.1 Plan

输入：

```typescript
{
  projects: {
    [currentProjectId]: {
      source,
      goal,
      leafFacts,
      openIntents,
      unconsumedHints
    }
  },
  external: [
    { factRef: { projectId, id, description }, pathOverview, verifiedCore }
  ],
  truncated,
  omitted
}
```

输出三选一：

```json
{ "kind": "intents", "intents": [{ "from": [{ "projectId": "...", "id": "f0001", "description": "..." }], "hintIds": [], "customProfile": null, "description": "..." }] }
```

```json
{ "kind": "complete", "from": [{ "projectId": "...", "id": "f0001", "description": "..." }], "hintIds": [], "description": "..." }
```

```json
{ "kind": "noop" }
```

Plan 只能原样引用当前 Project 的可见 leaf FactRef；`external` 不能进入 `from`。写入前 Runtime 重读前沿，Server 再次校验 leaf。并发导致 source 过期时最多重新 Plan 一轮。

### 5.2 Supervise

输入为当前 Project、Facts、Intents、Hints 和截断元数据。输出：

```json
{ "kind": "hint", "content": "..." }
```

或 `{ "kind": "noop" }`。每轮最多新增一个非重复 Hint。

### 5.3 Execute 与 Finalize

Execute 输入当前 Project、一个 open Intent 和已解析 sources。source Artifact 以规范绝对 `inputPath` 和 `readOnly:true` 提供；Runtime 在执行前后校验文件类型、大小和 SHA-256。

输出：

```json
{ "kind": "fact", "description": "...", "artifact": null }
```

或：

```json
{
  "kind": "fact",
  "description": "...",
  "artifact": {
    "filename": "report.md",
    "mediaType": "text/markdown",
    "content": "..."
  }
}
```

Worker 可在 Project `.tmp/` 中读写，但最终只接受合同中的一个内联 Artifact。Runtime 上传内容后调用 conclude，原子创建一个 Fact 并更新 `Intent.to`。

Execute 已启动但失败、超时或输出不合法时，可在满足 session 恢复条件的情况下运行一次 Finalize。Finalize 使用相同 worker、execution ID、上下文和输出合同。

### 5.4 Analyze

Analyze 输入当前 Fact，以及每个直接前驱的完整 FactRef 和已解析 Path Abstract DTO。输出：

```json
{
  "pathOverview": "从 origin 到当前 Fact 的路径概述",
  "verifiedCore": ["已经验证的核心内容"]
}
```

结果原子写入 `artifacts/path_abs_<factId>`。已有结果直接复用；Worker 连续失败时写入结构化降级结果。

## 6. 端到端流转

### 6.1 Plan 到 Fact

```mermaid
flowchart LR
  A["GraphClient 读取当前前沿"] --> B["组装 Plan context + snapshot"]
  B --> C["Worker 输出 intents / complete / noop"]
  C --> D["Runtime 重读前沿"]
  D --> E["Graph Server 校验并写 Intent"]
  E --> F["Execute 解析 sources"]
  F --> G["Worker 输出 Fact contract"]
  G --> H["可选 Artifact 上传"]
  H --> I["conclude: 新 Fact + Intent.to"]
```

Execute 失败不会创建伪 Fact；Intent 保持 open，后续 tick 可再次调度。

### 6.2 Artifact

```text
inline content
-> GraphClient 流式上传
-> Server 计算 SHA-256
-> artifacts/<sha256>
-> ArtifactRef 绑定 Fact
-> completion 时按 filename 物化到 out/
```

客户端不能指定最终 Artifact path。Server 拒绝绝对路径、路径逃逸和 symlink。

### 6.3 Federation

```mermaid
flowchart LR
  A["Plan pre-hook: Joint Plan"] --> B["HTTP joint-plan"]
  B --> C["Server 计算同 Task 其他 Projects 的 leaf Paths"]
  C --> D["递归复用或补齐 Path Abstract"]
  D --> E["Plan external: PathAbstract DTO"]
```

Task 的 Project 列表是固定 Federation 边界：Joint Plan 必须读取同 Task 全部其他 Projects 的当前 Paths，不存在开关或动态成员管理。不同 Dispatch 进程之间不直接传播数据，也不存在发布、恢复或消费队列；每次 Plan 都通过 Server HTTP 读取最新 frontier。

Completed Project Archive 同时携带 Graph、SQLite、内容 Artifact 和全部当前 leaf 的 `path_abs_<factId>`。导入后 Joint Plan 使用 `computePaths()` 与已有 Path Abstract 直接构建上下文；Path Abstract 已存在就终止递归，只有缺失项才执行 Analyze。

### 6.4 Complete 与 Reopen

```text
complete: current local leaves -> completion Intent -> goal -> status=completed
reopen: remove completion -> external feedback Fact -> status=active
```

两者都由 Server 在事务内完成。Hint 或 Joint Plan 输入不会自动 reopen。

## 7. 运行时策略

| 阶段 | 超时 | 重试 |
| --- | ---: | --- |
| Plan | 5 分钟 | 最多 3 次；stale leaf 另允许重做一轮 Plan |
| Supervise | 5 分钟 | 最多 3 次 |
| Execute | 10 分钟 | 不普通重试；可 Finalize 一次 |
| Finalize | 2 分钟 | 不重试 |
| Analyze | 5 分钟 | 最多 3 次，最终降级 |

Plan、Supervise 和 Analyze 只重试已启动且非外部取消的 provider failure、timeout 或 malformed output，间隔 2 秒。

Execute 并发容量为所有 `taskTypes` 包含 `execute` 的 Worker 的 `maxRunning` 之和。Runtime 重启后，Graph 中仍 open 的 Intent 会重新进入调度；任何运行态都不会伪装成持久化 Graph 状态。
