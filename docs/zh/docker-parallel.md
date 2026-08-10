# Peak Docker 并行化方案（per-task 容器，对标 Cairn）

> 本文档描述参考 [Cairn](https://github.com/oritera/Cairn) 的部署形态实现的“Server 在本机 + 每个 task 一个独立容器”方案。`.projects.json` 登记、外部图模式、严格只读挂载、`container/` 镜像资产、`peak start --docker` 和 task 管理界面均已落地；当前实施环境没有可用 Docker engine，因此真实容器端到端仍未验证。

## 1. 设计取向

- **隔离单元是 task（Board），不是 Project**。一个 `task.json` 定义一个 Board：拥有自己的 workers/scheduler/skills 配置和一组 Projects。task 内多 Project 之间的 FactRef 联邦是 Peak 的既有设计机制——同一 task 的 Projects 同属一个调度进程，联邦原样保留，**不需要任何开关**。跨 task 本来就没有联邦。
- **Server 本体在本机运行不变**：主机上 `peak serve` 独占根数据目录，提供 Graph API、Dashboard 与 task 管理控制面（第 7 节）。
- **每个 task 一个独立容器，可选本地或 Docker**：本地跑是现状的 `peak start`；Docker 跑是同一二进制的 `--graph-url` 外部图模式 + 按 UUID 精确目录映射。两形态长期共存（对应 Cairn 的 local mode / container mode）。
- **一个共享镜像**：预装全部 agent CLI 的 peak-task 镜像被所有 task 容器共用；镜像**不含任何凭据**，登录态与 API key 在容器启动时注入（见第 5 节）。
- **per-task 严格隔离**：容器只挂载本 task 的 Board 和 Project UUID，不可见根数据目录或其他 task；Project 目录只读，仅各自 `.tmp/` 可写（见 3.2）。

与 Cairn 的对照：Cairn Server ≈ 本机 `peak serve`；Cairn Dispatcher + per-project Worker 容器 ≈ per-task 容器（调度 + worker 执行一体）。Peak 把调度与 worker 收在同一个 task 容器里，因为 Board 本身就是调度与配置的原子单位，task 内联邦又要求同进程。

## 2. 根数据目录与目录布局

### 2.1 根数据目录可指定

Server 与 task 启动统一以**根数据目录**为准：CLI 已有 `--peak-home <directory>`（`cli.ts` 各命令，默认 `~/.peak`，可用 `PEAK_HOME` 环境变量覆盖，`src/utils/paths.ts`）。本方案把它提升为部署的一等公民：

- 主机 `peak serve --peak-home <root>` 独占该根目录；
- task（本地或容器）引用同一个 `<root>`；容器内以固定路径 `/peak` 出现；
- 同一主机可运行多个相互隔离的 Server（不同 `<root>`、不同端口）。

### 2.2 布局

```text
<root>/
├── .projects.json          # 进程/归属登记（见 3.3），Server 权威维护
├── server.pid / server.json # serve 自身的单实例登记（现状保留）
├── tasks/                  # Server 管理的 Board 目录（task 管理界面，见第 7 节）
│   └── <taskName>/
│       └── task.json
└── projects/
    └── <uuid>/             # 每个 Project 一个独立 shard（现状不变）
        ├── project.db
        ├── artifacts/<sha256>
        ├── logs/
        ├── out/
        └── .tmp/
```

规则：一个 task Runtime 只看见本 Board 与本 task 注册的 `projects/<uuid>`；`.projects.json`、`server.pid` 和其他 task 的 UUID 不暴露。每个 Worker 以当前 Project `.tmp/` 为 cwd/temp，外部 Project 结果只通过 Plan 的只读 FactRef + pathAbs 上下文提供。

## 3. 目标架构与启动流程

```text
本机                                Docker（同主机）
┌──────────────────────┐       ┌───────────────────┐  ┌───────────────────┐
│ peak serve（不变）     │ ◄──── │ task 容器 A        │  │ task 容器 B        │ …
│ GraphHttpServer       │ HTTP  │ peak start         │  │ peak start         │
│ ProjectStoreRegistry  │ HTTP  │  --graph-url       │  │  --graph-url       │
│ .projects.json 登记   │       │ （外部图模式）        │  │ （外部图模式）        │
│ <root>/projects/<uuid>│       │ worker CLI 子进程    │  │ worker CLI 子进程    │
│        ↑              │ per-  │ （容器内并行：        │  │ （容器内并行：        │
│        └───────────── │ UUID  │  多 Project ×       │  │  多 Project ×       │
│          仅挂载本 task │ mount │  executeCapacity）  │  │  executeCapacity）  │
│          的 UUID 目录  │       │ 仅可见本 task 的     │  │ 仅可见本 task 的     │
│                       │       │ UUID 目录           │  │ UUID 目录           │
└──────────────────────┘       └───────────────────┘  └───────────────────┘
          所有 task 容器共用同一个 peak-task 镜像（镜像不含凭据）
```

### 3.1 两阶段启动（先初始化 UUID，再起容器）

关键顺序：**Project UUID 先于容器存在**，挂载点才能按 UUID 精确计算。

1. **阶段一（主机侧）**：`peak start --docker <board>`（新增旗标；本地形态不变）
   - 加载 `task.json`，经 Server API 创建/attach 各 Project → 得到 UUID 集合（空 id 的创建并沿用现有原子写回 `task.json` 的机制；已有 UUID 的直接 attach）；
   - 经登记 API 在 `.projects.json` 注册各 UUID 的归属（taskName、boardDir、runtimeId、容器名；冲突返回 409，见 3.3）；
   - **Peak 代码自行组装并执行全部 docker 命令**——用户不手写任何 `docker run`：容器命名为 `peak_<sha256(taskName)[0:6]>`（同一 task 的所有 Project 共用一个容器）；镜像缺失时先 pull 已发布镜像，pull 不到则回退本地模式（见 5.3）；挂载集合（每个 UUID 一条 `-v <root>/projects/<uuid>:/peak/projects/<uuid>` + Board 目录 + 凭据注入）与网络参数由代码生成；docker CLI 不存在或守护进程未启动时明确报错并提示回退本地模式。
2. **阶段二（容器内）**：以 `--foreground --graph-url --projects-root /peak/projects --attach-only` 启动 Runtime——UUID 已存在，不再触发创建，只做 attach 与调度。

`resume` 同理：UUID 已在 `task.json` 中，阶段一直接 attach 并计算挂载。容器销毁即任务终止；UUID 目录留在主机根目录下，可随时被本地或新容器 resume。

### 3.2 容器内的视图

- 容器使用 `--read-only` 根文件系统。挂载集合 = 本 task 的 UUID 目录（只读）+ 每个 UUID 的 `.tmp/`（唯一可写 overlay）+ Board（只读）+ 登录态与 Skills（只读）。**不挂载 `<root>`，不挂载其他 task 的 UUID 目录**。
- 容器内路径统一为 `/peak/projects/<uuid>/...`，由 `--projects-root /peak/projects` 告知 Runtime（见 4.2 的路径重映射）。

## 4. 改造接缝清单

### 4.1 Runtime 外部图模式（核心代码改动）

`src/runtime/agent-runtime.ts:42-46` 目前无条件创建 `ProjectStoreRegistry` + 内嵌 `GraphHttpServer` + 用 `server.baseUrl` 建 client。改造为分支：

- `RuntimeOptions` 新增 `graphUrl?: string`。提供时：跳过 `new ProjectStoreRegistry` 与 `server.start()`，直接 `new GraphClient(graphUrl)`；不注入 UI root handler 与 runtime apiExtensions。
- CLI `start`/`resume` 新增 `--graph-url <url>` 与 `--projects-root <dir>`（见 4.2）；`--graph-url` 模式下 `--host/--port` 失效。
- `GraphClient` 不包含访问 token 或 loopback 硬编码；Runtime 全部 Graph 读写都走公开 Graph API。

### 4.2 task 边界与 Project 写入边界

现状中 Runtime/worker 会接触两类越界路径，需收编：

1. `GraphClient` 用 `projectsRoot` 把 Server 返回的相对 Artifact 路径重锚到容器 `/peak/projects`；`verifySources` 在 Worker 前后校验普通文件、size 与 SHA-256。
2. Federation 外部结果不进入 Execute source。Plan 只收到其他 Project 的完整 leaf FactRef 与只读 `path_abs_<factId>` 绝对路径。
3. Runtime 自身写 Graph/Artifact/log/out 通过主机 Server 完成；容器侧 Worker 只可写挂载的 Project `.tmp/`。Board、Project 其余内容、凭据与 Skills 都只读。
4. 本地形态仍是路径约定级隔离；容器形态由 read-only rootfs 和精确 bind mount 强制 task 边界。

### 4.3 `.projects.json` 进程登记（1 serve + N task）

- 现状 `registerServerProcess()`（`src/utils/server-process.ts:28-50`）以 `$PEAK_HOME/server.pid` 保证单实例，`serve` 与 `start` 不能并存。新形态下并存是常态，引入 `<root>/.projects.json` 作为 **Project 级归属登记**：

```json
{
  "version": 1,
  "projects": [
    {
      "projectId": "<uuid>",
      "taskName": "board-a",
      "boardDir": "/path/to/board",
      "mode": "run",
      "runtimeId": "...",
      "pid": 1234,
      "container": "peak_a1b2c3",
      "graphUrl": "http://host.docker.internal:8000",
      "startedAt": "20260806T163700.000"
    }
  ]
}
```

- `projects` 是**数组**，逐 Project 一条记录；`taskName` 记录真实任务名，`container` 记录命名规则产物 `peak_<sha256(taskName)[0:6]>`——同一 task 的多条 Project 记录共享同一个 `taskName` 与 `container`，据此可按 task 聚合（task 管理界面直接复用）。

- **权威在 Server**：attach/detach 经新端点（如 `POST/DELETE /api/projects/{id}/registration`），Server 原子写文件（tmp + rename）；UUID 已被活跃登记时 attach 返回 409——这就是"同一 active Project 不被多个 Runtime 调度"（AGENTS.md 既有要求）的强制化，从配置纪律升级为机制。
- **存活判定**：本机条目靠 pid 探测（现状机制）；容器条目由主机侧阶段一登记/注销（容器销毁 → `docker rm` 钩子或下次启动时 stale 清理）。条目不带租约心跳的初版够用，后续可复用 runtime heartbeat 扩展。
- **本机内嵌模式**（现状 `peak start` 不连外部 Server）：Runtime 直接操作该文件，同一套语义。
- `serve` 自身的 `server.pid` 单实例登记保留；`peak status/stop` 扩展为列出 serve + 各 task 条目（含容器名），`peak stop [task-name]` 不指定名称时对容器条目转为 `docker stop`。

### 4.4 明确不动的部分

- **联邦**：`FederationBus` 纯内存 Map + 读写 `<projectDir>/logs/main.log`（`src/graph/federation-bus.ts`），全部发生在 task 进程内与其可见的 UUID 目录上；跨 task 本来无联邦——零改动，无开关。
- **Worker 执行**：Runtime `WorkerPool` 根据配置路由出 workerName；`WorkerRuntime` → `ProcessRunner`（全库唯一 spawn 点）→ CLI 子进程。Worker 模块不接收 TaskType；stdin prompt、stdout 契约、10 MiB 预算和超时进程树终止全部保留。
- **输出链路**：Execute 结果 inline content 经 HTTP 上传 Artifact（`task-executor.ts:245-247`），天然跨容器。
- **Server 的 serve/export/import** 单机语义（`cli.ts:194/266/277`）不变。

## 5. 镜像与凭据（container/ 文件夹）

镜像只解决"装什么"，**不解决"登录谁"**——凭据一律运行期注入。仓库新增独立的 `container/` 文件夹承载全部容器资产，与主构建（`scripts/pack.mjs`）解耦。**Dockerfile、entrypoint、compose 都只是纯文件资产，绝不嵌入 TS 代码**，也不进入发布包。

```text
container/
├── Dockerfile           # peak-task 镜像
├── entrypoint.sh        # 凭据预检 + 启动
├── docker-compose.yaml  # 便捷入口（可选；Peak 自身生成全部 docker 命令）
└── AUTH.md              # 各 CLI 的登录/key 注入矩阵
```

### 5.1 Dockerfile 要点

- 基础 `node:22-slim`（>= 22.19.0；`node:sqlite` 在 Node 22 属实验模块，构建期以 `dist/cli.js workers` 冒烟验证旗标——`scripts/pack.mjs:134` 同款验证）。
- Peak 产物：`npm run pack` 的单文件 bundle（externals 仅 commander + tar）、`dist/ui/*.html`、`dist/runtime/prompts/*.md`、`version` 文件（`cli.ts:22-29` 从该文件读版本，必须带）。
- **agent CLI 无一特例**：四个后端统一经 npm 全局安装**最新版本**（不做版本钉版，升级随镜像重建自然发生）、PATH 解析。**为此 pi 协议必须去特例化**：现状 `pi.ts:21-36` 用 `import.meta.resolve("@earendil-works/pi-coding-agent")` 从 Peak 自身 node_modules 解析入口，与镜像无法同构；改为与其他三个后端一致的**纯命令行版本**（PATH 上的 `pi`，代码改动列入 M3），此后四个后端在 Dockerfile 里完全同构。
- **Skills 全部只读**：主机全局 Skills 以只读卷进入；缺少的 Board-local Skill 由启动器逐个只读 overlay 到发现路径。容器以 `--no-install-skills` 启动，不创建或清理主机链接。
- **常用工具预装（对标 Cairn worker 镜像）**：adb、frida（frida-tools，pip）、radare2（含 r2ghidra、r2flutter 插件——分别走 `r2pm -ci` 与上游 `make user-install`，编译层独立缓存）、tmux（长驻交互会话）。新增工具只改 `container/Dockerfile` 后用构建脚本重建。
- **对外编排接口 compose**：`container/docker-compose.yaml` 给出 adb 连接 USB 物理设备的完整配置（Linux `/dev/bus/usb` + privileged；Windows 经 usbipd-win 挂进 WSL2；macOS 用 network adb），也可作为纳入既有 compose/K8s 体系的参考封装；Peak 自身不依赖 compose。

### 5.2 凭据注入矩阵（AUTH.md 的核心内容）

| 后端 | 方式 A：task.json 显式 env（推荐） | 方式 B：登录态挂载（只读） |
| --- | --- | --- |
| claude-code | worker `env` 配置 `ANTHROPIC_API_KEY` | `~/.claude` → `/root/.claude`（复用主机 OAuth 登录态） |
| codex | worker `env` 配置 `OPENAI_API_KEY` | `~/.codex` → `/root/.codex` |
| opencode | worker `env` 配置 provider key | `~/.local/share/opencode` → `/root/.local/share/opencode` |
| pi | worker `env` 配置 provider key（其 provider 配置） | `~/.pi` → `/root/.pi` |

规则：

- **Peak 绝不主动扫描主机环境变量**（隐私红线）：API key 必须显式写在 `task.json` 的 per-worker `env` 里，随 `/board` 挂载进容器，由容器内 `ProcessRunner` 照常合并——值不经过 docker 命令行；**凭据只进 task 容器，不进 Server，不进镜像层**。
- 登录态挂载为 **只读**；需要刷新或写 home 的 CLI 可能失败，严格隔离场景优先使用方式 A。显式会话临时数据必须写当前 Project `.tmp/`。
- `entrypoint.sh` 启动前做**凭据预检**（Cairn local mode 的 startup healthcheck 同款思路）：逐个后端探测 CLI 可执行且存在认证信号（task.json worker env key / 容器 env / 已挂载登录态目录），缺失即快速失败并提示该用哪种配置——避免任务跑到一半才在 worker 超时报错。

### 5.3 镜像构建与分发（构建不归 Peak 管）

- **镜像构建不在 Peak 仓库范围内**：Peak 源码不含任何镜像构建代码；`container/` 仅保存镜像资产（Dockerfile、entrypoint、compose、AUTH.md）作为纯文件，构建上下文组装与 `docker build` 由仓库之外的流程负责。
- **Peak 只使用镜像**：`peak start --docker` 在本地镜像缺失时先 pull 已发布镜像；pull 也拿不到时抛 `DockerImageUnavailableError`，CLI **回退本地模式**继续跑（task 管理 API 显式选择 docker 时返回可读错误，不静默回退）。`peak stop`/`status` 对容器条目自动转为 `docker stop`/`docker inspect`。
- 镜像发布（`peak-task:<version>` 推送 docker.io；仓库名默认 `jygzyc/peak-task`，可用 `PEAK_IMAGE_REPO` 覆盖到私有 registry）同样由仓库之外的流程完成。
- docker CLI 不存在、守护进程未启动：明确报错并给出本地模式回退提示；Windows（Docker Desktop）与 Linux 的 CLI 差异由 Peak 代码消化。
- **容器 CLI 兼容 Podman**：所有容器命令经 `containerCli()` 解析——`PEAK_CONTAINER_RUNTIME` 显式指定（docker、podman 或完整路径），否则优先 docker、缺失时回退 podman（两者 CLI 参数面一致；`host-gateway` 需要 podman ≥ 4）。Podman 主机上的差异化问题不自动处理：SELinux 挂载 `:Z`、Windows 上 podman machine 的宿主路径映射需用户自行解决，未实测。

## 6. 用法

本机（现状，零容器依赖）：

```bash
peak serve --peak-home /data/peak
peak start /path/to/board
```

Docker（模式由命令行选择，docker 命令全部由 Peak 代码自动生成执行）：

```bash
peak start --docker /path/to/board
# 一条命令完成：初始化/attach UUID → .projects.json 登记 →
# 镜像缺失则先 pull docker.io 已发布镜像（pull 不到则回退本地模式）→
# 生成并执行 docker run
# （容器名 peak_<sha256(taskName)[0:6]>，按 UUID 精确挂载 + 显式凭据注入）
# 镜像构建不在此路径上，也不在 Peak 仓库范围内（container/ 仅为镜像资产）

peak status   # 列出 serve 与各 task（含容器名、taskName）
peak stop     # 本地 task 杀进程树，容器 task 自动 docker stop；可指定单个 task-name 只停一个
```

上一条命令等价展开的 `docker run`（Peak 内部生成，**仅示意，无需手写**）：

```bash
docker run -d --rm --read-only --name peak_a1b2c3 \
  -v /data/peak/projects/<uuid-1>:/peak/projects/<uuid-1>:ro \
  -v /data/peak/projects/<uuid-1>/.tmp:/peak/projects/<uuid-1>/.tmp:rw \
  -v /data/peak/projects/<uuid-2>:/peak/projects/<uuid-2>:ro \
  -v /data/peak/projects/<uuid-2>/.tmp:/peak/projects/<uuid-2>/.tmp:rw \
  -v /path/to/board-a:/board:ro \
  -v ~/.claude:/root/.claude:ro \
  --add-host host.docker.internal:host-gateway \
  peak-task:latest \
  start --foreground --attach-only \
      --graph-url http://host.docker.internal:8000 \
      --projects-root /peak/projects --no-install-skills
```

注意挂载集合里没有 `<root>` 本身——容器内不存在 `.projects.json`、`server.pid` 和其他 task 的目录。

编排备注：Peak 本身不依赖 compose；如需纳入既有 compose/K8s 体系，可复用上面的等价命令自行封装。K8s 下 Server 为单副本 StatefulSet + PVC，task 为 Job 按 UUID 做 subPath 挂载实现同样的最小可见性。本方案面向同主机 Docker，编排非重点。

## 7. Server 侧 task 管理界面

现状差距：Dashboard 是 Graph 的展示客户端，只有 Project 级 stop/resume/reopen；task（Board）的创建、启停、删除只存在于 CLI（`peak init/start/stop`）。本方案让 Server 兼任 task 生命周期的控制面，Dashboard 增加 task 管理视图，覆盖**创建、启动、停止、删除**四个动作。

### 7.1 职责与边界

- task 管理作为一个 `apiExtension` 在 CLI 组合根注入（`serve` 增加注入；`graph/` 不 import `runtime/`，边界 13 合规）；裸 `GraphHttpServer` 无此能力。
- task 状态的唯一事实来源 = `.projects.json` 登记（3.3）+ `<root>/tasks/` 目录扫描，不引入新的持久化表（SQLite 表集合不变）。
- Server 由此获得 spawn 本地进程与调用主机 docker CLI 的能力。Graph 与任务管理接口按产品边界公开；需要网络限制时由部署环境或反向代理负责。

### 7.2 tasks 目录

Server 管理的 Board 统一放在 `<root>/tasks/<taskName>/`（`task.json` + 可选 `skills/`）。创建即 scaffold：等价 `peak init` + 把表单字段写入严格 schema（`name`、`projects[{source,goal}]`、`workers`、可选 `skills`），落盘前过 `loadTaskConfig()` 校验。主机上已有的外部 Board 可通过"注册路径"纳入管理（只在 `.projects.json` 记录路径，不移动文件）；容器 task 的 Board 目录挂载源也是这里。

### 7.3 task 管理 API（apiExtension）

| 端点 | 语义 |
| --- | --- |
| `GET /api/tasks` | 列出 task：`{name, boardDir, status: running\|stopped, runtime: {mode, pid\|container, startedAt}?, projects: [{id, title, status}]}` |
| `POST /api/tasks` | 创建：`{name, projects, workers, skills?}` → 严格校验后 scaffold 到 `<root>/tasks/<name>/` |
| `POST /api/tasks/{name}/start` | 启动，body `{runtime: "local"\|"docker"}`。local：spawn `peak start --foreground --graph-url http://127.0.0.1:<port>` 子进程；docker：执行 3.1 的两阶段启动（复用 `peak start --docker` 同一代码路径：镜像缺失先 pull、pull 不到返回可读错误、命名 `peak_<sha256(taskName)[0:6]>`、生成全部 docker 命令）。已运行返回 409（复用登记冲突语义） |
| `POST /api/tasks/{name}/stop` | 停止：本地杀进程树（沿用 `ProcessRunner` 同款树杀）/ `docker stop`；注销 `.projects.json` 条目 |
| `DELETE /api/tasks/{name}` | 删除：先 stop + 注销，再删 Board 目录。**默认保留** `projects/<uuid>` 数据（可被其他 Board attach/resume）；显式 `?purge=true` 才在关闭 store 后删除 UUID 目录——破坏性操作，需 UI 二次确认 |

### 7.4 Dashboard task 视图

- 新增 tasks 页作为入口页：task 列表（名称、运行状态、local/docker、启动时间、项目状态聚合徽标）、创建表单（name + projects 的 source/goal + workers 的 JSON 或简易编辑器）、每行 start（选 local/docker）/stop/delete 按钮；点击 task 或项目跳转现有 Graph 视图。
- 沿用 Dashboard 既有约束：auto-refresh 轮询、无 CDN 自包含、移动布局；runtime 心跳 badge 语义不变。
- task 管理是**控制面**，不写图：Graph 的不可变语义、Runtime overlay 语义完全不受影响。

### 7.5 平台与权限备注

- 主机 docker CLI 在 Windows（Docker Desktop）同样可用；`start` 前做 `docker version` 预检，镜像缺失时先 pull 已发布镜像，pull 不到则返回可读错误（API 显式选择 docker，不静默回退本地）。
- Server 以自身启动用户的权限 spawn 子进程/容器，不提权；`.projects.json` 里的 pid/container 字段使 `peak stop` 与 UI stop 语义一致（CLI 与 UI 操作同一份登记，不会互相失明）。

## 8. 实施里程碑

| 里程碑 | 内容 | 验证 |
| --- | --- | --- |
| M1 根目录与登记 | `.projects.json` + 登记端点（3.3）；`--peak-home` 语义文档化（2.1） | 1 serve + 2 个本机 task 并存；重复 attach 同一 UUID 返回 409；`peak status/stop` 正确列出与清理 |
| M2 外部图模式与路径边界 | `--graph-url`、`--projects-root`、Artifact 相对路径重锚、Federation leaf + pathAbs | 本机双进程回归；source Artifact 前后 SHA-256 校验；外部 FactRef 不进入 Execute source |
| M3 容器化落地 | `container/`（Dockerfile + entrypoint 预检 + AUTH.md + compose USB adb）；pi 协议去特例化为纯命令行 PATH 调用（5.1）；`peak start --docker` 两阶段启动（5.3、3.1，只使用镜像、缺镜像回退本地）；容器命名 `peak_<sha256(taskName)[0:6]>` | 四个后端同构安装（最新版、PATH 解析）；容器内 task 完整生命周期：Artifact 校验、out/ 交付物主机可见、Finalize session 恢复；四个后端各跑一次凭据预检 + 单 Execute；≥2 容器并行互不干扰；强杀容器后 serve 不受影响、resume 恢复 |
| M4 task 管理界面 | 第 7 节：tasks 目录 + 管理 apiExtension + Dashboard task 视图 | API 级：create→start(local)→stop→delete 全生命周期；start(docker) 走通两阶段；冲突/重复 start 返回 409；purge 删除经二次确认且 store 已关闭；UI 冒烟（轮询、跳转图视图） |

测试约束沿用现有规范：测试从 `dist/` 导入、`npm test` 先清洁构建、HTTP/CLI 测试先停 server 关 registry 再删临时目录。

## 9. 风险与取舍

- **凭据是最大的工程变量**：各 CLI 的登录态目录结构、单实例锁、key 优先级各不相同且会随版本漂移——AUTH.md 必须逐个实测编写，entrypoint 预检是唯一防线；M3 为每个后端留独立验证。
- **路径映射双平台**：Windows 主机 ↔ Linux 容器路径形态差异由"相对化 + `--projects-root`"消化，M2/M3 需双平台验证；单机默认行为不变。
- **跨 Project 输入的性能**：FactRef Artifact 从本地路径变为 HTTP staging，大文件多一跳拷贝；受 Artifact 大小上限约束，初版不优化，需要时再加 Server 侧硬链接直通（同主机场景）。
- **`.projects.json` 的一致性**：原子写 + stale 清理覆盖大多数故障；"容器被 `docker kill -9` 且主机启动器同时崩溃"会留下僵死条目，靠下次 attach 时的存活探测清理，文档注明运维手段（`peak stop` 强制注销）。
- **同 task 共享故障域**：同一 task 的 worker 是同一容器内进程，一个失控 CLI 可能拖累同 task 其他执行——per-task 粒度的固有取舍（Cairn local mode 同样如此）；需要更强隔离就拆 Board。
- **公开网络边界**：Graph 与任务管理接口不内置鉴权。是否限制监听地址、增加 TLS 或反向代理由部署方决定。
- **delete/purge 的破坏性**：删 Board 目录与 purge UUID 数据目录不可恢复；purge 前必须先 stop 并关闭对应 store（WAL 句柄），UI 二次确认，API 默认保留数据。
- **docker 自动化的新故障面**：docker 命令由 Peak 代码生成执行后，Windows/Linux 的 CLI 行为差异、守护进程不可用、构建上下文收集失败都转化为 Peak 自己的错误路径——必须逐类给出可读报错与本地模式回退提示，绝不让用户看到裸 docker 报错。
- **镜像分发的信任链**：docker.io 上已发布镜像（仓库外流程构建推送）是常规使用的默认来源；私有部署用 `PEAK_IMAGE_REPO` 指向私有 registry。镜像层永不包含凭据（一律运行期注入），公开仓库不泄露登录态；主机环境变量绝不被扫描进容器。

## 10. 对 AGENTS.md 的影响

实施时需同步修订（范围有限）：

- **边界 10**：worker 仍是"单一共享 `ProcessRunner` 驱动的 CLI 子进程"——容器只是 Runtime 的部署形态，不违反该边界，"Runtime and Worker Behavior"章节补 task 容器化部署形态即可。
- **pi 后端描述**：`pi` 从"`import.meta.resolve` 自解析入口"改为与其他后端一致的 PATH 纯命令行调用后，"Runtime and Worker Behavior"与 worker registry 相关描述需同步改写（协议契约本身不变）。
- **边界 1/2/4/8**：均不变。外部图模式仍走 `GraphClient`；跨 Project 输入的 API staging 是易失暂存，不向目标图持久化源实体；worker 仍不接触 Graph/凭据。
- **Graph Model and Persistence / CLI 章节**：补根数据目录布局（`.projects.json`、`tasks/`）、`--graph-url` / `--projects-root` / `--attach-only` / `--docker` 与 1 serve + N task 语义。
- **Graph HTTP Server and Optional Web UI 章节**：补 task 管理 apiExtension（`serve` 注入，含 spawn/docker 能力的安全约束）与 Dashboard task 视图；强调控制面不写图、Graph 不可变语义不变。
