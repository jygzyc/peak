# Peak

## 1. 整体架构

### 1.1 顶层角色

顶层 Supervisor 负责在不同 Project 之间分派资源。每个 Project 对应一个任务，由该 Project 的 Planner 负责规划与执行。

创建 Project 时，需要同时初始化 Planner、Metacog 以及该 Project 对应的图数据库。

### 1.2 Project 角色

| 环节 | 作用 |
| --- | --- |
| Planner | 将大型任务拆分为原子任务，例如分析指定类、获取指定组件信息等；创建 Intent 并启动 Explorer |
| Explorer | 完成原子任务，并将 candidate Fact 写入图中 |
| Evaluator | 在出现 candidate Fact 时触发，判断 Fact 是否准确；接收到 Fact 广播时也会触发 |
| Metacog | 在每个 Fact pass 入图时以及整个分析流程结束时触发，负责整体纠偏与广播 |

每个角色都有一个以格式化字符串定义的初始 System Prompt，用于简洁、明确地说明自身职责。角色支持高度定制，例如可以同时配置 `explorer_gather`、`explorer_analysis` 等多个 Explorer。

每个角色都可以通过配置文件注入特定 Prompt，以执行指定领域的任务，同时也支持接入相应的领域知识、规范和 Skill。

每个角色都继承 Base Agent，并可配置允许访问的数据端口、Prompt、Tool 和 Skill。运行期间，Base Agent 只在当前 Project 的 `logs/` 目录下生成以时间戳命名的 context/output JSON 文件。

以下是一个 System Prompt 示例：

```ts
const PLANNER_SYSTEM_PROMPT = `
<SYSTEM_ROLE>
# Planner Role

You are the project-local planner. Read the supplied Graph snapshot, Hints, and evaluator results, then decide the next Graph actions.

## Responsibilities

- Expand pass Fact branches that still require work into small, independent Intents. One Intent must fit one Explorer execution and produce one candidate Fact.
- On the initial Graph revision, decide whether the task can be attempted end to end by one bootstrap-style Explorer. If so, create one ordinary Intent and route it to that Explorer profile.
- Use the from field only for verified parent Facts that are genuine prerequisites.
- Explicitly dispatch work that should start; an open Intent is not executable until dispatched.
- React to Hints and verdicts. Fail an Intent only when the available evidence establishes a dead-end.
- Stop an active explorer when its work is no longer useful without automatically denying its Intent.
- Create new Intents only from pass Facts. Expanding a pass Fact makes its subtree active without changing the Fact verdict.
- Decide from Fact semantics whether the task requires more work. Produce no new Graph action when the current root subtree is sufficient and settled.

## Boundaries

- Do not inspect the workspace, use tools, perform an Intent, or create or judge Facts.
- Do not repeat known dead-ends or create speculative dependencies.
- Do not declare the Project completed directly.
- Return only the JSON required by the output contract appended to this prompt.
</SYSTEM_ROLE>

<USER_ROLE>
${USER_PROMPT}
</USER_ROLE>

<EXPLORER_ROLES>
${EXPLORER_ROLES}
</EXPLORER_ROLES>

<NEEDED_TOOLS>
${NEEDED_TOOLS}
</NEEDED_TOOLS>

<NEEDED_SKILLS>
${NEEDED_SKILLS}
</NEEDED_SKILLS>

<GRAPH_CONTEXT>
${GRAPH_CONTEXT}
</GRAPH_CONTEXT>

<INPUT_CONTRACT>
${INPUT_CONTRACT}
</INPUT_CONTRACT>

<OUTPUT_CONTRACT>
${OUTPUT_CONTRACT}
</OUTPUT_CONTRACT>`;
```

## 2. Server 与 Graph 边界

### 2.1 Server 端

Server 面向不同 Project 提供统一的 RESTful 接口，用于访问图数据库。所有接口均通过 POST 请求调用。

