# 06 · Worker 后端适配（`src/worker/backends/`）

> 审计范围：8 个文件——`types.ts`（契约）、`registry.ts`（注册表）、`subprocess.ts`（共享子进程基类）、`codex.ts`、`claude.ts`、`opencode-cli.ts`、`opencode-http.ts`、`process.ts`。
> 本层是 worker 的「底层适配器」：把 prompt + WorkerConfig 翻译成具体 CLI 调用或 HTTP 请求，返回原始文本 + 进程元数据。不含调度/state。
> 本次重审重点：**session 复用（resume）已在所有 builtin backend 落地**——`subprocess.ts` 引入 `BuildArgvOptions`（sessionId/conclude）+ `extractSession()` 钩子；codex/claude 走 `--resume`、opencode-cli 走 `--session`、opencode-http 直接复用 `input.sessionId`。`conclude` 标志已透传到 `buildArgv`，不再是死协议。`DEFAULT_TIMEOUT_MS` 从 600_000 降至 300_000。

---

## 6.1 `types.ts`（40 行）— 后端契约

### 用途
**AgentBackend 契约**：后端是 OpenCode/Codex/Claude Code/自定义命令等交互或一次性 agent runtime 的底层适配器，收 prompt + WorkerConfig，返回原始文本 + 进程元数据。

### 关键导出
- `AgentBackend`（interface）：`id`/`invoke(input)`/`supportsConclude?`/`extractSession?(stdout, stderr): string | undefined`
- `BackendInvokeInput`：`prompt`/`config`/`cwd?`/`conclude?`/`partialOutput?`/`sessionId?`
- `BackendInvokeResult`：`text`/`returncode`/`stderr?`/`sessionId?`/`timedOut?`

### 新增/变更
- `AgentBackend` 新增 `extractSession?(stdout, stderr): string | undefined`（15–21 行，带 JSDoc：「从 worker 输出提取可复用 session id，供 conclude-fallback 路径带前序上下文重调；不支持 resume 的 backend 返回 undefined」）。
- `BackendInvokeInput` 新增 `sessionId?: string`（30–31 行，注释 "Reusable worker session id (when the backend supports resume)"）。
- `BackendInvokeResult` 新增 `sessionId?: string`（38 行）。

### 审计要点
- ✅ **`conclude`/`sessionId` 已激活，不再是死协议**：`conclude` 现由 `runSubagentWithText` 的 conclude-fallback 路径从协议层透传（pool→driver→invoke），`sessionId` 端到端贯通（见 [05](./05-worker-core.md) §5.1/5.4/5.5）。
- ⚠️ **`partialOutput?` 仍无消费**：`BackendInvokeInput.partialOutput?` 仍无任何 backend 读取或 driver 传入——是 conclude 协议里唯一仍未接线的遗留字段。
- ⚠️ **`AgentBackend.supportsConclude?` 仍无任何 backend 声明**：extractSession 已全面实现，但 supportsConclude 标志位仍是全空——若调用方靠它判断「能否 conclude」会误判。当前 conclude 路径直接传 conclude 标志，不查 supportsConclude，所以无功能影响，但元数据失真。
- ⚠️ **`invoke` 返回 `Promise | BackendInvokeResult` 混返**：与 `registry.ts` executeWorker 同款问题，调用方需兼容。
- ⚠️ **`BackendInvokeResult.stderr?` 可选**，但 `base.ts` 的 `WorkerResult.stderr` 非可选——`AgentDriver` 用 `?? ""` 兜底（[05](./05-worker-core.md) §5.4），跨层类型不一致。
- ✅ 契约从 6 字段扩到 8，但仍极简；extractSession 是可选钩子（`?`），不破坏旧 backend。

### 跨文件观察
- 被 `subprocess.ts`（基类，实现 extractSession 默认 no-op）、`opencode-http.ts`（直连，实现 extractSession no-op）、`registry.ts`（注册）使用。extractSession 的实际解析逻辑在各具体 backend（codex/claude/opencode-cli）。

