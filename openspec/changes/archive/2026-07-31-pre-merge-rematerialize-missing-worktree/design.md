## Context

Several pre-merge/fix paths **require** a managed on-disk worktree:

| Path | Today when `getForIssue` / `getOnDiskForIssue` is null |
| --- | --- |
| `maybeArchiveOpenspec` | If PR tip still has active OpenSpec change(s) (or tip listing fails) → `setBlocked(..., "needs-human")` with “worktree not found”; if no active change → skip |
| Pre-merge autofix production closure | `if (!wt) return { status: "error" }` with no rematerialize (~#729 residual re-entry and normal delta autofix) |
| Residual re-entry autofix (`reuseBlockedBy`) | Calls the same `attemptPreMergeAutoFix` dep; bare `error` escalates residual blockers without a real fix attempt |
| Fix stage write-in-tree (`advanceFix`) | Blocks `worktree-missing` immediately; recipe says re-run will not recreate |

Meanwhile:

- **Park-release** may legitimately delete clean managed worktrees when the remote tip / open PR remains recoverable.
- **`createWorktree`** already reconstructs from `origin/<pipeline/N-…>` (verified `ls-remote` tip) or open-PR head SHA (`resolveOpenPrHeadForBranch` → `pull/N/head`), and applies #622 reclaim safety (dirty / local-only refuse; no force-destroy of recoverable work).
- Escalating to a human solely to “restore the worktree” is a **factory defect** when the branch/PR head is still pushable (#626 archive, #729 residual autofix).

Related longer-horizon work: #760 (rematerialize disposition class), #759 (reconcile layer). This change is the **surgical** seam so archive/autofix/fix stop first-hopping to needs-human.

## Goals / Non-Goals

**Goals:**

- One shared injectable `ensureManagedWorktree` seam with an explicit result contract.
- Call sites in scope (exhaustive): OpenSpec archive, normal pre-merge autofix, residual re-entry autofix, fix rounds that write in-tree.
- Success → continue the stage; failure → typed block with recovery text; never silent-skip archive when active tip change remains or tip membership is unknown.
- Preserve #622 reclaim safety (dirty / local-only / unverifiable).
- Verify recreated worktree `HEAD` equals the recoverable open-PR head SHA (or verified remote branch tip).
- Durable run evidence of rematerialize `pass` / `fail` / `skipped` whenever a run dir exists.
- Recipe text stays honest for residual failures after rematerialize is attempted.

**Non-Goals:**

- Full #759 attempt ledger / multi-mechanism marker retirement.
- Expanding residual autofix allowlist beyond #768 (`code-behind-spec`).
- Product fixes for #675 merge findings.
- Rematerializing for every stage that currently blocks on missing worktree (eval / visual / design_gate / shipcheck) — out of scope unless free; default is the four call sites above.
- Changing park-release delete policy itself.
- Auto-merge or any merge automation.

## Decisions

### Decision 1: One injected seam — `ensureManagedWorktree` — with a fixed result contract

**Choice:** Add a single helper (preferred location: `core/scripts/worktree.ts`, or a thin adjacent module re-exported for stages) with this result shape:

```ts
type EnsureManagedWorktreeResult =
  | {
      result: "pass";
      worktree: { path: string; slug: string; branch: string };
      reason: string; // short, non-sensitive (e.g. "recreated from origin/pipeline/N-…")
      blockerKind?: undefined;
    }
  | {
      result: "skipped";
      worktree: { path: string; slug: string; branch?: string };
      reason: string; // e.g. "already-present"
      blockerKind?: undefined;
    }
  | {
      result: "fail";
      worktree: null;
      reason: string; // names the rematerialize failure; bounded, non-sensitive
      blockerKind: "worktree-creation-failed" | "worktree-capacity" | "worktree-missing";
    };
```

**Behavior:**

1. Lookup on-disk managed worktree via `getOnDiskForIssue` (path exists under managed root). If present → `skipped` with that worktree; do **not** remove/recreate.
2. If absent (including stale manager metadata with no on-disk path — treat as missing; do not trust metadata alone as “present”) → rematerialize.
3. Resolve slug from issue title via existing `slugify` (same as planning’s `bootstrapWorktree` / `slugify(title) || issue-${N}`).
4. Call `createWorktree(cfg, issueNumber, slug)` so startPoint resolution and #622 reclaim stay single-sourced:
   - Prefer verified remote tip: `ls-remote origin refs/heads/pipeline/<N>-<slug>` → fetch → `origin/<branch>` only when local remote-tracking ref matches the ls-remote tip (existing create guards).
   - Else open PR head: `resolveOpenPrHeadForBranch` → fetch `pull/<prNumber>/head` (or SHA fallback).
   - Never trust a stale local-only `refs/heads/pipeline/…` as startPoint without remote/PR recovery.
5. After create succeeds, **verify** worktree `HEAD` equals the intended tip SHA (open PR `head_sha` when an open PR exists for that branch; otherwise the verified remote tip SHA used as startPoint). Mismatch → treat as rematerialize **fail** (`worktree-creation-failed`); do not hand a mismatched tree to archive/autofix.
6. Failure mapping (explicit, no “or equivalent”):
   - `WorktreeCapacityError` / `isWorktreeCapacityError` → `blockerKind: "worktree-capacity"`.
   - Create/reclaim/auth/branch-missing/HEAD-mismatch/git-add failures → `worktree-creation-failed`.
   - Cannot attempt rematerialize because there is no recoverable identity (no slug/title, no remote branch, no open PR head) → `worktree-missing`.
7. Dirty-path / local-only checks run **only when an existing reclaim candidate path is present** (inside `createWorktree`’s `assertReclaimSafe`). Rematerialize MUST NOT force-destroy dirty or unpushed local-only candidates. Managed-root containment and no-force-reclaim for foreign/dangling candidates remain as today.

**Rejected:** Inline `git worktree add` at each call site. **Rejected:** Asking the operator to run `git worktree add` while the engine can do the same safely. **Rejected:** Multiple ad-hoc rematerialize helpers with divergent result shapes.

### Decision 2: Exhaustive call-site inventory (implementation MUST wire all four)

| # | Call site | File / function | Trigger | On success | On fail |
| --- | --- | --- | --- | --- | --- |
| A | OpenSpec archive | `maybeArchiveOpenspec` | `getForIssue`/`getOnDisk` null **and** tip membership active **or** tip membership unconfirmed (listing error) | re-resolve worktree; continue archive path | typed block once; **never** `null` while active/unknown |
| B | Normal pre-merge autofix | production `attemptPreMergeAutoFix` closure in `advancePreMerge` (~`if (!wt) return { status: "error" }`) | autofix eligible; lookup null | `performPreMergeAutoFix` with recreated path | return autofix failure with **diagnostic naming rematerialize** + typed stage surface; **not** bare `{status:"error"}` with empty diagnostic |
| C | Residual re-entry autofix | `enforceReviewShaGate` → `reuseBlockedBy` → same `attemptPreMergeAutoFix` dep | residual re-entry eligible; null wt | same as B | same as B; residual park must not hide factory rematerialize fail as product judgment alone |
| D | Fix write-in-tree | `advanceFix` (fix-1 / fix-2) | lookup null before harness | continue fix on recreated path | `setBlocked` with seam’s `blockerKind` + reason |

**Notes:**

- B and C share one production closure; rematerialize once inside that closure (or via injected `ensureManagedWorktree` on deps) covers both residual re-entry and normal delta autofix.
- Eval / visual / design_gate / shipcheck remain **out of scope** (no new behavior claims).
- Every call site that evaluates the seam MUST use the same result contract and event name.

### Decision 3: Archive missing-tree decision (precise, fail-closed)

When `maybeArchiveOpenspec` finds no on-disk worktree:

1. If OpenSpec mode is `off` or `prNumber` is undefined → skip (`null`) as today (`openspec-inactive`).
2. Inspect tip-side active change membership via **PR-head tree listing at the PR’s current head SHA** (`listPrHeadChangeDirs` → `getPrDetail.head_sha` + Contents API at that ref). Do **not** use cumulative PR path subtraction.
3. Listing failures / truncated / auth / ambiguous 404 remain **fail-closed** (existing `listPrHeadChangeDirs` behavior): treat as “membership cannot be confirmed.”
4. Decision matrix:
   - **No active dirs** (positively empty listing) → non-blocking skip (`null`); rematerialize **not** required for archive.
   - **One or more active dirs** → rematerialize, then archive on recreated tree.
   - **Cannot confirm membership** (listing throws) → rematerialize first (archive may still be required); if rematerialize fails, block with typed rematerialize/worktree kind (and reason naming both listing + rematerialize failure as appropriate). Prefer not returning `null` when membership is unknown.
5. On rematerialize success: re-run lookup, then existing archive path (cleanliness guard, archive, commit, push).
6. On rematerialize failure: **one** typed block (`worktree-creation-failed` / `worktree-capacity` / `worktree-missing`); **never** return `null` while membership is active or unknown; **never** bare `needs-human` for absence-only factory failure.

### Decision 4: Durable evidence — mandatory for pass / fail / skipped when runDir exists

**Choice:** Resolve the prior SHALL/MAY contradiction: whenever a scoped call site evaluates `ensureManagedWorktree` and `runDir` is present, it **SHALL** append exactly one durable `gate_result` event:

- `gate`: `"worktree-rematerialize"` (stable; same id for pre-merge and fix dogfood greps)
- `result`: `"pass"` | `"fail"` | `"skipped"`
- `reason`: short, bounded, non-sensitive string (no tokens, no full dumps)

**Rules:**

- `pass` — create succeeded and HEAD verification passed.
- `fail` — rematerialize attempted or required and did not succeed (include mapped failure class in reason text).
- `skipped` — worktree already present; rematerialize not needed. **Mandatory** when the seam is evaluated and finds present (not optional MAY).
- No false `pass` when tree was already present.
- Pattern: reuse `recordPreMergeGateResult` style (best-effort append; never throws into gate decision) or shared helper taking `runDir` + `runStoreDeps`.

### Decision 5: Blocker kinds and recipe honesty

**Choice:**

- Prefer **`worktree-creation-failed`** when rematerialize was attempted and create/reclaim/HEAD-verify failed.
- Prefer **`worktree-capacity`** when the throw is capacity-typed (`isWorktreeCapacityError`).
- Prefer **`worktree-missing`** only when rematerialize cannot be attempted (no recoverable PR/branch identity) or residual park after scoped paths still need the kind.
- Stop using bare **`needs-human`** for the #626 missing-worktree-with-active-change path.
- Update `BLOCKER_RECIPES["worktree-missing"]` and `blocked-recipes.test.ts`: remove “re-running will block again immediately” / “never recreates” claims for paths that now rematerialize. Residual recipe MUST direct operators at: verify remote branch / open PR recoverability, auth/`gh`, free capacity, resolve dirty/local-only reclaim under managed root, clear `blocked`, re-run. Manual `git worktree add` may remain as last-resort recovery when rematerialize cannot succeed — not as the only story.

**Rejected:** New blocker kind unless existing kinds cannot express the failure — prefer existing enum values.

### Decision 6: Injectable seam for unit tests

**Choice:** Plumb `ensureManagedWorktree` on `AdvancePreMergeDeps` and `AdvanceFixDeps` (and the autofix production closure), defaulting to the real helper. Unit tests inject:

- success (`pass` + path)
- failure with each `blockerKind`
- `skipped` already-present
- “not called when already present at call site that short-circuits before seam” as appropriate

No real network / git / subprocess in unit tests (existing deps pattern in `pre-merge-sha-gate.test.ts`, `pre-merge-spec-consistency.test.ts`).

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Rematerialize from stale local ref / wrong tip | createWorktree already refuses stale `origin/<branch>` after fetch; seam additionally verifies worktree HEAD vs open-PR head SHA / verified remote tip |
| Create capacity full during rematerialize | Map to `worktree-capacity`; do not pretend archive can skip |
| Dirty foreign collision at managed path | #622 reclaim refuse; surface as `worktree-creation-failed` |
| Stale manager metadata without on-disk path | Treat as missing; rematerialize; do not skip archive on metadata alone |
| Double install cost on rematerialize | Accept bootstrap cost; create already stamps marker; planning-style setup may be needed for harness work — follow create/bootstrap patterns used by planning where autofix needs deps |
| Recipe test conflict (“must not claim re-run recreates”) | Update test + recipe together |
| Scope creep into eval/visual | Keep call-site list exhaustive and closed |
| Bare `{status:"error"}` hides rematerialize fail | Autofix result MUST carry diagnostic; residual-reentry gate_result reason names rematerialize failure |

## Migration Plan

1. Spec + design land in this change (planning).
2. Implementation: seam + four call sites + tests + recipe update + `plugin/` mirror if `core/` changes.
3. Validate with unit fakes; then dogfood re-advance #626 / #729 after install.
4. Rollback: revert change; behavior returns to needs-human / bare error (no data migration).

## Open Questions

- Whether autofix rematerialize should also run dependency install (`detectAndInstall`) after create. **Default:** yes when create path does not already, because implementer harness needs a usable tree; reuse planning’s bootstrap pattern only if create alone is insufficient — keep surgical: if `createWorktree` + existing autofix preflight is enough, do not expand.
- HEAD verification when only remote tip exists and PR is closed: use verified remote tip SHA only; if neither PR nor remote tip exists → fail `worktree-missing` (cannot rematerialize).
