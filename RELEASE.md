# Peak Release Notes / Peak 发布日志

This file describes only the current release and is used as the GitHub Release body. The version source of truth is the `version` file at the repo root. For each release: bump `version`, sync `package.json.version`, and replace this file with the current version's notes.

本文件只描述当前版本，并作为 GitHub Release 的正文。版本号以仓库根目录 `version` 文件为准。每次发版：更新 `version` 文件、同步 `package.json.version`、并将本文件替换为当前版本说明。

---

## 0.1.1 — 2026-08-05

### 中文

- 收紧阶段提示词：Plan 增加显式 complete / noop / intents 决策顺序（以 open Intents 为门槛）与方向纠偏；Execute 明确已验证死胡同也是合法 Fact、禁止编造进度；Finalize 只基于 bound Execute 已确认的结果；Supervise 限定 Hint 必须是具体 discrepancy / gap / misdirection（缓解 Supervise 过度注入 Hint 的已知问题）；
- 发布流程：tag 触发的 GitHub Release 不再现场构建，改为消费 main CI 打包上传的 `dist-packages` 产物，并校验 tag ↔ manifest 版本 ↔ tarball sha256 三方一致；
- `package.json` 增加 `publishConfig.access: public`，支持 scoped 包免费发布到 npm。

### English

- Tightened phase prompts: Plan now has an explicit complete / noop / intents decision order gated on open Intents plus course correction; Execute makes verified dead ends valid Facts and forbids fabricating progress; Finalize bases the Fact only on results already confirmed in the bound Execute; Supervise restricts Hints to concrete discrepancies / gaps / misdirections (mitigating the known Supervise Hint over-injection issue);
- Release flow: the tag-triggered GitHub Release no longer rebuilds on tags; it consumes the `dist-packages` artifacts packed and uploaded by main CI, verifying tag ↔ manifest version ↔ tarball sha256 consistency;
- Added `publishConfig.access: public` to `package.json` so the scoped package can be published to npm for free.
