#!/usr/bin/env node
/**
 * Peak Web UI mock preview server.
 *
 * Serves the static UI site (dashboard / tasks / preview) together with an
 * in-memory mock implementation of every `/api/*` endpoint the UI calls, so
 * the whole UI can be previewed and tested without a real Graph server or
 * running Workers:
 *
 *   node scripts/mock-server.mjs                  # serve src/ui (dev bundle) on :8010
 *   npm run preview:ui                            # build:ui first, then this server
 *   node scripts/mock-server.mjs --port 9000      # custom port
 *   node scripts/mock-server.mjs --host 0.0.0.0   # LAN access (phones / tablets)
 *   node scripts/mock-server.mjs --data mock.json # custom scenario (see below)
 *   node scripts/mock-server.mjs --ui ./dist/ui   # serve a specific UI root
 *
 * Mocked endpoints (everything the shipped UI touches):
 *   GET  /api/projects                          project metas
 *   GET  /api/projects/:id                      project graph (facts + intents + hints)
 *   POST /api/fact-refs/resolve                 cross-project FactRef resolution
 *   POST /api/projects/:id/hints                add a hint (mutates in-memory state)
 *   PUT  /api/projects/:id/status               active/stopped/completed
 *   POST /api/projects/:id/reopen               completed -> active
 *   GET  /api/projects/:id/export?format=json|archive
 *   GET  /api/projects/:id/artifacts/:sha256    artifact bytes for the preview page
 *   GET  /api/tasks                             task list
 *   POST /api/tasks                             create task (+ its Projects)
 *   POST /api/tasks/:name/start | /stop         runtime state transitions
 *   DELETE /api/tasks/:name[?purge=true]        remove task (optionally its Projects)
 *
 * All state lives in memory and resets on restart — mutations made through the
 * UI are a convenient way to exercise status/flow animations without touching
 * anything on disk.
 *
 * Custom scenario file (`--data path.json`) uses the same shape as the
 * built-in `DEFAULT_STATE` below: `{ projects: [{ id, title, status, scope?,
 * createdAt, facts, intents, hints }], tasks: [...] }`. Custom projects with a
 * matching id replace the built-in demo project; unknown ids are appended.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));

/* ---------------------------------------------------------------------------
 * Command line
 * ------------------------------------------------------------------------ */
