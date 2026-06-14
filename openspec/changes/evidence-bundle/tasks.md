## 1. Types

- [ ] 1.1 Add `CommandRecord`, `StageRecord`, `ReviewRecord`, `OverrideRecord`, `RecoveryRecord`, and `EvidenceBundle` types to `core/scripts/types.ts`
- [ ] 1.2 Export all new types from `types.ts`

## 2. Bundle Writer Module

- [ ] 2.1 Create `core/scripts/evidence-bundle.ts` with a `BundleDeps` interface (`readFile`, `writeFile`, `rename`) defaulting to `fs/promises` equivalents
- [ ] 2.2 Implement `createBundle(runId, issue, pr, branch, harnesses, stateDir, deps?)` → writes initial `EvidenceBundle` JSON to `<stateDir>/<issue>/evidence.json` (via `.tmp` + rename)
- [ ] 2.3 Implement `recordStage(stateDir, issue, update: Partial<StageRecord>, deps?)` — reads existing bundle, upserts stage entry by stage name, writes back
- [ ] 2.4 Implement `recordCommand(stateDir, issue, stageName, cmd: CommandRecord, deps?)` — appends command to the matching stage entry
- [ ] 2.5 Implement `recordReview(stateDir, issue, review: ReviewRecord, deps?)` — appends to `reviews` array
- [ ] 2.6 Implement `recordOverride(stateDir, issue, override: OverrideRecord, deps?)` — appends to `overrides` array
- [ ] 2.7 Implement `recordRecovery(stateDir, issue, recovery: RecoveryRecord, deps?)` — appends to `recoveries` array
- [ ] 2.8 Implement `finalizeBundle(stateDir, issue, finalState, deps?)` — sets `finalState` and `finalizedAt`, writes back
- [ ] 2.9 Implement `readBundle(stateDir, issue, deps?)` — reads and parses the bundle JSON; returns `null` if file not found
- [ ] 2.10 Implement `printSummary(bundle: EvidenceBundle)` — formats and prints a human-readable table: identity block, stage table (name / outcome / duration), review summary (round / verdict / findings), overrides, recoveries, final state
- [ ] 2.11 Enforce the sensitive-value exclusion: `CommandRecord` captures only `cmd` (string), `exitCode` (number), and `durationMs` (number); stdout/stderr is capped at 500 chars and stored as `outputExcerpt`

## 3. Orchestrator Integration

- [ ] 3.1 In `core/scripts/pipeline.ts`, generate `pipelineRunId` at dispatch entry (already produced by commit-traceability; reuse or share)
- [ ] 3.2 Call `createBundle()` at the start of each dispatch cycle before the stage switch; pass `stateDir`, `issueNumber`, PR number (query via `gh`), current branch, and harness identity
- [ ] 3.3 Call `finalizeBundle()` after the dispatch loop exits (both normal and error paths)
- [ ] 3.4 After `finalizeBundle()`, post the path comment on the PR/issue using a deduplicated notification (skip if `notifiedAt` is already set in the bundle; set it after posting)
- [ ] 3.5 Add `--summary <issueNumber>` CLI flag: when present, call `readBundle()`, call `printSummary()`, and exit without entering the dispatch loop

## 4. Stage-Level Instrumentation

- [ ] 4.1 In each `core/scripts/stages/*.ts`, call `recordStage()` with `{ stage, enteredAt }` at the top of the advance function
- [ ] 4.2 Call `recordStage()` with `{ exitedAt, outcome }` immediately before any `transition()` or `setBlocked()` return path
- [ ] 4.3 Wherever a stage runs a shell command via `runCapped` or equivalent, wrap it to call `recordCommand()` with cmd, exitCode, durationMs, and a 500-char excerpt of combined output
- [ ] 4.4 In `core/scripts/stages/review.ts`, call `recordReview()` after the verdict JSON is parsed, with round, sha, verdict, and per-severity finding counts
- [ ] 4.5 In `core/scripts/stages/pre_merge.ts`, call `recordOverride()` for each override entry applied
- [ ] 4.6 In `core/scripts/stages/auto_recover.ts`, call `recordRecovery()` with trigger and round at each recovery event

## 5. Tests

- [ ] 5.1 Create `core/test/evidence-bundle.test.ts` with unit tests covering:
  - `createBundle` — file written with correct initial shape; `schemaVersion: 1`; `finalState: null`
  - `recordStage` — stage entry is created on first call; `exitedAt` and `outcome` are updated on second call for same stage
  - `recordCommand` — command appended to correct stage entry
  - `recordReview` — review appended to `reviews` array; sensitive values absent
  - `recordOverride` — override appended
  - `recordRecovery` — recovery appended
  - `finalizeBundle` — `finalState` and `finalizedAt` set; `finalState: null` before finalization
  - `readBundle` — returns `null` when file absent; returns parsed object when present
  - `printSummary` — output contains stage names, verdicts, and final state (snapshot test or string-contains assertions)
  - sensitive-value exclusion — `CommandRecord` has no field that could carry a raw env value; stdout capped at 500 chars
- [ ] 5.2 Add an integration-level test in `core/test/pipeline.test.ts` asserting that a full mock dispatch (planning → ready-to-deploy path) results in a bundle file with `finalState: "ready-to-deploy"` and at least one stage entry

## 6. Validation

- [ ] 6.1 Run `npm run ci` from root and confirm all tests pass and the mirror is in sync
- [ ] 6.2 Run `openspec validate evidence-bundle` and confirm it passes with no structural errors
- [ ] 6.3 Run a local pipeline invocation on a test issue and confirm: bundle file created, `--summary` output is human-readable, PR/issue receives the path comment
