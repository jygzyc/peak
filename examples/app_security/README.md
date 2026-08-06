# App Security Board

## 背景

本示例演示 Peak 驱动的 Android 应用漏洞挖掘:一个独立项目审计 `target/` 下的 APK,产出安全审计报告。项目 Goal 只描述最终结果,领域方法由已安装的四个 Skill 提供,任务拆分与依赖管理刻意不出现在领域配置中,由 Peak 根据 Goal 与当前进展自行组织。

## 功能

- 领域 Skill:
  - `decx-cli` — CLI 命令用法:打开目标、检查代码与组件清单、管理会话。
  - `decx-vulnhunt` — 漏洞挖掘方法:攻击面收集、模式路由、证据门(入口/可达性/可控性/防护/危险操作/可见影响逐级取证)、风险评级。
  - `decx-report` — 由定稿漏洞记录生成审计报告。
  - `decx-poc` — 由单条定稿漏洞记录构建 PoC。
- PoC 验证门:每条漏洞必须构建 PoC,并在 adb 连接的设备(真机或模拟器)上实际运行验证,观察到真实证明信号(adb logcat 日志、返回数据、目标行为);Supervise 对未通过 PoC 验证的漏洞一律退回,不得作为已证实漏洞。
- 报告包含三部分:已证实漏洞;按功能实现组织的风险地图(每个功能的实现对应的可能风险与当前已发现漏洞);潜在风险(存在代码级漏洞证据但现有利用条件不足、证据链有明确缺口的路径,逐项写明缺口与所需条件)。三部分口径严格分离,潜在风险不得作为已证实漏洞呈现。
- Custom Profile 在攻击面收集、单路径跟踪、评级定稿、PoC 构建验证、潜在风险整理或报告组装时提供针对性指引。

## 前置条件

- 已安装 `decx` CLI,Worker 进程可直接调用。
- 在 `task.json` 的 `source` 空位中填写应用信息:应用名称、包名、版本,以及 APK 本地路径或下载地址。
- 具备编译/部署条件(Android SDK/Gradle),并通过 adb 连接真机或模拟器,用于部署运行 PoC 与观测证明信号。
- Pi 已完成认证;两个 Worker 分别使用 `deepseek/deepseek-v4-flash`(Plan/Supervise)与 `minimax-cn/MiniMax-M3`(Execute)。

## 预期结果

- `app-security-report.md`(由完成阶段的 Execute 内联返回,Peak 物化到项目 `out/` 目录),含三部分:按 `decx-report` Skill 模板渲染的已证实漏洞、按功能实现组织的风险地图、潜在风险清单。
- 中间工作(攻击面清单、单路径证据、评级结论)通常返回简洁的无文件结果;Worker 不直接写交付文件。

## 运行

```bash
npm run build
node dist/cli.js run examples/app_security
```

项目的 `id` 初始为空,首次运行会把生成的 UUID 写回 `task.json`,后续运行复用。
