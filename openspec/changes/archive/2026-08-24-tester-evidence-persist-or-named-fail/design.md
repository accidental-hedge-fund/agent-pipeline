## Context

See `proposal.md` for why. Current law and code:

- Living `tester-evidence` already requires one producer run before `fail_closed` withhold, then load-only re-acquire. Only a written SHA-matched artifact is current. That law ran on #1048. Regeneration ran. The file was still absent.
- Living `test-build-gate` already requires a `TesterEvidence` record after a trusted command exit 0 when a run directory is present. The write was skipped.
- `core/scripts/testgate.ts` `recordEvidence` returns without writing when (1) HEAD is not a 40-char pin, or (2) a trusted-surface decision exists and the verifier fingerprint is unusable (`outcome: blocked`). The #1048 run hit (2): `trusted-surface.json` `blocked` / `missing_base_sha` / all-zero `candidate_sha`, `triggering_paths` `.github/pipeline.yml`. Suite command `npm run ci` exit 0 (~131s).
- `loadOrRegenerateTesterEvidenceForReview` swallows producer throw as non-fatal, then re-loads. Missing file → generic reason `No Tester suite evidence file for this run (missing tester-evidence.json).` → `withholdInvoke: true`.
- Review-routing uses that withhold as harness-failure (`tester-evidence-gate`). Train: `run_fatal; workflow-engine-defect`. `recover-parked` requires a HEAD-bound residual review artifact and refused.

Living `evidence-subject` already forbids a fabricated readiness subject on blocked trusted-surface. It does **not** say skip the Tester family artifact.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is #1048 / PR #1222 after #1224. The class is: a successful Tester producer (test-gate exit 0) followed by generic missing-file `fail_closed` withhold, so review never runs and recover-parked cannot clear a non-review residual. A review-routing-only skip of #1048, or a one-off persist for `.github/pipeline.yml` PRs, is a mole.
2. **Shared surfaces.** Persist lives in the test-gate producer (`recordEvidence`). Named withhold lives in Tester acquisition (`loadOrRegenerate` / load-only re-acquire). Recover-parked re-enters same-issue advance for a named persist/acquire withhold with no review residual. No new blocker class, no second recoverer, no `on_missing` default change.
3. **Next identical fault.** The next review-1 whose producer exits 0 while trusted-surface is blocked uses the same persist/acquire path. The unit tests fail if withhold stays true solely because the file is missing after recorded exit 0, or if `missing_base_sha` / all-zero SHA collapses into the generic missing-file string.

## Goals / Non-Goals

**Goals:**

- After a producer that recorded test-gate exit 0, persist SHA-matched `tester-evidence.json` for the real candidate HEAD.
- Blocked trusted-surface / unusable verifier pin omits fabricated `evidence_subject`; it does not skip the suite write.
- SHA-matched suite evidence without `evidence_subject` is current for review acquisition and unusable as a readiness-pass subject.
- If persist still cannot happen, withhold names a machine-readable persist/acquire code. Generic missing-file string is forbidden on that path.
- `recover-parked` retries named persist/acquire withholds that have no review residual, bounded by candidate SHA and one spent-fingerprint pass.
- Tests inject I/O and bite on the #1048 shape.

**Non-Goals:**

