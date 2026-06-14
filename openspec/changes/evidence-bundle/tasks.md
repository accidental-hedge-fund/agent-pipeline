## 1. Types

- [x] 1.1 Add `CommandRecord`, `StageRecord`, `ReviewRecord`, `OverrideRecord`, `RecoveryRecord`, and `EvidenceBundle` types to `core/scripts/types.ts`
- [x] 1.2 Export all new types from `types.ts` (plus `StageOutcome`, `StageUpdate`, and `EVIDENCE_SCHEMA_VERSION`)

## 2. Bundle Writer Module

- [x] 2.1 Create `core/scripts/evidence-bundle.ts` with a `BundleDeps` interface (`readFile`, `writeFile`, `rename`, `mkdir`) defaulting to `fs/promises` equivalents
- [x] 2.2 Implement `createBundle(stateDir, { runId, issue, pr, branch, harnesses }, deps?)` → writes initial `EvidenceBundle` JSON to `<stateDir>/<issue>/evidence.json` (via `.tmp` + rename)
- [x] 2.3 Implement `recordStage(stateDir, issue, update: StageUpdate, deps?)` — reads existing bundle, upserts stage entry by stage name, writes back
- [x] 2.4 Implement `recordCommand(stateDir, issue, stageName, cmd: CommandRecord, deps?)` — appends command to the matching stage entry (creating it if absent)
- [x] 2.5 Implement `recordReview(stateDir, issue, review: ReviewRecord, deps?)` — appends to `reviews` array
- [x] 2.6 Implement `recordOverride(stateDir, issue, override: OverrideRecord, deps?)` — appends to `overrides` array
- [x] 2.7 Implement `recordRecovery(stateDir, issue, recovery: RecoveryRecord, deps?)` — appends to `recoveries` array
- [x] 2.8 Implement `finalizeBundle(stateDir, issue, finalState, deps?)` — sets `finalState` and `finalizedAt`, writes back, returns the bundle
- [x] 2.9 Implement `readBundle(stateDir, issue, deps?)` — reads and parses the bundle JSON; returns `null` if file not found
- [x] 2.10 Implement `printSummary(bundle)` (+ pure `formatSummary(bundle)`) — identity block, stage table (name / outcome / duration + commands), review summary, overrides, recoveries, final state
- [x] 2.11 Enforce the sensitive-value exclusion: `makeCommandRecord` rebuilds a record with only `cmd` / `exitCode` / `durationMs` / `outputExcerpt`, capping the excerpt at 500 chars; `recordCommand` re-sanitizes defensively so a caller cannot smuggle extra (secret-bearing) fields into the bundle
- [x] 2.12 Added `markNotified(stateDir, issue, deps?)` so the orchestrator can stamp `notifiedAt` after posting the path comment (keeps the module pure — it never posts comments itself)

## 3. Orchestrator Integration

- [x] 3.1 In `core/scripts/pipeline.ts`, reuse the dispatch-wide `pipelineRunId` (commit-traceability) as the bundle `runId`
- [x] 3.2 Call `createBundle()` once at run entry (inside the per-issue lock, before the loop); pass `stateDir` (`runStateDir(domain)` = `/tmp/pipeline-<domain>`), `issueNumber`, PR number (queried via `gh`), current branch (`branchName` from the worktree), and harness identities
- [x] 3.3 Call `finalizeBundle()` after the dispatch loop exits, in a `finally` so it runs on the normal, blocked, and thrown paths; `finalState` is the stage the run ended at
- [x] 3.4 After `finalizeBundle()`, post the path comment on the PR (or issue) via `notifyBundlePath`, deduplicated on the bundle's `notifiedAt` (set via `markNotified` after posting)
- [x] 3.5 Add `--summary` CLI flag (issue number is the positional arg): reads the bundle locally and prints the summary **before** any `gh`/kill-switch/label/lock work, so it is offline-safe; exits 0 when present, non-zero with an error when absent

## 4. Stage-Level Instrumentation

- [x] 4.1 / 4.2 Stage entry/exit are recorded centrally by the orchestrator around each `dispatch()` call (entry before, `{ exitedAt, outcome }` after), with the outcome mapped from the stage's `Outcome`. **Design refinement vs. the original per-return-path plan:** centralizing in the orchestrator produces an accurate, gap-free per-stage timeline from one place instead of threading `recordStage` through every return path of seven large stage files, and keeps the stages free of audit bookkeeping. The dispatched `ready` label is recorded under the clearer name `planning` (the same name the test gate records its commands under, so they merge into one entry).
- [x] 4.3 The test gate (`runTestGate`) and the eval gate record each shell-command run via `recordCommand` (cmd, synthesized exit code, durationMs, 500-char excerpt). Recording is gated on a `stateDir` the orchestrator threads through stage opts — so direct unit-test calls (no `stateDir`) have **no filesystem side effects**, preserving the no-real-IO test contract.
- [x] 4.4 In `core/scripts/stages/review.ts`, call `recordReview()` right after the verdict is parsed, with round, reviewed SHA, the verdict string, and per-severity finding counts
- [x] 4.5 Override dispositions are recorded by the orchestrator from the `--override` argument at run entry — that is the only place the **full human-provided reason** exists (the review-stage application only sees the normalized disposition token). **Design refinement vs. the original `pre_merge.ts` plan:** `pre_merge.ts` does not apply overrides (the review stage's `partitionFindings` does), and it has no access to the reason text, so recording there could not satisfy "the human-provided reason."
- [x] 4.6 In `core/scripts/stages/auto_recover.ts`, call `recordRecovery()` (trigger `no-commits`, round, timestamp) at each successful recovery event

## 5. Tests

- [x] 5.1 Create `core/test/evidence-bundle.test.ts` (in-memory `BundleDeps` fakes — no real fs) covering: `createBundle` initial shape/`schemaVersion: 1`/`finalState: null`; `recordStage` create-then-update (no dup) + insertion order + recreate-if-missing; `recordCommand` appends to the right stage + creates entry; `recordReview` append + accumulate; `recordOverride` / `recordRecovery` append; `finalizeBundle` sets `finalState` + ISO `finalizedAt` (null before); `readBundle` null-when-absent / parsed-when-present; `formatSummary` contains stage names, verdicts, final state, durations; and the sensitive-value exclusion (four-field `CommandRecord`, 500-char cap, smuggled secret fields stripped and absent from the serialized bundle)
- [x] 5.2 Integration-level test (in `evidence-bundle.test.ts`, exercising the exact create→record→finalize sequence the orchestrator+stages make): a full planning → ready-to-deploy run yields a bundle with `finalState: "ready-to-deploy"` and stage entries. **Note:** placed here rather than `pipeline.test.ts` because `runAdvance` has no IO seam (it calls `gh`/lock directly), so a faithful, hermetic integration test lives at the bundle layer — which *is* the integration surface (the orchestrator only makes these module calls).

## 6. Validation

- [x] 6.1 `npm run ci` from root passes (662 core tests, mirror in sync, install smoke ok)
- [x] 6.2 `openspec validate evidence-bundle` passes
- [x] 6.3 Functional smoke of `--summary`: bundle written through the module, `--summary <issue>` prints a human-readable summary and exits 0; a missing bundle exits non-zero with a helpful path hint; runs offline (no `gh`)