function parseArgs(argv) {
  const options = { port: 8010, host: "127.0.0.1", data: null, ui: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--host") options.host = argv[++i];
    else if (arg === "--data") options.data = argv[++i];
    else if (arg === "--ui") options.ui = argv[++i];
    else if (arg === "--quiet" || arg === "-q") options.quiet = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/mock-server.mjs [--port 8010] [--host 127.0.0.1] [--data state.json] [--ui dir] [--quiet]\n",
      );
      process.exit(0);
    } else {
      console.error(`[peak-mock] unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    console.error(`[peak-mock] invalid --port: ${options.port}`);
    process.exit(1);
  }
  return options;
}

/* ---------------------------------------------------------------------------
 * Built-in mock scenario
 * ------------------------------------------------------------------------ */
const sha = (seed) => seed.toLowerCase().replace(/[^0-9a-f]/g, "").padEnd(64, "0").slice(0, 64);

const SHA_MARKDOWN = sha("a3f1c9d2e5b7f0a1c2d3e4f5a6b7c8d9");
const SHA_SVG = sha("b7e2c1a4d6f8e0b2c4d6e8f0a2b4c6d8e");

const DEFAULT_STATE = {
  projects: [
    {
      id: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
      title: "运行时评测：分布式图智能体",
      status: "active",
      scope: "基准测试、源码审计与并发压力测试",
      createdAt: "20250801T090000.000",
      facts: [
        {
          id: "origin",
          description:
            "源事实：团队需要一个跨进程协作、每一步推理都可独立验证与审计的分布式智能体运行时，为此立项对候选实现进行基准测试、源码审计与并发压力测试，并沉淀可复现的评测方法。",
          createdAt: "20250801T090000.000",
          artifact: {
            sha256: SHA_MARKDOWN,
            mediaType: "text/markdown",
            sizeBytes: 0,
            filename: "source-notes.md",
            path: `artifacts/${SHA_MARKDOWN}`,
          },
        },
        {
          id: "f1",
          description:
            "证据一：对三个候选运行时进行同等负载基准测试，Peak 在零拷贝跨项目引用场景下中位延迟最低，P95 为 42 毫秒。",
          createdAt: "20250801T092500.000",
          artifact: null,
        },
        {
          id: "f2",
          description:
            "证据二：源码审计确认跨项目引用是不可变的 FactRef 超链接，携带内容地址与描述，无法被修改或删除。",
          createdAt: "20250801T094100.000",
          artifact: null,
        },
        {
          id: "f3",
          description:
            "证据三：50 个并发 Worker 压力测试中，调度吞吐稳定在每分钟约 1200 个意图，无死锁、饥饿或重复执行。",
          createdAt: "20250801T095800.000",
          artifact: null,
        },
        {
          id: "goal",
          description:
            "目标事实：Peak 作为 HTTP 原生的分布式图智能体运行时，在可验证性、可审计性与并发调度三个维度均达到生产级要求，可推广到团队后续项目。",
          createdAt: "20250801T090000.000",
          artifact: null,
        },
      ],
      intents: [
        {
          id: "i1",
          from: [
            {
              projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
              id: "origin",
              description:
                "源事实：团队需要一个跨进程协作、每一步推理都可独立验证与审计的分布式智能体运行时，为此立项对候选实现进行基准测试、源码审计与并发压力测试，并沉淀可复现的评测方法。",
            },
            {
              projectId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
              id: "f1",
              description: "契约结论：FactRef 必须携带内容地址（SHA-256）、不可变描述与来源项目标识。",
            },
          ],
          to: {
            projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
            id: "f1",
            description:
              "证据一：对三个候选运行时进行同等负载基准测试，Peak 在零拷贝跨项目引用场景下中位延迟最低，P95 为 42 毫秒。",
          },
          customProfile: null,
          customProfileDigest: null,
          hintIds: [],
          description: "将上游契约结论与本项目源事实合并，推导出本地基准测试结论并落盘为证据。",
          createdBy: "worker:plan",
          createdAt: "20250801T091000.000",
          concludedBy: "worker:execute",
          concludedAt: "20250801T092500.000",
        },
        {
          id: "i2",
          from: [
            {
              projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
              id: "f1",
              description:
                "证据一：对三个候选运行时进行同等负载基准测试，Peak 在零拷贝跨项目引用场景下中位延迟最低，P95 为 42 毫秒。",
            },
          ],
          to: {
            projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
            id: "f2",
            description:
              "证据二：源码审计确认跨项目引用是不可变的 FactRef 超链接，携带内容地址与描述，无法被修改或删除。",
          },
          customProfile: null,
          customProfileDigest: null,
          hintIds: ["h1"],
          description: "按提示采用黑盒方式审计引用实现，确认不可变性与完整性校验路径。",
          createdBy: "worker:plan",
          createdAt: "20250801T092600.000",
          concludedBy: "worker:review",
          concludedAt: "20250801T094100.000",
        },
        {
          id: "i3",
          from: [
            {
              projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
              id: "f2",
              description:
                "证据二：源码审计确认跨项目引用是不可变的 FactRef 超链接，携带内容地址与描述，无法被修改或删除。",
            },
          ],
          to: {
            projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
            id: "f3",
            description:
              "证据三：50 个并发 Worker 压力测试中，调度吞吐稳定在每分钟约 1200 个意图，无死锁、饥饿或重复执行。",
          },
          customProfile: null,
          customProfileDigest: null,
          hintIds: [],
          description: "在审计结论之上执行并发压力测试，验证调度器在极端负载下的行为。",
          createdBy: "worker:plan",
          createdAt: "20250801T094200.000",
          concludedBy: "worker:execute",
          concludedAt: "20250801T095800.000",
        },
        {
          // OPEN: no conclusion yet and no assigned Worker — drifts slowly.
          id: "i4",
          from: [
            {
              projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
              id: "f3",
              description:
                "证据三：50 个并发 Worker 压力测试中，调度吞吐稳定在每分钟约 1200 个意图，无死锁、饥饿或重复执行。",
            },
          ],
          to: null,
          customProfile: null,
          customProfileDigest: null,
          hintIds: [],
          description: "等待任意 Worker 认领：将三项证据汇总为目标事实的结论意图。",
          createdBy: "worker:plan",
          createdAt: "20250801T095900.000",
          concludedBy: null,
          concludedAt: null,
        },
        {
          // OPEN + pinned custom execution profile: still open (no `to`), but
          // `customProfile` fixes which execution profile must run it.
          id: "i5",
          from: [
            {
              projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
              id: "f2",
              description:
                "证据二：源码审计确认跨项目引用是不可变的 FactRef 超链接，携带内容地址与描述，无法被修改或删除。",
            },
            {
              projectId: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
              id: "f3",
              description:
                "证据三：50 个并发 Worker 压力测试中，调度吞吐稳定在每分钟约 1200 个意图，无死锁、饥饿或重复执行。",
            },
          ],
          to: null,
          customProfile: "execute:security-review",
          customProfileDigest: "9f2a4b7c1d3e5f80",
          hintIds: ["h2"],
          description: "已绑定执行配置（execute:security-review），等待调度：结合审计与压力测试证据起草最终评估报告。",
          createdBy: "worker:supervise",
          createdAt: "20250801T100000.000",
          concludedBy: null,
          concludedAt: null,
        },
      ],
      hints: [
        {
          id: "h1",
          content: "验证时优先采用黑盒行为测试，避免依赖内部实现细节。",
          creator: "human:web",
          createdAt: "20250801T091500.000",
          consumedByIntentId: "i2",
          consumedAt: "20250801T092600.000",
        },
        {
          id: "h2",
          content: "补充网络分区与节点重启场景下的恢复测试，并记录恢复耗时。",
          creator: "human:review",
          createdAt: "20250801T100200.000",
          consumedByIntentId: null,
          consumedAt: null,
        },
      ],
    },
    {
      id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      title: "上游团队：接口契约评审",
      status: "completed",
      createdAt: "20250728T080000.000",
      facts: [
        {
          id: "origin",
          description: "上游源事实：跨项目引用需要保证引用目标在发布后不可变，且能独立校验完整性。",
          createdAt: "20250728T080000.000",
          artifact: null,
        },
        {
          id: "f1",
          description: "契约结论：FactRef 必须携带内容地址（SHA-256）、不可变描述与来源项目标识。",
          createdAt: "20250728T090000.000",
          artifact: null,
        },
      ],
      intents: [
        {
          id: "i1",
          from: [
            {
              projectId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
              id: "origin",
              description: "上游源事实：跨项目引用需要保证引用目标在发布后不可变，且能独立校验完整性。",
            },
          ],
          to: {
            projectId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            id: "f1",
            description: "契约结论：FactRef 必须携带内容地址（SHA-256）、不可变描述与来源项目标识。",
          },
          customProfile: null,
          customProfileDigest: null,
          hintIds: [],
          description: "评审跨项目引用的完整性约束并形成团队契约。",
          createdBy: "worker:plan",
          createdAt: "20250728T083000.000",
          concludedBy: "worker:review",
          concludedAt: "20250728T090000.000",
        },
      ],
      hints: [],
    },
    {
      id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      title: "已完成：监控面板选型",
      status: "completed",
      createdAt: "20250720T070000.000",
      facts: [
        {
          id: "origin",
          description: "源事实：需要一个轻量监控面板展示任务队列、Worker 状态与吞吐趋势。",
          createdAt: "20250720T070000.000",
          artifact: null,
        },
        {
          id: "f1",
          description: "证据：对比四个候选面板后，自研静态面板在部署成本与定制性上最优。",
          createdAt: "20250720T083000.000",
          artifact: null,
        },
        {
          id: "goal",
          description: "目标事实：监控面板已交付并通过验收，随下个版本上线。",
          createdAt: "20250720T070000.000",
          artifact: {
            sha256: SHA_SVG,
            mediaType: "image/svg+xml",
            sizeBytes: 0,
            filename: "panel-report.svg",
            path: `artifacts/${SHA_SVG}`,
          },
        },
      ],
      intents: [
        {
          id: "i1",
          from: [
            {
              projectId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
              id: "origin",
              description: "源事实：需要一个轻量监控面板展示任务队列、Worker 状态与吞吐趋势。",
            },
          ],
          to: {
            projectId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
            id: "f1",
            description: "证据：对比四个候选面板后，自研静态面板在部署成本与定制性上最优。",
          },
          customProfile: null,
          customProfileDigest: null,
          hintIds: [],
          description: "调研候选面板并输出选型证据。",
          createdBy: "worker:plan",
          createdAt: "20250720T073000.000",
          concludedBy: "worker:execute",
          concludedAt: "20250720T083000.000",
        },
        {
          id: "i2",
          from: [
            {
              projectId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
              id: "f1",
              description: "证据：对比四个候选面板后，自研静态面板在部署成本与定制性上最优。",
            },
          ],
          to: {
            projectId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
            id: "goal",
            description: "目标事实：监控面板已交付并通过验收，随下个版本上线。",
          },
          customProfile: null,
          customProfileDigest: null,
          hintIds: [],
          description: "按选型证据完成面板交付并输出验收报告。",
          createdBy: "worker:plan",
          createdAt: "20250720T083500.000",
          concludedBy: "worker:execute",
          concludedAt: "20250720T100000.000",
        },
      ],
      hints: [],
    },
  ],
  tasks: [
    {
      name: "demo-board",
      boardDir: "tasks/demo-board",
      status: "running",
      runtime: { mode: "local", pid: 4242, startedAt: "20250801T090500.000" },
      execution: { mode: "local" },
      projects: [
        {
          id: "0b9e1f2a-4c1d-4e8f-9a2b-3c4d5e6f7a8b",
          title: "运行时评测：分布式图智能体",
          status: "active",
        },
        {
          id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
          title: "已完成：监控面板选型",
          status: "completed",
        },
      ],
    },
    {
      name: "idle-board",
      boardDir: "tasks/idle-board",
      status: "stopped",
      runtime: null,
      execution: { mode: "docker", networkMode: "bridge" },
      projects: [
        {
          id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          title: "上游团队：接口契约评审",
          status: "completed",
        },
      ],
    },
  ],
};

/* ---------------------------------------------------------------------------
 * State helpers
 * ------------------------------------------------------------------------ */
function nowStamp() {
  const d = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function projectMeta(project) {
  const meta = { id: project.id, title: project.title, status: project.status, createdAt: project.createdAt };
  if (project.scope !== undefined) meta.scope = project.scope;
  return meta;
}

function graphOf(project) {
  return {
    project: projectMeta(project),
    facts: project.facts ?? [],
    intents: project.intents ?? [],
    hints: project.hints ?? [],
  };
}

function findProject(state, id) {
  return state.projects.find((project) => project.id === id);
}

function findFact(project, factId) {
  return (project?.facts ?? []).find((fact) => fact.id === factId);
}

function findArtifact(state, sha256) {
  for (const project of state.projects) {
    for (const fact of project.facts ?? []) {
      if (fact.artifact?.sha256 === sha256) return { project, fact, artifact: fact.artifact };
    }
  }
  return null;
}

function syncTaskProjectMetas(state) {
  for (const task of state.tasks) {
    for (const entry of task.projects ?? []) {
      const project = findProject(state, entry.id);
      if (project) {
        entry.title = project.title;
        entry.status = project.status;
      }
    }
  }
}

// Mirror requireUuid: malformed project ids are a 400 before any lookup.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireProject(state, id, response) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    error(response, 400, "invalid project id");
    return null;
  }
  const project = findProject(state, id);
  if (!project) {
    error(response, 404, "project not found");
    return null;
  }
  return project;
}

function loadCustomState(path) {
  if (!existsSync(path)) {
    console.error(`[peak-mock] custom scenario file not found: ${path}`);
    process.exit(1);
  }
  let custom;
  try {
    custom = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`[peak-mock] invalid scenario JSON: ${error.message}`);
    process.exit(1);
  }
  const state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  if (custom.projects !== undefined) {
    if (!Array.isArray(custom.projects)) {
      console.error("[peak-mock] scenario field \"projects\" must be an array");
      process.exit(1);
    }
    for (const project of custom.projects) {
      if (!project || typeof project.id !== "string") {
        console.error("[peak-mock] each scenario project needs a string id");
        process.exit(1);
      }
      const index = state.projects.findIndex((item) => item.id === project.id);
      if (index >= 0) state.projects[index] = project;
      else state.projects.push(project);
    }
  }
  if (custom.tasks !== undefined) {
    if (!Array.isArray(custom.tasks)) {
      console.error("[peak-mock] scenario field \"tasks\" must be an array");
      process.exit(1);
    }
    state.tasks = custom.tasks;
  }
  return state;
}

/* ---------------------------------------------------------------------------
 * Artifact bodies for the preview page
 * ------------------------------------------------------------------------ */
function artifactBody(artifact, fact) {
  if (artifact.mediaType === "image/svg+xml") {
    const lines = fact.description.match(/.{1,22}/gu) ?? [fact.description];
    const tspans = lines
      .map((line, index) => `<tspan x="48" y="${110 + index * 34}">${escapeXml(line)}</tspan>`)
      .join("");
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">` +
      `<rect width="640" height="360" rx="20" fill="#f5f6fa"/>` +
      `<rect x="24" y="24" width="592" height="312" rx="14" fill="none" stroke="#4f46e5" stroke-width="3"/>` +
      `<text x="48" y="64" font-family="system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="22" font-weight="700" fill="#161d2e">Peak 演示报告</text>` +
      `<text x="48" y="92" font-family="system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="15" fill="#68738b">${escapeXml(fact.id)} · ${escapeXml(artifact.filename ?? "")}</text>` +
      `<text font-family="system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="16" fill="#3b465d">${tspans}</text>` +
      `</svg>`
    );
  }
  return `${fact.description}\n\n---\nmock artifact · ${artifact.sha256}\n`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/* ---------------------------------------------------------------------------
 * HTTP plumbing
 * ------------------------------------------------------------------------ */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(rel) {
  return CONTENT_TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream";
}