数据库必须持久化到对应的 Project 中。禁止使用内存数据库、临时数据库或其他非持久化状态源。

Federation 不建表、不创建独立数据库；广播发送与接收记录持久化到各 Project 的 `logs/main.log`。

各 Project 角色在构造 Prompt 时，会根据各自权限向 Server 发起请求。查询结果以标准 JSON 格式存储，并按照统一的命名规则落地到对应的 Project 目录。最后，将文件引用、标准 Prompt 和定制 Prompt 一并加载到 Prompt Builder。

### 2.2 访问边界

Graph 的状态流转与 Server 强绑定。所有角色都只能通过 Server 间接影响 Graph，不能直接访问或修改 Graph。

因此，Server Graph 不应依赖任何角色，任何角色也不应直接操作数据库。

Planner、Explorer、Evaluator 和 Metacog 均不得获得数据库对象或数据库文件。角色只能读取 Server 按 Profile 生成并落地的标准 JSON 文件，也只能输出标准 JSON。输出先落地，再由 Server 校验权限和合同，最后提交到 Graph。

## 3. Worker 执行层

Worker 层采用 Driver 与进程执行器分离的结构：

```text
BaseAgent
  -> WorkerPool
  -> WorkerDriver
     ├── build execute invocation
     ├── build resume invocation
     ├── prepare or extract sessionRef
     └── extract assistant response
  -> ProcessRunner
     ├── spawn one CLI process
     ├── timeout and cancellation
     ├── stdout and stderr capture
     └── structured process result
```

每次 Worker 调用只启动一个 CLI 进程。Worker 不维护常驻 Agent 进程；跨调用连续性由 Agent CLI 自己持久化的 session 提供。

### 3.1 WorkerDriver

每种 CLI 对应一个 Driver。Driver 只负责该 CLI 的协议差异：

```ts
interface WorkerDriver {
  readonly type: WorkerType;
  readonly canResume: boolean;

  checkHealth(config: WorkerConfig, timeoutMs: number): Promise<HealthResult>;
  prepareSession(config: WorkerConfig): SessionRef | undefined;
  buildExecute(config: WorkerConfig, prompt: string, sessionRef?: SessionRef): ProcessSpec;
  buildResume(config: WorkerConfig, prompt: string, sessionRef: SessionRef): ProcessSpec;
  extractSession(
    prepared: SessionRef | undefined,
    result: ProcessResult,
  ): SessionRef | undefined;
  extractResponseText(result: ProcessResult): string;
}
```

- `prepareSession` 用于支持预分配 session id 的 CLI；
- `extractSession` 用于从 stdout、stderr 或结构化事件中获得 CLI 实际创建的 session id；
- `buildExecute` 构造首次单步调用；
- `buildResume` 构造恢复同一 Agent session 的第二次单步调用；
- `extractResponseText` 只提取 Assistant 最终文本，不解析角色 JSON 合同；
- Driver 不读取 Graph、不选择角色、不处理权限，也不决定何时恢复调用。

`checkHealth` 只验证对应 CLI 是否可执行以及 CLI 自身配置是否可用，不让 Peak 接管 Provider 认证，也不引入模型 API。健康检查失败只影响 Worker 可选性，不能写入 Graph。

`SessionRef` 包含 Worker 类型和该 Driver 返回的不透明 session 值。上层只能把 session 值原样交回同一个 Driver，不能解析、改写或跨 Worker 类型复用。

`SessionRef` 的生命周期严格限定在一次角色执行：

- Planner 每次处理新的 Graph revision 都启动新的 Agent CLI session；
- Explorer、Evaluator 和 Metacog 的每次正常调用也启动新的 Agent CLI session；
- 只有同一次角色执行内部的 execute→resume 收尾可以复用 `SessionRef`；
- 角色重试启动新的 Agent CLI session，不恢复上一次失败 attempt；
- `SessionRef` 不进入 Graph、RoleContext、角色输出、日志 checkpoint 或 Project 恢复状态。

