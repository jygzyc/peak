# Peak 重构计划

## 1. 目标

Peak 是基于分布式 Graph 的通用 Agent 运行时：

- 每个 Project 是独立 Graph 分片；
- Project 之间通过 `FactRef` 组成证明链；
- HTTP API 是 Graph 的唯一读写接口；
- Worker 只执行任务，不接触 Graph；
- 领域能力只来自 Skill；
- 内置 Graph Supervisor 只审视图并提出 Hint，不承担领域角色；
- 不使用可配置角色、Workflow、Evaluator 或 Metacog。

## 2. 硬约束

1. 每个 Project 使用随机 UUID 作为 `projectId` 和目录名。
2. 每个 Project 独立完成，不等待其他 Project、广播或 scope。
3. Fact 不可修改；变化和纠错通过新 Fact 表达。
4. 每个已结论 Intent 恰好产出一个 Fact。
5. 跨 Project 只保存 `FactRef`，不复制来源 Fact 或 Artifact。
6. 不建立中央 Graph/Federation 数据库。
7. HTTP API 是唯一 Graph Protocol；控制面也使用 loopback HTTP。
8. SQLite 和 `artifacts/` 只允许 Graph Server 访问。
9. 活动执行、claim、retry、cancel 和 session 只存在内存。
10. 第一版只允许一个 Runtime 调度同一批 Project。
11. Worker 不获得 GraphClient、Server URL/token、SQLite 或 FederationBus。
12. Task 不允许配置 Prompt、角色、权限或 Workflow。

## 3. 运行架构

```text
AgentRuntime
├── Config
│   ├── parse/validate task.json
│   └── initialize configured Skills
├── GraphHttpServer
│   └── per-Project SQLite + artifacts
├── RuntimeScheduler
│   ├── GraphClient (loopback HTTP)
│   ├── ProjectLoop[]
│   ├── ExecutionRegistry
│   └── FederationBus
├── TaskExecutor
│   ├── Plan
│   ├── Supervise
│   ├── Execute
│   └── Finalize
└── WorkerRuntime
    └── ProcessRunner + CLI backends
```

### 3.1 GraphHttpServer

负责：

- Graph HTTP schema；
- Graph 不变量；
- FactRef/scope 校验；
- SQLite transaction；
- Artifact 上传、下载和索引；
- Project/scope 导出；
- UUID、路径和鉴权检查。

### 3.2 GraphClient

- 与 HTTP endpoint 一一对应；
- 不定义第二套 Graph 语义；
- 不缓存权威状态；
- 不暴露 store 或文件路径。

### 3.3 ProjectLoop

- 通过 GraphClient 读取 Project；
- 调度 Plan/Supervise/Execute；
- 在内存记录活动执行；
- Project stopped/completed 后取消活动进程。

### 3.4 Graph Supervisor

每个 active Project 由一个轻量监督循环定期检查：

- 通过 GraphClient 读取完整 Graph；
- 识别停滞、遗漏验证、相互冲突或证明缺口；
- 每轮最多通过 Hint endpoint 提交一个 Hint，也可以 noop；
- 不创建 Intent/Fact，不 conclude，不 complete/reopen；
- Project stopped/completed 后停止。

Supervisor 是固定控制协议，不是可配置领域角色。

### 3.5 FederationBus

只负责：

- `publish(FactRef, provenance)`；
- pending/handled 队列；
- 从各 Project `logs/main.log` 恢复传递状态。

不读取 SQLite、不校验 Fact、不写 Graph、不决定完成。

### 3.6 Config

- 解析和校验 `task.json`；
- 合并内置默认值并输出 `ResolvedTaskConfig`；
- 校验 Worker、scheduler、task type 和 federation 配置；
- 校验 Task Skill 名称和 `SKILL.md`；
- 初始化各 Worker CLI 使用的 Skill 软链接；
- 不读取或写入 Graph。

## 4. Project 持久目录

```text
~/.peak/projects/<project-uuid>/
├── analysis.db
├── artifacts/
│   └── <sha256>
└── logs/
    ├── main.log
    └── graph-<timestamp>-<phase>.yaml
```

Project title 可修改；UUID 不可修改。

## 5. Graph 模型

### 5.1 FactRef

