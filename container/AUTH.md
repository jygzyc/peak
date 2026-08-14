# peak-task 镜像

Peak 的执行层是 **Cairn 形式**：dispatcher（Runtime）在宿主机调度，每个 Project 对应一个**长驻 worker 容器**（`sleep infinity`），Runtime 用 `docker exec` 把 worker 命令推进容器。worker 容器**零宿主机挂载**——graph 数据在 prompt 内、API key 走 worker env、Skills 走 `docker cp`、工作目录是容器内 `/work`。

## 执行模式（task.json `execution`）

| 模式 | 说明 |
| --- | --- |
| `local`（默认） | worker 作为宿主机子进程运行，per-project `.tmp` 工作目录，复用宿主机已配置的 CLI |
| `docker` | Runtime 在宿主机，每个 Project 一个长驻容器 + `docker exec`，零挂载，自包含镜像 |

`execution.mode: "docker"` 时，容器引擎或镜像不可用会让整个 Task 回退 `local`。

```json
{ "execution": { "mode": "docker", "networkMode": "host" } }
```

### docker 模式数据流（零挂载如何工作）

| 数据 | 传递方式 |
| --- | --- |
| Graph | 渲染进 prompt（worker 不直接访问 Project shard / SQLite） |
| API key | task.json `workers[].env` 注入（如 `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY`、`PI_API_KEY`），经 `docker exec -e` 进容器，**不挂载 `~/.claude`** |
| Skills | Board skills 通过 `docker cp` 注入容器；常用全局 skill 预装进镜像 |
| 工作目录 / 临时文件 | 容器内 `/work`（per-project 容器隔离，容器可写） |
| Artifact | worker 以 inline 文本输出，Runtime 存为内容寻址 Artifact（不通过文件路径回传） |

容器生命周期：Project 激活时 `ensureWorkspace` 起独立容器（已存在则复用）；Runtime 结束时删除其管理的容器；同名已停止容器在下次启动前自动回收。

## 预装工具

| 类别 | 工具 |
| --- | --- |
| Android 静态分析 | **decx**（`@jygzyc/decx-cli` + `decx self install`，JDK 17 运行） |
| Android 动态分析 | frida-tools、adb（复用宿主机 adb server）、radare2 + r2ghidra + r2flutter |
| Android 结构/脱壳 | androguard、unicorn、capstone |
| Web / 网络渗透 | nmap、nuclei、ffuf、sqlmap、proxychains4、impacket、chisel |
| 通用 | tmux、python3、git、curl、socat |
| Peak 内置辅助脚本 | `adb-setup`、`frida-auto`（crypto/ssl/root hook 模板） |

## Docker 网络（task.json `execution`）

```json
{
  "execution": {
    "mode": "docker",
    "networkMode": "host"
  }
}
```

`networkMode` 省略时使用容器引擎默认网络（通常为 `bridge`）；动态分析需要宿主监听端口时可显式设为 `host`。

## Android 设备接入

容器复用宿主机 adb server，不依赖 USB 直通或 `privileged`，Linux 与 Docker Desktop（Windows/macOS）行为一致：

1. 宿主机启动桥接：
   ```bash
   container/device-bridge.sh usb start          # USB 直连，推荐
   container/device-bridge.sh wifi <phone-ip> start  # WiFi，备选
   ```
2. 任务容器内 `adb-setup` / `frida-auto` 自动经 `host.docker.internal` 连接（`ADB_SERVER_SOCKET`、`FRIDA_HOST` 已 bake 进镜像）。

## 镜像分发与构建

- 镜像构建不属于 Peak 运行时。`container/` 保存 Dockerfile、device-bridge、脚本和本说明。
- Dockerfile 兼容 docker 与 podman；两种引擎都可构建：
  ```bash
  docker  build container/ -t peak-task:$(cat version)
  podman build container/ -t peak-task:$(cat version)
  ```
- `docker` 执行模式自动探测宿主机容器 CLI（优先 docker，次选 podman）；`PEAK_CONTAINER_RUNTIME` 可强制指定（如 `podman`）。DockerBackend 的 `--add-host host.docker.internal:host-gateway` 需要 podman >= 4。
- `docker` 模式优先使用本地 `peak-task:<version>`；不存在时拉取发布镜像，拉取失败回退 `local`。

## 注意

- `docker` 模式容器无 ENTRYPOINT，`CMD sleep infinity` 常驻等 `docker exec`；key 走 worker env（不挂载 CLI 配置目录）。
- Graph API 公开，Peak 不实现访问 token；网络边界由部署环境负责。
