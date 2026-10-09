# Contributing

Use Node.js 24, run `npm ci`, `npx install-electron --no`, and `npm run build`. Run typecheck, tests and actual desktop acceptance before proposing a change. Linux desktop acceptance needs a display or Xvfb and an enabled Chromium sandbox; do not disable it to make a test pass.

Keep PDF/DOCX inputs local and use authored synthetic documents in tests. Add a reproducing test for a bug, fix its cause and retain failure evidence. Do not change expected document equality or skip safety checks to make a failing case pass. Parser and report changes must preserve bounded processing and uncertainty.

Core interfaces are in `src/core/types.ts`. PDF comparison runs in a worker; Electron contains no document parser. Keep IPC small and sender-bound. Regenerate the corpus only intentionally and review manifest hashes. Add licenses and notices for new third-party components. Describe the problem, resulting behavior and relevant validation in a pull request.

Stable 1.x qualification also runs `scripts/upgrade-acceptance.mjs` against the pinned public 0.1.0 archive and a freshly extracted current package. The [CI workflow](.github/workflows/ci.yml) contains the full Windows/Linux setup and command arguments. It preserves one synthetic profile across versions, verifies package identities and report formats, reopens the old standalone HTML, and retains all six reports with its acceptance record. Use synthetic profiles and fixtures; do not run qualification against your personal application data.