```typescript
interface FactRef {
  projectId: string;
  factId: string;
}
```

### 5.2 ArtifactRef

```typescript
interface ArtifactRef {
  path: string;       // Server 生成的 Project-relative path
  sha256: string;
  mediaType: string;
  sizeBytes: number;
}
```

文件路径固定为：

```text
artifacts/<sha256>
```

### 5.3 Fact

```typescript
interface Fact {
  id: string;                     // origin | goal | f001...
  description: string;            // 必填，trim 后非空，UTF-8 <= 16 KiB
  artifact: ArtifactRef | null;   // 可选补充内容
  createdAt: string;
}
```

- `origin`、`goal` 在创建 Project 时生成；
- 每个 Fact 都必须有非空 `description`，无论是否存在 Artifact；
- `description` 是可独立理解的事实描述，不能只写“见附件”或文件路径；
- 短结论全部放在 `description`；
- 长结论仍需在 `description` 给出结论摘要，Artifact 只保存该 Fact 必要的详细内容、证据或报告；
- Artifact 不能代替 description，也不用于保存与 Fact 无关的工作区文件；
- Fact 和 ArtifactRef 创建后不可修改；
- Fact 没有 candidate/pass/deny/pending/verdict 状态。

### 5.4 Intent

```typescript
interface Intent {
  id: string;
  from: FactRef[];
  to: FactRef | null;
  description: string;            // 必填，trim 后非空，UTF-8 <= 16 KiB
  createdBy: string;
  createdAt: string;
  concludedBy: string | null;
  concludedAt: string | null;
}
```

```text
to = null    open
to != null   concluded
```

每个 Intent 都必须有非空 `description`，明确描述要执行或已经证明的内容。Intent 没有 Artifact；其执行产生的长结果属于结果 Fact。

Intent 不保存 worker、claim、heartbeat、attempt、retry 或 session。

### 5.5 Hint

```typescript
interface Hint {
  id: string;
  content: string;
  creator: string;
  createdAt: string;
}
```

Hint 不参与因果边，不自动 reopen Project。

### 5.6 Project

```typescript
interface ProjectMeta {
  id: string;
  title: string;
  status: "active" | "stopped" | "completed";
  scope?: string;
  createdAt: string;
}
```

### 5.7 不变量

- 普通 Intent 至少有一个 source；
- source 必须存在且不能是任何 Project 的 `goal`；
- 外部 source 必须与目标 Project 同 scope；
- source 不重复，顺序稳定；
- Intent 和 Fact 的 description 都必须存在、trim 后非空且不超过 UTF-8 16 KiB；
- Artifact 永远不能替代 Fact description；
- Execute 只能创建当前 Project 的 Fact；
- concluded Intent 不可修改；
- 每个 Project 最多一个 completion Intent；
- completion 的 target 是当前 Project `goal`；
- 被外部 Project 引用的 Project 禁止删除。

### 5.8 SQLite

核心表：

```text
project
artifacts
facts
intents
intent_sources
hints
counters
```

`artifacts` 只保存：

```text
sha256, path, media_type, size_bytes, created_at
```

`facts.artifact_sha256` 可空。`facts.description` 和 `intents.description` 必须 `NOT NULL`，服务层额外校验 trim 后非空和 UTF-8 byte length。SQLite 不保存 Artifact 正文或大 BLOB。

`intent_sources`：

```sql
CREATE TABLE intent_sources (
  intent_id          TEXT NOT NULL,
  position           INTEGER NOT NULL,
  source_project_id  TEXT NOT NULL,
  source_fact_id     TEXT NOT NULL,
  PRIMARY KEY (intent_id, position),
  UNIQUE (intent_id, source_project_id, source_fact_id)
);
```

不建立 execution、lease、event、directive、verdict、dead-end 或 federation 表。

## 6. Graph HTTP API

### 6.1 Project

```text
GET    /api/projects
POST   /api/projects
GET    /api/projects/{id}
DELETE /api/projects/{id}
PUT    /api/projects/{id}/title
PUT    /api/projects/{id}/status       # 仅 active <-> stopped
GET    /api/projects/{id}/facts/{factId}
GET    /api/projects/{id}/export?format=yaml|timeline
GET    /api/scopes/{scope}/export?format=yaml|timeline
```

