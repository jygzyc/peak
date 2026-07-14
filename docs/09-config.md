# 09 · 配置层（`src/config/`）

> 审计范围：9 个文件——`default-config.ts`、`task-config.ts`、`profile-loader.ts`、`prompt-loader.ts`、`providers-config.ts`、`provider-presets.ts`、`utils.ts`、**`agent-loader.ts`（新增）**、**`peak-home.ts`（新增）**。
> 本层负责 task.json 加载/合并、profile 规范化、prompt 文件读取、provider 配置（含 9 个 builtin preset）、`~/.peak/` 目录布局与 agent 补丁注入。
>
> **近期重大变更**：① `ContextSpec.relevanceScope` 的 `"chain"` 取值更名为 `"linked"`（`normalizeContext` 改判 `=== "linked"`）。② `PromptSpec` 新增 `concludeFile?`，explorer 默认 profile 启用 conclude 回退（`agent/prompts/explorer-conclude.md`）。③ `normalizePermissions` **已修复**：自定义 profile 声明的 `permissions` 现被正确读取，过往「permissions 被丢弃」的严重 bug 不复存在。④ `WorkflowConfig`/`DEFAULT_LIMITS`/`mergeWorkflow` 全部移除，改由 `SchedulerConfig`（`scheduler: { maxConcurrent, refillPerTick, workerLeaseMs }`）+ 自然终止；旧 `workflow.limits.{maxConcurrent,refillPerTick,workerLeaseMs}` 仍向后兼容映射到 scheduler，`maxSteps`/`stopGate`/`maxStagnation` 被忽略。⑤ `DEFAULT_METACOG_TRIGGERS.everySeconds` 统一为 30，与 `defaultConfig()` 对齐，过往「30 vs 60 打架」已解决。⑥ 新增 `agent-loader.ts`（注入 `~/.peak/agents/<name>.json` 补丁）与 `peak-home.ts`（`~/.peak/` 目录布局单一真相源）。⑦ `safeSessionName` 现已被 `session-manager.ts` 接线，且补上了 `..` 折叠，路径转义已防御。

---

## 9.1 `default-config.ts`（53 行）— 默认配置

### 用途
**task.json 缺字段时的最小可运行配置**。默认不编码领域漏洞挖掘策略；role prompt 保持最小，task.json 可经 `profiles.<id>.prompt.file` 覆盖（文件头 1–8 行）。

### 关键导出
- `defaultConfig(): TaskConfig`

### 默认值
- 4 个 builtin profile（planner/explorer/evaluator/metacog），各绑 `BUILTIN_PERMISSIONS[role]`、graphView（full/focused/evidence-only/summary）、output contract
  - explorer 额外带 `prompt.concludeFile: "agent/prompts/explorer-conclude.md"`，启用 conclude 回退
  - metacog 带 `triggers: { ...DEFAULT_METACOG_TRIGGERS }`（everySeconds=30）
  - planner 带 `cooldownSteps: 3`
- workers：仅 `opencode`（kind agent, backend opencode）
- `scheduler: { maxConcurrent: 3, refillPerTick: 1, workerLeaseMs: 300_000 }`
- control：`mainProfile: "planner", metacogProfile: "metacog", metacogIntervalSeconds: DEFAULT_METACOG_TRIGGERS.everySeconds`（即 30）

### 审计要点
- ✅ **`metacog.triggers.everySeconds` 与 `DEFAULT_METACOG_TRIGGERS.everySeconds` 已对齐为 30**：本文件 metacog profile 直接展开 `{ ...DEFAULT_METACOG_TRIGGERS }`，control.metacogIntervalSeconds 也取同一常量——过往「defaultConfig(30) vs DEFAULT_METACOG_TRIGGERS(60)」的不一致已彻底解决。
- ✅ **`maxSteps`/`DEFAULT_LIMITS`/`WorkflowConfig` 全部移除**：scheduler 只剩 `maxConcurrent`/`refillPerTick`/`workerLeaseMs` 三个资源旋钮，不再有深度/停止门/停滞上限，终止靠自然完成（`openIntents===0`）。过往「defaultConfig maxSteps=1000 vs SessionLoop 默认 100」的三重打架已不复存在。
- ✅ **explorer 默认启用 conclude 回退**：`builtinProfile` 接受 `extra.concludeFile`，写入 `profile.prompt.concludeFile`，使 explorer 首次解析失败时能用 conclude preamble 复用 session 重调（见 [03-agent.md §3.7](./03-agent.md)）。
- ⚠️ **`runtime: { worker: "opencode" }`**：所有 profile 默认用 opencode backend，需 `opencode serve` 或本地 CLI——开箱即用门槛仍偏高。
- ⚠️ **prompt 文件路径 `agent/prompts/planner.md`**：相对路径，PromptLoader 用 baseDir（sessionDir）解析，要求 session 目录下有 `agent/prompts/`——实际 prompt 在 `src/agent/prompts/`，运行时未必可达。
- ⚠️ **`builtinProfile` 不设 `sessionReuse`/`maxActive`/`intervalSeconds`**：全部走下游默认（metacog maxActive 默认 1）。
- ✅ 默认配置完整可运行（除 worker 依赖外部 opencode）。
- ✅ 不编码领域策略，符合「配置驱动」承诺。

