# Build, Test, and Release

This guide covers the Peak build/test/release workflow for contributors. For source layout and non-negotiable boundaries, see [`AGENTS.md`](../AGENTS.md).

## Commands

```bash
npm run typecheck
npm run build        # modular dist + scripts/*.mjs syntax & consistency checks
npm test             # builds first, runs tests against dist/
npm run smoke        # CLI smoke: init/workers/--version
npm run pack         # esbuild single-file bundle + npm pack + manifest
```

- `npm test` runs a clean TypeScript build first; tests import modular files from `dist/`, never directly from `src/`.
- HTTP/CLI tests must stop servers and close registries before removing temporary directories.
- `npm run pack` must be run last: its `prepack` phase replaces modular `dist/` with the production esbuild bundle, copies the UI to `dist/ui/`, copies runtime prompts, verifies `dist/cli.js workers`, and writes the tarball plus manifest under `dist-packages/`.

## Versioning and release notes

- Version is read from the root `version` file (synced into `package.json` at pack time; drift is caught by `check-scripts`).
- Release notes (bilingual): [`RELEASE.md`](../RELEASE.md).
- CI (`.github/workflows/ci.yml`) runs typecheck/build/test/smoke/pack on Linux + Windows; tags `v*` trigger the Release action (`.github/workflows/release.yml`), which packs, verifies the tag matches `version`, publishes the tarball to npm via Trusted Publishing (OIDC), and creates the GitHub Release.