`completed` 只能由 complete endpoint 设置；恢复只能调用 reopen。

### 6.2 Artifact

```text
POST /api/projects/{id}/artifacts
GET  /api/projects/{id}/artifacts/{sha256}
HEAD /api/projects/{id}/artifacts/{sha256}
```

上传流程：

1. streaming 写临时文件；
2. 计算 SHA-256；
3. 原子 rename 到 `artifacts/<sha256>`；
4. 写 `artifacts` 索引；
5. 返回 ArtifactRef。

规则：

- 客户端不能指定最终 path；
- 拒绝 absolute path、`..`、symlink escape；
- 上传和下载不把完整文件读入内存；
- 未被 Fact 引用的 Artifact 按安全窗口 GC。

### 6.3 FactRef

```text
POST /api/fact-refs/resolve
```

```json
{
  "targetProjectId": "...",
  "refs": [{"projectId": "...", "factId": "f001"}]
}
```

返回 Fact 摘要和 ArtifactRef，不返回 Artifact 正文，不复制到目标 Project。

### 6.4 Hint

```text
POST /api/projects/{id}/hints
```

```json
{
  "content": "对当前 Graph 的具体建议",
  "creator": "supervise:<executionId>"
}
```

Server 校验 Project 存在、content 非空且不超过 UTF-8 16 KiB；与已有 Hint trim 后完全相同则返回 `409`。外部调用可以给任意状态的 Project 添加 Hint，但只有 active Project 会运行 Supervisor/Plan。

### 6.5 Intent

```text
POST /api/projects/{id}/intents
POST /api/projects/{id}/intents/{intentId}/conclude
```

Create body 必须包含非空 description：

```json
{
  "from": [{"projectId": "...", "factId": "f001"}],
  "description": "需要执行或证明的具体事项",
  "createdBy": "plan:<executionId>"
}
```

Conclude body：

```json
{
  "description": "结论或摘要",
  "artifact": null,
  "concludedBy": "execute:<executionId>"
}
```

Conclude transaction：

1. Project 必须 active；
2. Intent 必须 open；
3. 校验 description 必填、trim 后非空、UTF-8 长度合规，并校验可选 ArtifactRef；
4. 创建本地 Fact；
5. 更新 Intent.to；
6. 返回 Fact 和 Intent。

并发 conclude 只有第一个成功，其余返回 `409`。

### 6.6 Complete

```text
POST /api/projects/{id}/complete
```

```json
{
  "from": [{"projectId": "...", "factId": "f001"}],
  "description": "Goal 证明",
  "completedBy": "plan:<executionId>"
}
```

同一 transaction：

1. 校验 FactRef；
2. 创建 `FactRef[] -> currentProject/goal` completion Intent；
3. 将 Project 标记为 completed；
4. 返回 completion 和 Project。

完成不等待其他 Project、广播、pending reference 或活动 Worker。晚到 conclude 返回冲突。

### 6.7 Reopen

```text
POST /api/projects/{id}/reopen
```

只允许显式调用：删除当前 completion Intent，写 external feedback Fact/Intent，并恢复 active。Hint 和 Federation 消息不能 reopen。

## 7. 任务协议

### 7.1 Plan

作用：决定下一步证明结构。

输出三选一：

```json
{"kind":"complete","from":[{"projectId":"...","factId":"f001"}],"description":"..."}
```

```json
{"kind":"intents","intents":[{"from":[{"projectId":"...","factId":"f001"}],"description":"..."}]}
```

```json
{"kind":"noop"}
```

Plan 不执行 Intent、不直接创建 Fact、不操作其他 Project。

### 7.2 Supervise

作用：独立审视当前 Graph，并只提出改进 Hint。

输出二选一：

```json
{"kind":"hint","content":"当前证明缺少对……的验证，建议……"}
```

```json
{"kind":"noop"}
```

规则：

- 只对 active Project 运行；
- 每轮最多一个 Hint；
- Hint content 必填、trim 后非空、UTF-8 不超过 16 KiB；
- 与已有 Hint trim 后完全相同则不写入；
- 通过 `POST /api/projects/{id}/hints` 写入，creator 为 `supervise:<executionId>`；
- 不创建 Intent/Fact，不执行工具探索，不完成或 reopen Project；
- 新 Hint 进入 Graph 后触发下一轮 Plan。