Peak Project 与 Agent CLI session 是完全不同的概念。Project 通过持久化 Graph 保持任务连续性；Agent CLI session 只为一次 Worker 调用链保留短期上下文。

不同 CLI 可以使用不同的 session 策略：

- 预先生成 session id，并在首次调用时显式传入；
- 首次调用后从 stderr 诊断信息提取；
- 从 stdout 的结构化 session 事件提取；
- CLI 不可靠支持恢复时，将 `canResume` 设为 `false`。

每个 Driver 的 execute/resume 命令必须通过集成测试验证，不能根据其他 CLI 的参数形式推断。

### 3.2 ProcessRunner

ProcessRunner 统一负责进程机制，不包含任何 Agent 或角色语义：

```ts
interface ProcessResult {
  stdout: string;
  stderr: string;
  returncode: number;
  timedOut: boolean;
  cancelled: boolean;
  cancelReason?: string;
}

interface WorkerExecutionResult {
  result: ProcessResult;
  responseText: string;
  sessionRef?: SessionRef;
}
```

ProcessRunner 必须：

- 使用参数数组和明确的 stdin 传递，不通过 shell 拼接动态 Prompt；
- 为每次调用创建独立子进程；
- 持续收集 stdout 和 stderr，以便进程退出后提取 `sessionRef`；
- timeout 时先请求进程组正常终止，经过短 grace period 后强制终止；
- cancellation 与 timeout 分开表达，不能只编码到通用非零退出码或错误字符串；
- 终止整个子进程树，避免 Agent CLI 启动的工具进程成为 orphan；
- 限制 stdout/stderr 大小，并返回结构化失败原因。

### 3.3 WorkerPool 边界

WorkerPool 对上层提供两种单步调用：

```ts
execute(request): Promise<WorkerExecutionResult>
resume(request, sessionRef): Promise<WorkerExecutionResult>
```

`resume` 不是新的角色执行，也不对应新的 Graph operation。调用者负责决定是否允许恢复；WorkerPool 只验证：

- Worker 类型与 `sessionRef` 来源一致；
- 当前 Driver 的 `canResume` 为 `true`；
- `sessionRef` 属于当前角色 execution id；
- resume 调用使用独立 timeout 和 cancellation signal。

Worker 配置仍只包含 CLI 执行参数，例如 `type`、`model`、`args` 和 `timeoutMs`。认证、Provider 和 session 文件继续由对应 Agent CLI 管理；Peak 不增加模型 API 或 Provider SDK。

## 4. Graph 与状态流转

每个 Project 仅使用一张图：

```text
~/.peak/projects/<project-id>/analysis.db
```

Project 创建时即创建 Fact，而不是把起点和目标仅保存在 Task 配置中：

- `origin` 是唯一 root Fact，内容来自 `task.target`；
- `task.goal` 也会成为一个 normal Fact，并通过初始化 system Intent 与 root 相连；
- Goal 只描述初始任务方向，不是 Fact 的结构类型，也不是唯一完成节点；
- 后续 Explorer 产出的 Fact 都是 normal Fact；
- 某个 Fact 是否足以完成任务、是否仍需派生 Intent，由 Planner 根据 Fact 内容和 Task 语义判断；
- 不存在特殊 `goal` 类型或独立于 DAG 的结束节点。

### 4.1 Intent

Intent 是 DAG 的边。

```text
open     待做
claimed  Explorer 正在执行，占位防重
pass     做完，产出 candidate Fact
deny     dead-end，由 Planner 根据 pass Fact 判断
```

### 4.2 Fact

Fact 是 DAG 的节点。

```text
candidate  初始状态，刚产出，等待审查
pass       已采纳，可作为 Intent 的 parent
deny       已判定不成立，不可作为 Intent 的 parent
pending    存在尚未满足的前置条件，挂起等待，不可作为 Intent 的 parent
```