### 跨文件观察
- 被 `task-config.loadConfig` 作 merge base、`cli.ts init` 生成模板。metacogIntervalSeconds 与 MetacogSupervisor 的 `DEFAULT_METACOG_INTERVAL_MS=30000` 一致。

---

## 9.2 `task-config.ts`（254 行）— task.json 加载器

### 用途
**task.json 加载与合并**。读用户文件，叠在 defaultConfig() 上（中间还叠一层 `~/.peak/config.json` 全局 baseline），校验必需 task 字段，经 ProfileLoader 规范化 profile，注入 `agents` 引用的补丁，返回 TaskConfig + session 元数据。保持解析结构性；role 语义应在 prompt/config，不在代码（文件头 1–8 行）。

### 关键导出
- `loadConfig(configPath, sessionOverride?, opts?): LoadedConfig`
- `LoadedConfig`（config/session/sessionDir/configPath）
- `LoadConfigOptions`（extends `InjectionOptions`，含 `skipBaseline?`）

### loadConfig 流程
1. resolve + existsSync 校验
2. readFileSync + JSON.parse（try/catch 美化错误）
3. `mergeConfig(defaultConfig(), readBaselineConfig() ?? {}, parsed)`——三层合并：defaults ← `~/.peak/config.json` ← task.json
4. **`agents` 字段**（string 数组）：调 `injectAgents` 把 `~/.peak/agents/<name>.json` 补丁注入对应 builtin slot；非数组静默忽略（legacy safe，不再抛「removed field」）
5. 校验 task.target / task.goal 必填
6. session = override ?? config.task.session ?? deriveSessionFromTarget(target) ?? deriveSessionName(absPath)
7. sessionDir = dirname(absPath)

### mergeConfig / mergeWorkers / mergeScheduler / mergeControl
逐字段合并，override 的 `stringValue`/`numberValue` 命中则覆盖，否则用 base。profiles 始终规范化（含 base 的 4 个 builtin）。baseline 的 workers 垫在 task workers 之下（task wins）。

### mergeScheduler（替代旧 mergeWorkflow）
- 读 `scheduler` 顶层字段 + 旧 `workflow.limits.{maxConcurrent,refillPerTick,workerLeaseMs}`（向后兼容映射）
- `maxSteps`/`stopGate`/`maxStagnation` 等 legacy 字段**被忽略**（无 depth limit、无 forced termination）
- 优先级：task `scheduler` > task `workflow.limits` > base > `DEFAULT_SCHEDULER`

### 审计要点
- ✅ **`~/.peak/config.json` baseline 层**：全局默认 workers/control 现可在 `~/.peak/config.json` 集中配置，task.json 覆盖之——三层合并（defaults ← baseline ← task）清晰。malformed baseline 静默忽略（不阻塞 task 加载）。
- ✅ **`agents` 字段语义反转**：旧版检测到 `agents` 抛「removed field」错；现改为注入入口（string 数组 → `~/.peak/agents/<name>.json`）。非数组/空数组安全忽略。
- ⚠️ **`stringValue` 与 `utils.ts` 同名不同义**（本文件双参 dot-path 不 trim vs utils.ts 单参 trim）：本文件未 import utils.ts，自定义了一份。两套同名函数签名不同，易混。
- ⚠️ **`deriveSessionName`**（250–254 行）：取 configPath 父目录名，`replace(/[^a-zA-Z0-9_-]/g,"-")`——本身不防 `..`，但下游 `SessionManager.sessionDir` 已用 `safeSessionName` + `relative` 检查兜底（见 [04-session.md](./04-session.md)），路径转义已被防御。
- ⚠️ **`deriveSessionFromTarget`**（98–104 行）：从 task.target 抽 stem 作 session 名，同样经 `safeSessionName` 下游兜底。
- ⚠️ **无 schema 校验**：仅校验 target/goal 非空，profile 内部字段错误靠 normalizeProfile 抛错，worker 字段类型错误静默吞（stringValue 返 undefined）。
- ⚠️ **profiles 合并 `{...base.profiles, ...profiles}`**（146–149 行）：先展开 base 再展开 profiles，二次展开 base 冗余（base.profiles 已在 profiles 内），无害但隐晦。
- ✅ profile 始终规范化，下游形状保证。
- ✅ `mergeScheduler` 对 legacy `workflow.limits` 的向后兼容映射注释清晰。

