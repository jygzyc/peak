# 06 · Worker 后端适配（`src/worker/backends/`）

> 审计范围：8 个文件——`types.ts`（契约）、`registry.ts`（注册表）、`subprocess.ts`（共享子进程基类）、`codex.ts`、`claude.ts`、`opencode-cli.ts`、`opencode-http.ts`、`process.ts`。
> 本层是 worker 的「底层适配器」：把 prompt + WorkerConfig 翻译成具体 CLI 调用或 HTTP 请求，返回原始文本 + 进程元数据。不含调度/state。

---

## 6.1 `types.ts`（31 行）— 后端契约

### 用途
**AgentBackend 契约**：后端是 OpenCode/Codex/Claude Code/自定义命令等交互或一次性 agent runtime 的底层适配器，收 prompt + WorkerConfig，返回原始文本 + 进程元数据。

### 关键导出
- `AgentBackend`（interface）：`id`/`invoke(input)`/`supportsConclude?`
- `BackendInvokeInput`：`prompt`/`config`/`cwd?`/`conclude?`/`partialOutput?`
- `BackendInvokeResult`：`text`/`returncode`/`stderr?`/`timedOut?`

### 审计要点
- 🚨 **`conclude`/`partialOutput`/`supportsConclude` 全是死协议**（codegraph 确认：仅 types.ts 内出现，无任何 backend 实现或调用方）：`BackendInvokeInput.conclude?`/`partialOutput?` 从不被 `AgentDriver.invoke` 传入（§5.4 只传 prompt/config/cwd），`AgentBackend.supportsConclude?` 无任何 backend 声明。是**预留未实现的「流式/提前结束」协议**。
- ⚠️ **`invoke` 返回 `Promise | BackendInvokeResult` 混返**：与 `registry.ts` executeWorker 同款问题，调用方需兼容。
- ⚠️ **`BackendInvokeResult.stderr?` 可选**，但 `base.ts` 的 `WorkerResult.stderr` 非可选——`AgentDriver` 用 `?? ""` 兜底（§5.4），跨层类型不一致。
- ✅ 契约极简，6 个字段。

### 跨文件观察
- 被 `subprocess.ts`（基类）、`opencode-http.ts`（直连）、`registry.ts`（注册）使用。

---

## 6.2 `registry.ts`（48 行）— 后端注册表

### 用途
**backend id → AgentBackend 实现的映射**。AgentDriver 用它解析配置 worker 的底层 runtime。

### 关键导出
- `registerAgentBackend(backend): () => void`（返回 unregister 函数，支持还原）
- `getAgentBackend(id)`/`listAgentBackendIds()`
- re-export `ProcessBackend`

### 初始化
模块加载时 `REGISTRY.set` 注册 5 个 builtin：`claude-code`/`codex`/`opencode`/`opencode-http`/`process`。

### 审计要点
- ⚠️ **模块加载副作用**（18–26 行）：import 本模块即注册 5 个 backend，副作用在顶层执行。若测试想隔离 registry，需手动 unregister。`registerAgentBackend` 返回还原函数，但 builtin 注册未保留还原句柄。
- ⚠️ **`registerAgentBackend` 的还原判断**（31–35 行）：`if (REGISTRY.get(id) === backend)` 才还原——若期间被第三方覆盖，unregister 不操作，合理但隐晦。
- ⚠️ **`listAgentBackendIds` 给 `workerCapabilities` 用**，输出顺序依赖 Map 插入序。
- ✅ unregister 模式优雅，支持测试隔离与临时注册。
- ✅ re-export `ProcessBackend` 便于 `AgentDriver.resolveBackend` 直接 new。

### 跨文件观察
- 被 `agent-driver.ts`（getAgentBackend + ProcessBackend）、`registry.ts`（worker 层，listAgentBackendIds）使用。

---

## 6.3 `subprocess.ts`（97 行）— 子进程基类

### 用途
**命令式后端的共享子进程执行器**。处理 spawn、stdin/prompt 投递、超时、stdout/stderr 捕获、结果整形，使各 backend adapter 保持小巧（文件头 1–7 行）。

