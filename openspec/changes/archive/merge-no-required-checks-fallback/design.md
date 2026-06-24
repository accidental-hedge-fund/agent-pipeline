## Context

`core/scripts/stages/merge.ts` gates a squash-merge on three sequential checks: (1) mergeability, (2) required status checks, (3) linked issue at `pipeline:ready-to-deploy`. The required-checks gate calls `gh pr checks <pr> --required --json name,bucket`. When the base branch has no branch-protection required checks, `gh` exits non-zero with the message "no required checks reported on the '<branch>' branch" — the handler treats this as a fatal subprocess error and aborts before reaching the issue-stage gate.

## Goals / Non-Goals

**Goals:**
- Distinguish "no required checks configured" (empty set, benign) from "required checks configured but failing" (blocking).
- When no required checks are configured, substitute a fallback safety check that gives equivalent assurance: all observable checks green + mergeability confirmed.
- Keep the `MergeDeps` injection seam pattern intact so the new path is fully unit-testable.

**Non-Goals:**
- Changing the merge flow for repos that do have required checks.
- Adding configuration knobs — the fallback is automatic and unconditional.
- Changing the mergeability or issue-stage gates.

## Decisions

### D1 — Detect the empty-set case by exit message, not exit code

**Decision:** Inspect the `gh` stderr output for the canonical "no required checks reported" substring when the required-checks call exits non-zero. If that substring is present, treat it as the empty-set case; any other non-zero exit is still a hard error.

**Rationale:** `gh` exits non-zero for both "no required checks" and genuine `gh` failures (network error, auth error, bad PR number). Distinguishing by message is the only reliable signal. The message text is stable in `gh` and matches the exact output observed in production.

**Alternative considered:** Treat any non-zero exit as "no required checks". Rejected: it would silently swallow real `gh` errors (e.g., auth failure) and allow merges when the check call itself failed.

### D2 — Fallback calls `gh pr checks <pr>` (without `--required`) and inspects buckets

**Decision:** In the fallback path, call `gh pr checks <pr> --json name,bucket` (no `--required` flag) and block if any check has bucket `fail`, `pending`, or `cancel`. Only `pass` and `skipping` are non-blocking.

**Rationale:** This mirrors exactly what the required-checks gate verifies, but applied to the full observable check set. It is the safest practical substitute for branch protection when branch protection is absent. Matching the same `name,bucket` shape means the same parsing logic applies.

**Alternative considered:** Skip the fallback check entirely (merge on mergeability alone). Rejected: `MERGEABLE`/`CLEAN` does not guarantee CI passed; a red check could be present. The pipeline label alone is also insufficient — the label may have been set before a new push.

### D3 — `MergeDeps` gains `ghPrChecksAll` as a new injectable

**Decision:** Add `ghPrChecksAll(prNumber): Promise<CheckResult[]>` to `MergeDeps` alongside the existing `ghPrChecksRequired`. The production default shells out to `gh pr checks <pr> --json name,bucket`; test deps return fixtures.

**Rationale:** Consistent with the existing pattern where every I/O call is injectable. Keeps the fallback path 100% unit-testable without a subprocess and without special-casing.

**Alternative considered:** Reuse `ghPrChecksRequired` with a `required` boolean parameter. Rejected: changes the existing seam signature and forces updates to all existing call sites and test fixtures.

### D4 — Gate order: fallback check runs before the issue-stage gate

**Decision:** The fallback path performs both the non-required checks check AND the mergeability re-check (already done in gate 1) before reaching the issue-stage gate. The issue-stage gate order is unchanged.

**Rationale:** Fail-fast on observable signals. If non-required checks are red, there is no need to inspect the issue stage.

## Risks / Trade-offs

- **False "no required checks" message from `gh`** — if `gh` ever changes this message text, the detection silently falls through to the hard-fail path (safe failure mode: blocks merge rather than allowing it). Document the detection string in a comment.
- **Fallback blocks on any pending check** — a slow optional check (e.g., a linter that takes 10 minutes) will block the merge until it completes. This is intentional: absent branch protection, the fallback is conservative.
- **Repos with partial branch protection** — if a repo has some required checks configured but the `--required` call still fails for an unrelated reason, D1's message-based detection prevents false entry into the fallback path. Only the exact empty-set message triggers the fallback.

## Open Questions

- None. The exact `gh` error message is confirmed from production logs in the issue evidence. The `name,bucket` JSON shape is confirmed from `gh pr checks --json` output observed in CI.
