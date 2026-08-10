# peak-task 镜像凭据注入矩阵

镜像只解决"装什么"，不解决"登录谁"。**凭据一律运行期注入**：只进 task 容器，不进 Server，不进镜像层。

| 后端 | CLI 命令 | 方式 A：task.json 显式 env（推荐） | 方式 B：登录态挂载（只读） |
| --- | --- | --- | --- |
| claude-code | `claude` | worker `env` 配置 `ANTHROPIC_API_KEY` | 自动挂载 `~/.claude` → `/root/.claude`（复用主机 OAuth 登录态） |
| codex | `codex` | worker `env` 配置 `OPENAI_API_KEY` | 自动挂载 `~/.codex` → `/root/.codex` |
| opencode | `opencode` | worker `env` 配置 provider key（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `DEEPSEEK_API_KEY` / `GOOGLE_API_KEY` 等） | 自动挂载 `~/.local/share/opencode` → `/root/.local/share/opencode` |
| pi | `pi` | worker `env` 配置 provider key（同上矩阵，按其 provider 配置） | 自动挂载 `~/.pi` → `/root/.pi` |

## 注入规则

- **Peak 绝不主动扫描主机环境变量**。API key 必须显式写在 `task.json` 的 per-worker `env` 里；该配置随 `/board` 挂载进容器，由容器内 Runtime 的 `ProcessRunner` 照常合并进 worker 子进程——值不经过 docker 命令行，`docker inspect` 不可见。
- 登录态目录一律 **只读**。需要刷新登录态、写锁文件或在 home 下保存会话的 CLI 可能失败；Docker 严格隔离场景应优先使用方式 A。Worker 的显式临时状态必须落在当前 Project `.tmp/`。
- 只有主机上**已存在**的登录态目录才会被挂载，无需手写任何 docker 参数。

## Skills 挂载

- 主机 `~/.agents/skills`（OpenCode 与 Pi）和 `~/.claude/skills`（Claude Code）只读挂载；Codex 不使用 Skills。
- Docker Runtime 总是使用 `--no-install-skills`。当目标全局 Skill 不存在时，启动器把 Board 自带 `skills/<name>` 直接只读 overlay 到相应容器发现路径；既不创建临时链接，也不修改主机 Skill 目录。

## entrypoint 凭据预检

容器启动时 `entrypoint.sh` 对 task 实际使用的后端（`PEAK_PREFLIGHT_BACKENDS`，由 `peak start --docker` 从 `task.json` 的 worker 类型生成）逐一探测：

1. CLI 在镜像中可执行（缺失 → 提示该 CLI 未安装，需重建镜像）；
2. 存在至少一个认证信号：`task.json` worker `env` 中配置了对应 key、容器 env 已设置（用户自行注入的）、或对应登录态目录已挂载且非空。

任一后端缺失即快速失败并打印该用的配置方式——避免任务跑到一半才在 worker 超时报错。预检是**启发式信号检查**，不验证凭据真实有效性；凭据过期/额度耗尽仍以 worker 阶段错误呈现。

## 镜像分发与构建

- **镜像构建不是 Peak 运行时的职责，也不在 Peak 仓库范围内**。`container/` 仅保存镜像资产（Dockerfile、entrypoint、compose、AUTH.md）作为纯文件；构建上下文组装与 `docker build` 由仓库之外的流程负责，正式发布时推送 `peak-task:<version>` 到 docker.io。四个 agent CLI 一律安装最新版，不做版本钉版，升级随镜像重建自然发生。
- **Peak 只使用镜像**：`peak start --docker` 在本地镜像缺失时先 pull 已发布镜像；pull 也拿不到时抛出 `DockerImageUnavailableError`，CLI 自动**回退本地模式**（task 管理 API 显式选择 docker 时则返回可读错误，不静默回退）。
- 镜像预装常用工具：adb、frida（frida-tools）、radare2（含 r2ghidra、r2flutter 插件）、tmux。要新增工具请修改 `container/Dockerfile` 后用脚本重建——容器是 `--rm` 的，运行期安装不留存。
- `container/docker-compose.yaml` 是镜像的对外编排接口：给出 adb 连接 USB 物理设备的挂载方式（Linux `/dev/bus/usb` + privileged；Windows 走 usbipd-win 进 WSL2；macOS 用 network adb），以及纳入既有 compose/K8s 体系的参考封装。

## 注意

- Graph API 本身公开，Peak 不实现访问 token。是否增加反向代理或网络边界由部署方决定。
- 容器内 `host.docker.internal` 经 `--add-host host.docker.internal:host-gateway` 提供；Docker Desktop（Windows/macOS）与 Linux 均可用。
