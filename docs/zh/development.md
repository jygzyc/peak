# 构建、测试与发布

本文面向贡献者，说明 Peak 的构建、测试与发布工作流。

## 命令

```bash
npm run typecheck     # 核心类型检查（先生成嵌入资产）
npm run typecheck:ui  # 浏览器 UI app 独立 tsconfig 类型检查（DOM lib、bundler 解析）
npm run typecheck:all # 两者都查（CI 与 pack 发布门禁使用）
npm run build         # 仅核心：模块化 dist + scripts/*.mjs 语法与一致性校验
npm run build:ui      # 仅 UI：打包 src/ui/app、重新嵌入资产、类型检查、复制 dist/ui
npm run build:all     # 两者（原先的整体式 build）
npm run preview:ui    # build:ui 后启动 UI + mock /api 后端（无需真实 Graph server）
npm test              # 先做核心构建，再针对 dist/ 运行测试
npm run smoke         # CLI 冒烟：init/workers/--version
npm run pack          # esbuild 单文件 bundle + 只打包自包含 dist 包 + manifest
```

- 核心与 UI 分开编译：进行中或损坏的 UI 永远不会阻塞核心构建、类型检查或测试；只执行 `npm run build` 即可得到可用的 CLI 与 Graph server（不含仪表盘 bundle）。
- `npm test` 先执行干净的核心 TypeScript 构建；测试从 `dist/` 导入模块化文件，绝不直接导入 `src/`。
- HTTP/CLI 测试必须在删除临时目录前停止 Server 并关闭注册表。
- `npm run pack` 必须最后执行：其 `prepack` 阶段用生产 esbuild bundle 替换模块化 `dist/`，把 UI 复制到 `dist/ui/`，复制 runtime prompts，校验 `dist/cli.js workers`，并在 `dist-packages/` 下写出 tarball 与 manifest。

## Web UI 的 mock 数据预览

`npm run preview:ui` 先构建 UI bundle，再启动 `scripts/mock-server.mjs`：一个独立的预览服务器，同时提供静态站点与 UI 所调用的全部 `/api/*` 端点的内存 mock 实现（projects、graph、FactRef 解析、hints、status/reopen、export、artifacts、tasks），无需 Graph server、Board 或 Worker：

```bash
npm run preview:ui                 # 构建 UI 并服务 http://127.0.0.1:8010/
npm run preview:ui:serve           # 只启动服务（UI 已构建）
node scripts/mock-server.mjs --port 9000            # 自定义端口
node scripts/mock-server.mjs --host 0.0.0.0         # 手机 / 平板局域网访问
node scripts/mock-server.mjs --data my-state.json       # 自定义场景
node scripts/mock-server.mjs --ui ./dist/ui             # 指定 UI 根目录
```

- 内置场景含三个演示 Project（中文 source/goal 用于验证换行与截断）、跨项目 FactRef、三种状态的 intent（open / claimed / concluded）、hints、供预览页使用的 artifacts（markdown + SVG），以及两个任务（一个 running）。
- 全部状态在内存中：通过 UI 做出的修改（hints、status、tasks 等）重启后重置。
- 自定义场景文件与 `scripts/mock-server.mjs` 内置 `DEFAULT_STATE` 同构：`{ projects: [{ id, title, status, scope?, createdAt, facts, intents, hints }], tasks: [...] }`；id 相同的 project 替换演示项目，未知 id 追加。

## 版本与发布日志

- 版本号以根目录 `version` 文件为准（打包时同步进 `package.json`；漂移由 `check-scripts` 拦截）。
- 发布日志（中英双语）：[`RELEASE.md`](../../RELEASE.md)。
- CI（`.github/workflows/ci.yml`）在 Linux + Windows 上运行 typecheck/build/test/smoke/pack；tag `v*` 触发 Release action（`.github/workflows/release.yml`）：现场打包、校验 tag 与 `version` 一致、通过 Trusted Publishing（OIDC）把 tarball 发布到 npm，并创建 GitHub Release。
