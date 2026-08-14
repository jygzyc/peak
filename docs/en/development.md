# Build, Test, and Release

This guide covers the Peak build, test, and release workflow for contributors.

## Commands

```bash
npm run typecheck     # core typecheck (regenerates embedded assets first)
npm run typecheck:ui  # browser UI app under its own tsconfig (DOM libs, bundler resolution)
npm run typecheck:all # both (used by CI and the pack release gate)
npm run build         # core-only modular dist + scripts/*.mjs syntax & consistency checks
npm run build:ui      # UI-only: bundle src/ui/app, re-embed assets, typecheck, copy dist/ui
npm run build:all     # both (previous monolithic build)
npm run preview:ui    # build:ui, then serve the UI + a mock /api backend (no Graph server needed)
npm test              # core build first, tests against dist/
npm run smoke         # CLI smoke: init/workers/--version
npm run pack          # esbuild single-file bundle + npm pack of the self-contained dist package + manifest
```

- Core and UI compile separately: an in-progress or broken UI never blocks the core build, typecheck, or test suite; `npm run build` alone produces a working CLI and Graph server without the dashboard bundle.
- `npm test` runs a clean core TypeScript build first; tests import modular files from `dist/`, never directly from `src/`.
- HTTP/CLI tests must stop servers and close registries before removing temporary directories.
- `npm run pack` must be run last: its `prepack` phase replaces modular `dist/` with the production esbuild bundle, copies the UI to `dist/ui/`, copies runtime prompts, verifies `dist/cli.js workers`, and writes the tarball plus manifest under `dist-packages/`.

## Web UI preview with mock data

`npm run preview:ui` builds the UI bundle and starts `scripts/mock-server.mjs` — a standalone preview server that serves the static site together with an in-memory mock implementation of every `/api/*` endpoint the UI calls (projects, graphs, FactRef resolution, hints, status/reopen, exports, artifacts, tasks). No Graph server, Board, or Worker is required:

```bash
npm run preview:ui                 # build UI + serve on http://127.0.0.1:8010/
npm run preview:ui:serve           # serve without rebuilding (UI already bundled)
node scripts/mock-server.mjs --port 9000            # custom port
node scripts/mock-server.mjs --host 0.0.0.0         # LAN access for phones / tablets
node scripts/mock-server.mjs --data my-state.json   # custom scenario
node scripts/mock-server.mjs --ui ./dist/ui         # serve a specific UI root
```

- The built-in scenario has three demo Projects (Chinese source/goal text to exercise wrapping), cross-project FactRefs, intents in all three states (open / claimed / concluded), hints, artifacts (markdown + SVG) for the preview page, and two tasks (one running).
- All state is in-memory: mutations made through the UI (hints, status, tasks, …) reset on restart.
- A custom scenario file uses the same shape as the built-in `DEFAULT_STATE` in `scripts/mock-server.mjs`: `{ projects: [{ id, title, status, scope?, createdAt, facts, intents, hints }], tasks: [...] }`. Projects with a matching id replace the demo project; unknown ids are appended.

## Versioning and release notes

- Version is read from the root `version` file (synced into `package.json` at pack time; drift is caught by `check-scripts`).
- Release notes (bilingual): [`RELEASE.md`](../../RELEASE.md).
- CI (`.github/workflows/ci.yml`) runs typecheck/build/test/smoke/pack on Linux + Windows; tags `v*` trigger the Release action (`.github/workflows/release.yml`), which packs, verifies the tag matches `version`, publishes the tarball to npm via Trusted Publishing (OIDC), and creates the GitHub Release.
