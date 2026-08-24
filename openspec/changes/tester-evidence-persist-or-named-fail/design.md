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
- If persist still cannot happen, withhold names the persist/acquire cause. Generic missing-file string is forbidden on that path.
- `recover-parked` retries named persist/acquire withholds that have no review residual.
- Tests inject I/O and bite on the #1048 shape.

**Non-Goals:**

- Changing default `on_missing` to `fail_open`.
- Inventing a readiness subject or verifier fingerprint on blocked trusted-surface.
- Fully repairing every `missing_base_sha` / all-zero SHA trusted-surface computation (named diagnostic + persist the suite record is this class). A follow-up MAY pin trusted-surface to the real HEAD and base SHA; this change MUST NOT depend on that to unblock review.
- Auto-overriding HIGH/CRITICAL/security.
- 300-file `getPrDiff` (#1223). Splitting #1048. Tugboat/Buzz. Merge inside advance/loop.

## Decisions

### 1. Persist the suite record even when subject emission fail-closes

**Choice:** After a required test-gate command exits 0 and HEAD is a full 40-char SHA, write `tester-evidence.json` with suite `overall_status: "passed"` (or the recorded non-pass class). If trusted-surface is blocked, omit `evidence_subject` (legacy_unbound / no fabricated verifier pin). Do not `return` before `writeTesterEvidence` solely because `resolveVerifierFingerprint` is null.

**Why:** Review needs SHA-matched suite evidence, not a readiness subject. Deploy-ready / readiness already fail-closed on blocked trusted-surface. Skipping the family artifact turns a named trusted-surface block into a generic missing-file park that recover-parked cannot see.

**Alternatives considered:**

- Keep skip-write, only rename the withhold → rejected as primary path. Review still does not run in the same invocation. Train still STOPs unless recover-parked is expanded. Living `test-build-gate` already requires the write after exit 0.
- Invent an engine-only verifier fingerprint so subject can be emitted on blocked TS → rejected. Violates living `evidence-subject`.
- Mark `overall_status: unavailable` because TS is blocked even though CI exited 0 → rejected. That lies about the suite. Suite status is command authority.

### 2. Named withhold is the fallback, not the happy path

**Choice:** If persist still cannot happen after recorded exit 0 (I/O failure, unpinnable HEAD), re-acquire MUST NOT use the generic missing-file string. The reason MUST name the persist/acquire cause (`trusted-surface blocked: missing_base_sha`, persist write failure, invalid candidate SHA). `withholdInvoke` MAY stay true in that fallback. Same-argv retry / recover-parked can act on the name.

**Why:** AC1 is persist **or** named fail. Persist is how review-1 continues in-process (unblocks v1.40.0 train). Named fail is how a true persist hole stays diagnosable.

**Alternatives considered:**

- Always withhold as missing when the file is absent, regardless of producer result → this is the bug.
- Fail-open after producer success even without a file → rejected. Invents a path that implies the suite is reviewable without evidence.

### 3. Producer callback contract for tests

**Choice:** The biting unit test does not need a live `runTestGate`. It injects a regenerate callback that records test-gate exit 0 (in-memory command row / sidecar) and either writes the artifact or leaves a blocked `trusted-surface.json`. Assert: after `loadOrRegenerate`, either `withholdInvoke === false` with SHA-matched artifact, or withhold reason is not the generic missing-file string. A second test feeds `trusted-surface.json` `missing_base_sha` + all-zero SHA and fails on generic collapse.

Existing test "regenerate that writes nothing still withholds" remains valid **only** when the callback does not record test-gate exit 0.

**Why:** Issue AC3/AC4. Inject I/O. No live network/git/subprocess.

### 4. recover-parked retries named persist/acquire, not missing-review DNR

**Choice:** If the causal park reason is a named Tester persist/acquire withhold and there is no HEAD-bound review finding, re-enter `pipeline single`. Do not return `still-parked` solely for "no HEAD-bound residual review artifact." Keep the existing refuse for parks that are generic missing without a producer-success record, and for HIGH/CRITICAL/security residuals.

**Why:** #1048 recover-parked refused because review never ran. After persist-in-process, that park should not occur. Named-fail fallback still needs a controller recipe: retry review, do not invent DNR.

**Alternatives considered:**

- Teach recover-parked to override a synthetic finding → rejected. There is no review finding.
- Leave recover-parked unchanged because persist-in-process is enough → incomplete class: named-fail fallback would still be a dead park.

### 5. Do not fix trusted-surface `missing_base_sha` as a prerequisite

**Choice:** This change does not require trusted-surface to resolve base SHA or to stop writing all-zero `candidate_sha` sentinels. Review unblocks by persisting suite evidence (or naming the block). A later issue MAY pin trusted-surface evaluation to the real HEAD and merge-base.

**Why:** Class is persist/acquire after successful producer. Coupling review to a full trusted-surface repair expands scope and still needs persist-or-named-fail if TS remains blocked for a real policy reason.

## Risks / Trade-offs

- **[Risk] Suite evidence without `evidence_subject` looks like a readiness pass.** → Mitigation: omit fabricated subject; readiness consumers already treat missing/unusable subject as non-current; deploy-ready still fail-closes on blocked trusted-surface. Tests assert no fabricated verifier-fingerprint match.
- **[Risk] recover-parked re-entry loops on a persist hole that never writes.** → Mitigation: named reason stays; generic missing without producer success does not take this path; existing fingerprint / still-parked rules bound retries. Do not add a second recoverer.
- **[Risk] Existing "writes nothing still withholds" test is over-broad.** → Mitigation: keep it for callbacks that do not record exit 0; add the exit-0 persist-or-named-fail test that fails on generic missing.

## Migration Plan

- Ship in one PR with `core/` + regenerated `plugin/`. No config key. No artifact schema bump required (schema_version 1 records without subject remain `legacy_unbound`).
- Rollback is revert. In-flight runs with missing files retry persist-or-named-fail on next review-1.
- No data backfill.

## Open Questions

None. Persist-after-exit-0 vs named-fail fallback is decided. Trusted-surface base-SHA repair is out of scope.
