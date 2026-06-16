## 1. Config Schema

- [x] 1.1 Add optional `setup_command?: string` field to the pipeline config schema in `core/scripts/config.ts`
- [x] 1.2 Update config validation/loading to pass `setup_command` through to callers
- [x] 1.3 Add `setup_command` to the example `.github/pipeline.yml` with a comment explaining its use

## 2. Dependency Install Logic

- [x] 2.1 Create `core/scripts/worktree-setup.ts` implementing `detectAndInstall(worktreePath, config, deps)` — detects lockfile, checks `node_modules` idempotency, runs the install or `setup_command`, captures output, throws on non-zero exit
- [x] 2.2 Implement lockfile detection precedence: `pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn install`, `package-lock.json` → `npm ci`; return `{skipped: true}` if none found and no `setup_command`
- [x] 2.3 Implement idempotency check: skip if `node_modules` exists and `setup_command` is not set
- [x] 2.4 Implement `setup_command` override: run via `{shell: true}` in worktree CWD; empty string → skip
- [x] 2.5 Surface install stdout/stderr in pipeline log output (same pattern as test gate output)

## 3. Wire into Worktree Bootstrap

- [x] 3.1 Call `detectAndInstall` at the end of `createWorktree` (or in the wrapper that immediately follows) in `core/scripts/harness.ts` (or wherever `createWorktree` is invoked)
- [x] 3.2 Ensure the CWD passed to the install subprocess is the worktree path, not the repo root
- [x] 3.3 On install failure, emit a clear error naming the failed command and its exit code, then rethrow to block all subsequent stages

## 4. Tests

- [x] 4.1 Write unit tests for `detectAndInstall` covering: pnpm detection, yarn detection, npm detection, no lockfile (skip), `node_modules` present (skip), `setup_command` override, empty `setup_command` (skip), and non-zero exit (throw with message)
- [x] 4.2 Write a regression test that fails when `detectAndInstall` is a no-op but the worktree has a `pnpm-lock.yaml` — proves the test bites without the fix
- [x] 4.3 Confirm all tests use `deps` injection (no real filesystem, network, or subprocess calls)

## 5. Documentation and Mirror Sync

- [x] 5.1 Update README to document the `setup_command` config key with examples (plain install, custom multi-step, opt-out with `""`)
- [x] 5.2 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror
- [x] 5.3 Run `npm run ci` from the repo root and confirm it passes (all tests green, mirror in sync, install smoke passes)
