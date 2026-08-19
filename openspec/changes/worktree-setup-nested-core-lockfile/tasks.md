## 1. Biting tests

- [ ] 1.1 In `core/test/worktree-setup.test.ts`, add a `detectAndInstall` case whose fixture is only `/wt/core/package-lock.json`, with no `/wt/core/node_modules` and `setup_command` unset. Assert the spawned command is `npm ci` and CWD is `/wt/core`. Confirm the test fails on current root-only detection.
- [ ] 1.2 Add cases: root lockfile still installs at `/wt` even when `/wt/core/package-lock.json` exists; root `/wt/node_modules` does not skip when the only lockfile is `/wt/core/package-lock.json`; `/wt/core/node_modules` present skips; empty `setup_command` skips nested; non-empty `setup_command` runs at `/wt` and does not auto-detect `core/`; two first-level lockfile dirs skip; deeper-than-first-level lockfile skips; nested `npm ci` non-zero throw names `npm ci`.
- [ ] 1.3 Keep deps injection. Do not call real filesystem, network, or subprocess.

## 2. Nested fallback in detectAndInstall

- [ ] 2.1 In `core/scripts/worktree-setup.ts`, choose the package root before the `node_modules` skip: worktree root if it has a lockfile; else exactly one first-level subdirectory with a lockfile (D1, D2, D3).
- [ ] 2.2 Add an optional directory-list seam on `SetupDeps`. After a root miss, list first-level names when the seam succeeds; always also probe `core/`; ignore `.git`, `node_modules`, and names that start with `.`; treat a thrown list as empty (D4).
- [ ] 2.3 Spawn the matching install (`pnpm install` / `yarn install` / `npm ci`) with CWD set to the chosen package root. Keep `setup_command` first and at the worktree root (D5).
- [ ] 2.4 Keep the existing throw path, timeout, truncation, and log line. The log SHALL name the nested lockfile path when that path is used.

## 3. Preserve the #174 root path

- [ ] 3.1 Re-run the existing `worktree-setup.test.ts` root-lockfile, idempotency, `setup_command`, failure, timeout, and truncation cases and confirm they still pass without edits to their assertions.

## 4. Docs

- [ ] 4.1 Update `docs/config.md` / README setup notes if they still say lockfile detection is worktree-root only. State the first-level nested fallback and that multiple first-level lockfile dirs skip (use `setup_command`).

## 5. Mirror and gate

- [ ] 5.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` with the `core/` edits.
- [ ] 5.2 Run `npm run ci` from the repo root. Do not claim done until that command exits 0.
