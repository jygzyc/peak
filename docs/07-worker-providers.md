# 07 · 模型 Provider 层（`src/worker/providers/`）

> 审计范围：3 个文件——`types.ts`（契约）、`registry.ts`（注册表）、`configured.ts`（动态工厂 + ConfiguredProvider）。
> 本层是 worker 的「直连模型 API」适配：不走 agent CLI 子进程，直接调 LLM SDK（OpenAI/Anthropic）拿文本。被 `ApiDriver`（§5.6 即 worker/api-driver）消费。

---

## 7.1 `types.ts`（29 行）— Provider 契约

### 用途
**任意模型后端 worker 的 provider 契约**。实现包装官方 SDK（或自定义），暴露单一 `complete` 调用。agent runtime 把它们当「prompt→text」黑盒。加新模型只需写一个 `implements ModelProvider` 的类并 `registerProvider`（文件头 1–8 行）。

### 关键导出
- `ModelCallInput`：`prompt`/`system?`/`model?`/`temperature?`/`maxTokens?`
- `ModelCallResult`：`text`/`session?`
- `ModelProvider`（interface）：`id`/`complete(input, config): Promise<ModelCallResult>`

### 审计要点
- 🚨 **`ModelCallResult.session?` 字段从未被填充**（codegraph 确认：`configured.ts:45/56` 都 `return { text }`，无 session）——死字段，预留的 session 复用协议（与 `WorkerSessionManager` 呼应），但 ConfiguredProvider 从不产出。
- ⚠️ **`complete(input, config)` 双参**：input 是运行时（prompt/system/model/temperature/maxTokens），config 是 WorkerConfig（含 apiKeyEnv/baseUrl 等）——两处都有 `model`/`maxTokens`，优先级在实现里定（§7.3），契约未声明。
- ⚠️ **`system` 字段**：ModelCallInput 有 `system?`，但 `ApiDriver.execute`（worker/api-driver）只传 `prompt/maxTokens/model/temperature`，**不传 system**——prompt 里混 preamble，未用 system 通道。
- ✅ 契约极简，3 个 interface。

### 跨文件观察
- 被 `registry.ts`（注册）、`configured.ts`（实现）、`api-driver.ts`（消费）使用。

---

## 7.2 `registry.ts`（35 行）— Provider 注册表

### 用途
**动态从 providers.json + builtin preset 构建 provider 注册表**。首次 import 时加载 `~/.peak/agent/providers.json`（或 `PEAK_AGENT_PROVIDERS` env 路径），与 preset 合并，为每项注册一个 `ConfiguredProvider`。外部仍可 `registerProvider` 编程式加自定义 adapter（文件头 1–8 行）。

### 关键导出
- `registerProvider(provider): () => void`（返回 unregister）
- `getProvider(id)`/`listProviderIds()`
- `reloadProviders(explicit?)`：重建 REGISTRY
- re-export `ModelProvider`/`ModelCallInput`/`ModelCallResult`

### 模块级状态
`let REGISTRY = buildProvidersFromConfig(undefined)`——**import 即读盘**（loadProvidersFile）。

### 审计要点
- 🚨 **模块顶层 IO 副作用**（第 13 行）：import 本模块即 `loadProvidersFile()` 读 `~/.peak/agent/providers.json`。测试若不设 `PEAK_AGENT_PROVIDERS` 或 mock 文件，会读真实用户配置，污染测试。`reloadProviders(undefined)` 可重建，但初始副作用不可避免。
- ⚠️ **`REGISTRY` 是模块级 `let`**：`reloadProviders` 整体替换，但 `registerProvider`/`getProvider` 持有的是模块绑定（非快照），reload 后第三方 registerProvider 的项丢失。
- ⚠️ **`registerProvider` 覆盖不报错**：同 id 直接 set，silent override，无 warning。
- ⚠️ **`reloadProviders(explicit as Record<string, never> | undefined)`**（第 31 行）：`as` 强转，类型语义可疑——explicit 是 `Record<string, unknown>`，强转 `Record<string, never>` 不安全。
- ⚠️ **无 unregister builtin 的句柄**：与 backends/registry 同，builtin 注册未保留还原点。
- ✅ unregister 函数模式与 backends 一致。
- ✅ reloadProviders 支持热重载。

### 跨文件观察
- 被 `api-driver.ts`（getProvider/resolveProviderId）、`registry.ts`（worker 层，listProviderIds）使用。`buildProvidersFromConfig` 来自 configured.ts。

---

## 7.3 `configured.ts`（97 行）— 动态 provider 工厂

### 用途
**动态 provider 工厂**：从用户 providers.json（或 preset 默认）构建 `ModelProvider` 实例。取代静态注册 OpenAI/Anthropic/DeepSeek 类，改为单一入口读盘配置 + 构造对应 SDK-backed provider（文件头 1–7 行）。