---

## 6.2 `registry.ts`（47 行）— 后端注册表

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
- ✅ 注册的 5 个 backend 现在全部支持 session resume（见后续 §），registry 层无需改动。

### 跨文件观察
- 被 `agent-driver.ts`（getAgentBackend + ProcessBackend）、`registry.ts`（worker 层，listAgentBackendIds）使用。

---

## 6.3 `subprocess.ts`（110 行）— 子进程基类

### 用途
**命令式后端的共享子进程执行器**。处理 spawn、stdin/prompt 投递、超时、stdout/stderr 捕获、结果整形，使各 backend adapter 保持小巧（文件头 1–7 行）。**本次新增**：session resume（`BuildArgvOptions`）+ `extractSession()` 钩子。

### 关键导出
- `SubprocessBackend`（abstract class，implements `AgentBackend`）：抽象 `buildArgv(config, prompt, opts?): {argv, env?, input?}`，实现 `invoke`，提供默认 no-op `extractSession()`
- `BuildArgvOptions`（interface，17–21 行）：`sessionId?: string`/`conclude?: boolean`——**新导出的类型**，供子类 buildArgv 接收 session/conclude

### 常量
- `SPAWN_ERROR_RETURNCODE = 127`
- `DEFAULT_TIMEOUT_MS = 300_000`（**5 分钟**，原 600_000/10 分钟已下调）
- `MAX_STDOUT_BYTES = 10MB`

### invoke 流程（33–109 行）
1. `buildArgv(input.config, input.prompt, { sessionId: input.sessionId, conclude: input.conclude })`（34 行）——**透传 sessionId/conclude 给子类**
2. `timeoutMs = input.config.timeoutMs ?? DEFAULT_TIMEOUT_MS`（35 行）
3. `spawn(argv[0], argv.slice(1), {cwd, stdio, env: {...process.env, ...env, PEAK_AGENT_ACTIVE:"1"}})`
4. 若有 input：写 stdin 后 end
5. stdout 累积，超 10MB 则 SIGTERM
6. stderr 累积（同 10MB 上限）
7. `setTimeout(timeoutMs)` 超时 SIGTERM + `timedOut=true`
8. `close` 事件（87–107 行）：拼 stdout/stderr，**`sessionId = this.extractSession?.(stdout, stderr) ?? input.sessionId`（90 行）**——优先用输出解析出的新 session，回退到入参 session；超时/信号走 SPAWN_ERROR，否则正常 returncode；两条路径都回传 `sessionId`

### 新增/变更
- `BuildArgvOptions` 类型（17–21 行）+ `buildArgv` 签名加第三参 `opts?`（26 行）。
- 默认 `extractSession()` no-op（28–31 行，返回 undefined）。
- `invoke` 调 buildArgv 时传入 `{sessionId, conclude}`（34 行）。
- close handler 调 `this.extractSession` 并把 sessionId 写进所有结果分支（90、96、105 行）。
- `DEFAULT_TIMEOUT_MS` 600_000 → 300_000（14 行）。

