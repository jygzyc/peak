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
- `board.skills` 是 Task 级 Skill 安装/允许列表；每个 Custom Profile 用 `customProfile.skills` 只选择当前阶段所需的子集，在攻击面收集、单路径跟踪、评级定稿、PoC 构建验证、潜在风险整理或报告组装时提供针对性指引。所选名称会记录在本地 `graph-*.json` 的 `customProfile.skills` 下，但快照不包含顶层 Skills 或 Worker 配置。

## 前置条件（`execution.mode: "docker"`）

本示例用 docker 执行后端：worker 在 per-project 容器内运行，decx / frida / adb / radare2 等工具预装在 `peak-task` 镜像里，无需宿主机单独安装。

- **构建镜像**（docker 或 podman）：`docker build container/ -t peak-task:$(cat version)`
- **Provider key**：docker 模式不挂载宿主机 CLI 配置目录，需在 `task.json` 的 `workers[].env` 填入各 Worker 的 provider key（opencode / pi 的 key，例如 `PI_API_KEY`）。
- **Android 设备**：宿主机运行 `container/device-bridge.sh usb start` 接入真机或模拟器（容器经 `host.docker.internal` 复用宿主机 adb server，无需 USB 直通）。
- 在 `task.json` 的 `source` 填写应用信息：应用名称、包名、版本，以及 APK 本地路径或下载地址。
- 具备编译/部署条件（Android SDK/Gradle，镜像内已含 cmdline-tools）用于 PoC 构建部署。

## 预期结果

- `app-security-report.md`(由完成阶段的 Execute 内联返回,Peak 物化到项目 `out/` 目录),含三部分:按 `decx-report` Skill 模板渲染的已证实漏洞、按功能实现组织的风险地图、潜在风险清单。
- 中间工作(攻击面清单、单路径证据、评级结论)通常返回简洁的无文件结果;Worker 不直接写交付文件。

## 运行

```bash
npm run build
docker build container/ -t peak-task:$(cat version)   # 构建任务镜像
container/device-bridge.sh usb start                       # 接入 Android 设备（宿主机）
node dist/cli.js serve --port 8000                          # 独立 Graph Server
node dist/cli.js start examples/app_security --graph-url http://127.0.0.1:8000
```

`start` 会先创建缺失 Project、写回完整 UUID 集，再启动后台 Dispatch；后续运行复用这些 UUID。`execution.mode: "docker"` 下容器引擎或镜像不可用时整个 Task 回退 `local`。完成后运行 `node dist/cli.js stop`。
