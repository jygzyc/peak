# 09 · 配置层（`src/config/`）

> 审计范围：7 个文件——`default-config.ts`、`task-config.ts`、`profile-loader.ts`、`prompt-loader.ts`、`providers-config.ts`、`provider-presets.ts`、`utils.ts`。
> 本层负责 task.json 加载/合并、profile 规范化、prompt 文件读取、provider 配置（含 9 个 builtin preset）。

---

## 9.1 `default-config.ts`（52 行）— 默认配置

### 用途
**task.json 缺字段时的最小可运行配置**。默认不编码领域漏洞挖掘策略；role prompt 保持最小，task.json 可经 `profiles.<id>.prompt.file` 覆盖（文件头 1–8 行）。

### 关键导出
- `defaultConfig(): TaskConfig`

### 默认值
- 4 个 builtin profile（planner/explorer/evaluator/metacog），各绑 `BUILTIN_PERMISSIONS[role]`、graphView（full/focused/evidence-only/summary）、output contract
- workers：仅 `opencode`（kind agent, backend opencode）
- workflow.limits：`maxSteps:1000, maxConcurrent:3, refillPerTick:1, maxStagnation:8`
- workflow.metacog.triggers：`everySteps:5, everySeconds:30, stagnationLevel:3`
- control：`mainProfile:planner, metacogProfile:metacog, metacogIntervalSeconds:30`

### 审计要点
- 🚨 **`metacog.triggers.everySeconds:30`** 与 `DEFAULT_METACOG_TRIGGERS.everySeconds:60`（types.ts）**不一致**——本文件 30，types.ts 常量 60。MetacogSupervisor 读 config（即 30），types.ts 的常量实际无消费方，但数值打架。
- 🚨 **`maxSteps:1000`** 与 `SessionLoop.run` 默认 `maxSteps:100`（[04-session.md](./04-session.md) §4.1）不一致。task-config 合并后 config.workflow.limits.maxSteps=1000，但 `run` 的 RunOptions.maxSteps 默认 100，cli.ts 传 `opts.maxSteps ?? config.workflow.limits.maxSteps`——若用户不传 `--max-steps`，cli 用 config 的 1000；但若调用方直接 `loop.run(id)` 不传 options，走 100。两条路径不同。
- ⚠️ **`runtime: { worker: "opencode" }`**：所有 profile 默认用 opencode backend，而 opencode-cli/opencode-http 不支持 sessionReuse、且需 `opencode serve` 或本地 CLI——开箱即用门槛高。
- ⚠️ **prompt 文件路径 `agent/prompts/planner.md`**：相对路径，PromptLoader 用 baseDir（sessionDir）解析，要求 session 目录下有 `agent/prompts/`——实际 prompt 在 `src/agent/prompts/`，运行时未必可达。
- ⚠️ **`builtinProfile` 不设 `sessionReuse`/`maxActive`/`intervalSeconds`**：全部走下游默认（metacog maxActive 默认 1）。
- ✅ 默认配置完整可运行（除 worker 依赖外部 opencode）。
- ✅ 不编码领域策略，符合「配置驱动」承诺。

### 跨文件观察
- 被 `task-config.loadConfig` 作 merge base、`cli.ts init` 生成模板。`metacogIntervalSeconds:30` 与 MetacogSupervisor 的 `DEFAULT_METACOG_INTERVAL_MS=30000` 一致（巧合）。

---

## 9.2 `task-config.ts`（190 行）— task.json 加载器

### 用途
**task.json 加载与合并**。读用户文件，叠在 defaultConfig() 上，校验必需 task 字段，经 ProfileLoader 规范化 profile，返回 TaskConfig + session 元数据。保持解析结构性；role 语义应在 prompt/config，不在代码（文件头 1–8 行）。

### 关键导出
- `loadConfig(configPath, sessionOverride?): LoadedConfig`
- `LoadedConfig`（config/session/sessionDir/configPath）

### loadConfig 流程
1. resolve + existsSync 校验
2. readFileSync + JSON.parse（try/catch 美化错误）
3. 检测 `agents` 字段 → 抛「removed field」错
4. `mergeConfig(defaultConfig(), parsed)`
5. 校验 task.target / task.goal 必填
6. session = override ?? config.task.session ?? deriveSessionName(absPath)
7. sessionDir = dirname(absPath)

