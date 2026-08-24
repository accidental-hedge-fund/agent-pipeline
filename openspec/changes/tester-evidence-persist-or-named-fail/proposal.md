## Why

v1.40.0 train STOPped on #1048 at review-1 after the deterministic tester producer ran `npm run ci` and exited 0, then wrote no `tester-evidence.json`. `fail_closed` withheld the reviewer with the generic missing-file string. Train classified `run_fatal; workflow-engine-defect`. `recover-parked` refused because there was no HEAD-bound residual review artifact. Review never ran. Serial ship could not start siblings. This is engine persist/acquire, not #1048's product scope.

## What Changes

- **Class law, not a #1048 mole.** After `loadOrRegenerateTesterEvidenceForReview` runs the producer and that producer records a test-gate command exit 0, the run directory SHALL contain a SHA-matched `tester-evidence.json` for the candidate HEAD, **or** review SHALL fail with a named persist/acquire reason other than `missing tester-evidence.json`.
- A successful suite command SHALL persist the Tester family artifact even when trusted-surface is `blocked` (`missing_base_sha`, all-zero `candidate_sha`). Readiness subject emission MAY stay fail-closed. The suite record SHALL NOT be omitted for that reason.
- `fail_closed` SHALL NOT collapse a present `trusted-surface.json` `repo_policy` `missing_base_sha` / all-zero `candidate_sha` into the generic missing-file withhold string.
- Named persist/acquire fail SHALL be recoverable by `recover-parked` or a later same-argv review retry. It SHALL NOT be a dead park whose only residual is "no HEAD-bound review finding."
- Unit tests inject I/O. They fail if withhold stays true solely because the file is missing after a producer that recorded test-gate exit 0, and if the trusted-surface blocked diagnostic is collapsed into the generic missing-file string.

**BREAKING:** none. `on_missing` default stays `fail_closed`. Review still does not invent a suite pass.

Non-goals: 300-file `getPrDiff` fallback (#1223, merged); splitting #1048 / deleting `plugin/`; changing default `on_missing` to `fail_open`; auto-overriding HIGH/CRITICAL; Tugboat/Buzz; deleting Tugboat.

## Acceptance criteria

- [ ] After `loadOrRegenerateTesterEvidenceForReview` runs the producer and that producer records test-gate command exit 0, the run directory contains a SHA-matched `tester-evidence.json` for the candidate HEAD, **or** review fails with a named reason other than `missing tester-evidence.json` (for example `trusted-surface blocked: missing_base_sha`) that `recover-parked` or a later same-argv retry can act on.
- [ ] A successful `npm run ci` producer does not leave no evidence file **and** then `fail_closed`-withhold as generic missing solely because `trusted-surface.json` has `repo_policy` `missing_base_sha` and all-zero `candidate_sha`.
- [ ] A unit test fails if the producer callback resolves after recording test-gate exit 0 and `withholdInvoke` is still true solely because `tester-evidence.json` is missing. Inject I/O; no live network, git, or subprocess.
- [ ] A unit test fails if `trusted-surface.json` `repo_policy` `missing_base_sha` with `candidate_sha` all zeros is collapsed into the generic missing-file withhold string with no distinct diagnostic.
- [ ] Living `tester-evidence` requires persist-or-named-fail after a successful producer. After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends Tester persist/acquire and recover-parked retry, not a new family. -->

### Modified Capabilities

- `tester-evidence`: After a successful producer, persist SHA-matched suite evidence or fail with a named persist/acquire reason. Generic missing-file withhold is forbidden when the producer recorded test-gate exit 0.
- `test-build-gate`: A trusted gate command that exits 0 still writes `TesterEvidence` when a run directory is available, even if trusted-surface is blocked and readiness subject emission is withheld.
- `review-layer`: Review-1 / review-2 / delta regenerate-then-reacquire still never invents a pass. After a successful producer they persist-or-named-fail instead of parking on generic missing.
- `evidence-subject`: Fail-closed readiness subject production (blocked trusted-surface, unusable verifier pin) SHALL NOT suppress the Tester family artifact write after a successful suite command.
- `supervisor-recover-parked`: A named Tester persist/acquire withhold with no review-finding residual is retryable engine work (re-enter same-issue advance). It is not a dead "no HEAD-bound residual review artifact" park.

## Impact

- **Producer:** `core/scripts/testgate.ts` `recordEvidence` currently returns without writing when trusted-surface is blocked or the candidate SHA is unpinnable. That skip is the #1048 hole after `npm run ci` exit 0.
- **Acquire/withhold:** `core/scripts/tester-evidence.ts` `loadOrRegenerateTesterEvidenceForReview` + `testerEvidenceWithholdResult`. Post-producer re-acquire still load-only. Withhold reason must name persist/acquire cause when the producer recorded exit 0.
- **Review callers:** `core/scripts/stages/review-routing.ts` and `pre-merge-sha-gate.ts` (same regenerate callback).
- **Recover:** `core/scripts/recover-parked.ts` currently still-parks when there is no HEAD-bound review residual. Named persist/acquire fail must re-enter review, not refuse as DNR/stale.
- **Tests:** `core/test/tester-evidence.test.ts` (and gate/recover tests as needed). Inject I/O. Existing "regenerate that writes nothing still withholds" stays valid only when the producer did **not** record test-gate exit 0.
- **Does not:** merge inside advance/loop; skip review; change `on_missing` default; invent a readiness subject on blocked trusted-surface; reverse papercut backlog policy.
- **Evidence (live, 2026-08-23):** run `1048-2026-08-23T21-19-18-604Z`. Producer `npm run ci` exit 0 (~131s), `pr_head_sha` `c7fe8128ffff…`, no `tester-evidence.json`. `trusted-surface.json` `outcome: blocked`, `repo_policy` `missing_base_sha`, `candidate_sha` all zeros, `triggering_paths` `.github/pipeline.yml`. Withhold: `No Tester suite evidence file for this run (missing tester-evidence.json)`. Train `ship-v1.40.0` `workflow-engine-defect` on #1048.
- **Class vs site:** the site is #1048 / PR #1222 after #1224 landed. The class is: successful tester producer then generic missing-file `fail_closed` park. The next large PR that touches `.github/pipeline.yml` uses the same persist/acquire path and does not need a new mole issue.
