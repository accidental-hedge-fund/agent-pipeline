## 1. Config Schema

- [ ] 1.1 Add `format_gate` array schema to `PartialConfigSchema` in `core/scripts/config.ts` (each entry: `{ command: string, auto_fix: boolean }`, strict unknown-key rejection)
- [ ] 1.2 Set `DEFAULT_CONFIG.format_gate` to `[]`
- [ ] 1.3 Write unit tests: valid config accepted, missing field rejected, unknown key rejected, absent key defaults to `[]`

## 2. Format Gate Implementation

- [ ] 2.1 Create `core/scripts/stages/format-gate.ts` with `runFormatGate(worktreePath, config, issueNumber, deps)` accepting injectable `deps` (exec, git status, git commit)
- [ ] 2.2 Implement auto-fix path: run command → check dirty worktree → commit `chore: auto-format (#N)` → re-run → block if re-run non-zero
- [ ] 2.3 Implement check-only path: run command → block with `"Format gate command '<cmd>' failed:\n<output>"` if non-zero
- [ ] 2.4 Return early (no-op) when `config.format_gate` is empty

## 3. Stage Integration

- [ ] 3.1 Call `runFormatGate` in `core/scripts/stages/implementing.ts` after commit-range verification and before PR open/update
- [ ] 3.2 Call `runFormatGate` in `core/scripts/stages/fix.ts` (fix rounds 1 and 2) after commit-range verification and before PR update

## 4. Review-SHA Gate Extension

- [ ] 4.1 Extend `isPipelineInternalCommit` to recognize commit messages beginning with `chore: auto-format (#` as pipeline-internal
- [ ] 4.2 Add unit test: auto-format commit returns `true`; developer commit alongside auto-format commit returns `false` for the developer commit

## 5. Unit Tests for Format Gate

- [ ] 5.1 Test: no-op when `format_gate` is empty
- [ ] 5.2 Test: auto-fix path — changes produced, commit created, re-run passes → success
- [ ] 5.3 Test: auto-fix path — re-run exits non-zero → `{ status: "blocked", reason: ... }`
- [ ] 5.4 Test: auto-fix path — no changes produced → no commit, proceed
- [ ] 5.5 Test: check-only path — exits 0 → success
- [ ] 5.6 Test: check-only path — exits non-zero → `{ status: "blocked", reason: ... }`
- [ ] 5.7 Test: multiple entries run in order, second entry failure blocks even after first passes

## 6. This Repo's Pipeline Config

- [ ] 6.1 Add `format_gate` entries to `.github/pipeline.yml` for this repo (e.g. `cargo fmt` with `auto_fix: true` or language-appropriate equivalent) to self-test the feature

## 7. Documentation and Mirror

- [ ] 7.1 Document `format_gate` in `README.md` (config reference section): purpose, fields, examples for Rust and JS repos
- [ ] 7.2 Run `node scripts/build.mjs` to regenerate `plugin/` mirror and commit alongside core changes
- [ ] 7.3 Run `npm run ci` from repo root and confirm all tests pass
