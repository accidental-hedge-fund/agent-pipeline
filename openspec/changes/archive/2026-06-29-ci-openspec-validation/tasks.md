## 1. CI gate wiring

- [x] 1.1 Add a `scripts/ci-openspec.mjs` guard that exits 0 when the repo has no
  `openspec/` directory, and otherwise runs `openspec validate --all`, exiting with its
  status.
- [x] 1.2 Resolve the `openspec` CLI in the guard so a fresh CI runner without a
  preinstalled CLI still validates (PATH first, deterministic fallback otherwise).
- [x] 1.3 Add a `ci:openspec` npm script and wire it into the `ci` chain in `package.json`.
- [x] 1.4 Confirm `.github/workflows/ci.yml` still runs `npm run ci` verbatim (no new
  bespoke YAML step).

## 2. Tests

- [x] 2.1 Add a drift-guard test asserting the `ci` npm script includes the OpenSpec
  validation step (fails if the step is removed from the chain).
- [x] 2.2 Add a test asserting the guard exits 0 without invoking validation when run
  against a directory that has no `openspec/` workspace.
- [x] 2.3 Add a regression test demonstrating the guard exits non-zero when the workspace
  is structurally invalid (so an invalid spec/change fails CI). Prove the test bites.

## 3. Documentation

- [x] 3.1 Update the README build/test section to state that `npm run ci` validates the
  OpenSpec workspace (`openspec validate --all`).
- [x] 3.2 Update `CLAUDE.md` and `AGENTS.md` build/test guidance with the same gate.

## 4. Verification

- [x] 4.1 Run `openspec validate --all` and confirm it passes (including this change).
- [x] 4.2 Regenerate the plugin mirror if any `core/`/`hosts/` files changed and confirm
  `node scripts/build.mjs --check` passes.
- [x] 4.3 Run `npm run ci` from the repo root and confirm green.