### mergeConfig / mergeWorkers / mergeWorkflow / mergeControl
逐字段合并，override 的 `stringValue`/`numberValue` 命中则覆盖，否则用 base。profiles 始终规范化（含 base 的 4 个 builtin）。

### 审计要点
- 🚨 **`stringValue` 与 `utils.ts` 同名不同义**（第 165 行 vs utils.ts:12）：本文件的 `stringValue(obj, key)` 支持 dot-path（`task.target`），utils.ts 的 `stringValue(value)` 不支持、且 trim。两套同名函数，签名不同，易混。本文件未 import utils.ts，自定义了一份。
- ⚠️ **`deriveSessionName`**（185–189 行）：取 configPath 的父目录名，`replace(/[^a-zA-Z0-9_-]/g,"-")`——**不防 `..`**：若 configPath 在 `../../evil/` 下，父目录名是 `evil`（合法），session 名 `evil`；但若父目录名本身含 `..`（如路径 `foo/..../task.json`），替换后变 `----`。配合 SessionManager 的 `join(baseDir, sessionId)` 路径转义（[04-session.md](./04-session.md) §4.5），session 名虽经 sanitize 但 sanitize 不防 `..` 序列。
- ⚠️ **`agents` 字段检测**（37–39 行）：旧字段迁移保护，good；但只检测 `agents`，不检测其它历史字段。
- ⚠️ **mergeWorkflow 的 `workerLeaseMs` 无 fallback 到 DEFAULT_LIMITS**：`base.limits.workerLeaseMs`——defaultConfig 的 limits 没有 `workerLeaseMs` 字段（只 maxSteps/maxConcurrent/refillPerTick/maxStagnation），所以 base.limits.workerLeaseMs 是 undefined；override 不设则最终 undefined，SessionLoop 用 `DEFAULT_LIMITS.workerLeaseMs`(300000) 兜底——链路对但隐晦。
- ⚠️ **`plannerCooldownSteps` 不在 mergeWorkflow**：types.ts 的 WorkflowConfig.limits 含 `plannerCooldownSteps?`，但 mergeWorkflow 不解析它，session-loop 用 `?? 3` 兜底。
- ⚠️ **profiles 合并 `{...base.profiles, ...profiles}`**（83–85 行）：先展开 base 再展开 profiles——但 profiles 已是含 4 builtin + custom 的完整集（67–71 行规范化），二次展开 base 是冗余（base.profiles 已在 profiles 内）。
- ⚠️ **无 schema 校验**：仅校验 target/goal 非空，profile 内部字段错误靠 normalizeProfile 抛错，worker 字段类型错误静默吞（stringValue 返 undefined）。
- ✅ `agents` 旧字段检测 + 清晰错误信息。
- ✅ profile 始终规范化，下游形状保证。

### 跨文件观察
- 被 `cli.ts run`、`index.ts` re-export。`normalizeProfile` 来自 profile-loader。

---

## 9.3 `profile-loader.ts`（117 行）— Profile 规范化

### 用途
**SubagentProfile 配置规范化**。严格 profiles-only，无 legacy 字段映射。每个 profile 必须声明 runtime/prompt/context/permissions/output（文件头 1–6 行）。

### 关键导出
- `normalizeProfile(profileId, raw): SubagentProfile`

### 规范化逻辑
- role = `r.role ?? profileId`
- runtime：`r.runtime ?? r` 作源，必须 `worker`；可选 workers/model/provider
- prompt：必须 `prompt.file`；可选 rules/knowledge/instructions
- context：graphView 默认 full；可选 maxFacts/includeDeadEnds/includeProgress/rotateOnContextFull/relevanceScope
- **permissions：`BUILTIN_PERMISSIONS[role] ?? BUILTIN_PERMISSIONS[profileId] ?? []`**
- output：contract 默认 candidate_fact
- 可选 maxActive/intervalSeconds