### 7.3 Execute

作用：执行一个 open Intent 并产出 Fact。

短结果：

```json
{"kind":"fact","description":"..."}
```

长结果仍必须提供 description；Artifact 只承载该 Fact 必要的详细内容：

```json
{
  "kind":"fact",
  "description":"摘要",
  "artifact": {
    "localPath":"reports/report.md",
    "mediaType":"text/markdown"
  }
}
```

Worker cwd 是 `task.workspace`。TaskExecutor 将 localPath 解析到该 workspace，拒绝 symlink/越界/超限文件，通过 GraphClient 上传后再 conclude。

### 7.4 Finalize

不是任务类型。只在 Execute timeout 或格式失败且 Worker 支持 resume 时运行一次：

- resume 同一 session；
- 不继续探索；
- 只整理已确认结果；
- 输出与 Execute 相同合同。

### 7.5 JSON 合同

拒绝：

- Markdown fence/prose；
- 多个 JSON；
- 缺失或未知字段；
- 缺失或空白的 Intent/Fact description；
- context 外 FactRef；
- 非法 Artifact 路径；
- 超过 16 KiB 的 description。

## 8. 调度

```typescript
interface ActiveExecution {
  executionId: string;
  projectId: string;
  kind: "plan" | "supervise" | "execute";
  intentId?: string;
  workerName: string;
  controller: AbortController;
  sessionRef?: SessionRef;
}
```

ExecutionRegistry 仅在内存：

- 每个 Project 最多一个 Plan；
- 每个 Project 最多一个 Supervise；
- 每个 Intent 最多一个 Execute；
- 不同 Intent 可并发；
- Runtime 重启后 open Intent 重新可调度。

ProjectLoop：

```text
GET Project through GraphClient
if status != active: cancel and stop
consume pending FactRefs
run Supervise when nextSuperviseAt reached and no active Supervise
run Plan when checkpoint changed and no active Plan
fill remaining slots with open Intents excluding active intentIds
```

Plan checkpoint：

```typescript
interface PlanCheckpoint {
  factCount: number;
  hintCount: number;
  openIntentCount: number;
  federationCursor: number;
}
```

触发：首次观察、Fact/Hint 增加、open Intent 清零、新 Federation reference。

Supervise 使用内存 `nextSuperviseAt` 轮询，不写 Graph lease/cursor；Runtime 重启后 active Project 可立即监督。Supervise 与其他任务共享全局和 Project 并发配额。

Worker 选择：

```text
taskTypes -> maxRunning -> health retry-after -> priority -> active count -> random
```

## 9. Federation

发送：

```text
conclude success
-> source main.log: send_fact_reference
-> FederationBus.publish(FactRef, provenance)
```

接收：

```text
pending FactRefs
-> POST /api/fact-refs/resolve
-> materialize required Artifacts through HTTP
-> bind immutable Plan context
-> Plan write succeeds through HTTP
-> target main.log: receive_fact_reference
-> markHandled
```

失败时不 mark handled。

规则：

- scope 只控制可见性；
- completed Project 不再调度；
- completed Project 的 Fact/Artifact 继续可读；
- target 不永久复制 source Fact/Artifact；
- 广播不阻塞完成、不触发 reopen；
- FederationBus 无数据库，只从 `main.log` 恢复。

## 10. Worker 与 Context

TaskExecutor 通过 HTTP 获取本次执行可见的 Graph，并在调用 Worker 前写入不可变 YAML：

```text
~/.peak/projects/<project-uuid>/logs/graph-<timestamp>-<phase>.yaml
```

规则：

- `<timestamp>` 使用 UTC、文件名安全且单调唯一的时间戳；
- `<phase>` 只允许 `plan`、`supervise`、`execute`、`finalize`；
- 文件使用临时文件 + atomic rename 写入，禁止覆盖；
- YAML 包含本次绑定的 Project Graph、assignment、Hints、pending FactRefs 和 ArtifactRef；
- Prompt 只传 YAML 的绝对路径和输出合同；
- Supervise snapshot 使用与其他任务相同的完整 Graph 格式；
- Finalize 使用与 Execute 相同的绑定上下文，并写自己的 `graph-<timestamp>-finalize.yaml`；
- Worker cwd 固定为 `task.workspace`。