### 审计要点
- 🚨 **`spawn(built.argv[0], ...)`**：argv[0] 是命令名（如 `"codex"`/`"claude"`/`"opencode"`），未用全路径，依赖 `PATH` 解析——**PATH 劫持风险**：若恶意/被污染的 PATH 目录含同名可执行，会执行任意代码。结合下游 backend 的 `--dangerously-*` 标志（§6.4/§6.5），放大 RCE 面。
- 🚨 **prompt 经 argv 传递**（历史）：prompt 是 graph 内容（含 attacker-controlled 的 fact/intent description）。**现状**：codex/opencode 已改走 stdin（`input: prompt` + argv 末尾 `-`），claude 仍走 argv（`-- <prompt>`）；Windows 上 `spawn` 带 `shell: process.platform === "win32"`，argv 内 prompt 的特殊字符会经 cmd.exe 解释——claude 的 argv prompt 路径仍有注入面。
- ⚠️ **`shell: process.platform === "win32"`**（subprocess.ts:54）：Windows 下 spawn 经 cmd.exe，npm 安装的 CLI（.cmd shim）需要 shell 解析；但 argv 元素被 cmd.exe 二次解释（`&`/`|`/`%VAR%` 等），Node 仅做最小引号转义（DEP0190 警告）。当前 codex/opencode 已规避（stdin），claude 的 argv prompt 仍暴露。
- ⚠️ **超时 SIGTERM 后无 SIGKILL 兜底**（78–81 行）：子进程可忽略 SIGTERM，导致 zombie；`finish` 在 close 事件才 resolve，超时但子进程不退则 Promise 永悬。
- ⚠️ **`extractSession` 解析时机**（90 行）：只在 close handler 跑，超时 SIGTERM 杀进程后 close 仍触发，故超时路径也能提取 session（96 行）——合理，但若 stdout 被截断（超 10MB）解析可能失败。
- ⚠️ **`extractSession ?? input.sessionId` 回退**（90 行）：若子类解析失败（regex 不匹配），回退到入参 sessionId——保证 resume 链不丢，但若入参也空则 sessionId 为 undefined（正常，首次调用）。
- ⚠️ **`child.removeAllListeners()`**（第 54 行）：finish 时移除监听，但未 `child.kill()`（除非超时/超量）；若 close 已触发但 stdout 仍有 buffered data，可能丢失。
- ⚠️ **stderr 10MB 上限静默截断**（72–76 行）：超限不再 push，但无标记，下游不知道 stderr 被截。
- ⚠️ **`env: {...process.env, ...}`**：把整个 process.env 透传给子进程，若主进程 env 含敏感（如 `OPENAI_API_KEY`）会泄漏给 backend CLI——本意是让 backend 能读 key，但无白名单过滤。
- ✅ **sessionId 提取+回传设计健壮**：extractSession 优先（新 session）、入参回退（复用链）、双分支都写——确保 pool 层总能拿到 sessionId。
- ✅ stdin/stdout/stderr 三 pipe 完整，10MB 防爆。
- ✅ `settled` 标志防重复 resolve。
- ✅ `BuildArgvOptions` 导出供子类与外部复用。

### 跨文件观察
- 被 `codex.ts`/`claude.ts`/`opencode-cli.ts`/`process.ts` 继承。是所有命令式 backend 的执行核心，也是 session resume 的中枢：子类只需实现 `buildArgv`（读 opts.sessionId 决定是否加 resume flag）+ `extractSession`（从输出挖 sessionId），其余由基类处理。

---

## 6.4 `codex.ts`（58 行）— Codex CLI 后端

### 用途
适配 peak worker 请求到 **Codex CLI**。是 AgentDriver 背后的一个可执行 backend；调度/role prompt/graph state 由上层处理（文件头 1–10 行）。**本次变更**：prompt 改走 stdin（`-`），不再经 argv；保留 `--resume <sessionId>` 支持 + `extractSession()`。

### 关键导出
- `CodexBackend`（class，extends `SubprocessBackend`）：`id = "codex"`

### buildArgv（17–27 行）
```
argv = ["codex", "exec",
  "--dangerously-bypass-approvals-and-sandbox",
  ...modelFlags, ...providerFlags]
if opts.sessionId: argv += ["--resume", opts.sessionId]
argv += ["-"]                 # 经 stdin 读 prompt（与 opencode-cli 一致）
env = envFor(config)
input = prompt                # 经 stdin 投递
```
- `modelFlags`：`config.model ?? process.env.CODEX_MODEL` → `["--model", m]`
- `providerFlags`：`config.baseUrl ?? process.env.CODEX_BASE_URL` → 一组 `-c key=value` 配置（model_provider/wire_api/base_url/env_key 等）
- `envFor`：`apiKeyEnv ?? "OPENAI_API_KEY"` 读 env，有则 `{OPENAI_API_KEY: key}`

