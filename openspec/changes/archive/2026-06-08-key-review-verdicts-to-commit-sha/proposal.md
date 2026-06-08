## Why

Review verdicts are currently stored without binding them to the commit they evaluated, so an approval can remain valid even after new commits land that change the diff. This means an item can advance through the pipeline on a stale approval that no longer reflects the current code.

## What Changes

- Every recorded review verdict gains a `commitSha` field identifying the exact HEAD it evaluated.
- Before trusting a prior verdict at any gate transition, the pipeline checks whether HEAD still matches the recorded SHA. If HEAD has advanced, the verdict is discarded and review is re-run.
- Review comments posted to the PR/issue include the short SHA so it is visible which commit each verdict covers.
- No behavior changes when HEAD does not move between the review stage and the next gate check.

## Capabilities

### New Capabilities

- `review-sha-gating`: Bind review verdicts to a commit SHA at record time; invalidate and re-run review when HEAD has moved past the recorded SHA before the next pipeline gate.

### Modified Capabilities

- `verdict-normalization`: The verdict record shape gains a required `commitSha` field; existing normalization and retry logic is otherwise unchanged.

## Impact

- **Pipeline review stage** — verdict recording adds `commitSha` capture.
- **Gate transition logic** — every gate that reads a prior review verdict must now compare the stored SHA against current HEAD before accepting the verdict.
- **Review comment template** — comments must surface the short SHA.
- **Verdict normalization spec** — record shape change (additive, no breaking behavior change for existing fields).
- **Tests** — new scenarios for SHA mismatch detection and re-review trigger; existing tests unaffected when SHA matches.
