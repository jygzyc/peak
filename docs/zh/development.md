# 构建、测试与发布

本文面向贡献者，说明 Peak 的构建/测试/发布工作流。源码布局与不可越界边界见 [`AGENTS.md`](../../AGENTS.md)。

## 命令

```bash
npm run typecheck
npm run build        # 模块化 dist + scripts/*.mjs 语法与一致性校验
npm test             # 先构建，再针对 dist/ 运行测试
npm run smoke        # CLI 冒烟：init/workers/--version
npm run pack         # esbuild 单文件 bundle + 只打包自包含 dist 包 + manifest
```

- `npm test` 先执行干净的 TypeScript 构建；测试从 `dist/` 导入模块化文件，绝不直接导入 `src/`。
- HTTP/CLI 测试必须在删除临时目录前停止 Server 并关闭注册表。
- `npm run pack` 必须最后执行：其 `prepack` 阶段用生产 esbuild bundle 替换模块化 `dist/`，把 UI 复制到 `dist/ui/`，复制 runtime prompts，校验 `dist/cli.js workers`，并在 `dist-packages/` 下写出 tarball 与 manifest。

## 版本与发布日志

- 版本号以根目录 `version` 文件为准（打包时同步进 `package.json`；漂移由 `check-scripts` 拦截）。
- 发布日志（中英双语）：[`RELEASE.md`](../../RELEASE.md)。
- CI（`.github/workflows/ci.yml`）在 Linux + Windows 上运行 typecheck/build/test/smoke/pack；tag `v*` 触发 Release action（`.github/workflows/release.yml`）：现场打包、校验 tag 与 `version` 一致、通过 Trusted Publishing（OIDC）把 tarball 发布到 npm，并创建 GitHub Release。
