## 1. Schema and Config

- [x] 1.1 Add `auto-merge-eligibility-schema.ts` in `core/scripts/` defining `EligibilityJudgeOutput` and `AutoMergeEligibilityArtifact` types/zod schemas
- [x] 1.2 Add `auto_merge_eligibility` config block to `PartialConfigSchema` in `core/scripts/config.ts` with all keys and defaults (`enabled`, `max_diff_lines`, `max_files`, `deny_paths`, `allow_paths`, `min_confidence`)
- [x] 1.3 Add a schema-drift guard test in `core/test/auto-merge-eligibility-schema.test.ts` asserting the `EligibilityJudgeOutput` schema matches the judge prompt's `{{schema_block}}`

## 2. Judge Prompt Template

- [x] 2.1 Create `core/scripts/prompts/auto_merge_eligibility_judge.md` with context payload placeholders (`{{pr_diff_summary}}`, `{{file_list}}`, `{{review_verdict}}`, `{{ci_status}}`, `{{evidence_metadata}}`, `{{issue_scope}}`) and the `{{schema_block}}` instruction
- [x] 2.2 Verify the prompt instructs the judge to return raw JSON only (no prose) and includes all `EligibilityJudgeOutput` field descriptions

## 3. Deterministic Policy Engine

- [x] 3.1 Create `core/scripts/stages/auto_merge_eligibility.ts` with `runDeterministicChecks(deps, context)` that evaluates all hard-deny conditions and returns `{ passed: boolean; checks: CheckResult[]; denial_reasons: string[] }`
- [x] 3.2 Implement built-in deny path patterns (migrations, auth, billing, security, infra/deploy, secrets/env, dependency manifests, cron/schedulers, public API surfaces, release config, prod config) as a compile-time constant
- [x] 3.3 Implement threshold checks: diff line count vs `max_diff_lines`, file count vs `max_files`
- [x] 3.4 Implement `deny_paths` and `allow_paths` config pattern matching
- [x] 3.5 Implement CI success check (query PR head SHA for passing check runs)
- [x] 3.6 Implement unresolved review comment check (query PR review threads)
- [x] 3.7 Implement review verdict check (read from evidence bundle; deny if not clean)
- [x] 3.8 Implement evidence bundle completeness check
- [x] 3.9 Implement behavioral-change-without-tests check (diff touches source but no test files and no `no_test_rationale` in evidence)
- [x] 3.10 Implement single-run linkage check (PR must link to exactly one pipeline run artifact)

## 4. LLM Judge Invocation

- [x] 4.1 Add `invokeEligibilityJudge(deps, context)` in `auto_merge_eligibility.ts` that builds the judge prompt, calls the reviewer harness via `reviewMode: prompt-harness`, and returns the raw output string
- [x] 4.2 Add `parseAndValidateJudgeOutput(raw: string)` that parses JSON and validates against `EligibilityJudgeOutput` schema; returns `{ ok: true; output }` or `{ ok: false; reason: string }`
- [x] 4.3 Implement confidence threshold check against `config.auto_merge_eligibility.min_confidence`

## 5. Gate Orchestration and Artifact Write

- [x] 5.1 Add `runEligibilityGate(deps, config, context)` that: runs deterministic checks → if denied, writes `needs-human` artifact → else invokes judge → validates/checks confidence → writes final artifact
- [x] 5.2 Implement `buildEligibilityArtifact(...)` that constructs the full `AutoMergeEligibilityArtifact` object including `revert_note` (format: `"git revert <head_sha>"`)
- [x] 5.3 Add `recordEligibilityArtifact(bundle, artifact)` that writes to the evidence bundle via the existing record API before finalization

## 6. shipcheck-gate Integration

- [x] 6.1 In `core/scripts/stages/shipcheck_gate.ts` (or equivalent), call `runEligibilityGate(...)` after all existing checks when `config.auto_merge_eligibility.enabled` is `true`
- [x] 6.2 Wrap the gate call in a try/catch; log errors but do NOT let gate failures block advancement to `ready-to-deploy`
- [x] 6.3 Add eligibility verdict to the shipcheck-gate stage summary string (shown in GitHub comment and stdout)

## 7. Tests

- [x] 7.1 Add `core/test/auto-merge-eligibility.test.ts` with a `Deps` seam (fake `gh`, fake harness, fake evidence bundle) injected via parameter
- [x] 7.2 Test: eligible low-risk PR — all deterministic checks pass, judge returns high-confidence, artifact has `eligibility: "auto-merge-eligible"`
- [x] 7.3 Test: migration file triggers hard deny — judge NOT invoked, artifact has `needs-human` with `"touches: migrations"` in `denial_reasons`
- [x] 7.4 Test: diff line count exceeds threshold — `needs-human` with threshold denial reason
- [x] 7.5 Test: judge returns invalid schema — `needs-human` with `"judge: schema validation failed"`
- [x] 7.6 Test: judge confidence below `min_confidence` — `needs-human` with confidence denial reason
- [x] 7.7 Test: judge harness times out / errors — `needs-human` with `"judge: harness error or timeout"`
- [x] 7.8 Test: missing evidence bundle — deterministic denial fires, `needs-human`
- [x] 7.9 Test: gate disabled (default) — `runEligibilityGate` not called, no artifact in evidence bundle
- [x] 7.10 Test: gate error inside shipcheck-gate does not block `ready-to-deploy`
- [x] 7.11 Prove tests bite: verify each test fails without the corresponding implementation

## 8. Config Schema Tests

- [x] 8.1 Add config parsing tests for `auto_merge_eligibility` block: valid block accepted, unknown key rejected, `min_confidence > 1` rejected, omitted block defaults to `enabled: false`

## 9. Build and CI

- [x] 9.1 Run `npm run ci` from repo root — confirm all tests pass and plugin mirror is in sync
- [x] 9.2 Regenerate `plugin/` via `node scripts/build.mjs` and commit alongside `core/` changes
