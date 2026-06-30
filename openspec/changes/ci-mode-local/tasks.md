## 1. Config schema

- [ ] 1.1 Add `ci_mode: "github" | "local"` to the `PipelineConfig` interface in `core/scripts/types.ts`, alongside `ci_timeout` / `ci_poll_interval` / `ci_no_run_grace_s`.
- [ ] 1.2 Set `DEFAULT_CONFIG.ci_mode = "github"` in `core/scripts/types.ts`.
- [ ] 1.3 Add `ci_mode: z.enum(["github", "local"]).optional().describe("Source of pre-merge CI verification: github (default) waits on gh pr checks; local relies on the current run's local test-gate result and skips the GitHub Actions wait.")` to `PartialConfigSchema` in `core/scripts/config.ts`.
- [ ] 1.4 Resolve it in the `merged` config object: `ci_mode: fileConfig.ci_mode ?? DEFAULT_CONFIG.ci_mode`.
- [ ] 1.5 Emit `ci_mode` (with an inline `#` comment) in the `writeConfig` YAML scaffold near the other `ci_*` lines, and add it to the config-from-partial builder so round-tripping a partial config preserves it.

## 2. Pre-merge local-CI verification

- [ ] 2.1 Add a `readRunEvents?` seam to `AdvancePreMergeDeps` in `core/scripts/stages/pre_merge.ts`, defaulting to `readEvents` from `run-store.ts`.
- [ ] 2.2 Add a helper (in `pre_merge.ts` or `run-store.ts`) that, given a run directory and the events reader, returns the most-recent `stage_accounting` event with `harness === "test-gate"` (or `null` when none / no run dir).
- [ ] 2.3 In `advance()` "Step 1: CI", branch on `cfg.ci_mode`. When `"local"`: do NOT call `getPrChecksFn` or the check-runs API. Read the latest test-gate outcome via 2.2.
- [ ] 2.4 Local pass: when the latest test-gate outcome is a pass, record evidence and fall through to "Step 2: mergeability" exactly as the `github` path does after CI passes (do not return early — the mergeability and OpenSpec gates must still run).
- [ ] 2.5 Local failure: when the latest test-gate outcome is a failure, `setBlocked(..., "pre-merge", "needs-human")` with a message naming the failed local gate, and return `{ advanced: false, status: "blocked", reason: ... }`.
- [ ] 2.6 Local missing-result fail-closed: when `opts.runDir` is absent, no `test-gate` event exists for the run, or the log can't be read, `setBlocked(..., "needs-human")` with a clear message stating `ci_mode: local` found no local test-gate result for this run, and return blocked. Never advance.
- [ ] 2.7 Leave the `github` path (poll, zero-run recovery, CI-failure rebase) untouched so default behavior is byte-for-byte identical.

## 3. Tests

- [ ] 3.1 `config.test.ts`: `ci_mode` absent → `"github"`; `ci_mode: local` accepted; an out-of-enum value throws naming `ci_mode`; emitted JSON Schema includes `ci_mode` with the enum and a non-empty description.
- [ ] 3.2 `pre_merge.test.ts`: `ci_mode: github` (default) still calls `getPrChecks` (spy asserts called) — regression guard for the default path.
- [ ] 3.3 `pre_merge.test.ts`: `ci_mode: local` with a recorded test-gate pass advances past CI to mergeability and never calls `getPrChecks` (spy asserts not called).
- [ ] 3.4 `pre_merge.test.ts`: `ci_mode: local` with a recorded test-gate failure blocks to `needs-human`.
- [ ] 3.5 `pre_merge.test.ts`: `ci_mode: local` with no test-gate event (and with no `runDir`) blocks to `needs-human` with the fail-closed message; verify it does not silently advance.
- [ ] 3.6 `pre_merge.test.ts`: `ci_mode: local` still blocks on a conflicting / spec-invalid PR (mergeability and OpenSpec gates unaffected).
- [ ] 3.7 Prove each new test bites — it fails before the corresponding code change.

## 4. Docs + mirror

- [ ] 4.1 Document `ci_mode` in `README.md`: the default, what `local` does, and the operator responsibility (only enable when the local gate equals full CI per `test-gate-ci-parity`; branch protection stays operator-owned).
- [ ] 4.2 Regenerate the mirror: `node scripts/build.mjs`, and commit the updated `plugin/` in the same change.

## 5. Gate

- [ ] 5.1 `npm run ci` is green from the repo root (`ci:core` → mirror check → install smoke → `openspec validate --all`).
