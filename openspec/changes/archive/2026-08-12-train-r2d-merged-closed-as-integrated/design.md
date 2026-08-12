## Context

See `proposal.md` for motivation. Today `runTrain` merge mode has an early "already integrated" path that depends on `TrainDeps.getPrForIssue`, which is wired to the open-only `getPrForIssue` helper. After a PR merges, that lookup returns `null`. If the issue still carries `pipeline:ready-to-deploy` (common when merge does not strip the stage label) and/or the issue is closed, the train skips advance, then hard-stops in the merge wave with `ready-to-deploy but has no linked open PR`.

Existing infrastructure already solves the discovery half for reconciliation (`getPrForIssueAnyState` via issue timeline; used by loop reconcile and ship-adapter). Train does not use it yet.

## Goals / Non-Goals

**Goals:**

- Make merge-mode reconciliation find linked PRs in any state so finished work is classified `already-integrated`.
- Keep fail-closed behavior for still-open R2D issues that truly need a mergeable open PR.
- Prefer the smallest change in `train.ts` + tests; reuse existing gh helpers.

**Non-Goals:**

- Auto-merging without an open PR.
- Changing advance-only train (no `--merge`) beyond consistent already-done handling if it shares the same path.
- Adding repository `auto_merge` or a merge stage on advance.
- Mandatory label mutation (clearing stale R2D on close/merge) as a correctness dependency — optional follow-up hygiene only.
- Expanding milestone issue listing policy beyond what train needs for explicit `--issues` lists (closed issues can appear when operators pass them explicitly or when a selector includes them).

## Decisions

### 1. Any-state PR resolution for integration reconciliation

**Choice:** Add a train dependency seam that can resolve a linked PR across open/closed/merged (e.g. `getPrForIssueAnyState` in real deps; injectable in tests). Use it for the early already-integrated check and for the merge-wave "no open PR" branch before failing.

**Why:** Open-only lookup is the root cause. Reusing the timeline-based helper avoids inventing a second discovery path and matches #511 reconciliation.

**Alternatives considered:**

- Infer "done" from `issue.state === "closed"` alone → rejects: closed without a merged PR (wontfix, duplicate close) must not count as integrated.
- Scan `gh pr list --state all` repo-wide → rejected previously (#511); timeline is scoped and complete.
- Only skip when closed AND R2D without looking up PR → weaker proof; miss open-issue + merged-PR + stale R2D.

### 2. Classification order in merge mode

**Choice:** For each item, before requiring an open PR to merge:

1. Resolve linked PR (any state preferred; open PR still wins for active merge).
2. If PR is merged and merge-result OID is contained in fetched base → `already-integrated`, continue.
3. If PR is merged but containment cannot be proven → stop with a containment/observe blocker (same class as today), do not claim "no linked open PR".
4. If no open PR and issue is closed, and a linked merged PR exists but merge OID is unavailable → still treat as already-integrated when observe reports merged (document: prefer OID + containment when present; closed+merged without OID is acceptable skip only if observe proves merged — implementers prove with tests; do not invent a merge).
5. If issue is open (merge-eligible), stage is R2D, and no open PR → fail with the existing blocker class.
6. If open PR exists → merge as today.

**Rationale:** Matches operator intent on ship trains: finished work is noise; unfinished R2D without a PR is a real error.

**Containment when OID present:** Keep the same `fetchBase` + `isAncestor` proof as the existing already-integrated path. When OID is present and not contained, fail closed (do not skip).

### 3. Label hygiene is not required for correctness

**Choice:** Train ignores stale R2D on finished items by classification, not by clearing labels. Optional future work: merge path or post-integrate hook clears R2D; out of this change unless trivial and already gated.

**Why:** Train correctness must not depend on mutating issue labels mid-train; side effects expand review surface.

### 4. Advance-only train

**Choice:** No behavioral change required for non-merge train except: if shared helpers change, keep non-merge path recording `ready-to-deploy` for open unfinished work. Closed+merged items on a non-merge train may still report R2D/skip consistently; do not start merging.

## Risks / Trade-offs

- **[Risk] Wrong PR selected from timeline (stale closed unmerged PR)** → Mitigation: prefer merged observation; if multiple candidates ever appear, prefer merged with merge commit / same selection rules as `getPrForIssueAnyState` / timeline picker already used elsewhere; unit-test the train classification against dep fakes.
- **[Risk] Closed issue without any PR counted as integrated** → Mitigation: require a linked merged PR (or open PR path); closed alone is not enough for `already-integrated`.
- **[Risk] Extra GraphQL timeline cost per item** → Mitigation: only on merge-mode reconciliation when open PR is null or already-integrated check runs; single-issue timeline is bounded.
- **[Risk] Message change breaks supervisors parsing the exact blocker string** → Mitigation: keep the existing string for the open/no-PR fail path; do not reuse it for finished items.

## Migration Plan

- Ship as a normal PR on the train path; no data migration.
- Rollback: revert the change; ships that hit stale R2D closed issues fail as before.

## Open Questions

- None that block specs or tasks. Optional label-clear hygiene is deferred.