### 关键导出
- `SubprocessBackend`（abstract class，implements `AgentBackend`）：抽象 `buildArgv(config, prompt): {argv, env?, input?}`，实现 `invoke`

### 常量
- `SPAWN_ERROR_RETURNCODE = 127`
- `DEFAULT_TIMEOUT_MS = 600_000`（10 分钟）
- `MAX_STDOUT_BYTES = 10MB`

### invoke 流程
1. `buildArgv` 得 argv/env/input
2. `spawn(argv[0], argv.slice(1), {cwd, stdio, env: {...process.env, ...env, DECX_AGENT_ACTIVE:"1"}})`
3. 若有 input：写 stdin 后 end
4. stdout 累积，超 10MB 则 SIGTERM
5. stderr 累积（同 10MB 上限）
6. `setTimeout(timeoutMs)` 超时 SIGTERM + `timedOut=true`
7. `close` 事件：拼 stdout/stderr，超时/信号走 SPAWN_ERROR，否则正常 returncode

### 审计要点
- 🚨 **`spawn(built.argv[0], ...)`**：argv[0] 是命令名（如 `"codex"`/`"claude"`/`"opencode"`），未用全路径，依赖 `PATH` 解析——**PATH 劫持风险**：若恶意/被污染的 PATH 目录含同名可执行，会执行任意代码。结合下游 backend 的 `--dangerously-*` 标志（§6.4/§6.5），放大 RCE 面。
- 🚨 **prompt 经 argv 传递**（`["codex","exec",..., "--", prompt]`）：prompt 是 graph 内容（含 attacker-controlled 的 fact/intent description），进 argv 时若含特殊字符可能被 shell 解释——但 `spawn` 不经 shell（无 `shell:true`），argv 直传，OK。但 `process.ts` 的 `input: prompt` 走 stdin，更安全。
- ⚠️ **超时 SIGTERM 后无 SIGKILL 兜底**（67–70 行）：子进程可忽略 SIGTERM，导致 zombie；`finish` 在 close 事件才 resolve，超时但子进程不退则 Promise 永悬。
- ⚠️ **`child.removeAllListeners()`**（第 43 行）：finish 时移除监听，但未 `child.kill()`（除非超时/超量）；若 close 已触发但 stdout 仍有 buffered data，可能丢失。
- ⚠️ **stderr 10MB 上限静默截断**（61–65 行）：超限不再 push，但无标记，下游不知道 stderr 被截。
- ⚠️ **`timedOut: timedOut || undefined`**（第 84 行）：`false || undefined` = undefined，非超时路径不写 timedOut 字段——语义 OK 但 `BackendInvokeResult.timedOut?` 本就可选。
- ⚠️ **`env: {...process.env, ...}`**：把整个 process.env 透传给子进程，若主进程 env 含敏感（如 `OPENAI_API_KEY`）会泄漏给 backend CLI——本意是让 backend 能读 key，但无白名单过滤。
- ✅ stdin/stdout/stderr 三 pipe 完整，10MB 防爆。
- ✅ `settled` 标志防重复 resolve。

### 跨文件观察
- 被 `codex.ts`/`claude.ts`/`opencode-cli.ts`/`process.ts` 继承。是所有命令式 backend 的执行核心。

---

## 6.4 `codex.ts`（52 行）— Codex CLI 后端

### 用途
适配 decx-agent worker 请求到 **Codex CLI**。是 AgentDriver 背后的一个可执行 backend；调度/role prompt/graph state 由上层处理（文件头 1–7 行）。

### 关键导出
- `CodexBackend`（class，extends `SubprocessBackend`）：`id = "codex"`

### buildArgv
```
argv = ["codex", "exec",
  "--dangerously-bypass-approvals-and-sandbox",
  ...modelFlags, ...providerFlags,
  "--", prompt]
env = envFor(config)
```
- `modelFlags`：`config.model ?? process.env.CODEX_MODEL` → `["--model", m]`
- `providerFlags`：`config.baseUrl ?? process.env.CODEX_BASE_URL` → 一组 `-c key=value` 配置（model_provider/wire_api/base_url/env_key 等）
- `envFor`：`apiKeyEnv ?? "OPENAI_API_KEY"` 读 env，有则 `{OPENAI_API_KEY: key}`

