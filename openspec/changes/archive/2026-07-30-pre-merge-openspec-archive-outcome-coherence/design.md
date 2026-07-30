## Context

Pre-merge OpenSpec handling today uses **two different active-change notions**:

1. **`maybeArchiveOpenspec` candidates** — from the local worktree: `git diff --name-only origin/<base>...HEAD` → `changeIdsFromPaths` → filtered by `changeDirExists(worktree, id)`. Candidate discovery currently runs **before** the archive-base fast-forward to `origin/<branch>`.
2. **`enforceOpenspecActiveChangeGuard` residual** — from the PR head file list only: `getPrDiff` → `diffFilePaths` → `unarchivedChangeIdsFromPrFiles` (worktree-independent by design from #467).

A `gate_result` for `openspec-archive` can therefore say `skipped` / `no-candidates` (or `pass` listing candidate ids) while the later guard still sees unarchived paths on the PR tip. Production fingerprints:

| Instance | Sequence | Root-class |
| --- | --- | --- |
| #626 / PR #713 | `skipped` `no-candidates` → blocked `openspec-invalid` naming still-active id | Candidate empty while PR residual non-empty |
| #675 / PR #721 | `pass` listing two ids → later `skipped` `no-candidates` → blocked naming one residual (foreign/stacked) | Pass over-claimed; partial archive; stacked change not treated consistently |

Additional code smells that amplify the dual outcome:

- After archive CLI calls return success, if `git status` is clean, the step records **`skipped` / `no-candidates`** even though candidates were non-empty — a false skip that can precede the residual guard.
- Pass reason is `candidates.join(", ")` after CLI success, **not** after verifying each id left `openspec/changes/<id>/` (or landed under archive).

Constraints: keep fail-closed semantics from #467; keep archive-base sync (#579); do not relax “active OpenSpec changes block ready-to-deploy”; no auto-merge; surgical change only.

## Goals / Non-Goals

**Goals:**

- One **shared active-change set** for a given PR head evaluation used by archive attempt and residual still-active check.
- Coherent `gate_result` outcomes: no skip/pass-then-block on the same residual ids in one pre-merge pass.
- Honest multi-archive: pass names only ids actually archived; partial archive fails closed with residual ids named.
- Stacked/foreign active changes on the PR tip are in that shared set.
- Regression tests that fail on current dual-outcome behavior.

**Non-Goals:**

- Teaching implementers to archive earlier (still required by product rules).
- Loop resume stranding at `pr_opened` after block (#712).
- Changing scoreboard/offramp taxonomy for `openspec-invalid` beyond accurate residual blocking.
- Replacing the OpenSpec CLI or rewriting living-spec archive merge mechanics.

## Decisions

### D1 — Single source of truth for “active on this PR head”

**Choice:** Derive the authoritative active-change id set from the **PR head path list** (`getPrDiff` / `diffFilePaths` → unarchived-id helper), the same family of inputs the residual guard already trusts. Use that set as:

- archive candidates (when worktree is available), and
- residual still-active check after archive / when skipping.

When the worktree is present, **intersect with filesystem truth after archive-base sync** (see D2): only archive ids that still have `openspec/changes/<id>/` on disk; if PR says active but the dir is missing after sync, fail closed (needs-human or openspec-invalid with the id named) rather than silent skip.

**Alternatives considered:**

- *Worktree-only as sole truth* — rejects #467 override/resume and missing-worktree guarantees.
- *Union of PR paths and local git diff* — more complex; still can diverge after FF if local was stale; PR tip is the merge surface operators care about.
- *Leave two sources, add a consistency assertion only* — catches the dual outcome but does not fix partial archive / false pass listing.

### D2 — Compute candidates only after archive-base fast-forward

**Choice:** Reorder `maybeArchiveOpenspec` so cleanliness + fetch/FF to `origin/<branch>` complete **before** final candidate resolution. Active ids are then evaluated on the same reviewed head the archive commit will parent.

**Why:** Candidate discovery before FF is a concrete skip→block path when the worktree lags a stacked merge that introduced a foreign active change.

**Alternatives:** Re-probe after FF in addition to pre-FF probe (redundant if we only act post-FF).

### D3 — Verify archive effect before recording `pass`

**Choice:** After each successful `openspec archive <id>` (or after the batch + before commit), assert that `openspec/changes/<id>/` no longer exists as an active dir (or that the id is no longer in the residual set derived from post-archive worktree paths). Collect `archivedIds` only for ids that cleared. Record:

- `pass` reason = `archivedIds.join(", ")` only when every candidate in the shared set is in `archivedIds` (and commit/push succeed as today), **or**
- if some candidates remain active after the archive attempts, **block** with `openspec-invalid` naming residual ids (do not record multi-id pass).

Never record `skipped` / `no-candidates` when the pre-archive shared active set was non-empty (including the “archive produced no git diff” branch — that becomes a fail/block with residual ids named).

**Alternatives:** Trust CLI exit code alone (current — failed in production).

### D4 — Residual guard reuses the same helper / set definition

**Choice:** `enforceOpenspecActiveChangeGuard` continues to read PR files (worktree-independent), but MUST use the **same pure function** and semantics as candidate residual membership (including any fix for date-prefixed archive folder names if needed so “archived” matching is not brittle). One pre-merge pass MUST NOT emit archive `skipped`/`no-candidates` for a non-empty residual of that function.

**Note:** Date-prefixed archive dirs (`openspec/changes/archive/YYYY-MM-DD-<id>/`) mean residual is primarily “active path still present,” not “active minus archive-folder-name equality.” Keep residual definition explicit in the helper so tests pin it.

### D5 — Event evidence stays one decision per archive evaluation

**Choice:** Keep a single `gate_result` for the archive step per evaluation: `pass` (archived ids), `skipped` only for true empty set or openspec-inactive, or `fail` with blocking reason. Coherence is enforced so a later residual block in the same pass cannot contradict a prior no-candidates skip for the same head.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| PR diff and worktree disagree (stale worktree after FF failure) | Existing base-sync already blocks when FF cannot reach reviewed head; missing dir for PR-active id fails closed. |
| Foreign active change on a stack is intentionally another issue’s work | Still must not ship unarchived; block with named id is correct product behavior — do not special-case “not this issue’s change.” |
| Reordering FF before candidates changes timing of cleanliness | Cleanliness already required before FF; keep that order; only move candidate resolution after sync. |
| Stricter pass verification breaks flaky archive CLI success-with-no-op | Desired: surface real failures instead of dual outcomes. |
| Tests need synthetic dual-outcome reproduction against old logic | Prefer unit tests with injectable deps that recreate empty candidates + non-empty PR residual, and multi-id CLI success with one dir remaining. |

## Migration Plan

1. Land helper + reorder + verification + tests behind normal PR path.
2. No config flag required — behavior change is correctness-only and fail-closed.
3. Rollback: revert the change; dual outcomes return (acceptable only as emergency).

## Open Questions

- None blocking authoring: product accepts blocking on foreign/stacked active changes present on the PR tip (same as today’s residual guard intent).
- Implementer may choose whether residual-after-partial-archive reuses `enforceOpenspecActiveChangeGuard` in-process or inlines the same helper — both satisfy the shared-set requirement if the pure function is single-sourced.