Fact 还具有结构类型：

```text
root    唯一根节点
normal  初始 Goal 和 Explorer 产出的普通 Fact
```

结构类型只描述 Fact 在 DAG 中的位置，不表达领域语义。`origin` 是唯一 `root`，创建时即为 `pass`，不可被否决、挂起或重新创建。其余 Fact 一律为 `normal`。

Fact verdict 表达对事实真假的判断：

- `pass` 表示该 Fact 为真，可以作为新 Intent 的 parent；
- `deny` 表示该 Fact 不成立，永久保留用于审计和避免重复探索，但不能继续扩展；
- `pending` 表示该 Fact 已经被确认是事实，但它声明的前置条件尚未被当前 Graph 中的 `pass` Fact 满足，因此暂时挂起且不能继续扩展；
- Planner 不得修改 Fact verdict，也不得从 `deny` 或 `pending` Fact 创建 Intent。

Evaluator 对新 `candidate` Fact 可以给出 `pass`、`deny` 或 `pending`。将 Fact 设为 `pending` 时必须同时记录结构化前置条件，不能只给出一段等待原因。

Fact verdict 的合法状态流转固定为：

```text
candidate -> pass | deny | pending
pending   -> pending | pass
```

`pass` 和 `deny` 都是最终状态。`pending` Fact 不会退回 `candidate`，也不会变成 `deny`。后续新的本地 `pass` Fact 或 Federation 广播出现时，Evaluator 直接复核其前置条件：条件仍未满足则保持 `pending`，全部满足则转为 `pass`。

### 4.3 End 语义

`end` 不是第五种 Fact verdict，也不单独持久化。它是根据当前 DAG 递归计算的子树状态。

Fact 的本地审查已经结束，当且仅当其 verdict 为：

```text
pass | pending | deny
```

`candidate` 仍在等待 Evaluator，因此不属于 end。

Intent 在以下任一情况下属于 end：

- Intent 为 `deny`；
- Intent 为 `pass`，并且它产出的 Fact 子树已经 end。

Fact 子树在以下条件全部满足时属于 end：

- Fact 的本地审查已经结束；
- 从该 Fact 出发的所有 Intent 都已经 end；
- 不存在从该 Fact 出发的 `open` 或 `claimed` Intent。

因此，一个没有子 Intent 的 `pass`、`pending` 或 `deny` Fact 是 end；非叶 Fact 只有在全部子分支都 end 后才是 end。父节点的 end 状态由子节点递归决定，不单独持久化。

Fact verdict 与子树是否 end 相互独立：

- Planner 从一个已结束的 `pass` Fact 创建新 `open` Intent 后，该 Fact 仍然是 `pass`，但它及其祖先子树立即不再是 end；
- 新的本地 `pass` Fact 或 Federation 广播出现后，Evaluator 可以复核 `pending` Fact；复核期间 Fact 保持 `pending`，结果只能继续 `pending` 或转为 `pass`；
- `deny` Fact 不能被重新激活，也不能产生子 Intent；
- 上述变化不删除历史 Fact、Intent、verdict 或审计记录。

### 4.4 Intent Sets

基于多个 Fact 创建 Intent 时，通过 `intent_sets` 记录它们之间的关系。

### 4.5 Hint

Hint 是独立节点，用于关联并影响结论（Fact / Intent）。用户在任务执行过程中输入的内容也视为 Hint。

### 4.6 Bootstrap 快速路径

Bootstrap 不是新的角色、Fact 类型、Intent 类型或 Graph 状态，而是 Planner 在初始图上的一种路由决策。

Planner 第一次读取 root 子树时，需要判断当前任务是否适合由单个 Explorer 做一次端到端尝试：

- 预计一次 Explorer 执行可以覆盖主要工作；
- 当前尚无 Explorer 产出的 Fact；
- 当前没有其他 `open` 或 `claimed` Intent；
- `EXPLORER_ROLES` 中存在描述与该任务匹配的 bootstrap 风格 Explorer。