### 审计要点
- 🚨 **`--dangerously-bypass-approvals-and-sandbox`**（第 19 行）：默认禁用 Codex 的审批与沙箱。LLM 输出（可被 prompt injection 控制，因 graph 的 fact/intent description 来自分析目标，含 attacker-controlled 内容）可触发**任意系统调用**。结合 §6.3 的 PATH 风险，构成 **prompt injection → RCE** 链。
- 🚨 **providerFlags 的 `-c` 配置注入**（38–43 行）：`base_url="${baseUrl}"` 直接插值进 `-c` 参数，baseUrl 来自 config/env；若 baseUrl 含 `"` 或换行，破坏 codex 配置语法。无转义。
- ⚠️ **`model_reasoning_effort="high"` 硬编码**（第 41 行）：不可配，可能与用户期望不一致。
- ⚠️ **`env_key="OPENAI_API_KEY"` 硬编码**（第 43 行）：即便 config.apiKeyEnv 指向别的 env，provider 配置仍要求 OPENAI_API_KEY——envFor 也只设 OPENAI_API_KEY，apiKeyEnv 配置项形同虚设。
- ⚠️ **无 `--resume` / session 复用**：与 `WorkerSessionManager`（§5.7）的 sessionReuse 假设矛盾——codex backend 不支持 resume，但 profile 可配 `sessionReuse:true`，manager 会建 session 但 codex 不认。
- ✅ envFor 的 key 缺失返回 undefined，不污染 env。

### 跨文件观察
- 注册到 backend registry（id `codex`）；`BUILTIN_WORKER_CONFIGS.codex = {kind:"agent", backend:"codex"}`。

---

## 6.5 `claude.ts`（32 行）— Claude Code CLI 后端

### 用途
把 worker 调用翻译成 **claude-code CLI** 调用。文件保持 thin，通用子进程行为委托 shared helper（文件头 1–7 行）。

### 关键导出
- `ClaudeBackend`（class，extends `SubprocessBackend`）：`id = "claude-code"`

### buildArgv
```
argv = ["claude", "--dangerously-skip-permissions", "-p", "--", prompt]
env = envFor(config)
```
- `envFor`：`ANTHROPIC_MODEL`（若 config.model）、`ANTHROPIC_BASE_URL`（若 config.baseUrl）、`ANTHROPIC_AUTH_TOKEN`（从 `apiKeyEnv ?? "ANTHROPIC_API_KEY"` 读）

### 审计要点
- 🚨 **`--dangerously-skip-permissions`**（第 17 行）：与 codex 同款，默认跳过 claude-code 的权限确认。LLM 输出可触发任意文件读写/命令执行。叠加 prompt injection → RCE。
- ⚠️ **`ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY`**（第 29 行）：把 apiKeyEnv（默认 ANTHROPIC_API_KEY）的值映射到 `ANTHROPIC_AUTH_TOKEN`——两个 env 名不同，claude-code 实际认哪个需核实；若 claude-code 读 ANTHROPIC_API_KEY 而非 AUTH_TOKEN，则鉴权失败。
- ⚠️ **无 `--resume` / session 复用**：与 codex 同，profile 配 sessionReuse 无效。
- ⚠️ **`-p`（print 模式）+ `--` prompt**：argv 形式清晰，但无 model 之外的配置透传（config.args 被忽略，对比 opencode-cli 用 config.args）。
- ✅ 极简，env 缺失返回 undefined。

### 跨文件观察
- 注册 id `claude-code`；`BUILTIN_WORKER_CONFIGS["claude-code"]`。

---

## 6.6 `opencode-cli.ts`（34 行）— OpenCode CLI 后端

### 用途
**本地 CLI 执行**的 OpenCode subprocess worker，支持 DECX 专属 env 接线（graph-aware workflow）。HTTP transport 在 opencode-http.ts（文件头 1–7 行）。

### 关键导出
- `OpencodeCliBackend`（class，extends `SubprocessBackend`）：`id = "opencode"`

### buildArgv
```
args = ["run"]
if config.model: args += ["--model", m]
args += ["--print"]
if config.args: args += [...config.args]
args += [prompt]
argv = ["opencode", ...args]
env = { OPENCODE_BASE_URL?, OPENCODE_API_KEY? }
```