### 审计要点
- 🚨 **`normalizePermissions` 忽略 `raw.permissions`**（95–97 行）：`return BUILTIN_PERMISSIONS[role] ?? BUILTIN_PERMISSIONS[profileId] ?? []`——**完全不看 raw.permissions**。自定义 profile 在 task.json 声明的 `permissions: [...]` 被丢弃，强制用 builtin。与 AGENTS.md「custom profiles declare their own via SubagentProfile.permissions」承诺**直接冲突**。自定义 role（如 `android-source-finder`）无法获得任何权限，decision-applier 全部 require 失败。
- ⚠️ **`normalizeContext` 的 `view as GraphView`**（82 行）：`str(contextRaw.graphView) as GraphView` 强转，LLM/用户写 `graphView: "ful"`（拼错）会通过强转，运行时 renderGraphView 的 default 分支回退 full，静默吞错。
- ⚠️ **`normalizeOutput` 同款强转**（101 行）：`contract as OutputContract`。
- ⚠️ **`normalizeRuntime` 的 `src = runtimeRaw ?? r`**（45 行）：允许 profile 顶层直接写 worker/model（无 runtime 包裹）——向后兼容，但与 SubagentProfile 类型（runtime 必须是对象）不符。
- ⚠️ **`normalizePrompt` 强制 `prompt.file`**（60–69 行）：未声明抛错——但 defaultConfig 的 builtin profile 都有 file，custom profile 漏 file 会硬失败。
- ⚠️ **`str`/`num`/`strArr` 重复定义**：与 utils.ts/task-config.ts 各有一套字符串解析助手，三处重复。
- ✅ 严格规范化，缺字段即抛错（fail-fast）。
- ✅ role 回退到 profileId，允许 profile 名即 role 名。

### 跨文件观察
- 被 `task-config.mergeConfig` 对每个 profile 调用。permissions bug 是自定义 profile 的致命缺口。

---

## 9.4 `prompt-loader.ts`（75 行）— Prompt 文件加载

### 用途
**从 PromptSpec 组装 subagent prompt**。从 `prompt.file`（必填，相对 task config dir）读 role preamble，按序追加可选 rules/knowledge/instructions 文件或文本。动态 graph context 由 ContextBuilder 另外前置；本 loader 只产静态 role preamble（文件头 1–8 行）。

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
- resolvePath：绝对路径直用，否则 `resolve(baseDir ?? cwd, p)`

### 审计要点
- 🚨 **`tryReadFile` 失败静默返 undefined**（56–65 行）：primary 失败则 `load` 返 `{preamble:"", fromConfig:false}`——subagent-runner 检测 `!fromConfig` 抛错（见 [03-agent.md](./03-agent.md) §3.7），OK；但 rules/knowledge 的 `tryReadFile(rule) ?? rule`：文件读失败则把 rule 路径字符串当正文 push——**用户写错 rules 文件路径，路径字符串会被当 prompt 文本喂给 LLM**，静默污染。
- ⚠️ **`looksLikePath` 启发式**（72–74 行）：`/\.[a-z0-9]+$/i` 把任何末尾带点的字符串当路径——普通句子 `Use the API.` 会被当路径，existsSync 失败返 undefined，`?? rule` 当文本，侥幸 OK；但 `a/b` 含斜杠必当路径。
- ⚠️ **无路径转义防护**：`resolvePath` 不防 `../`，baseDir 外的文件可读——读 prompt 文件风险低（用户自配），但 rules/knowledge 若被外部输入控制可读任意文件。
- ⚠️ **无文件大小限制**：读巨大文件直接进 prompt，可能撑爆 context。
- ⚠️ **`---` 分隔符**：markdown YAML front-matter 语义，但这里是分隔追加块，LLM 可能误解。
- ⚠️ **fromConfig 只反映 primary**：rules/knowledge 读失败不影响 fromConfig=true，调用方无法知道部分加载。
- ✅ 文件优先 + 文本回退的 rules/knowledge 设计灵活。
- ✅ baseDir 可配，测试友好。

### 跨文件观察
- 被 `subagent-runner`（每次 runSubagentWithText new 一个，或复用传入）、`session-loop`/`metacog-supervisor`（构造时 new）使用。

---

## 9.5 `providers-config.ts`（144 行）— providers.json 加载