TaskExecutor 不直接读取 Project `artifacts/`。需要 Artifact 正文时，通过 HTTP 下载到 OS 临时目录，并把临时文件路径写入 YAML；Worker 生成的长结果文件位于 `task.workspace`，成功后由 TaskExecutor 上传为 Artifact。

stdout/stderr 只在内存收集，保留现有 ProcessRunner 的 10 MiB 上限。成功时只解析模型响应；失败时只向应用日志写 bounded preview，不持久化原始 stdout/stderr。

`logs/main.log` 只记录 Graph/Federation 操作元数据；`logs/graph-*.yaml` 只记录执行时的图上下文，不保存 Worker 原始输出。

Builtin Prompt：

```text
plan.md
supervise.md
execute.md
execute-finalize.md
```

Task 不可覆盖 Prompt。Worker driver 只处理 CLI 参数、session 和响应提取；ProcessRunner 处理 stdin、timeout、cancel、进程树和输出限制。

支持：

```text
opencode | codex | pi | claude-code
```

## 11. Config

### 11.1 配置解析

入口：

```typescript
loadTaskConfig(taskFile: string): ResolvedTaskConfig
initializeTaskSkills(config: ResolvedTaskConfig): InstalledSkill[]
```

`loadTaskConfig()`：

1. 读取 `<task-dir>/task.json`；
2. 严格校验 schema，拒绝未知字段；
3. 校验 `task.target`、`task.goal` 和至少一个 Worker；
4. 应用 scheduler/tasks 默认值；
5. 规范化相对路径，并记录 Task 目录作为 Skill 根目录；
6. 返回不可变 `ResolvedTaskConfig`。

该函数无副作用。AgentRuntime 随后调用 `initializeTaskSkills()`；后者先校验全部 Skill，再创建链接。

### 11.2 Skill 初始化

Skill 配置只允许名称：

```text
<task-dir>/skills/<name>/SKILL.md
```

规则：

- 拒绝空名称、绝对路径、`..` 和路径分隔符；
- 配置的每个 Skill 必须存在 `SKILL.md`；
- OpenCode/Pi 链接到 `~/.agents/skills/<name>`；
- Claude Code 链接到 `~/.claude/skills/<name>`；
- Codex 第一版不安装 Skill；
- 已指向同一来源的 symlink 视为成功；
- 可更新旧 symlink，但绝不覆盖已有真实文件或目录；
- 初始化必须幂等；
- 不下载 Skill，不修改 Task 原始文件。

### 11.3 Schema

```json
{
  "task": {
    "name": "...",
    "target": "...",
    "goal": "...",
    "workspace": "...",
    "skills": ["some-skill"]
  },
  "workers": {
    "default": {
      "type": "pi",
      "model": "...",
      "taskTypes": ["plan", "supervise", "execute"],
      "maxRunning": 2,
      "priority": 1,
      "args": []
    }
  },
  "scheduler": {
    "maxConcurrent": 4,
    "maxRunningProjects": 4,
    "maxProjectConcurrent": 2,
    "refillPerTick": 4,
    "intervalMs": 3000
  },
  "tasks": {
    "plan": {"timeoutMs": 45000, "maxIntents": 3},
    "supervise": {"timeoutMs": 45000, "intervalMs": 60000},
    "execute": {
      "timeoutMs": 600000,
      "finalizeTimeoutMs": 120000,
      "maxArtifactBytes": 104857600
    }
  },
  "federation": {"scope": "..."}
}
```

至少一个 Worker 必须支持 `supervise`。删除 `agent`、role/profile、prompt、tools taxonomy、context policy、workflow、lease 和角色 retry 配置。

## 12. 目标源码结构