### extractSession（29–32 行）
- `SESSION_RE = /session[: ]+([0-9a-fA-F-]{8,})/i`（12 行）
- 优先扫 stderr，再扫 stdout；匹配则返回捕获组（session id）。

### 新增/变更
- **prompt 投递改为 stdin**：`argv.push("-")` + `input: prompt`，不再 `argv.push("--", prompt)`。原因：Windows cmd.exe 下超长 prompt（planner 的完整图上下文）经 argv 会被截断/引号转义失败（实测 `spawn cmd.exe ENOENT`）；codex CLI 支持 `-` 从 stdin 读。与 `opencode-cli.ts` 的 stdin 方案一致。
- `buildArgv` 第三参 `opts?: BuildArgvOptions`，`opts.sessionId` 时 `argv.push("--resume", opts.sessionId)`（24 行）。
- `extractSession()`（29–32 行）+ `SESSION_RE` 常量（12 行）。

### 审计要点
- 🚨 **`--dangerously-bypass-approvals-and-sandbox`**（第 20 行）：默认禁用 Codex 的审批与沙箱。LLM 输出（可被 prompt injection 控制，因 graph 的 fact/intent description 来自分析目标，含 attacker-controlled 内容）可触发**任意系统调用**。结合 §6.3 的 PATH 风险，构成 **prompt injection → RCE** 链。
- 🚨 **providerFlags 的 `-c` 配置注入**（43–49 行）：`base_url="${baseUrl}"` 直接插值进 `-c` 参数，baseUrl 来自 config/env；若 baseUrl 含 `"` 或换行，破坏 codex 配置语法。无转义。
- ⚠️ **`model_reasoning_effort="high"` 硬编码**（第 47 行）：不可配，可能与用户期望不一致。
- ⚠️ **`env_key="OPENAI_API_KEY"` 硬编码**（第 49 行）：即便 config.apiKeyEnv 指向别的 env，provider 配置仍要求 OPENAI_API_KEY——envFor 也只设 OPENAI_API_KEY，apiKeyEnv 配置项形同虚设。
- ⚠️ **`--resume` 依赖 codex CLI 支持**：flag 已加，但实际能否 resume 取决于 codex 版本是否认 `--resume <id>`；`SESSION_RE` 解析也依赖 codex 输出含 `session: <uuid>` 字样——若 codex 改输出格式，extractSession 失配，回退到入参 sessionId（仍能复用，但首次调用无法获取新 session id）。
- ✅ **prompt 经 stdin**：不再进 argv，消除了 §6.3 记录的 argv prompt 注入面（特殊字符不再经 shell 解释）。
- ✅ **session 复用链完整**：buildArgv 加 resume + extractSession 挖 id，codex 从「不支持 resume」变为「支持」。
- ✅ envFor 的 key 缺失返回 undefined，不污染 env。

### 跨文件观察
- 注册到 backend registry（id `codex`）；`BUILTIN_WORKER_CONFIGS.codex = {kind:"agent", backend:"codex"}`。与 `WorkerSessionManager`（[05](./05-worker-core.md) §5.7）的 sessionReuse 假设现已对齐。

---

## 6.5 `claude.ts`（38 行）— Claude Code CLI 后端

### 用途
把 worker 调用翻译成 **claude-code CLI** 调用。文件保持 thin，通用子进程行为委托 shared helper（文件头 1–7 行）。**本次新增**：`--resume <sessionId>` 支持 + `extractSession()`。

### 关键导出
- `ClaudeBackend`（class，extends `SubprocessBackend`）：`id = "claude-code"`