### 用途
**用户自定义 provider 配置**，从 `~/.decx/agent/providers.json`（或 `DECX_AGENT_PROVIDERS` env）加载。schema 镜像磁盘 JSON：每 provider 按 id 键，含 baseURL/apiKeyEnv/model + 可选覆盖。id 对应 task.json 的 `worker.provider`。builtin preset 提供常见 API 默认，用户只需复制 preset 进文件填 key（文件头 1–11 行）。

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
- 🚨 **`initProvidersFile` 复制 preset 时丢失 `kind` 和 `headers`**（79–86 行）：`seeded[preset.id] = { name, baseURL, apiKeyEnv, model }`——**不复制 preset 的 kind/headers**（虽然 preset 本身也没 kind 字段，见 §9.6）。即便 preset 加了 kind，initProvidersFile 也不写进 providers.json。叠加 §9.6 的 anthropic preset 无 kind，anthropic provider 永远 kind=undefined → ConfiguredProvider 走 openai 分支（[07-worker-providers.md](./07-worker-providers.md) §7.3）→ 必然失败。
- 🚨 **`loadProvidersFile` 的模块级缓存**（36–37、46、59–61 行）：`cachedFile`/`cachedPath` 进程级缓存，saveProvidersFile 清缓存，但**外部修改 providers.json 后缓存不失效**——测试与运行时可能读到陈旧配置。`reloadProviders`（providers/registry）调 `loadProvidersFile()` 走缓存，无法强刷。
- ⚠️ **`loadProvidersFile` JSON 解析失败静默返 `{}`**（55–57 行）：catch 块 `result = {}`，用户 providers.json 写坏无提示，provider 全消失。
- ⚠️ **`findProvider` 的 `presetToUserConfig` 不带 kind/headers**（99–103、136–143 行）：preset 回退路径同样丢失 kind——即便 preset 有 kind，转 UserProviderConfig 也不带。
- ⚠️ **`defaultProvidersPath` 用 homedir()**：跨平台 home 解析，OK；但无 DECX_HOME 联动（与 decx-cli 的 `~/.decx` 机制不互通，本包固定 `~/.decx/agent/providers.json`）。
- ⚠️ **`saveProvidersFile` 无原子写**：直接 writeFileSync，中途崩溃可能损坏文件。
- ⚠️ **`listKnownProviders` 输出无 kind**（108–134 行）：返回项无 kind 字段，CLI 展示无法区分 openai/anthropic。
- ✅ user 优先 + preset 回退的合并顺序清晰。
- ✅ homedir + env 覆盖路径。

### 跨文件观察
- 被 `providers/registry`（buildProvidersFromConfig → loadProvidersFile）、`api-driver`（resolveProviderId → loadProvidersFile + findProvider）、`providers/configured`（findProvider/loadProvidersFile）使用。是 provider 层的配置源。

---

## 9.6 `provider-presets.ts`（100 行）— Builtin Provider Preset

### 用途
**常见中外 LLM API 的 builtin preset**。每个是完整 provider 配置，用户复制进 `~/.decx/agent/providers.json` 填 key。镜像 cc-switch 的「50+ preset」但用简单 JSON，无 GUI（文件头 1–15 行）。

### 关键导出
- `ProviderPreset`（interface：id/name/baseURL/apiKeyEnv/model/description）
- `PROVIDER_PRESETS: ProviderPreset[]`：9 个（openai/anthropic/deepseek/glm/minimax/kimi/qwen/openrouter/ollama）

### 审计要点
- 🚨 **`ProviderPreset` interface 缺 `kind` 与 `headers` 字段**（17–24 行）：只有 id/name/baseURL/apiKeyEnv/model/description——**无法表达 anthropic（需 kind:"anthropic"）**。anthropic preset（36–42 行）因此无 kind，ConfiguredProvider 走 openai 分支调 Anthropic API 必然失败。需在 ProviderPreset 加 `kind?`/`headers?`，且 initProvidersFile/presetToUserConfig 复制时带上。
- ⚠️ **模型版本疑似占位/未来版本**：`gpt-5.5`、`claude-4.8-opus`、`deepseek-v4-pro`、`glm-5.2`、`MiniMax-M3` 等——审计时点（2026-07）这些版本号需核实是否真实存在；若为占位，用户复制后需手改 model。
- ⚠️ **`ollama` preset 的 `apiKeyEnv: "OLLAMA_API_KEY"` + `model: "llama3.2"`**：ollama 本地无需 key，但 preset 要求 OLLAMA_API_KEY env——description 提示「set OLLAMA_API_KEY=ollama」，UX 别扭。
- ⚠️ **`openrouter` preset model `anthropic/claude-4.6-sonnet`**：跨厂商 model id，依赖 openrouter 路由；kind 仍是 openai（openrouter 是 OpenAI 兼容），OK。
- ⚠️ **preset 间 baseURL 末尾斜杠不一**：多数有 `/v1`，ollama 是 `http://localhost:11434/v1`，openrouter `https://openrouter.ai/api/v1`——一致 OK；但 ConfiguredProvider 不清理末尾斜杠（opencode-http 会清理），拼接 `/chat/completions` 时若 baseURL 带尾斜杠会双斜杠。
- ✅ preset 集中定义，便于维护。
- ✅ description 字段供 CLI 展示。