```text
src/
├── config/                     # Task 配置解析与 Skill 初始化
│   ├── types.ts
│   ├── task-config.ts
│   ├── defaults.ts
│   └── task-skill-installer.ts
├── graph/                      # Graph、跨图、API、Server、展示
│   ├── types.ts
│   ├── api.ts
│   ├── graph-client.ts
│   ├── http-server.ts
│   ├── project-store-registry.ts
│   ├── sqlite-store.ts
│   ├── artifact-store.ts
│   ├── federation-bus.ts
│   ├── export.ts
│   └── dashboard.html
├── project/                    # 单 Project 管理
│   ├── project-manager.ts
│   ├── project-loop.ts
│   └── graph-supervisor.ts
├── worker/                     # Agent CLI 调用
│   ├── types.ts
│   ├── worker-runtime.ts
│   ├── process-runner.ts
│   └── backends/
├── runtime/                    # 多 Project 运行时
│   ├── agent-runtime.ts
│   ├── scheduler.ts
│   ├── execution-registry.ts
│   ├── task-executor.ts
│   ├── contracts.ts
│   ├── context.ts
│   └── prompts/
│       ├── plan.md
│       ├── supervise.md
│       ├── execute.md
│       └── execute-finalize.md
├── cli.ts
└── index.ts
```

禁止新增顶层 `app/`、`client/`、`server/`、`task/`、`dashboard/`。Config 只放在 `config/`，Runtime 不再维护另一套配置解析。

只有 `graph/http-server.ts` 和 `graph/project-store-registry.ts` 可以 import `sqlite-store.ts`/`artifact-store.ts`。二者不从 `index.ts` 导出。

删除：

- 公共 Graph/GraphReader 数据库接口；
- `federated-graph.ts`；
- MainAgent/RoleAgents；
- Evaluator/Metacog；
- PermissionChecker/DecisionApplier；
- RoleOutputService；
- Directive/Event/dead-end/verdict 协议。

## 13. 实施顺序

### PR1：Graph HTTP

- Graph/API types；
- per-Project SQLite/Artifact store；
- Project/Fact/Intent/Hint/Artifact endpoints；
- FactRef resolve；
- conclude/complete/reopen transaction；
- GraphClient；
- HTTP、路径、并发和持久化测试。

### PR2：Config + Runtime

- 严格 Task schema、默认值和 `ResolvedTaskConfig`；
- Skill 名称/path 校验与幂等链接初始化；
- ExecutionRegistry；
- ProjectLoop/RuntimeScheduler/GraphSupervisor；
- Plan/Supervise/Execute/Finalize；
- Worker Artifact 输出；
- 所有 Graph I/O 切换到 GraphClient；
- 删除持久 claim/heartbeat/lease 和旧四角色路径；
- 单 Project lifecycle 测试。

### PR3：Federation

- FederationBus send/receive/recovery；
- 跨 Project Intent/Completion；
- scope export/Dashboard；
- 跨 Project lifecycle 测试；
- 更新 README、AGENTS.md、data-flow 和 examples。

## 14. 验收

必须覆盖：

- Config 严格拒绝未知字段、非法 Skill 名称和缺失 `SKILL.md`；
- Skill 链接初始化幂等且不覆盖真实目录；
- 所有 Graph I/O 经 HTTP；
- 非 Server 模块不能访问 SQLite/Artifact store；
- UUID/path/token 隔离；
- Intent/Fact description 必填、非空、长度受限，Artifact 不能替代 description；
- Artifact streaming、hash、size、path traversal、symlink 和 GC；
- 跨 scope/不存在/Goal FactRef 被拒绝；
- 并发 conclude 只有一个成功；
- completed 后晚到 conclude 被拒绝；
- Project 完成不等待其他 Project 或 pending broadcast；
- 跨 Project 不复制 Fact/Artifact；
- completed Project 继续提供证明；
- Runtime 重启后 open Intent 可重新执行；
- FederationBus 从 `main.log` 恢复；
- Supervise 按配置周期轮询 active Graph，每轮最多写一个非重复 Hint；
- Supervise 只允许 hint/noop，不能创建 Intent/Fact 或完成 Project；
- Supervisor Hint 会触发 Plan，stopped/completed Project 不再监督；
- 每个 Plan/Supervise/Execute/Finalize 在 `logs/graph-<timestamp>-<phase>.yaml` 留下不可变图上下文；
- 不存在逐次 output 文件，stdout/stderr 只保存在有上限的内存 buffer；
- 错误日志只输出 bounded preview；
- Worker 不获得 Graph/HTTP/SQLite 权限；
- 严格 JSON 合同；
- 单 Project 和跨 Project 完整 lifecycle。

```bash
npm run typecheck
npm run build
npm test
npm run smoke
npm run pack
```