### buildArgv（17–22 行）
```
argv = ["claude", "--dangerously-skip-permissions", "-p"]
if opts.sessionId: argv += ["--resume", opts.sessionId]   # 新增（19 行）
argv += ["--", prompt]
env = envFor(config)
```
- `envFor`：`ANTHROPIC_MODEL`（若 config.model）、`ANTHROPIC_BASE_URL`（若 config.baseUrl）、`ANTHROPIC_AUTH_TOKEN`（从 `apiKeyEnv ?? "ANTHROPIC_API_KEY"` 读）

### extractSession（24–27 行）
- `SESSION_RE = /session[: ]+([0-9a-fA-F-]{8,})/i`（12 行）——与 codex 同款 regex
- 优先扫 stderr，再扫 stdout。

### 新增/变更
- `buildArgv` 新增第三参 `opts?: BuildArgvOptions`，`opts.sessionId` 时 `argv.push("--resume", opts.sessionId)`（19 行）。
- 新增 `extractSession()`（24–27 行）+ `SESSION_RE` 常量（12 行）。

### 审计要点
- 🚨 **`--dangerously-skip-permissions`**（第 18 行）：与 codex 同款，默认跳过 claude-code 的权限确认。LLM 输出可触发任意文件读写/命令执行。叠加 prompt injection → RCE。
- ⚠️ **`ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY`**（第 36 行）：把 apiKeyEnv（默认 ANTHROPIC_API_KEY）的值映射到 `ANTHROPIC_AUTH_TOKEN`——两个 env 名不同，claude-code 实际认哪个需核实；若 claude-code 读 ANTHROPIC_API_KEY 而非 AUTH_TOKEN，则鉴权失败。
- ⚠️ **`--resume` 依赖 claude-code CLI 支持**：与 codex 同，flag 已加，实际行为取决于 claude-code 是否认 `--resume`。`SESSION_RE` 与 codex 完全相同（uuid 形），若两者 session id 格式不同会失配。
- ⚠️ **`-p`（print 模式）+ `--` prompt**：argv 形式清晰，但无 model 之外的配置透传（config.args 被忽略，对比 opencode-cli 用 config.args）。
- ✅ **session 复用链完整**：与 codex 对称实现，claude 从「不支持 resume」变为「支持」。
- ✅ 极简，env 缺失返回 undefined。

### 跨文件观察
- 注册 id `claude-code`；`BUILTIN_WORKER_CONFIGS["claude-code"]`。sessionReuse 假设现已对齐。

---

## 6.6 `opencode-cli.ts`（41 行）— OpenCode CLI 后端

### 用途
**本地 CLI 执行**的 OpenCode subprocess worker，支持 Peak 专属 env 接线（graph-aware workflow）。HTTP transport 在 opencode-http.ts（文件头 1–7 行）。**本次新增**：`--session <sessionId>` 支持 + `extractSession()`。

### 关键导出
- `OpencodeCliBackend`（class，extends `SubprocessBackend`）：`id = "opencode"`

### buildArgv（17–35 行）
```
args = ["run"]
if config.model: args += ["--model", m]
if opts.sessionId: args += ["--session", opts.sessionId]   # 新增（20 行）
args += ["--print"]
if config.args: args += [...config.args]
args += [prompt]
argv = ["opencode", ...args]
env = { OPENCODE_BASE_URL?, OPENCODE_API_KEY? }
```

### extractSession（37–40 行）
- `SESSION_RE = /(ses_[0-9a-zA-Z]{10,})/`（12 行）——与 codex/claude 的 uuid regex **不同**，匹配 opencode 的 `ses_xxx` 形 session id
- 优先扫 stderr，再扫 stdout。

### 新增/变更
- `buildArgv` 新增第三参 `opts?: BuildArgvOptions`，`opts.sessionId` 时 `args.push("--session", opts.sessionId)`（20 行）。
- 新增 `extractSession()`（37–40 行）+ `SESSION_RE` 常量（12 行）。