### 审计要点
- ⚠️ **`config.args` 透传**（第 19 行）：允许用户在 task.json 给 opencode 加任意参数——若 config.args 含 `--dangerously-*` 类标志，放大权限。对比 codex/claude 的 dangerous 标志是硬编码，opencode 是用户可注入。
- ⚠️ **无 session 复用标志**：`opencode run --print` 是一次性，无 `--resume`/`--session`；与 §6.7 的 http backend「每次 invoke 建 session」一致，但与 WorkerSessionManager 的 sessionReuse 假设矛盾。
- ⚠️ **`OPENCODE_API_KEY` 映射**（第 26 行）：从 `apiKeyEnv ?? "OPENCODE_API_KEY"` 读，写入 env 的同名 `OPENCODE_API_KEY`——若 apiKeyEnv 是别的名（如 `MY_KEY`），读 MY_KEY 写 OPENCODE_API_KEY，OK；但默认两边同名，易混。
- ⚠️ **`--print` 模式**：opencode 的 print 模式输出格式需 backend 外的 parseEnvelope 能解析；若 opencode print 输出含 markdown 围栏或非 JSON，依赖 parse-envelope 的容错。
- ✅ config.args 透传提供灵活性。
- ✅ env 条件构造，缺失返 undefined。

### 跨文件观察
- 注册 id `opencode`；与 `opencode-http`（id `opencode-http`）互补。`AgentDriver.resolveBackend` 的 `transport:"http"` 会找 `opencode-http`（§5.4）。

---

## 6.7 `opencode-http.ts`（95 行）— OpenCode HTTP 后端

### 用途
向运行中的 OpenCode 兼容 HTTP 服务发 prompt，而非起本地进程。适用于 OpenCode session 管理由外部 daemon 拥有的场景（文件头 1–7 行）。

### 关键导出
- `OpencodeHttpBackend`（class，implements `AgentBackend`）：`id = "opencode-http"`

### 常量
- `DEFAULT_BASE_URL = "http://127.0.0.1:4096"`
- `DEFAULT_TIMEOUT_MS = 300_000`（5 分钟）

### invoke 流程
1. `baseUrl = (config.baseUrl ?? DEFAULT).replace(/\/$/,"")`
2. password = `config.password ?? process.env.OPENCODE_SERVER_PASSWORD` → Basic auth（`opencode:password` base64）
3. `POST {baseUrl}/session`（title `decx-agent-${Date.now()}`）→ 取 `session.id`
4. `POST {baseUrl}/session/{id}/message`（body `{parts:[{type:"text", text: prompt}]}`）→ `extractAssistantText`
5. 超时：`maxTokens ? maxTokens*1000 : DEFAULT`

### 审计要点
- 🚨 **每次 invoke 新建 session**（第 21、41–51 行）：注释明说「no cross-turn session reuse ... Cairn model」。但 `WorkerSessionManager`（§5.7）和 `SubagentRunner` 在 `sessionReuse:true` 时会 acquire session 并把 sessionId 传给 backend——**opencode-http 完全忽略传入的 sessionId**（invoke 不读 input.sessionId，BackendInvokeInput 也无此字段）。sessionReuse 对 opencode-http 无效，但 profile 仍可配，语义冲突。
- ⚠️ **超时 = `maxTokens * 1000` ms**（第 63 行）：把 maxTokens（token 数）当毫秒用，语义错位——maxTokens=4096 → 4096 秒超时？还是 4096*1000=4096000ms≈68 分钟？数值荒谬。应独立 timeoutMs。
- ⚠️ **`POST /session` 超时 10s 硬编码**（第 45 行）：与服务端建连，10s 固定。
- ⚠️ **Basic auth 明文 password**（第 35 行）：`Buffer.from(\`opencode:${password}\`).toString("base64")`——base64 非加密，依赖 HTTPS；但默认 baseUrl 是 http://127.0.0.1，本地 OK，跨网络则密码明文。
- ⚠️ **`sessionResp.json() as {id:string}`**（第 50 行）：强转，服务端返回非预期 shape 会运行时崩。
- ⚠️ **`extractAssistantText` 容错**（79–90 行）：处理 `type:"text"` 与 `content:string` 两种 part，但若 part 是 `{type:"tool_use"}` 等非文本，静默跳过——可能丢失 agent 的工具调用信息。
- ⚠️ **无重试**：网络抖动直接 errorResult。
- ⚠️ **session 不删除**：每次 invoke 建新 session，服务端 session 累积，资源泄漏（依赖服务端 GC）。
- ✅ 错误信息含「Is 'opencode serve' running?」提示，UX 友好。
- ✅ baseUrl 末尾斜杠清理。