- Changing default `on_missing` to `fail_open`.
- Inventing a readiness subject or verifier fingerprint on blocked trusted-surface.
- Fully repairing every `missing_base_sha` / all-zero SHA trusted-surface computation (named diagnostic + persist the suite record is this class). A follow-up MAY pin trusted-surface to the real HEAD and base SHA; this change MUST NOT depend on that to unblock review.
- Auto-overriding HIGH/CRITICAL/security.
- Adding a new `BlockerKind` or stage-diagnostic reason code. Keep `harness-failure` for the withhold Outcome.
- 300-file `getPrDiff` (#1223). Splitting #1048. Tugboat/Buzz. Merge inside advance/loop.

## Decisions

### 1. Persist the suite record even when subject emission fail-closes (primary)

**Choice:** After a required test-gate command exits 0 and HEAD is a full 40-char SHA, write `tester-evidence.json` with suite `overall_status: "passed"` (or the recorded non-pass class). If trusted-surface is blocked, omit `evidence_subject` (no fabricated verifier pin). Do not `return` before `writeTesterEvidence` solely because `resolveVerifierFingerprint` is null.

**Why:** Review needs SHA-matched suite evidence, not a readiness subject. Deploy-ready / readiness already fail-closed on blocked trusted-surface. Skipping the family artifact turns a named trusted-surface block into a generic missing-file park that recover-parked cannot see. A successful persist in the same invocation is how review-1 continues; named fail is only the fallback.

**Alternatives considered:**

- Keep skip-write, only rename the withhold → rejected as primary path. Review still does not run in the same invocation. Train still STOPs unless recover-parked is expanded. Living `test-build-gate` already requires the write after exit 0.
- Invent an engine-only verifier fingerprint so subject can be emitted on blocked TS → rejected. Violates living `evidence-subject`.
- Mark `overall_status: unavailable` because TS is blocked even though CI exited 0 → rejected. That lies about the suite. Suite status is command authority.

### 2. Artifact SHA is worktree HEAD, never trusted-surface `candidate_sha`

**Choice:** `recordEvidence` pins `TesterEvidence.candidate_sha` from the gate's worktree HEAD (`deps.gitHead(wtPath)`), then `normalizeCandidateSha` (full 40-hex). It SHALL NOT copy `trusted-surface.json`'s `candidate_sha` (including the all-zero sentinel from #1048). Unpinnable HEAD still MUST NOT write a fake SHA.

**Why:** Review acquisition matches the artifact to the candidate under review. The #1048 trusted-surface decision SHA was zeros; using it would make a written file stale against the real HEAD (`c7fe8128ffff…`). Existing `normalizeCandidateSha` in `core/scripts/tester-evidence.ts` is the pin function.

### 3. Suite evidence without `evidence_subject` is review-current, not a readiness pass

**Choice:** SHA-matched `TesterEvidence` that omits `evidence_subject` is valid suite evidence for review acquisition. `loadTesterEvidenceForReviewSync` already classifies that path `current` with `subject_outcome: "legacy_unbound"` and `withholdInvoke: false` when `candidate_sha` matches. Keep that. Do not invent a new acquisition class. Readiness / deploy-ready consumers still treat a missing or unusable subject as non-current and SHALL NOT treat this record as a readiness-pass subject.

**Why:** Living tester-evidence already allows `legacy_unbound` SHA fallback. Newly produced records may omit the subject when subject emission fail-closes; they are not only historical. Review needs the suite row. Readiness still fail-closes on blocked trusted-surface.

### 4. Typed producer observation, not logs or `summary.json`

**Choice:** Extend `TestGateResult` with a typed producer observation:

```ts
recorded_required_exit_0: boolean
required_command_exit_code: number | null
persist: {
  ok: boolean
  candidate_sha: string | null  // 40-hex or null
  code?: TesterPersistAcquireCode
  error?: string                // bounded, redacted original write error
}
```

Change `loadOrRegenerateTesterEvidenceForReview`'s regenerate callback from `() => Promise<void>` to `() => Promise<TesterProducerObservation>`. Review-routing and pre-merge SHA-gate pass through `runTestGate`'s typed result. Acquisition MUST NOT infer exit 0 from `summary.json`, `terminal.log`, or free-form stderr.

**Why:** Plan review required an explicit typed result from `runTestGate` through regeneration/acquisition. The current callback is `Promise<void>` and discards `TestGateResult`. Inferring from logs is the class of bug this issue is about.

**Pattern:** `TestGateResult` in `core/scripts/testgate.ts` already carries typed gate outcomes (`passed`, `toolingFailure`, `dirtyWorktree`) instead of parsing command output. Extend that object; do not add a parallel channel.

### 5. Named withhold is the fallback; the code is durable and machine-readable

**Choice:** If persist still cannot happen after recorded exit 0 (atomic write failure, unpinnable HEAD, or re-acquire still missing), re-acquire MUST NOT use the generic missing-file string. Set a closed `TesterPersistAcquireCode` on `TesterAcquisitionResult` (`persist_write_failed` | `unpinnable_candidate_sha` | `producer_exit_0_artifact_missing`). Persist that code in the run directory as `tester-persist-acquire.json` and as an HTML comment marker on the blocked comment (`<!-- pipeline-tester-persist-acquire: v1 {…} -->`), matching `RECOVER_PARKED_SPENT_MARKER` in `core/scripts/recover-parked.ts`. `withholdInvoke` stays true. Same-argv retry / recover-parked consume the code, not display prose.

Do **not** add a new `BlockerKind`. Keep `harness-failure` for the withhold Outcome (`testerEvidenceWithholdResult` + existing #882 path). Display text may include trusted-surface `blocked` / `missing_base_sha` as context; the machine code is the persist/acquire enum.

**Why:** AC1 is persist **or** named fail. Persist is how review-1 continues in-process (unblocks v1.40.0 train). Named fail is how a true persist hole stays diagnosable. A display-string-only change is not durable: recover-parked would have to parse prose.

**Alternatives considered:**

- Always withhold as missing when the file is absent, regardless of producer result → this is the bug.
- Fail-open after producer success even without a file → rejected. Invents a path that implies the suite is reviewable without evidence.
- New `BlockerKind` → rejected as extra closed-enum cascade (recipes, stage-diagnostic map). Persist-first usually eliminates the park. The HTML marker is the recover-parked signal.

### 6. Atomic write failure after exit 0 never manufactures a passed artifact

**Choice:** `writeTesterEvidence` already returns `{ ok: false, error }` and does not claim stored success (`core/scripts/tester-evidence.ts`). After recorded exit 0, `recordEvidence` MUST surface that result on `TestGateResult.persist` (`ok: false`, `code: persist_write_failed`, bounded redacted `error`). It MUST NOT write a substitute passed artifact. Acquisition then withholds with that named code.

**Why:** Plan review required an explicit persistence-error path. Today's `recordEvidence` swallows write errors as `console.warn` and returns void, so acquisition only sees generic missing.

### 7. recover-parked retries named persist/acquire, bounded by SHA and one spent pass

**Choice:** Before the "no HEAD-bound residual review artifact" `still-parked` return, if the causal park carries a `pipeline-tester-persist-acquire` marker with `recorded_required_exit_0: true` and a named code, and there is no HEAD-bound review finding, re-enter `pipeline single` via existing `reenterAdvanceAfterRecoverParked`. Fingerprint is `(issue, stage, persist_acquire_code, candidate_sha)`. Reuse `isFingerprintSpent` / spent-comment ledger. One supervisor pass per fingerprint: a persistent write failure at the same SHA becomes `already-spent` and stays parked. A new candidate SHA is a new fingerprint. Keep the existing refuse for parks that are generic missing without a producer-success record, and for HIGH/CRITICAL/security residuals. Do not invent a review residual. Do not add a second recoverer.

**Why:** #1048 recover-parked refused because review never ran. After persist-in-process, that park should not occur. Named-fail fallback still needs a controller recipe: retry review once per SHA, do not loop forever, do not invent DNR.

**Alternatives considered:**

- Teach recover-parked to override a synthetic finding → rejected. There is no review finding.
- Leave recover-parked unchanged because persist-in-process is enough → incomplete class: named-fail fallback would still be a dead park.
- Unbounded re-entry on every recover-parked invoke → rejected. Persistent write failure would loop.

### 8. Do not fix trusted-surface `missing_base_sha` as a prerequisite

**Choice:** This change does not require trusted-surface to resolve base SHA or to stop writing all-zero `candidate_sha` sentinels. Review unblocks by persisting suite evidence (or naming the persist/acquire code). A later issue MAY pin trusted-surface evaluation to the real HEAD and merge-base.

**Why:** Class is persist/acquire after successful producer. Coupling review to a full trusted-surface repair expands scope and still needs persist-or-named-fail if TS remains blocked for a real policy reason.

### 9. Implementation order is persist, then named fail, then recover

**Choice:** Ship in one PR, but implement and prove in this order: (1) successful-gate artifact persistence for the #1048 shape; (2) typed observation + named post-producer acquisition failure only as fallback; (3) recover-parked consumption of the durable code, SHA-bounded. A green persist test on blocked trusted-surface should normally eliminate the parked state.

## Risks / Trade-offs

- **[Risk] Suite evidence without `evidence_subject` looks like a readiness pass.** → Mitigation: omit fabricated subject; `subject_outcome: legacy_unbound`; readiness consumers already treat missing/unusable subject as non-current; deploy-ready still fail-closes on blocked trusted-surface. Tests assert review-current + no fabricated verifier-fingerprint match.
- **[Risk] recover-parked re-entry loops on a persist hole that never writes.** → Mitigation: spent fingerprint includes candidate SHA + persist code; one pass per fingerprint; generic missing without producer success does not take this path.
- **[Risk] Existing "writes nothing still withholds" test is over-broad.** → Mitigation: keep it for callbacks that do not record exit 0; add the exit-0 persist-or-named-fail test that fails on generic missing.
- **[Risk] Inferring producer success from summary.json.** → Mitigation: typed `TesterProducerObservation` from `runTestGate`; tests inject that object, not log text.

## Migration Plan

- Ship in one PR with `core/` + regenerated `plugin/`. No config key. No artifact schema bump required (schema_version 1 records without subject remain `legacy_unbound` for review SHA fallback).
- Rollback is revert. In-flight runs with missing files retry persist-or-named-fail on next review-1.
- No data backfill.

## Open Questions

None. Persist-after-exit-0 is primary. Named-fail fallback uses a durable code. Trusted-surface base-SHA repair is out of scope.