### 跨文件观察
- 被 `cli.ts run`、`index.ts` re-export。`normalizeProfile` 来自 profile-loader，`injectAgents` 来自 agent-loader，`configFile` 来自 peak-home。

---

## 9.3 `profile-loader.ts`（134 行）— Profile 规范化

### 用途
**SubagentProfile 配置规范化**。严格 profiles-only，无 legacy 字段映射。每个 profile 必须声明 runtime/prompt/context/permissions/output（文件头 1–6 行）。

### 关键导出
- `normalizeProfile(profileId, raw): SubagentProfile`

### 规范化逻辑
- role = `r.role ?? profileId`
- runtime：`r.runtime ?? r` 作源，必须 `worker`；可选 workers/model/provider
- prompt：必须 `prompt.file`；可选 rules/knowledge/instructions/**concludeFile**
- context：graphView 默认 full；可选 maxFacts/includeDeadEnds/includeProgress/rotateOnContextFull/**relevanceScope**（`"linked" | "all"`，旧值 `"chain"` 已更名）
- **permissions：若 `r.permissions` 是数组则取声明值（过滤非法项），否则回退 builtin**
- output：contract 默认 candidate_fact
- 可选 maxActive/intervalSeconds/**cooldownSteps**/**triggers**/**sessionReuse**/**maxOutputTokens**/**promptCache**

### 审计要点
- ✅ **`normalizePermissions` 已修复**（102–114 行）：当 `r.permissions` 是数组时，过滤出 `VALID_PERMISSIONS` 集合内的项后返回；只有 profile **未声明** permissions 时才回退 `BUILTIN_PERMISSIONS[role] ?? BUILTIN_PERMISSIONS[profileId] ?? []`。过往「自定义 profile permissions 被丢弃、强制 builtin」的严重 bug 已修复——自定义 role（如 `android-source-finder`）现在能正确拿到声明的权限，与 AGENTS.md「custom profiles declare their own」承诺一致。代码注释（104–107 行）明确指向旧 bug。
- ✅ **`VALID_PERMISSIONS` 白名单**（22–25 行）：8 种合法权限枚举，非法值被静默过滤（不抛错）——宽松但安全，避免拼写错误让 profile 拿到任意权限。
- ✅ **`concludeFile` 解析**（82–83 行）：`const concludeFile = str(p.concludeFile); if (concludeFile) spec.concludeFile = concludeFile;`——与 `PromptSpec.concludeFile?` 类型对齐，subagent-runner 据此启用 conclude 回退。
- ✅ **`relevanceScope` 改判 `"linked"`**（97 行）：`contextRaw.relevanceScope === "linked" || contextRaw.relevanceScope === "all"`——旧值 `"chain"` 不再被接受，写 `"chain"` 会被丢弃（回退默认全量），迁移时需更新 task.json。
- ✅ **per-profile 调节旋钮已补齐读取**（本次修复）：`normalizeProfile` 现读取 `cooldownSteps`/`triggers`（经 `normalizeTriggers`）/`sessionReuse`/`maxOutputTokens`/`promptCache`——过往这些字段虽在 `SubagentProfile` 类型声明、`defaultConfig` 也设值，但 `loadConfig → normalizeProfile` 这条路径（task.json 实际走的路径）会静默丢弃，导致 task.json 里写 `"cooldownSteps": 3` 不生效。现与 agent-loader.ts 的 `applyTuning` 字段集对齐。
- ⚠️ **`normalizeContext` 的 `view as GraphView`**（89 行）：`str(contextRaw.graphView) as GraphView` 强转，LLM/用户写 `graphView: "ful"`（拼错）会通过强转，运行时 renderGraphView 的 default 分支回退 full，静默吞错。
- ⚠️ **`normalizeOutput` 同款强转**（119 行）：`contract as OutputContract`。
- ⚠️ **`normalizeRuntime` 的 `src = runtimeRaw ?? r`**（50 行）：允许 profile 顶层直接写 worker/model（无 runtime 包裹）——向后兼容，但与 SubagentProfile 类型（runtime 必须是对象）不符。
- ⚠️ **`str`/`num`/`strArr` 重复定义**：与 utils.ts/task-config.ts 各有一套字符串解析助手，三处重复。
- ✅ 严格规范化，缺字段即抛错（fail-fast）。
- ✅ role 回退到 profileId，允许 profile 名即 role 名。

### 跨文件观察
- 被 `task-config.mergeConfig` 对每个 profile 调用。permissions bug 已清零，自定义 profile 链路畅通。

---

## 9.4 `prompt-loader.ts`（74 行）— Prompt 文件加载

### 用途
**从 PromptSpec 组装 subagent prompt**。从 `prompt.file`（必填，相对 task config dir）读 role preamble，按序追加可选 rules/knowledge/instructions 文件或文本。动态 graph context 由 ContextBuilder 另外前置；本 loader 只产静态 role preamble（文件头 1–8 行）。conclude preamble 也经此 loader 加载（subagent-runner 传 `{ file: concludeFile }`）。

### 关键导出
- `PromptLoader`（class）：`load(spec): ResolvedPrompt`
- `ResolvedPrompt`（preamble/fromConfig）、`PromptLoaderOptions`（baseDir?）

### load 逻辑
1. `tryReadFile(spec.file)`，失败返 `{preamble:"", fromConfig:false}`
2. push primary
3. rules：每项 `tryReadFile(rule) ?? rule`（文件优先，否则当文本），追加 `---\n<text>`
4. knowledge：同 rules
5. instructions：追加 `---\nInstructions: <text>`
6. join `\n\n`

### tryReadFile / looksLikePath
- `looksLikePath`：含 `/\\`、或末尾 `.<ext>`、或 `.`/`~/` 开头
- resolvePath：绝对路径直用，否则 `resolve(baseDir ?? DIST_ROOT, p)`
- **DIST_ROOT 探测**（本次变更）：不再硬编码 `dirname(import.meta.url) + ".."`（假设 `dist/config/prompt-loader.js` 的 tsc 布局），改为探测式——先查 `..`（tsc dev 布局：`dist/config/` → `dist/`），再查自身目录（esbuild 单文件 bundle：`dist/index.js` → `dist/`），找到含 `agent/prompts/planner.md` 的那个。这修复了 `npm run pack` 产出的扁平 bundle 无法解析 builtin prompt 的 bug（esbuild bundle 在 `dist/index.js`，旧 DIST_ROOT 算到包外）。

### 审计要点
- ⚠️ **`tryReadFile` 失败静默返 undefined**（56–65 行）：primary 失败则 `load` 返 `{preamble:"", fromConfig:false}`——subagent-runner 检测 `!fromConfig` 抛错（见 [03-agent.md §3.7](./03-agent.md)），OK；但 rules/knowledge 的 `tryReadFile(rule) ?? rule`：文件读失败则把 rule 路径字符串当正文 push——**用户写错 rules 文件路径，路径字符串会被当 prompt 文本喂给 LLM**，静默污染。
- ⚠️ **conclude preamble 加载失败重新抛原始 parseErr**：subagent-runner 在 `loader.load({ file: concludeFile })` 返 `!fromConfig` 时重新抛首次解析错误（不掩盖），逻辑正确；但本 loader 自身对 primary 缺失是静默返空，依赖调用方判 fromConfig。
- ⚠️ **`looksLikePath` 启发式**（72–74 行）：`/\.[a-z0-9]+$/i` 把任何末尾带点的字符串当路径——普通句子 `Use the API.` 会被当路径，existsSync 失败返 undefined，`?? rule` 当文本，侥幸 OK；但 `a/b` 含斜杠必当路径。
- ⚠️ **无路径转义防护**：`resolvePath` 不防 `../`，baseDir 外的文件可读——读 prompt 文件风险低（用户自配），但 rules/knowledge 若被外部输入控制可读任意文件。
- ⚠️ **无文件大小限制**：读巨大文件直接进 prompt，可能撑爆 context。
- ⚠️ **`---` 分隔符**：markdown YAML front-matter 语义，但这里是分隔追加块，LLM 可能误解。
- ⚠️ **fromConfig 只反映 primary**：rules/knowledge 读失败不影响 fromConfig=true，调用方无法知道部分加载。
- ✅ 文件优先 + 文本回退的 rules/knowledge 设计灵活。
- ✅ baseDir 可配，测试友好。conclude preamble 复用同一 loader，无特例。

### 跨文件观察
- 被 `subagent-runner`（每次 runSubagentWithText new 一个，或复用传入）、`session-loop`/`metacog-supervisor`（构造时 new）使用。conclude 回退路径也经此 loader。

---

## 9.5 `providers-config.ts`（148 行）— providers.json 加载

### 用途
**用户自定义 provider 配置**，从 `~/.peak/providers.json`（或 `PEAK_AGENT_PROVIDERS` env）加载。schema 镜像磁盘 JSON：每 provider 按 id 键，含 baseURL/apiKeyEnv/model + 可选 name/kind/headers。id 对应 task.json 的 `worker.provider`。builtin preset 提供常见 API 默认，用户只需复制 preset 进文件填 key（文件头 1–11 行）。路径经 `peak-home.providersFile()` 解析。

### 关键导出
- `UserProviderConfig`（interface：baseURL/apiKeyEnv/model + name?/kind?/headers?）
- `ProvidersFile = Record<string, UserProviderConfig>`
- `defaultProvidersPath()`/`loadProvidersFile()`/`saveProvidersFile()`
- `initProvidersFile(filePath?, presets?)`：不存在则用 preset 播种
- `findProvider(id, file, presets?)`：user 优先，preset 回退
- `listKnownProviders()`/`presetToUserConfig()`

### 模块级缓存
`cachedFile`/`cachedPath`——loadProvidersFile 缓存。

### 审计要点
- ✅ **`initProvidersFile` 现已复制 `kind` 与 `headers`**（79–87 行）：`seeded[preset.id] = { name, baseURL, apiKeyEnv, model, ...(preset.kind ? { kind } : {}), ...(preset.headers ? { headers } : {}) }`——过往「复制 preset 丢 kind/headers」的 bug 已修复。叠加 §9.6 的 anthropic preset 现带 `kind:"anthropic"`，anthropic provider 经 initProvidersFile 写入后 kind 正确。
- ✅ **`presetToUserConfig` 也带 kind/headers**（139–148 行）：preset 回退路径同样保留 kind——过往「findProvider 回退 preset 丢 kind」的 bug 同步修复。
- ✅ **`listKnownProviders` 输出含 kind**（112–136 行）：preset 与 user 项均带 kind 字段，CLI 展示可区分 openai/anthropic。
- ✅ **anthropic 链路贯通**：provider-presets 的 anthropic preset 带 `kind:"anthropic"` → initProvidersFile/presetToUserConfig 复制 kind → ConfiguredProvider 因 `kind ?? "openai"` 命中 `"anthropic"` 分支调 `createAnthropic`（见 [07-worker-providers.md §7.3](./07-worker-providers.md)）。过往「anthropic provider 链路断裂」的严重 bug 已修复。
- ⚠️ **`loadProvidersFile` 的模块级缓存**（35–37、44–61 行）：`cachedFile`/`cachedPath` 进程级缓存，saveProvidersFile 清缓存，但**外部修改 providers.json 后缓存不失效**——测试与运行时可能读到陈旧配置。`reloadProviders`（providers/registry）调 `loadProvidersFile()` 走缓存，无法强刷。
- ⚠️ **`loadProvidersFile` JSON 解析失败静默返 `{}`**（53–56 行）：catch 块 `result = {}`，用户 providers.json 写坏无提示，provider 全消失。
- ⚠️ **`defaultProvidersPath` 联动 `peak-home`**：现经 `providersFile()` 解析，受 `PEAK_HOME` 影响——比旧版固定 `~/.peak/agent/providers.json` 更灵活，但 `PEAK_AGENT_PROVIDERS` env 仍优先于 `PEAK_HOME`。
- ⚠️ **`saveProvidersFile` 无原子写**：直接 writeFileSync，中途崩溃可能损坏文件。
- ✅ user 优先 + preset 回退的合并顺序清晰。

### 跨文件观察
- 被 `providers/registry`（buildProvidersFromConfig → loadProvidersFile）、`api-driver`（resolveProviderId → loadProvidersFile + findProvider）、`providers/configured`（findProvider/loadProvidersFile）使用。是 provider 层的配置源。

---

## 9.6 `provider-presets.ts`（104 行）— Builtin Provider Preset

### 用途
**常见中外 LLM API 的 builtin preset**。每个是完整 provider 配置，用户复制进 `~/.peak/providers.json` 填 key。镜像 cc-switch 的「50+ preset」但用简单 JSON，无 GUI（文件头 1–15 行）。

### 关键导出
- `ProviderPreset`（interface：id/name/baseURL/apiKeyEnv/model/description + **kind?/headers?**）
- `PROVIDER_PRESETS: ProviderPreset[]`：9 个（openai/anthropic/deepseek/glm/minimax/kimi/qwen/openrouter/ollama）

### 审计要点
- ✅ **`ProviderPreset` interface 现含 `kind?` 与 `headers?`**（17–28 行）：过往「缺 kind 字段、无法表达 anthropic」的 bug 已修复。anthropic preset（40–47 行）现带 `kind: "anthropic"`。
- ✅ **anthropic preset 链路完整**：`kind:"anthropic"` → initProvidersFile 复制 → ConfiguredProvider 走 createAnthropic 分支。过往「anthropic 链路断裂」的根因（preset 无 kind）已清除。
- ⚠️ **模型版本疑似占位/未来版本**：`gpt-5.5`、`claude-4.8-opus`、`deepseek-v4-pro`、`glm-5.2`、`MiniMax-M3` 等——审计时点（2026-07）这些版本号需核实是否真实存在；若为占位，用户复制后需手改 model。
- ⚠️ **`ollama` preset 的 `apiKeyEnv: "OLLAMA_API_KEY"` + `model: "llama3.2"`**：ollama 本地无需 key，但 preset 要求 OLLAMA_API_KEY env——description 提示「set OLLAMA_API_KEY=ollama」，UX 别扭。
- ⚠️ **`openrouter` preset model `anthropic/claude-4.6-sonnet`**：跨厂商 model id，依赖 openrouter 路由；kind 仍是 openai（openrouter 是 OpenAI 兼容），OK。
- ⚠️ **preset 间 baseURL 末尾斜杠不一**：多数有 `/v1`，ollama 是 `http://localhost:11434/v1`，openrouter `https://openrouter.ai/api/v1`——一致 OK；但 ConfiguredProvider 不清理末尾斜杠，拼接 `/chat/completions` 时若 baseURL 带尾斜杠会双斜杠。
- ✅ preset 集中定义，便于维护。
- ✅ description 字段供 CLI 展示。kind/headers 透传到 UserProviderConfig。

### 跨文件观察
- 被 `providers-config`（initProvidersFile/findProvider/listKnownProviders/presetToUserConfig）、`api-driver`（resolveProviderId 扫 preset）、`providers/configured`（buildProvidersFromConfig）使用。anthropic 链路已贯通。

---

## 9.7 `utils.ts`（61 行）— 共享解析助手

### 用途
**跨配置加载/协议解析/HTTP handler 的共享解析助手**。集中 `isRecord`/`stringValue` 等，避免每模块重复（文件头 1–4 行）。

### 关键导出
- `isRecord(value)`、`stringValue(value)`（trim）、`stringArray(value)`（trim 过滤）、`positiveInt(value)`、`safeSessionName(value)`、`utcnow()`、`parseJson(value, fallback)`

### 审计要点
- ✅ **`safeSessionName` 已接线且修复 `..`**（39–47 行）：现新增 `.replace(/\.{2,}/g, ".")` 把 `..` 序列折叠成单 `.`——过往「不防 `..`」的漏洞已补。且已被 `session/session-manager.ts:32` 调用（不再是「生产零调用」）。`session-manager` 还叠加 `relative(baseDir, dir)` 检查双重防御，路径转义已堵死（见 [04-session.md §4.5](./04-session.md)）。
- ✅ **`utils.ts` 已有生产消费方**：`session-manager.ts` import `safeSessionName`，`providers-config.ts`/`task-config.ts` 经 `peak-home.ts` 间接关联。过往「整文件生产死代码」的判断不再成立（至少 safeSessionName 已被采用）。
- ⚠️ **`stringValue` 与 task-config.ts 同名不同签名**（见 §9.2）：本文件 `stringValue(value)` 单参 trim，task-config `stringValue(obj, key)` 双参 dot-path——若有人误 import，行为不符预期。task-config 仍未 import utils.ts，自定义了一份。
- ⚠️ **`parseJson` 用 `String(value ?? "")`**：对 null/undefined 返空串再 JSON.parse 抛错走 fallback，OK；但对对象 `String({a:1})` → `"[object Object]"` 解析失败 fallback。
- ⚠️ **`positiveInt` 不支持负数/0**：`parsed > 0`，0 被拒——某些配置 0 是合法值。
- ✅ 函数小而专注，注释清晰。
- ✅ `safeSessionName` 思路正确且现已接线、修 `..`。

### 跨文件观察
- `safeSessionName` 被 `session-manager.ts` 使用，是路径转义防御的核心。其余助手（`isRecord`/`utcnow` 等）仍主要在测试侧，但文件不再是纯死代码。

---

## 9.8 `agent-loader.ts`（191 行）— Agent 补丁注入【新增】

### 用途
**把 `~/.peak/agents/<name>.json` 的可复用 role 配置注入四个 builtin profile slot（planner/explorer/evaluator/metacog）**。agent 文件是 builtin profile 的 **patch**（非独立 profile）：声明目标 slot 与要覆盖的字段，省略的字段保留 builtin 默认。这保留了 graph-generation + blackboard 架构（SessionLoop 仍只认四个 builtin slot），同时让用户无需改 task.json 即可定制每个 role（文件头 1–13 行）。agent 文件还可带 `workers` map，合并进 task 的 workers（task-level wins）。

### 关键导出
- `BUILTIN_SLOTS`（`["planner","explorer","evaluator","metacog"]`）、`BuiltinSlot`
- `AgentFile`（interface：slot + runtime?/prompt?/context?/permissions?/output?/maxActive?/cooldownSteps?/triggers?/intervalSeconds?/sessionReuse?/maxOutputTokens?/promptCache?/workers?）
- `LoadedAgent`（name/slot/file）
- `InjectionOptions`（agentsDir?，测试覆盖）
- `loadAgent(name, opts?)`、`applyAgentPatch(base, agent)`、`injectAgents(baseProfiles, agentNames, opts?)`

### applyAgentPatch 合并语义
- `runtime`/`prompt`/`context`：deep-merge，patch 字段 win，省略保留 base
- `permissions`/`output.contract`：**整体替换**（非拼接），agent 可收窄 builtin 能力
- 数值字段（maxActive/cooldownSteps/intervalSeconds/maxOutputTokens）：agent 值优先，否则 base
- `triggers`/`sessionReuse`/`promptCache`：同上

### 审计要点
- ⚠️ **`mergePrompt` 不透传 `concludeFile`**（137–145 行）：合并 prompt 时只处理 `file`/`rules`/`knowledge`/`instructions`，**漏了 `concludeFile`**——若 agent patch 想启用/覆盖 conclude 回退，`concludeFile` 会被丢弃。是新增字段后的遗漏，建议补 `...(patch.concludeFile ? { concludeFile: patch.concludeFile } : base.concludeFile ? { concludeFile: base.concludeFile } : {})`。
- ⚠️ **`applyAgentPatch` 的 permissions 整体替换**：agent 声明 `permissions` 就完全替换 builtin（非并集），用户需显式列出全部所需权限——若只想「加一个权限」会意外丢掉 builtin 的其它权限。文档需强调替换语义。
- ⚠️ **`loadAgent` slot 校验**（85–92 行）：slot 必须在 `BUILTIN_SLOTS` 内，否则抛错——good；但若 builtin profile 被用户在 task.json 中删除（profiles 只保留自定义），`injectAgents` 的 `profiles[agent.slot]` 查找会 undefined，抛「no such builtin profile exists」。边界正确但用户可能困惑。
- ⚠️ **`injectAgents` workers 合并顺序**（56–60 行）：agent workers 垫在 task workers 之下（task wins）——但 `injectAgents` 返回的 workers 是「所有 agent 的并集」，task-config 再 `{ ...injected.workers, ...config.workers }`，task wins 正确。
- ⚠️ **agent 文件 JSON 解析失败抛错**（77–79 行）：单 agent 坏文件会让整个 loadConfig 失败——fail-fast，OK，但无 skip 选项。
- ✅ patch 模型清晰：保留四 slot 架构，允许字段级覆盖。
- ✅ `BUILTIN_SLOTS` 常量集中定义，slot 校验严格。
- ✅ workers 随 role 携带，task-level wins 语义明确。

### 跨文件观察
- 被 `task-config.loadConfig` 在检测到 `agents` 数组时调用。`agentFile()` 路径来自 `peak-home.ts`。是「用户定制 role 而不改 task.json」的关键机制。

---

## 9.9 `peak-home.ts`（79 行）— `~/.peak/` 目录布局【新增】

### 用途
**Peak home 目录布局的单一真相源**。集中所有文件系统位置在单一根（默认 `~/.peak`）下（文件头 1–16 行）：

```
~/.peak/
├── config.json          全局 baseline（默认 workers/control）
├── agents/<name>.json   可复用 role 配置，注入 builtin slot
├── tasks/<name>.json    task 配置（target/goal/session + agent refs）
├── sessions/<session>/  每会话执行状态（analysis.db）
└── providers.json       模型 provider 配置
```

`PEAK_HOME` env 覆盖根目录。SessionManager、loadConfig、CLI 全部经这些 helper 路由。

### 关键导出
- `peakHome()`：`PEAK_HOME` env 或 `~/.peak`
- `peakPath(...segments)`：根下拼接
- `agentsDir()`/`tasksDir()`/`sessionsDir()`/`providersFile()`/`configFile()`
- `ensurePeakLayout()`：幂等创建 `agents`/`tasks`/`sessions` 子目录
- `agentFile(name)`/`taskFile(name)`

### 审计要点
- ✅ **单一真相源**：所有路径集中在此，SessionManager（sessionsDir）、task-config（configFile）、providers-config（providersFile）、agent-loader（agentFile）统一路由——过往「providers-config 自己拼 `~/.peak/agent/providers.json`」的硬编码已替换。
- ✅ **`PEAK_HOME` env 覆盖**：测试与多实例部署友好，单点控制根目录。
- ✅ **`ensurePeakLayout` 幂等**：每次运行调，缺则建，存在不抛——safe。
- ⚠️ **`ensurePeakLayout` 不建 `providers.json` 所在根目录**：只建 `agents`/`tasks`/`sessions`，`providers.json` 直接在根下；`saveProvidersFile` 自带 `mkdirSync(recursive)` 兜底，OK。
- ⚠️ **`peakHome()` 用 `homedir()`**：跨平台 home 解析，OK；但 `PEAK_HOME` 设为相对路径时 `join(homedir(), ...)` 不触发（env 直接返回），相对路径行为依赖调用方 cwd。
- ⚠️ **`agentFile`/`taskFile` 不 sanitize name**：`join(agentsDir, `${name}.json`)`——若 name 含 `../` 可逃逸 agents 目录。`loadAgent` 的 name 来自 task.json 的 `agents` 数组（用户可控），理论上可 `../../etc/passwd`。当前无校验。风险有限（用户自配），但建议 sanitize。
- ✅ 布局注释清晰，helper 命名直观。
- ✅ `sessionsDir()` 默认作 `SessionManager` 的 baseDir，与 `safeSessionName` 配合堵死路径转义。

### 跨文件观察
- 被 `session-manager.ts`（sessionsDir）、`task-config.ts`（configFile）、`providers-config.ts`（providersFile）、`agent-loader.ts`（agentFile）、`cli.ts`（taskFile/sessionsDir）使用。是整个配置/运行时文件系统布局的根。

---

## 跨文件小结（本册）

1. **✅ 自定义 profile permissions 已修复**：`normalizePermissions` 现读取 `raw.permissions`，自定义 role 拿到声明权限。过往本册最严重 bug 已清零。
2. **✅ anthropic provider 链路已贯通**：`ProviderPreset` 加 `kind?`/`headers?`，anthropic preset 带 `kind:"anthropic"`，`initProvidersFile`/`presetToUserConfig`/`listKnownProviders` 全部透传 kind → ConfiguredProvider 走 createAnthropic。过往跨册根因已清除。
3. **✅ metacog everySeconds 默认值已统一**：`DEFAULT_METACOG_TRIGGERS.everySeconds` 与 `defaultConfig()` 均为 30，control.metacogIntervalSeconds 取同一常量。过往「三处壁钟默认值打架」已解决。
4. **✅ WorkflowConfig/maxSteps/DEFAULT_LIMITS 已移除**：`SchedulerConfig` 只剩资源旋钮，`mergeScheduler` 向后兼容旧 `workflow.limits` 的三个资源字段，maxSteps 等被忽略。过往「maxSteps 默认值三重打架」已不复存在。
5. **✅ conclude 回退已接线**：`PromptSpec.concludeFile` → `normalizePrompt` 解析 → explorer 默认 profile 启用 → subagent-runner 触发回退。conclude 不再是死协议。
6. **✅ safeSessionName 已接线 + 修复 `..`**：`session-manager.ts` 调用，`..` 折叠为 `.`，叠加 relative 检查，路径转义已防御。
7. **⚠️ `agent-loader.mergePrompt` 漏 `concludeFile`**：patch 合并时不透传 concludeFile，agent 想覆盖 conclude 回退会失效——新增字段后的遗漏，建议补。
8. **⚠️ 三处 `stringValue` 同名不同义**：utils.ts（单参 trim）、task-config.ts（双参 dot-path 不 trim），重复定义且签名不同，task-config 仍未 import utils.ts。
9. **⚠️ prompt-loader rules/knowledge 失败回退当文本**：错误的文件路径被当 prompt 喂 LLM。
10. **⚠️ `peak-home.agentFile`/`taskFile` 不 sanitize name**：name 含 `../` 可逃逸目录，风险有限但建议补。
11. 本册历史严重 bug（permissions、anthropic）已全部清零，建议重点关注 §7（mergePrompt 漏 concludeFile）与 §8（stringValue 统一）。
