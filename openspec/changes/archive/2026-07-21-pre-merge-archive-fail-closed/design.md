# Design — pre-merge OpenSpec archive fail-closed (#467)

## Context

`advancePreMerge` (core/scripts/stages/pre_merge.ts) runs:
review-SHA gate → **step 0: `maybeArchiveOpenspec`** → conflict pre-check → CI gate →
delta review → mergeability → advance. `maybeArchiveOpenspec` returns:

- `null` → "nothing to do", pre-merge continues;
- `waiting` → archive committed+pushed, CI re-runs;
- `blocked` → surfaced to the operator.

Today four distinct conditions collapse into `null`:

| # | Condition | Code |
|---|-----------|------|
| 1 | worktree not found on disk | `if (!wt \|\| !isActiveFn(...)) return null` |
| 2 | OpenSpec not active for the worktree | same line |
| 3 | candidate probe `git diff --name-only origin/<base>...HEAD` fails (`ignoreFailure: true`) → empty stdout | `candidates.length === 0 → return null` |
| 4 | genuinely no active change directories | same line |

Only (4) is a legitimate skip; (2) is legitimate but should still be observable. (1) and (3)
are unknown-state cases silently treated as success. Whichever of these fired for #464 (the
run artifacts do not distinguish them — that is itself the bug), the outcome was identical:
an active change shipped to `main`.

## Decisions

### D1 — Guard the outcome, not the code path

The primary fix is a **head-side postcondition**, not a patch to the specific skip branch that
bit #464. Before pre-merge advances, compute from the PR file list:

```
activeIds  = { id : "openspec/changes/<id>/…" ∈ files, id ≠ "archive" }
archivedIds = { id : "openspec/changes/archive/<id>/…" ∈ files }
remaining = activeIds \ archivedIds   // non-empty ⇒ block
```

Rationale: this is a pure function of data the stage already fetches (`getPrDiff` →
`diffFilePaths`, the same seam the delta review uses at pre_merge.ts:1324). It is
worktree-independent, so it holds identically on the first run, on an override-resumed run in
a fresh process, and after a worktree removal — which is precisely the invariant #467 asks
for. It also cannot regress into a false "already archived" pass, because the archived
counterpart must appear in the *same* diff.

*Rejected:* asserting via the local worktree filesystem (`listChangeDirs`). That reintroduces
the worktree dependency that likely caused the bug.

*Rejected:* `gh pr view N --json files`. It works (verified: `.files[].path` returns the PR's
changed paths) but adds a second, paginated gh shape for data the stage already has.

### D2 — Convert unknown state into a block, not a skip

- Candidate probe exit ≠ 0 → block (`openspec-invalid`) naming the git error. Never infer
  "no candidates" from a failed command.
- Worktree missing while OpenSpec is active **and** the PR file list contains
  `openspec/changes/<id>/` → block (`needs-human`, worktree-missing recovery recipe already
  exists). Worktree missing with no OpenSpec paths in the PR → unchanged (`null`).
- OpenSpec inactive → still `null`, but recorded as a skip with reason `openspec-inactive`.

D2 makes the failure loud at its origin; D1 makes it impossible to leak even if a new skip
path is added later. Both are kept: the guard alone would block with a less actionable
message.

### D3 — Reuse the head-side file list already fetched

The delta review already calls `getPrDiff` for the same PR head. The guard runs after the
archive step and before the advance, and uses the same seam
(`deps.getPrDiff` / `diffFilePaths`) so unit tests inject a plain string and do no network.

### D4 — Archive-failure surfacing stays as-is, with the CLI output verbatim

`openspec archive <id>` failing (e.g. `MODIFIED` header not present in the living spec) already
routes to `setBlocked(cfg, issue, "openspec archive <id> failed:\n<output>", "pre-merge",
"openspec-invalid")`. This change only pins that behavior with a regression test asserting the
CLI output appears verbatim in the blocker reason — so the operator sees the "header not
found" line and can add a `## RENAMED Requirements` block. Auto-generating that block is out
of scope (#467 "Out of scope").

### D5 — Observability

Emit one `stage_note`/run event per pre-merge invocation recording the archive decision:
`archived <ids>` | `skipped: <no-candidates|openspec-inactive>` | `blocked: <reason>`. Without
this, a future silent skip is again undiagnosable from `events.jsonl` (as it was for #464).

## Risks

- **False block on a repo that legitimately carries a long-lived active change on the PR
  branch.** Mitigation: the guard only considers ids the PR itself introduces (present in its
  own file list), which is the same candidate rule the archive step uses; a change that exists
  on the base branch and is untouched by the PR is not in the diff.
- **Ordering.** The guard must run after `maybeArchiveOpenspec` returns `waiting` has been
  handled (that path returns early), so the guard never fires on the poll that just pushed the
  archive commit.