### 关键导出
- `ConfiguredProvider`（class，implements `ModelProvider`）
- `buildProvidersFromConfig(explicit?): Map<string, ModelProvider>`

### ConfiguredProvider.complete 逻辑
1. `apiKey = resolveApiKey(userConfig, config)`（env 读 keyEnv，缺则抛）
2. `model = config.model ?? userConfig.model`
3. `baseURL = config.baseUrl ?? userConfig.baseURL`
4. `kind = userConfig.kind ?? "openai"`
5. `kind === "anthropic"` → `createAnthropic({apiKey, baseURL})` + `generateText`（含 cacheControl metadata 若有 system）
6. 否则 → `createOpenAI({apiKey, baseURL, headers: userConfig.headers})` + `generateText`

### buildProvidersFromConfig 逻辑
- 先遍历 `PROVIDER_PRESETS`，findProvider(preset.id) 命中则建 ConfiguredProvider
- 再遍历 file 自定义 key，跳过 seen，建 ConfiguredProvider
- 返回 Map

### 审计要点
- 🚨 **anthropic 走 OpenAI SDK 的条件歧义**：`kind === "anthropic"` 才走 createAnthropic。但 `provider-presets.ts` 的 `anthropic` preset（§7.4 即 config/provider-presets）**没有 `kind` 字段**（ProviderPreset interface 也不含 kind）——preset 复制成 providers.json 后 `userConfig.kind ?? "openai"` 回退到 `"openai"`，**anthropic provider 实际走 createOpenAI**，调用 `https://api.anthropic.com/v1` 用 OpenAI 协议，**必然失败**（Anthropic API 非 OpenAI 兼容）。
- 🚨 **`userConfig.headers` 仅 OpenAI 分支传**（第 48 行）：anthropic 分支 `createAnthropic({apiKey, baseURL})` 不传 headers——若 anthropic preset/custom 需自定义 header（如 `anthropic-version`），丢失。叠加 preset 无 headers 字段，anthropic 完整性缺失。
- ⚠️ **`resolveApiKey` 抛错信息含 `userConfig.name ?? "?"`**（第 63 行）：name 可能未设，显示 `?`，debug 不友好。
- ⚠️ **`maxOutputTokens: input.maxTokens ?? config.maxTokens ?? 4096`（anthropic）vs `input.maxTokens ?? config.maxTokens`（openai）**：anthropic 有 4096 兜底，openai 无——两分支默认值不对称，openai 路径 maxTokens 为 undefined 时由 SDK 决定。
- ⚠️ **`experimental_providerMetadata: { anthropic: { cacheControl } }`**（第 43 行）：仅在有 system 时加，cache ephemeral；但 system 当前从不被 ApiDriver 传（§7.1），此分支**实际不可达**。
- ⚠️ **`buildProvidersFromConfig` 的 `findProvider` 两次调**（82–84 preset 路径，89–92 file 路径）：preset 路径里 `findProvider(preset.id, file)` 已命中才 set，file 路径再 `findProvider(id, file)`——同 id 第二次必然命中（因为 file 是来源），冗余。
- ⚠️ **无错误隔离**：单个 provider 构造失败（如 createOpenAI 抛）会拖垮整个 build。
- ✅ 用 `@ai-sdk/openai`/`@ai-sdk/anthropic` + `ai` 的 `generateText`，统一抽象。
- ✅ preset 优先 + 自定义补充的合并顺序清晰。

### 跨文件观察
- 被 `registry.ts`（buildProvidersFromConfig + 初始 REGISTRY）使用；ConfiguredProvider 是所有 preset/custom provider 的唯一实现类。`kind`/`headers` 字段来自 `UserProviderConfig`（见 [09-config.md](./09-config.md) 的 providers-config.ts）。

---

## 跨文件小结（本册）

1. **🚨 anthropic provider 链路断裂**：`provider-presets.ts` 的 anthropic preset 无 `kind`（且 `ProviderPreset` interface 无 kind 字段）→ 复制进 providers.json 后 `kind ?? "openai"` → ConfiguredProvider 走 createOpenAI 调 Anthropic API → 必然失败。需在 preset 或 ProviderPreset 加 `kind`，且 providers-config 的 `initProvidersFile` 复制时要带上。
2. **🪦 `ModelCallResult.session` 死字段** + `experimental_providerMetadata` cache 分支不可达（system 不被传）。
3. **⚠️ 模块顶层 IO 副果**：import providers/registry 即读盘 `~/.peak/agent/providers.json`，测试隔离困难。
4. **⚠️ anthropic/openai 两分支默认值与字段不对称**（maxTokens 4096 兜底、headers 缺失）。
5. 本册是 provider 层，与 `config/provider-presets.ts`、`config/providers-config.ts` 紧耦合——anthropic bug 的根因跨册（preset 定义在 config，消费在 providers），需联合 [09-config.md](./09-config.md) 修。
