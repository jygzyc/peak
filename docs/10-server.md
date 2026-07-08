# 10 · HTTP 服务与 Dashboard（`src/server/`）

> 审计范围：2 个文件——`http-server.ts`（HTTP API + SSE + dashboard 分发）、`dashboard.html`（嵌入式前端单页）。
> 本层是 decx-agent 的对外观测/控制面：列出 project、查 detail、发 directive、SSE 实时推 event、提供 dashboard UI。是 Graph 状态的 adapter，不应重复 loopestration 策略（文件头 1–7 行）。

---

## 10.1 `http-server.ts`（191 行）— HTTP API + Dashboard 服务

### 用途
**decx-agent session 的 HTTP API 与 dashboard 服务**。暴露 project 列表、project 详情、directives、event stream、嵌入式 dashboard HTML。server 是 Graph 状态的 adapter，不重复 loopestration 策略。

### 关键导出
- `HttpServer`（class）：`start(options): Promise<void>`/`stop(): Promise<void>`/`port: number`
- `HttpServerOptions`（host?/port?）

### 构造
`constructor(graph: Graph, sessionLoop?: SessionLoop)`——持有 graph 与可选 sessionLoop。

### 路由表
| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/` | 返回 dashboard HTML |
| GET | `/api/projects` | `graph.listProjects()` |
| GET | `/api/projects/:id` | project + facts + intents + unconsumedHints + unconsumedDirectives + links + progress |
| POST | `/api/projects/:id/directives` | 读 body JSON → `graph.addDirective` |
| GET | `/api/projects/:id/stream` | SSE 推 event（poll 1s） |
| GET | `/api/projects/:id/events?since=` | `graph.events(id, since, 500)` |

### start/stop
`createServer` + `listen(port, host)`；默认 `127.0.0.1:25429`。`assignedPort` 从 `server.address()` 取真实端口。stop 走 `server.close`。

### SSE（handleSSE）
- 写 `: connected\n\n` + 最近 10 event
- `setInterval(poll 1000ms)`：`graph.events(proj.id, lastSeq, 100)`，逐条 `data: <json>\n\n`，更新 lastSeq
- `sseClients: Map<ProjectId, Set<ServerResponse>>` 跟踪连接；close/error 时 cleanup（clearInterval + delete）

### 审计要点
- 🚨 **无任何认证/鉴权**：所有路由（含 `POST /directives`）无 token/session/CORS 校验。默认绑 `127.0.0.1` 限制为本地，但**多用户/同机其它进程可通过 `POST /api/projects/:id/directives` 控制 agent 行为**（发 stop/pause/kill-intent/spawn-intent）。叠加 §6 的 prompt injection → RCE 链，本地任意进程可经 directive 注入 prompt 控制 LLM 执行任意命令。
- 🚨 **`sessionLoop` 构造参数持有但完全未用**（第 42 行 + codegraph 确认）：`private readonly sessionLoop?: SessionLoop` 仅在签名出现，`handle` 内无任何 `this.sessionLoop.` 调用——dead 参数。AgentRuntime/cli.ts 都传入，但 server 从不读。可能是为「server 主动触发 step」预留，未实现。
- ⚠️ **`loadDashboard()` 每次请求读盘**（第 134、19–28 行）：`serveDashboard` 每次 `GET /` 都 `readFileSync`——无缓存，高频访问 IO 浪费。
- ⚠️ **`POST /directives` 无 body 校验**（100–107 行）：`JSON.parse(body) as DirectiveInput` 强转，非法 JSON 或缺字段直接抛，被外层 catch 返 500；未校验 `input.kind` 是否合法 DirectiveKind、`input.payload` 是否字符串——graph.addDirective 内部会存什么取决于实现。
- ⚠️ **`readBody` 无大小限制**（182–189 行）：无上限累加 chunk，大 body 可耗内存（DoS）。
- ⚠️ **SSE 用 poll 1s 而非事件驱动**（155–163 行）：`setInterval` 每秒 `graph.events()`——延迟最多 1s，且每个 SSE 客户端独立 poll，N 客户端 N 倍 graph 查询。应改 graph 事件通知（如 EventEmitter）。
- ⚠️ **SSE `lastSeq` 初始为 0**（145 行）：客户端连上后从 seq>0 推，但若 graph 是新 session，最近 10 event 的 lastSeq 可能 >0，`pollInterval` 从 lastSeq 续推 OK；但跨进程重启（graph 是 SqliteGraph 持久化），历史 event 已在 db，新连接只推最近 10 + 后续增量，历史不可回溯。
- ⚠️ **`sseClients` 无上限**：每 project 的 Set 无大小限制，恶意客户端可开大量连接耗 fd。
- ⚠️ **URL 解析用 `req.headers.host`**（第 72 行）：`new URL(req.url, \`http://${req.headers.host}\`)`——Host header 可被客户端伪造，但本 server 仅取 pathname，不依赖 host 作安全决策，OK。
- ⚠️ **`decodeURIComponent(projectMatch[1])`**（88、103、112、118 行）：projectId 从 URL 解码，`getProject(idOrSession)` 既接 id 也接 session——OK，但未校验 projectId 格式，任意字符串进 graph 查询。
- ⚠️ **无 OPTIONS/CORS 处理**：浏览器跨域请求 dashboard 无法 fetch API（除非同源）；dashboard 与 API 同源（都经本 server），OK。
- ⚠️ **`stop()` 不关 SSE 连接**：`server.close` 等所有连接断开才回调，SSE 长连接会让 stop 卡住（除非客户端断开）。
- ✅ 路由清晰，正则匹配 projectId。
- ✅ 统一 try/catch 返 500 + error message。
- ✅ `assignedPort` 支持端口 0 随机分配场景。

### 跨文件观察
- 被 `AgentRuntime`（构造时 `new HttpServer(graph, sessionLoop)`，但 sessionLoop 死参数）、`cli.ts`（resume 命令 `new HttpServer(graph, loop)`）、`index.ts`（re-export）使用。`dashboard.html` 是同级文件。

---

## 10.2 `dashboard.html`（413 行，14684 字节）— 嵌入式 Dashboard 前端

### 用途
**decx-agent 的单页 dashboard**，由 `GET /` 返回。GitHub 暗色主题，左侧 project 列表 + 右侧详情面板，支持 SSE 实时 event、发送 directive。

### 结构
- **`<head>`**：title + 内联 CSS（CSS 变量定义暗色主题色板：bg/bg-card/border/text/accent/green/red/yellow/purple/blue）
- **`<body>`**：flex 布局，`#sidebar`（260px）+ `#main`
  - `#sidebar`：`#project-list`（project 列表）
  - `#main`：`#header`（`#project-title` + `#project-status` badge）+ `#content`（`#left-panel` 进度条/facts/intents/hints + `#right-panel` directive 表单 + `#events`）
  - `#directive-form`：`<select id="dir-kind">`（stop/pause/resume/hint/kill-intent/spawn-intent）+ payload 输入 + 发送按钮
- **`<script>`**：原生 JS（无框架）

### JS 逻辑（300–413 行）
- `loadProjects()`：`fetch('/api/projects')` → 填 `#project-list`
- `selectProject(id)`：`fetch('/api/projects/'+id)` → 渲染 title/status/progress-bar/fact-list/intent-list/hint-list；`new EventSource('/api/projects/'+id+'/stream')` → event 进 `#events`
- `sendDirective()`：`fetch('/api/projects/'+currentProject+'/directives', {method:POST, body: JSON.stringify({kind, payload})})`

### 审计要点
- 🚨 **XSS 风险**：`innerHTML` 直接拼 graph 数据（326 `project-status.innerHTML = '<span class="badge ' + data.project.status + '">' + data.project.status + '</span>'`、329 progress-bar、fact/intent/hint list 渲染）——graph 的 fact.description/intent.description 来自 LLM 输出（可能被分析目标的 prompt injection 控制），若含 `<script>` 等 HTML，`innerHTML` 会执行。应改 `textContent` 或转义。
- ⚠️ **`project.status` 直接进 class 名**（326）：`class="badge ${status}"`——status 含空格/特殊字符会破坏 class，且若 status 含 `"><img onerror=...>` 可注入（取决于 graph 是否校验 status）。
- ⚠️ **EventSource 全局单例 `evtSource`**：切换 project 前未 `close()` 旧连接（377 行直接 new），累积 SSE 连接，服务端 `sseClients` 累积，资源泄漏。
- ⚠️ **无错误处理 UI**：fetch 失败无提示，用户看不到网络错误。
- ⚠️ **无自动刷新 project 列表**：新增 project 需手动刷新页面。
- ⚠️ **directive payload 输入框**：单行 input，长 payload（如 hint 多行内容）不便。
- ⚠️ **CSS 变量 + 暗色主题硬编码**：无浅色主题切换。
- ⚠️ **无 CSP meta**：HTML 无 Content-Security-Policy，结合 §XSS 风险，注入脚本可执行。
- ✅ 暗色主题视觉一致（GitHub 风格）。
- ✅ SSE 实时更新 event 面板。
- ✅ directive 表单覆盖 6 种 kind。

### 跨文件观察
- 由 `http-server.loadDashboard()` 读取并返回。`loadDashboard` 候选路径 `MODULE_DIR/dashboard.html` 与 `MODULE_DIR/server/dashboard.html`——构建后 dashboard.html 需与 http-server.js 同目录（esbuild bundle 后同级），需确认 build 配置正确拷贝。

---

## 跨文件小结（本册）

1. **🚨 HTTP server 无认证**：本地多用户/进程可经 `POST /directives` 控制 agent，叠加 prompt injection → RCE 链。建议加 token（启动时生成，CLI 打印）或 unix socket。
2. **🚨 dashboard innerHTML XSS**：LLM 输出（含 attacker-controlled description）经 innerHTML 渲染可执行脚本。改 textContent + 加 CSP。
3. **🪦 `sessionLoop` 参数死代码**：HttpServer 持有但不读。
4. **⚠️ SSE poll 1s + 每客户端独立 poll**：N 客户端 N 倍 graph 查询，应改事件驱动。
5. **⚠️ EventSource 切换 project 不 close**：客户端 SSE 连接泄漏。
6. **⚠️ loadDashboard 每次读盘**：无缓存。
7. 本册是「对外面」，安全风险集中（认证 + XSS），建议优先修 §1/§2。
