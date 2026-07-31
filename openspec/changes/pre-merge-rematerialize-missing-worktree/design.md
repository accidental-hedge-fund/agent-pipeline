## Context

Several pre-merge/fix paths **require** a managed on-disk worktree:

| Path | Today when `getForIssue` / `getOnDiskForIssue` is null |
| --- | --- |
| `maybeArchiveOpenspec` | If PR tip still has active OpenSpec change(s) → `setBlocked(..., "needs-human")` with “worktree not found”; if no active change → skip |
| Pre-merge autofix closure | Returns `{ status: "error" }` with no rematerialize (~#729 residual re-entry) |
| Residual re-entry autofix | Calls that closure; error escalates residual blockers without a real fix attempt |
| Fix stage (write-in-tree) | Blocks `worktree-missing` immediately; recipe says re-run will not recreate |

Meanwhile:

- **Park-release** may legitimately delete clean managed worktrees when the remote tip / open PR remains recoverable.
- **`createWorktree`** already reconstructs from `origin/<pipeline/N-…>` or open-PR head SHA, and applies #622 reclaim safety (dirty / local-only refuse; no force-destroy of recoverable work).
- Escalating to a human solely to “restore the worktree” is a **factory defect** when the branch/PR head is still pushable (#626 archive, #729 residual autofix).

Related longer-horizon work: #760 (rematerialize disposition class), #759 (reconcile layer). This change is the **surgical** seam so archive/autofix stop first-hopping to needs-human.

## Goals / Non-Goals

**Goals:**

- Shared rematerialize seam for stages that require a managed worktree.
- Call sites in scope: OpenSpec archive, pre-merge autofix (including residual re-entry), fix rounds that write in-tree.
- Success → continue the stage; failure → typed block with recovery text; never silent-skip archive when active tip change remains.
- Preserve #622 reclaim safety (dirty / local-only / unverifiable).
- Durable run evidence of rematerialize attempt + result.
- Recipe text stays honest for residual failures after rematerialize is attempted.

**Non-Goals:**

- Full #759 attempt ledger / multi-mechanism marker retirement.
- Expanding residual autofix allowlist beyond #768 (`code-behind-spec`).
- Product fixes for #675 merge findings.
- Rematerializing for every stage that currently blocks on missing worktree (eval / visual / design_gate) unless sharing the seam is free and does not expand behavior claims — default scope is pre-merge + fix write paths named by the issue.
- Changing park-release delete policy itself.
- Auto-merge or any merge automation.

## Decisions

### Decision 1: Rematerialize via existing create path, not a parallel `git worktree add`

**Choice:** Implement rematerialize by calling `createWorktree` (or a thin `ensureManagedWorktree` wrapper that delegates to it) with the issue’s title/slug so startPoint resolution stays single-sourced (`origin/<branch>` when remote tip exists; else open-PR head fetch).

**Rationale:** Create already has mutex serialization, capacity gate, reclaim safety, dependency install bootstrap, managed marker stamp, and PR-head reconstruction. A second add path would re-implement #622 and drift.

**Rejected:** Inline `git worktree add` at each call site. **Rejected:** Asking the operator to run `git worktree add` while the engine can do the same safely.

### Decision 2: Trigger only when lookup is null — do not “heal” a present dirty tree by force recreate

**Choice:** Rematerialize only when on-disk / managed lookup returns no worktree for the issue. If a worktree **exists**, existing cleanliness / archive / fix guards apply; rematerialize does not replace them.

**Rationale:** Issue requires dirty-path checks only when an existing path is present (via create reclaim). Force-recreating over a present dirty tree would destroy operator/harness work and weaken #622.

### Decision 3: Call-site order — rematerialize before archive/autofix work, fail closed on failure

**Archive (`maybeArchiveOpenspec`):**

1. Lookup worktree.
2. If null and OpenSpec mode is not off and `prNumber` is defined: determine whether tip still has active change dirs (`listPrHeadChangeDirs` / existing tip membership).
3. If no active tip change → keep non-blocking skip (`null` / `no-candidates`).
4. If active tip change (or membership listing fails when archive may be required) → rematerialize first.
5. On rematerialize success → re-resolve worktree and continue archive as today.
6. On rematerialize failure → block with `worktree-creation-failed` or `worktree-missing` (typed), concrete reason naming the rematerialize error — **not** vague residual `needs-human` “restore the worktree”, and **not** skip archive while active change remains.

**Pre-merge autofix / residual re-entry:**

1. Before `performPreMergeAutoFix` (or inside the production autofix closure currently returning `{ status: "error" }` on null wt), rematerialize when lookup is null.
2. On success, run autofix with the new path.
3. On failure, return a typed autofix error / stage block that names rematerialize failure (not a silent product residual park that hides factory env failure).

**Fix stage write path:**

1. When fix would block solely for missing worktree, rematerialize once.
2. Success → continue fix; failure → existing `worktree-missing` / `worktree-creation-failed` with accurate recipe.

### Decision 4: Evidence — `gate_result` (or stage event) with explicit rematerialize gate id

**Choice:** Append a durable run event when rematerialize is attempted, e.g. `gate_result` with gate `worktree-rematerialize` (or stage-scoped reason prefix) and `result` pass/fail/skipped, plus a short reason string (error message or “already present”).

**Rationale:** Dogfood must prove the path fired (#626/#729 re-advance). Archive already records `openspec-archive` gate results; rematerialize should be separately visible so a later archive pass is not confused with “tree was always there”.

### Decision 5: Blocker kinds and recipe honesty

**Choice:**

- Prefer **`worktree-creation-failed`** when rematerialize was attempted and create/reclaim threw (auth, git add fail, capacity, dirty reclaim refuse).
- Prefer **`worktree-missing`** only when rematerialize cannot be attempted (e.g. no PR/branch identity to recreate from) or as documented fallback.
- Stop using bare **`needs-human`** for the #626 missing-worktree-with-active-change path.
- Update `BLOCKER_RECIPES["worktree-missing"]` and the test that forbids promising re-run recreation: for paths that now rematerialize, residual park text MUST describe rematerialize failure recovery (auth, push branch, free capacity, clean foreign dirty tree) rather than “re-run will never recreate”.

**Rejected:** New blocker kind unless existing kinds cannot express the failure without ambiguity — prefer existing enum values to avoid recipe/map churn.

### Decision 6: Injectable seam for unit tests

**Choice:** Expose rematerialize as an injectable dep on `AdvancePreMergeDeps` / fix deps (e.g. `ensureManagedWorktree` / `rematerializeWorktree` / reuse `createWorktree` dep), defaulting to the real create path. Unit tests inject success, failure, and “not called when already present” without network/git.

**Rationale:** Matches existing test style (`getForIssue`, `listPrHeadChangeDirs` fakes in `pre-merge-spec-consistency.test.ts` / `pre-merge-sha-gate.test.ts`).

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Rematerialize from stale remote while local-only work was park-released incorrectly | Park-release already refuses delete when local-only / no recoverability; rematerialize only starts from remote/PR head — do not weaken park-release |
| Create capacity full during rematerialize | Typed `worktree-capacity` / creation-failed; do not pretend archive can skip |
| Dirty foreign collision at managed path | #622 reclaim refuse; surface that error in block reason |
| Double install cost on rematerialize | Accept bootstrap cost; create already installs deps — correct over fast-wrong |
| Recipe test conflict (“must not claim re-run recreates”) | Update test + recipe together so honesty matches new call sites |
| Scope creep into eval/visual | Keep call-site list explicit in tasks; share helper only |

## Migration Plan

1. Spec + design land in this change (planning only).
2. Implementation: seam + call sites + tests + recipe update + `plugin/` mirror if `core/` changes.
3. Validate with unit fakes; then dogfood re-advance #626 / #729 after install.
4. Rollback: revert change; behavior returns to needs-human / bare error (no data migration).

## Open Questions

- Whether fix-stage rematerialize should share the exact same event gate id as pre-merge (prefer yes for dogfood grep).
- Whether capacity-blocked rematerialize should use `worktree-capacity` vs `worktree-creation-failed` (prefer existing capacity kind when the throw is capacity-typed).