### 审计要点
- ⚠️ **`config.args` 透传**（第 22 行）：允许用户在 task.json 给 opencode 加任意参数——若 config.args 含 `--dangerously-*` 类标志，放大权限。对比 codex/claude 的 dangerous 标志是硬编码，opencode 是用户可注入。
- ⚠️ **`--session` flag 位置**（20 行）：插在 `--model` 之后、`--print` 之前——若 opencode 对 flag 顺序敏感需核实；一般 CLI 用 cobra/urfave 不敏感。
- ⚠️ **`--print` 模式**：opencode 的 print 模式输出格式需 backend 外的 parseEnvelope 能解析；若 opencode print 输出含 markdown 围栏或非 JSON，依赖 parse-envelope 的容错。`--session` 复用时 print 模式是否仍输出 session id（供 extractSession）需核实。
- ⚠️ **`OPENCODE_API_KEY` 映射**（第 28 行）：从 `apiKeyEnv ?? "OPENCODE_API_KEY"` 读，写入 env 的同名 `OPENCODE_API_KEY`——若 apiKeyEnv 是别的名（如 `MY_KEY`），读 MY_KEY 写 OPENCODE_API_KEY，OK；但默认两边同名，易混。
- ✅ **session 复用链完整**：`--session` + extractSession（用 `ses_` regex，区别于 codex/claude 的 uuid regex）。
- ✅ config.args 透传提供灵活性。
- ✅ env 条件构造，缺失返 undefined。

### 跨文件观察
- 注册 id `opencode`；与 `opencode-http`（id `opencode-http`）互补。`AgentDriver.resolveBackend` 的 `transport:"http"` 会找 `opencode-http`（[05](./05-worker-core.md) §5.4）。两者现在都支持 session 复用，但机制不同：cli 走 `--session` flag + stdout 提取，http 走直接复用 input.sessionId。

---

## 6.7 `opencode-http.ts`（104 行）— OpenCode HTTP 后端

### 用途
向运行中的 OpenCode 兼容 HTTP 服务发 prompt，而非起本地进程。适用于 OpenCode session 管理由外部 daemon 拥有的场景（文件头 1–7 行）。**本次变更**：现在**复用现有 sessionId**（若 input.sessionId 提供，跳过 POST /session 创建），成功结果回传 sessionId；新增 no-op `extractSession()`。

### 关键导出
- `OpencodeHttpBackend`（class，implements `AgentBackend`）：`id = "opencode-http"`

### 常量
- `DEFAULT_BASE_URL = "http://127.0.0.1:4096"`
- `DEFAULT_TIMEOUT_MS = 300_000`（5 分钟）

### invoke 流程（30–80 行）
1. `baseUrl = (config.baseUrl ?? DEFAULT).replace(/\/$/,"")`
2. password = `config.password ?? process.env.OPENCODE_SERVER_PASSWORD` → Basic auth（`opencode:password` base64）
3. **session 解析（39–58 行，新增分支）**：
   - 若 `input.sessionId` 存在 → 直接复用（40–41 行，**跳过 POST /session**）
   - 否则 `POST {baseUrl}/session`（title `peak-${Date.now()}`，10s 超时）→ 取 `session.id`（43–54 行）
4. `POST {baseUrl}/session/${sessionId}/message`（body `{parts:[{type:"text", text: prompt}]}`）→ `extractAssistantText`
5. 超时：`AbortSignal.timeout(input.config.timeoutMs ?? DEFAULT_TIMEOUT_MS)`（67 行）
6. 成功返回 `{text, returncode:0, stderr:"", sessionId}`（76 行，**回传 sessionId**）

### 新增/变更
- session 复用分支：`if (input.sessionId) sessionId = input.sessionId`（40–41 行），跳过 session 创建。
- 成功结果新增 `sessionId`（76 行）。
- 新增 no-op `extractSession()`（82–86 行，注释说明「HTTP backend 在 result 里直接带 sessionId，此方法为接口对称保留」）。