### 跨文件观察
- 被 `providers-config`（initProvidersFile/findProvider/listKnownProviders/presetToUserConfig）、`api-driver`（resolveProviderId 扫 preset）、`providers/configured`（buildProvidersFromConfig）使用。是 anthropic bug 的根因源头。

---

## 9.7 `utils.ts`（49 行）— 共享解析助手

### 用途
**跨配置加载/协议解析/HTTP handler 的共享解析助手**。集中 `isRecord`/`stringValue` 等，避免每模块重复（文件头 1–4 行）。

### 关键导出
- `isRecord(value)`、`stringValue(value)`（trim）、`stringArray(value)`（trim 过滤）、`positiveInt(value)`、`safeSessionName(value)`、`utcnow()`、`parseJson(value, fallback)`

### 审计要点
- 🚨 **`safeSessionName` 无生产调用方**（codegraph 确认：仅 config-utils.test.ts 调用）：`replace(/[^a-zA-Z0-9._-]+/g,"-").replace(/^-+|-+$/g,"")`——**不防 `..`**（`.` 是允许字符）。即便被调用，session 名 `../evil` → `../evil`（保留），路径转义仍成立。当前生产无调用，等于「转义防护未接线」。
- 🚨 **整个 `utils.ts` 无生产 import**（codegraph + grep 确认：`src/` 内无任何文件 `from ".../config/utils"`）：`isRecord`/`stringValue`/`stringArray`/`positiveInt`/`utcnow`/`parseJson` 全部仅被 config-utils.test.ts 测试。**整个文件是死代码**（生产侧），task-config.ts 自定义了同名 stringValue，http-server 用自己的解析。文件头宣称「避免重复」却无人用。
- ⚠️ **`stringValue` 与 task-config.ts 同名不同签名**（见 §9.2）：本文件 `stringValue(value)` 单参 trim，task-config `stringValue(obj, key)` 双参 dot-path——若有人误 import，行为不符预期。
- ⚠️ **`parseJson` 用 `String(value ?? "")`**：对 null/undefined 返空串再 JSON.parse 抛错走 fallback，OK；但对对象 `String({a:1})` → `"[object Object]"` 解析失败 fallback。
- ⚠️ **`positiveInt` 不支持负数/0**：`parsed > 0`，0 被拒——某些配置 0 是合法值（如 maxSteps=0 表无限）。
- ✅ 函数小而专注，注释清晰。
- ✅ `safeSessionName` 思路正确（即便未接线、且 `.` 漏洞）。

### 跨文件观察
- 被 `config-utils.test.ts` 测试，但生产零消费。是「写了通用工具却没推广采用」的典型——要么接线（替换 task-config/http-server 的重复助手 + 修 safeSessionName 防 `..`），要么删除。

---

## 跨文件小结（本册）

1. **🚨 自定义 profile permissions 丢失**：profile-loader 忽略 raw.permissions，强制 builtin——自定义 role 拿不到任何权限，与 AGENTS.md 承诺冲突。是配置层最严重 bug。
2. **🚨 anthropic provider 链路断裂（跨册根因在此）**：provider-presets 的 ProviderPreset 无 kind 字段 + anthropic preset 无 kind → initProvidersFile/presetToUserConfig 不复制 kind → ConfiguredProvider 走 openai 分支 → 调 Anthropic API 失败。需在 ProviderPreset + UserProviderConfig + 各复制点统一带 kind/headers。
3. **🚨 `utils.ts` 整文件生产死代码 + `safeSessionName` 不防 `..`**：路径转义防护写了但没接线，且本身漏 `.`。
4. **⚠️ 三处 `stringValue` 同名不同义**：utils.ts（单参 trim）、task-config.ts（双参 dot-path）、重复定义。
5. **⚠️ metacog everySeconds 默认值打架**：defaultConfig(30) vs DEFAULT_METACOG_TRIGGERS(60)。
6. **⚠️ prompt-loader rules/knowledge 失败回退当文本**：错误的文件路径被当 prompt 喂 LLM。
7. 本册含 2 个 sever bug（permissions、anthropic），建议优先修。