/** Map a pathname to a posix-relative UI resource path, or null when unsafe. */
function resolveUiPath(pathname) {
  let rel = pathname === "/" ? "dashboard.html" : pathname.slice(1);
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const cleaned = [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || segment.includes("\\")) return null;
    cleaned.push(segment);
  }
  return cleaned.length ? cleaned.join("/") : null;
}

function readFromRoots(rel, roots) {
  for (const root of roots) {
    const base = resolve(root);
    const abs = resolve(root, rel);
    if (abs !== base && !abs.startsWith(base + sep)) continue;
    if (existsSync(abs)) {
      try {
        return readFileSync(abs);
      } catch {
        // try the next root
      }
    }
  }
  return undefined;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function json(response, status, payload) {
  send(response, status, `${JSON.stringify(payload)}\n`, { "content-type": "application/json; charset=utf-8" });
}

function error(response, status, message) {
  json(response, status, { error: message });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

/* ---------------------------------------------------------------------------
 * API handlers (mirror of the shipped UI's fetch surface)
 * ------------------------------------------------------------------------ */
function handleApi(state, method, parts, query, request, response) {
  // GET /api/projects — project metas.
  if (method === "GET" && parts.length === 2 && parts[1] === "projects") {
    return json(response, 200, state.projects.map(projectMeta));
  }

  // POST /api/fact-refs/resolve — cross-project FactRef resolution.
  if (method === "POST" && parts[1] === "fact-refs" && parts[2] === "resolve" && parts.length === 3) {
    return readBody(request).then((body) => {
      if (typeof body.targetProjectId !== "string" || body.targetProjectId.trim() === "") {
        return error(response, 400, "targetProjectId is required");
      }
      if (!UUID_PATTERN.test(body.targetProjectId)) return error(response, 400, "invalid project id");
      if (!Array.isArray(body.refs) || body.refs.length === 0) return error(response, 400, "at least one FactRef is required");
      const resolved = [];
      const seen = new Set();
      for (const ref of body.refs) {
        if (!ref || typeof ref.projectId !== "string" || typeof ref.id !== "string") {
          return error(response, 400, "invalid FactRef");
        }
        const key = `${ref.projectId}/${ref.id}`;
        if (seen.has(key)) return error(response, 400, "duplicate FactRef");
        seen.add(key);
        const source = findProject(state, ref.projectId);
        const fact = findFact(source, ref.id);
        if (!source || !fact) return error(response, 404, `fact not found: ${key}`);
        resolved.push({
          ref,
          fact: {
            id: fact.id,
            description: fact.description,
            createdAt: fact.createdAt,
            artifact: fact.artifact
              ? {
                  sha256: fact.artifact.sha256,
                  mediaType: fact.artifact.mediaType,
                  sizeBytes: fact.artifact.sizeBytes,
                  filename: fact.artifact.filename,
                  inputPath: `${ref.projectId}/artifacts/${fact.artifact.sha256}`,
                  readOnly: true,
                }
              : null,
          },
        });
      }
      return json(response, 200, resolved);
    }).catch((err) => error(response, 400, err.message));
  }

  // GET /api/tasks — task list.
  if (method === "GET" && parts.length === 2 && parts[1] === "tasks") {
    syncTaskProjectMetas(state);
    return json(response, 200, { tasks: state.tasks });
  }

  // POST /api/tasks — create a task (mirrors the real extension: returns the
  // fresh TaskSummary; Projects are NOT created until the Board is prepared).
  if (method === "POST" && parts.length === 2 && parts[1] === "tasks") {
    return readBody(request).then((body) => {
      const name = String(body.name ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return error(response, 400, "invalid task name");
      if (state.tasks.some((task) => task.name === name)) return error(response, 409, `task already exists: ${name}`);
      if (!Array.isArray(body.projects) || body.projects.length === 0) {
        return error(response, 400, "projects must be a non-empty array");
      }
      if (!Array.isArray(body.workers) || body.workers.length === 0) {
        return error(response, 400, "workers must be a non-empty array");
      }
      state.tasks.push({
        name,
        boardDir: `tasks/${name}`,
        status: "stopped",
        runtime: null,
        execution: body.execution ?? { mode: "local" },
        projects: [],
      });
      return json(response, 201, { name, boardDir: `tasks/${name}`, status: "stopped", runtime: null, projects: [] });
    }).catch((err) => error(response, 400, err.message));
  }

  // POST /api/tasks/:name/start | /stop (mirror the real response shapes)
  if (method === "POST" && parts[1] === "tasks" && parts.length === 4) {
    const task = state.tasks.find((item) => item.name === parts[2]);
    if (!task) return error(response, 404, "task not found");
    if (parts[3] === "start") {
      if (task.status === "running") return error(response, 409, "task already running");
      task.status = "running";
      task.runtime = {
        mode: task.execution?.mode ?? "local",
        pid: 1000 + Math.floor(Math.random() * 8999),
        startedAt: nowStamp(),
      };
      return json(response, 200, { name: task.name, status: "running", execution: task.execution?.mode ?? "local" });
    }
    if (parts[3] === "stop") {
      if (task.status !== "running") return error(response, 409, "task is not running");
      task.status = "stopped";
      task.runtime = null;
      return json(response, 200, { name: task.name, status: "stopped" });
    }
    return error(response, 404, "unknown task action");
  }

  // DELETE /api/tasks/:name[?purge=true] — real shape: 200 { name, deleted, purged }
  if (method === "DELETE" && parts[1] === "tasks" && parts.length === 3) {
    const index = state.tasks.findIndex((item) => item.name === parts[2]);
    if (index < 0) return error(response, 404, "task not found");
    const [task] = state.tasks.splice(index, 1);
    const purge = query.get("purge") === "true";
    if (purge) {
      const ids = new Set((task.projects ?? []).map((entry) => entry.id));
      state.projects = state.projects.filter((project) => !ids.has(project.id));
    }
    return json(response, 200, { name: task.name, deleted: true, purged: purge });
  }

  // Project routes: GET /api/projects/:id
  if (parts[1] === "projects" && parts.length === 3 && method === "GET") {
    const project = requireProject(state, parts[2], response); if (!project) return undefined;
    if (!project) return error(response, 404, "project not found");
    return json(response, 200, graphOf(project));
  }

  // PUT /api/projects/:id/status — real server only accepts active|stopped.
  if (parts[1] === "projects" && parts[3] === "status" && method === "PUT") {
    const project = requireProject(state, parts[2], response); if (!project) return undefined;
    if (!project) return error(response, 404, "project not found");
    return readBody(request).then((body) => {
      const status = body.status;
      if (status !== "active" && status !== "stopped") {
        return error(response, 400, "invalid status");
      }
      project.status = status;
      syncTaskProjectMetas(state);
      return json(response, 200, projectMeta(project));
    }).catch((err) => error(response, 400, err.message));
  }

  // POST /api/projects/:id/reopen — real server returns the full updated graph.
  if (parts[1] === "projects" && parts[3] === "reopen" && method === "POST") {
    const project = requireProject(state, parts[2], response); if (!project) return undefined;
    if (!project) return error(response, 404, "project not found");
    return readBody(request).then((body) => {
      const description = String(body.description ?? "").trim();
      const creator = String(body.creator ?? "").trim();
      if (!description || !creator) return error(response, 400, "description and creator are required");
      if (Buffer.byteLength(description, "utf8") > 1024) return error(response, 400, "description exceeds 1 KiB");
      if (Buffer.byteLength(creator, "utf8") > 1024) return error(response, 400, "creator exceeds 1 KiB");
      project.status = "active";
      syncTaskProjectMetas(state);
      return json(response, 200, graphOf(project));
    }).catch((err) => error(response, 400, err.message));
  }

  // POST /api/projects/:id/hints — mirror requireShortDescription (1 KiB limits).
  if (parts[1] === "projects" && parts[3] === "hints" && method === "POST") {
    const project = requireProject(state, parts[2], response); if (!project) return undefined;
    if (!project) return error(response, 404, "project not found");
    return readBody(request).then((body) => {
      const content = String(body.content ?? "").trim();
      const creator = String(body.creator ?? "").trim();
      if (!content || !creator) return error(response, 400, "content and creator are required");
      if (Buffer.byteLength(content, "utf8") > 1024) return error(response, 400, "content exceeds 1 KiB");
      if (Buffer.byteLength(creator, "utf8") > 1024) return error(response, 400, "creator exceeds 1 KiB");
      project.hints ??= [];
      const hint = {
        id: `h${project.hints.length + 1}`,
        content,
        creator,
        createdAt: nowStamp(),
        consumedByIntentId: null,
        consumedAt: null,
      };
      project.hints.push(hint);
      return json(response, 201, hint);
    }).catch((err) => error(response, 400, err.message));
  }

  // GET /api/projects/:id/export?format=json|timeline|archive (mirror the real
  // server: json = graph, timeline = flattened event list, archive = gzip).
  if (parts[1] === "projects" && parts[3] === "export" && method === "GET") {
    const project = requireProject(state, parts[2], response); if (!project) return undefined;
    if (!project) return error(response, 404, "project not found");
    const graph = graphOf(project);
    const format = query.get("format");
    if (format !== null && format !== "json" && format !== "timeline" && format !== "archive") {
      return error(response, 400, "invalid export format");
    }
    if (format === "archive") {
      const buffer = gzipSync(JSON.stringify(graph, null, 2));
      return send(response, 200, buffer, {
        "content-type": "application/gzip",
        "content-length": buffer.length,
        "content-disposition": `attachment; filename="peak-${project.id}.tar.gz"`,
      });
    }
    if (format === "timeline") {
      const timeline = [
        ...graph.facts.map((fact) => ({ at: fact.createdAt, projectId: graph.project.id, type: "fact", value: fact })),
        ...graph.intents.map((intent) => ({ at: intent.createdAt, projectId: graph.project.id, type: "intent", value: intent })),
        ...graph.hints.map((hint) => ({ at: hint.createdAt, projectId: graph.project.id, type: "hint", value: hint })),
      ].sort((left, right) => left.at.localeCompare(right.at));
      return json(response, 200, timeline);
    }
    return json(response, 200, graph);
  }

  // GET|HEAD /api/projects/:id/artifacts/:sha256 (etag + length, like the real store)
  if (parts[1] === "projects" && parts[3] === "artifacts" && parts.length === 5 && (method === "GET" || method === "HEAD")) {
    const project = requireProject(state, parts[2], response); if (!project) return undefined;
    if (!project) return error(response, 404, "project not found");
    const match = findArtifact(state, parts[4]);
    if (!match || match.project.id !== project.id) return error(response, 404, "artifact not found");
    const body = Buffer.from(artifactBody(match.artifact, match.fact), "utf8");
    const headers = {
      "content-type": match.artifact.mediaType ?? "application/octet-stream",
      "content-length": body.length,
      etag: match.artifact.sha256,
    };
    if (method === "HEAD") {
      response.writeHead(200, { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
      return response.end();
    }
    return send(response, 200, body, headers);
  }

  return error(response, 404, "unknown API route");
}

/* ---------------------------------------------------------------------------
 * Server
 * ------------------------------------------------------------------------ */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = options.data ? loadCustomState(options.data) : JSON.parse(JSON.stringify(DEFAULT_STATE));
  const uiRoots = options.ui ? [resolve(options.ui)] : [join(root, "src", "ui"), join(root, "dist", "ui")];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    const parts = [];
    try {
      for (const part of url.pathname.split("/").filter(Boolean)) parts.push(decodeURIComponent(part));
    } catch {
      return error(response, 400, "malformed path");
    }

    if (parts[0] === "api") {
      return handleApi(state, method, parts, url.searchParams, request, response);
    }

    if (method === "GET" || method === "HEAD") {
      const rel = resolveUiPath(url.pathname);
      const content = rel ? readFromRoots(rel, uiRoots) : undefined;
      if (content !== undefined) {
        const headers = { "content-type": contentTypeFor(rel) };
        if (method === "GET") return send(response, 200, content, headers);
        response.writeHead(200, headers);
        return response.end();
      }
    }

    if (!options.quiet) {
      process.stdout.write(`[peak-mock] ${method} ${url.pathname} -> 404\n`);
    }
    return error(response, 404, "not found");
  });

  await new Promise((done) => server.listen(options.port, options.host, done));

  const base = `http://127.0.0.1:${options.port}`;
  const demo = state.projects[0];
  const artifact = (demo?.facts ?? []).find((fact) => fact.artifact)?.artifact;
  const lan = options.host === "0.0.0.0" || options.host === "::"
    ? Object.values(networkInterfaces()).flat().filter(
        (iface) => iface && iface.family === "IPv4" && !iface.internal,
      ).map((iface) => iface.address)
    : [];
  process.stdout.write(
    `\n[peak-mock] Peak Web UI mock preview server\n` +
    `  Graph dashboard   ${base}/\n` +
    `  Task management   ${base}/tasks.html\n` +
    (artifact
      ? `  Artifact preview  ${base}/preview.html?project=${demo.id}&artifact=${artifact.sha256}\n`
      : "") +
    (lan.length ? lan.map((ip) => `  LAN access        http://${ip}:${options.port}/\n`).join("") : "") +
    `\n` +
    `  ${state.projects.length} demo Project(s) · ${state.tasks.length} demo Task(s)\n` +
    `  State is in-memory: POST/PUT changes reset on restart; use --data state.json to load a custom scenario.\n` +
    `  UI roots: ${uiRoots.join(" ; ")}\n\n`,
  );
}

await main();
