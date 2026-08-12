## 1. Engine-known scratch classification

- [ ] 1.1 Extend `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` in `core/scripts/worktree-dirt.ts` with a narrow pattern matching worktree-relative `artifacts/challenge-response-*.json` (not all of `artifacts/**`).
- [ ] 1.2 Update module/header comments and any config/schema help text that enumerates the engine-known set so they list challenge-response dumps alongside `tasks/**` and `.pipeline-prompt-*`.
- [ ] 1.3 Confirm `matchScratchGlob` correctly matches `artifacts/challenge-response-1010.json` and does not match product namespaces or unrelated `artifacts/` paths.

## 2. Unit / classifier regressions

- [ ] 2.1 Add pure classifier tests: porcelain/path list only `artifacts/challenge-response-N.json` → scratch non-empty, product empty via `classifyWorktreeDirt` / `productDirtyPaths`.
- [ ] 2.2 Add fail-closed mixed test: challenge-response dump + `core/scripts/foo.ts` → product includes the core path.
- [ ] 2.3 Add narrow-glob negative: non-matching `artifacts/` path remains product dirt (proves no blanket `artifacts/**` waiver).
- [ ] 2.4 Prove the challenge-response-only classifier test **bites** without the new engine glob (would classify as product).

## 3. Gate-level regressions

- [ ] 3.1 Test-gate regression: injectable porcelain with only `artifacts/challenge-response-*.json` → pre-run dirty trust does not hard-block; command is allowed to run (or restore-then-proceed).
- [ ] 3.2 Assert that challenge-response-only dirt does **not** produce `blocker_kind: test-gate-exhausted` / product-dirt exhaustion wording for that dirt alone.
- [ ] 3.3 Format-gate pre-flight: scratch-only challenge-response does not refuse implement-path dirty check solely for that path (if pre-flight still uses the shared classifier).
- [ ] 3.4 Confirm format auto-fix / test-fix salvage still exclude challenge-response scratch from product commits when mixed with product dirt (reuse product-path-only salvage rules).

## 4. Optional write-path hygiene (if in scope for this change)

- [ ] 4.1 If prompts or engine code currently encourage dumping under `artifacts/challenge-response-*.json`, prefer documenting or directing future dumps under gitignored `.agent-pipeline/` without removing the engine-glob safety net for the legacy path.
- [ ] 4.2 Do **not** auto-commit challenge-response JSON into the product tree.

## 5. Mirror, validate, CI

- [ ] 5.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 5.2 Run `openspec validate fixtest-gate-challenge-response-scratch` (and `openspec validate --all` as needed) until clean.
- [ ] 5.3 Run `npm run ci` from the repo root and fix failures until green.