满足条件时，Planner 创建一个普通 Intent，以相关 `pass` Fact 为 parent，并将其路由到该 Explorer。Graph 不保存 `bootstrap` 标记，也不使用保留 Intent；定制能力来自 Explorer Profile 的 description、Prompt、Tool 和 Skill。

Bootstrap 风格 Explorer 与普通 Explorer 使用相同协议：

```text
Planner
  -> ordinary Intent
  -> bootstrap-style Explorer
  -> candidate Fact
  -> selected Evaluator
  -> pass | deny | pending
```

Bootstrap 不能绕过 Evaluator，也不能直接结束 Project。Fact 变为 `pass` 后，Planner 根据最新 Graph 判断它是否已经足以完成任务；如果无需继续创建 Intent，控制面再按统一结束条件完成 Project。若结果为 `deny` 或 `pending`，Planner 继续按普通图规划。

### 4.7 Explorer 失败收尾

Explorer 始终只有一种正常输出：符合 `candidate_fact` 合同的标准 JSON。超时或首次输出解析失败不引入第二种输出协议，但会触发第二次单步 Worker 调用。

两次调用是两个独立的 CLI 进程，通过 Agent CLI 自身持久化的 session 续接上下文：

```text
execute(explorerPrompt)
  -> first CLI process
  -> { result, sessionRef }
  -> timeout or invalid JSON
  -> resume(sessionRef, finalizePrompt)
  -> second CLI process
  -> standard candidate_fact JSON
```

控制面不会向仍在运行的进程写入第二段 stdin。第一次调用超时后先终止该 CLI 进程；首次输出解析失败时，该进程已经正常退出。随后 Worker backend 使用 `sessionRef` 启动一个新的 CLI 进程并恢复同一个 Agent session。

提前结束必须满足：

- Worker backend 支持返回 `sessionRef` 并以该引用恢复 Agent session；
- Explorer 主执行已经实际启动；
- 失败原因是超时或输出格式错误；
- 当前 Project 仍允许执行角色，且该 Intent 仍为 `claimed`；
- 本次 Explorer 执行尚未请求过提前结束。

第二次单步调用使用专门的 finalize Prompt，但仍属于同一次 Explorer 角色执行。该 Prompt 要求 Agent：

- 不继续执行任务；
- 不启动新工具或等待仍在运行的工作；
- 只总结当前 session 已经获得且可以举证的事实；
- 不判断 Fact verdict，不绕过 Evaluator；
- 立即返回与正常 Explorer 完全相同的 `candidate_fact` JSON。

提前返回的结果与正常返回没有任何协议差异：

```text
Explorer candidate_fact JSON
  -> Server validates candidate_fact
  -> Intent claimed -> pass
  -> normal candidate Fact
  -> Evaluator gate
```

Worker backend 为此提供两个底层机制：

- 首次单步调用返回或从事件流中提取 `sessionRef`；
- 恢复调用根据 Worker 类型构造相应的 resume 命令。

`sessionRef`、当前执行阶段以及是否已进行恢复调用都只属于本次执行的内存状态，不写入 Graph。两次调用复用同一个 immutable RoleContext artifact 和 assignment，第二次调用不能读取更新后的 Graph 后改变任务边界。

控制面不增加输出 kind，也不写额外 Graph operation。如果 Worker 不支持 session 恢复、第一次执行未获得 `sessionRef`、第二次调用仍不是合法标准 JSON，或当前没有可举证事实，则本次 Explorer 失败：不创建 Fact、不伪造 `deny`，并将 Intent 释放回 `open`。外部取消、用户 stop、Directive kill 或 Worker 尚未启动时不得启动恢复调用。达到 Profile retry 上限后沿用统一失败处理。

## 5. 多 Project 与任务结束