### 跨文件观察
- 是唯一非 subprocess 的 backend（直连 implements AgentBackend）；与 opencode-cli 互补。`AgentDriver.resolveBackend` 在 `transport:"http"` 时优先找它。

---

## 6.8 `process.ts`（20 行）— 泛型命令后端

### 用途
**配置命令 worker 的泛型后端**。执行 task config 里任意 command/args 定义，是自定义 agent CLI 的逃生舱，同时保留通用 AgentBackend 调用契约（文件头 1–7 行）。

### 关键导出
- `ProcessBackend`（class，extends `SubprocessBackend`）：`id = "process"`

### buildArgv
```
command = config.command ?? "echo"
args = config.args ?? []
return { argv: [command, ...args], input: prompt }
```

### 审计要点
- 🚨 **任意命令执行**（第 16 行）：`config.command` 来自 task.json，无白名单/校验——task.json 可指定 `command: "rm"`、`args: ["-rf","/"]`，被 `SubprocessBackend.spawn` 执行。是设计意图（escape hatch），但若 task.json 来源不受信（如从 graph/外部输入生成），是 RCE。
- ⚠️ **默认 `command = "echo"`**（第 16 行）：未配 command 时 echo prompt，returncode 0，stdout=prompt——静默「成功」但无意义，易误导调试（看似 worker 正常实则没跑 agent）。
- ⚠️ **prompt 走 stdin**（`input: prompt`）：比 argv 传更安全（无 argv 注入），但 echo 默认不读 stdin——默认配置下 prompt 被丢弃。
- ⚠️ **`AgentDriver.resolveBackend` 回退 new ProcessBackend**（§5.4 第 49 行）：`config.command` 存在时回退，但 ProcessBackend 不读 `config.backend`/`config.transport`，纯 command/args。
- ✅ 极简，职责单一。
- ✅ escape hatch 设计合理，给自定义 CLI 留口。

### 跨文件观察
- 注册 id `process`；被 `agent-driver.ts` 在 `config.command` 存在且无注册 backend 时回退使用，也在 `backends/registry.ts` re-export 供直接 new。

---

## 跨文件小结（本册）

1. **🚨 安全风险集中地**：codex（`--dangerously-bypass-approvals-and-sandbox`）、claude（`--dangerously-skip-permissions`）默认关审批/沙箱；process（任意 command）；叠加 subprocess 的 PATH 劫持 + 全 env 透传。结合协议层 graph 中 attacker-controlled description 进 prompt → **prompt injection → RCE** 链。建议：sandbox 默认开、PATH 白名单、env 最小化、prompt 经 stdin。
2. **🚨 sessionReuse 协议三层不一致**：`WorkerSessionManager`（§5.7）假设复用 → `SubagentRunner` 在 sessionReuse 时 acquire + 传 sessionId → 但 `opencode-http` 每次新建 session 忽略传入 sessionId，`codex`/`claude`/`opencode-cli` 无 `--resume`。**sessionReuse 对所有 builtin backend 无效**，仅 ConfiguredProvider（model 层）可能支持。
3. **🪦 死协议**：`BackendInvokeInput.conclude?`/`partialOutput?`/`AgentBackend.supportsConclude?`——预留的流式/提前结束协议，零实现零调用。
4. **⚠️ opencode-http 超时 = maxTokens×1000**：token 数当毫秒，数值荒谬。
5. **⚠️ subprocess 超时无 SIGKILL 兜底**：zombie 子进程风险。
6. 本册是安全审计重点，建议优先修 §1（默认关 dangerous、PATH/env 收敛）与 §2（sessionReuse 文档对齐或实现 resume）。
