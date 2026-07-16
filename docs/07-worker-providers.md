# Direct Model Provider

> 当前实现审计，2026-07-16。

`ApiDriver` 是 WorkerPool 到直接模型 provider 的薄映射层。`ConfiguredProvider` 使用 AI SDK 的 OpenAI/Anthropic adapter，接收 prompt、system、temperature、max token 与 AbortSignal，不参与 Graph mutation、角色选择或重试策略。

## 配置来源

- 默认路径：`PEAK_HOME/providers.json`；`PEAK_AGENT_PROVIDERS` 可显式覆盖文件位置。
- 文件不存在时使用内置 provider preset。
- 文件存在但 JSON、根对象、必填字段、kind 或 headers 不合法时立即报错；不会静默退回 preset。
- 每项必须声明非空 `baseURL`、`apiKeyEnv`、`model`；`kind` 只能是 `openai` 或 `anthropic`；headers 的值必须是字符串。

API key 只从配置指定的环境变量读取，缺失时在调用前失败。用户配置覆盖同 id preset；未知 id 可作为新增 provider。

## 取消与错误

AbortSignal 直接传给 SDK。provider 只返回文本，envelope 解析和 output contract 校验由 agent 协议层完成。网络、鉴权和模型错误不得在 provider 内转换成虚构的成功输出。

## 当前余项

1. 为真实 OpenAI-compatible 与 Anthropic endpoint 增加可选集成测试。
2. 对 provider 配置增加秘密字段误写检测，避免用户把 key 明文写入 `apiKeyEnv`。