### 审计要点
- ⚠️ **文件头注释（21–23 行）已过时**：注释仍写「creates one session per invoke (no cross-turn session reuse) ... Cairn model」，但代码（40–41 行）已实现复用——**注释与实现不一致**，应更新注释。
- ⚠️ **复用 sessionId 不校验存在性**：`input.sessionId` 提供时直接 `POST /session/<id>/message`，若该 session 在服务端已过期/不存在，message 请求会失败（返回非 ok 走 errorResult），但错误信息不提示「session 不存在」——复用失败时 UX 模糊。
- ⚠️ **超时已修正为 `config.timeoutMs ?? DEFAULT_TIMEOUT_MS`（300_000ms）**（67 行）：旧实现的 `maxTokens*1000` 荒谬超时已移除。session 创建仍用 10s 硬编码（48 行）。
- ⚠️ **Basic auth 明文 password**（第 35 行）：`Buffer.from(\`opencode:${password}\`).toString("base64")`——base64 非加密，依赖 HTTPS；但默认 baseUrl 是 http://127.0.0.1，本地 OK，跨网络则密码明文。
- ⚠️ **`sessionResp.json() as {id:string}`**（第 53 行）：强转，服务端返回非预期 shape 会运行时崩。
- ⚠️ **`extractAssistantText` 容错**（89–100 行）：处理 `type:"text"` 与 `content:string` 两种 part，但若 part 是 `{type:"tool_use"}` 等非文本，静默跳过——可能丢失 agent 的工具调用信息。
- ⚠️ **无重试**：网络抖动直接 errorResult。
- ⚠️ **首次调用仍建新 session**：无 input.sessionId 时 POST /session，服务端 session 累积；但后续复用同 session 不再新建，泄漏大幅缓解（依赖 extractSession 在 subprocess 路径挖 id，或上层 sessionManager 持有 id）。
- ✅ **session 复用打通**：从「每次新建、忽略 input.sessionId」变为「有则复用、无则新建、结果回传」，与 WorkerSessionManager 假设对齐。
- ✅ 错误信息含「Is 'opencode serve' running?」提示，UX 友好。
- ✅ baseUrl 末尾斜杠清理。
- ✅ 超时从荒谬的 maxTokens×1000 改为 config.timeoutMs ?? 300_000。

### 跨文件观察
- 是唯一非 subprocess 的 backend（直连 implements AgentBackend）；与 opencode-cli 互补。`AgentDriver.resolveBackend` 在 `transport:"http"` 时优先找它。extractSession 是 no-op，因 sessionId 已在 result 里直接携带（76 行），无需从输出文本解析。

---

## 6.8 `process.ts`（20 行）— 泛型命令后端

### 用途
**配置命令 worker 的泛型后端**。执行 task config 里任意 command/args 定义，是自定义 agent CLI 的逃生舱，同时保留通用 AgentBackend 调用契约（文件头 1–7 行）。

### 关键导出
- `ProcessBackend`（class，extends `SubprocessBackend`）：`id = "process"`

### buildArgv（15–19 行）
```
command = config.command ?? "echo"
args = config.args ?? []
return { argv: [command, ...args], input: prompt }   # 忽略 _opts
```

### 新增/变更
- `buildArgv` 签名加第三参 `_opts?: BuildArgvOptions`（15 行，**前缀下划线表示忽略**）——仅为满足基类抽象签名，不消费 sessionId/conclude（泛型命令无法假设支持 resume）。