多个 Project 同时执行时，可以通过相同 federation scope 组成一组关联任务。

Planner 不直接改变 Project 的完成状态。每次 Graph、Hint 或广播发生有效变化后，Planner 必须先消费最新 Graph revision，并根据 Fact 语义判断是否还需要创建 Intent。Planner 没有产生新 Intent 时，控制面才可以检查结束条件。

单个 Project 在以下条件全部满足时结束：

- `origin` 的整棵子树已经 end；
- 不存在 `open` 或 `claimed` Intent、`candidate` Fact 或活动角色执行；
- Planner 已处理当前最新 Graph revision，并且没有产生新的 Graph action；
- Metacog 已审查本轮新增的 `pass` Fact；
- 不存在该 Project 尚未处理的 Fact 广播。

`pending`、`pass` 和 `deny` 都是合法的分支终点。项目完成表示 Planner 判断当前事实已经足够、没有创建更多 Intent，并且整棵 root 子树自然收敛；它不依赖任何预先标记的 Goal Fact。

同一 ProjectGroup 中的所有 Project 都满足上述条件，并且组内不存在待处理广播时，整组任务结束。后续 Hint 可以促使 Planner 从已有 `pass` Fact 创建新 Intent；新的本地 `pass` Fact 或相关广播也可以触发 `pending` Fact 的条件复核。`pending` 转为 `pass` 后，Planner 可以从该 Fact 创建新 Intent，使对应子树再次进入执行状态。

## 6. UI

UI 通过 Server 获取统一的图状态，并在 Web 页面中绘制，展示效果参考 Cairn。

用户可以随时通过 UI 注入 Hint。图中需要清晰展示整个任务的 DAG 结构：

- Fact 是节点；
- Intent 是边；
- Hint 是独立节点。

## 7. Task 配置

### 7.1 单个 Task 结构

Task 位于当前 Workspace 目录：

```text
workspace/
├── task.json
├── <task-agent>.json
└── skills/
    ├── skill-1/SKILL.md
    └── skill-2/SKILL.md
```

- `task.json`：任务基础配置。
- `<task-agent>.json`：当前 Task 的角色配置包，用于定义角色、`description`、Prompt、Tool、Skill 名称、Context 和 Worker 引用。`description` 是必填字段，Planner 会加载该描述，并在分发任务时以此为依据指定角色。
- `skills/<name>/SKILL.md`：当前 Task 的 Skill 源。任务初始化时，根据 Worker 创建软链接并完成安装。

Task 的 `agent` 用于加载同目录下的 `<name>.json`；省略该字段时使用原生角色。Agent JSON 负责定义定制 Prompt、Tool、Skill 名称和 Worker 引用。

`task.target` 是 root Fact 的描述。`task.goal` 创建一个与 root 相连的初始 normal Fact，但它不具有特殊结构语义，也不是唯一终点。开放性任务可以产生任意数量的 normal Fact，Planner 根据当前事实决定是否还需要继续探索。

### 7.2 Skill 安装位置

```text
OpenCode、Pi Agent -> ~/.agents/skills
Claude Code        -> ~/.claude/skills/
```

## 8. Peak Home 与持久化目录

```text
~/.peak/
└── projects/
    ├── .project.yaml
    └── <project-id>/
        ├── analysis.db
        └── logs/
            ├── <timestamp>-<role>-context.json
            ├── <timestamp>-<role>-output.json
            └── main.log
```

- `analysis.db`：仅保存当前 Project 的任务状态。
- `*-context.json`：Server 为某次角色执行生成的输入。
- `*-output.json`：角色返回并通过合同校验的输出。
- `main.log`：以追加方式记录每次角色输出通过 Server 校验后触发的 Graph 操作，以及 `{projectId, factId, reason}` 广播的发送与接收。

`~/.peak/projects/.project.yaml` 记录当前激活的 Project 及其对应 ID。Project ID 使用随机 UUID。
