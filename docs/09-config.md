# 第一版配置合同

> 当前实现审计，2026-07-16。配置解析严格失败，不执行字段映射、迁移或双重解释。

## TaskConfig

```text
task        target/goal 必填；可选 session/name/workspace
profiles    profile id -> 固定协议角色配置
workers     底层 agent/api/mock worker
scheduler   maxConcurrent/refillPerTick/workerLeaseMs
control     main/explorer/evaluator/metacog profile 绑定 + globalMaxConcurrent
federation  scope + members
agents      task 文件中的可复用 agent patch 名称数组
```

`workflow`、`federation.group`、`federation.enabled` 和 `control.metacogIntervalSeconds` 不属于 schema，出现即报错。metacog cadence 的唯一来源是所绑定 profile 的 `triggers.everySeconds`。

合并顺序是 `defaultConfig() <- PEAK_HOME/config.json <- task.json`。global baseline 或 task JSON 损坏会立即失败。task prompt 相对路径按 task config 所在目录解析；agent patch prompt 相对路径按 agent 文件所在目录解析。

## Profile

每个 profile 规范化为：

```text
role
runtime { worker, workers?, model?, provider? }
prompt  { file, instructions?, rules?, knowledge?, skills?, concludeFile? }
context { graphView, maxFacts?, includeDeadEnds?, includeProgress?, ... }
permissions
output { contract }
maxActive / cooldownSteps / triggers / maxOutputTokens / retry
```

`role` 只能绑定 planner/explorer/evaluator/metacog。自定义 profile id 用于多开或专门化同一协议角色；permission 只能是该角色能力上限的子集，output contract 必须与角色匹配。`control.*Profile` 决定四个协议槽实际使用哪个 profile，SessionLoop 在启动时再次验证 role。

Agent 文件是对 builtin slot 的 patch，不是另一套 profile schema。任务 `agents` 中的名称只能含字母、数字、点、下划线或连字符，且不能包含路径；`agentFile/taskFile` 和测试注入目录都执行同一校验。

## Worker 与 provider

Worker 的 `kind` 是 `agent | api | mock`。agent backend 可选 Codex、Claude Code、OpenCode 或 custom process；api worker 通过 provider 配置调用模型。

`providers.json` 存在时必须是合法对象，每项必须含 `baseURL/apiKeyEnv/model`。解析失败、字段缺失、非法 kind 或非字符串 header 都会报错，不会静默选择 preset。

## Session 与路径

- `PEAK_HOME` 默认 `~/.peak`，所有持久状态统一位于其下。
- session id 经 SessionManager 校验，不能逃逸 sessions 目录。
- workspace 以 task config 目录为基准解析，与 session DB 目录分离。
- 未指定 federation scope 时以 session id 作为 scope，避免无关任务自动成组。

## 当前余项

1. 对 graphView、trigger 和所有数字 tuning 字段进一步统一严格范围校验。
2. PromptManifest 的 task-config 指纹改用 canonical serializer，形成跨平台稳定 hash。
3. provider 配置可增加未知字段拒绝或告警，减少拼写错误。