### 审计要点
- 🚨 **任意命令执行**（第 16 行）：`config.command` 来自 task.json，无白名单/校验——task.json 可指定 `command: "rm"`、`args: ["-rf","/"]`，被 `SubprocessBackend.spawn` 执行。是设计意图（escape hatch），但若 task.json 来源不受信（如从 graph/外部输入生成），是 RCE。
- ⚠️ **默认 `command = "echo"`**（第 16 行）：未配 command 时 echo prompt，returncode 0，stdout=prompt——静默「成功」但无意义，易误导调试（看似 worker 正常实则没跑 agent）。
- ⚠️ **prompt 走 stdin**（`input: prompt`）：比 argv 传更安全（无 argv 注入），但 echo 默认不读 stdin——默认配置下 prompt 被丢弃。
- ⚠️ **`_opts` 被忽略**：泛型后端无法透传 session resume/conclude 给任意命令；若用户的自定义命令支持 resume 语义，需自行在 config.args 里配，ProcessBackend 不自动加 flag。继承基类的 no-op extractSession，故 sessionId 不回传（除非命令输出恰好被基类 extractSession 解析，但基类默认 no-op）。
- ⚠️ **`AgentDriver.resolveBackend` 回退 new ProcessBackend**（[05](./05-worker-core.md) §5.4 第 52 行）：`config.command` 存在时回退，但 ProcessBackend 不读 `config.backend`/`config.transport`，纯 command/args。
- ✅ 极简，职责单一。
- ✅ escape hatch 设计合理，给自定义 CLI 留口。
- ✅ 签名对齐基类抽象（接 `_opts`），不破坏 `SubprocessBackend.invoke` 的透传逻辑。

### 跨文件观察
- 注册 id `process`；被 `agent-driver.ts` 在 `config.command` 存在且无注册 backend 时回退使用，也在 `backends/registry.ts` re-export 供直接 new。是唯一不支持 session resume 的 builtin（设计上合理，因命令任意）。

---

## 跨文件小结（本册）

1. **🚨 安全风险集中地（未变）**：codex（`--dangerously-bypass-approvals-and-sandbox`）、claude（`--dangerously-skip-permissions`）默认关审批/沙箱；process（任意 command）；叠加 subprocess 的 PATH 劫持 + 全 env 透传。结合协议层 graph 中 attacker-controlled description 进 prompt → **prompt injection → RCE** 链。建议：sandbox 默认开、PATH 白名单、env 最小化、prompt 经 stdin。
2. **✅ session 复用（resume）已全面落地（重大改善）**：之前的「sessionReuse 协议三层不一致」「sessionReuse 对所有 builtin backend 无效」「codex/claude 无 --resume」「opencode-http 每次新建 session」**全部已解决**——`subprocess.ts` 引入 `BuildArgvOptions` + `extractSession`，codex/claude 加 `--resume`，opencode-cli 加 `--session`，opencode-http 复用 input.sessionId。session 复用管道从「断的脚手架」变为端到端可用。仅 `process.ts`（泛型命令）不支持，设计合理。
3. **✅ conclude 协议已激活（不再是死协议）**：`BackendInvokeInput.conclude?` 现由 runSubagentWithText 的 conclude-fallback 路径从协议层透传，经 pool→driver→invoke→buildArgv（`BuildArgvOptions.conclude`）。`sessionId` 端到端贯通。**唯一遗留**：`partialOutput?` 仍无消费、`supportsConclude?` 仍无 backend 声明（conclude 路径不查它，无功能影响）。
4. **✅ 超时修正**：`subprocess.ts` 的 `DEFAULT_TIMEOUT_MS` 从 600_000（10min）降至 300_000（5min）；`opencode-http.ts` 的荒谬 `maxTokens*1000` 超时改为 `config.timeoutMs ?? 300_000`。两处统一为 5 分钟默认 + config 可覆盖。
5. **⚠️ 仍存的小问题**：subprocess 超时无 SIGKILL 兜底（zombie 风险）；opencode-http 文件头注释（21–23 行）与复用实现不一致（应更新）；codex/claude 的 `--resume` 与 `SESSION_RE` 依赖对应 CLI 实际支持/输出格式；stderr 10MB 静默截断无标记。
6. 本册是安全审计重点，建议优先修 §1（默认关 dangerous、PATH/env 收敛）。session 复用与 conclude 透传两块**已从「预留/断的脚手架」转为「可用」**，是本轮最大改善，WorkerSessionManager 的 sessionReuse 假设现已与所有 builtin backend 对齐。
