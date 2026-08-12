## Context

See `proposal.md` for motivation and dogfood evidence (#1013 / PR #1016, train
ship-v1.38.0).

Pre-archive cleanliness lives in
`core/scripts/stages/pre-merge-openspec-archive.ts` (~350–390):

1. `git status --porcelain` (fail-closed on nonzero exit — #255).
2. `stripPipelineInternalMarkers` — only
   `PIPELINE_INTERNAL_MARKER_FILES` (`.pipeline-rebase-attempted`, #522 / #597).
3. Any remaining porcelain → `setBlocked(..., "pre-merge", "needs-human")`.
4. Marker-only dirt: best-effort unlink, then proceed.

Archive-failure rollback is `git restore .` + `git clean -fd openspec/`. The
guard is intentionally fail-closed for **real** uncommitted work.

Format/test gates already classify
`artifacts/challenge-response-*.json` as engine-known non-product scratch via
`classifyWorktreeDirt` / `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` in
`core/scripts/worktree-dirt.ts` (#1013 / `test-gate-non-product-dirty`). Pre-merge
archive does **not** share that classifier today.

Existing regressions in `core/test/pre-merge-spec-consistency.test.ts` cover
product dirty, dirty `openspec/`, marker-only proceed, rename destination
outside `openspec/`, and failed status. There is no challenge-response-only
case.

## Goals / Non-Goals

**Goals:**

- Challenge-response-only porcelain does not block pre-merge archive.
- Product and dirty OpenSpec porcelain still block.
- Failed `git status` still fail-closes.
- Prefer one dirt model with format/test gates; avoid a third ad-hoc path list.
- Preserve marker-only unlink/proceed behavior (#597).

**Non-Goals:**

- Broad `artifacts/**` waiver.
- Auto-committing challenge-response JSON.
- Weakening destructive-rollback safety for product / OpenSpec paths.
- Expanding #1013 after review-2 approve (this change is the archive consumer).
- Changing archive CLI, base-sync, residual active-change guard, or CI gates.

## Decisions

### D1: Reuse shared non-product classification for archive cleanliness

**Decision:** After a successful `git status --porcelain`, treat residual dirt as
blocking only when **product** paths remain. Classify porcelain paths with the
shared worktree dirt classifier (`parsePorcelainPaths` +
`classifyWorktreeDirt` / `productDirtyPaths`) so
`artifacts/challenge-response-*.json` matches the same engine-known scratch set
as format/test gates. Pipeline-internal markers remain excluded (existing
`stripPipelineInternalMarkers` / marker unlink path).

**Rationale:** #1013 already fixed the wrong classification for this basename
pattern. A parallel hard-coded path list in pre-merge would drift again. Shared
classification is the minimal coherent fix.

**Alternatives considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Shared classifier** (chosen) | One source of truth with #1013; pure tests already exist | Archive must compose marker strip + scratch class |
| Extend `stripPipelineInternalMarkers` only | Tiny local change | Conflates markers with scratch; wrong abstraction |
| Unlink challenge-response only | Clears porcelain | Loses dump; still need classify if unlink fails; parallel list |
| Config-only globs | Flexible | Does not fix default dogfood; operators must know |

### D2: Scratch-only → proceed; optional best-effort unlink

**Decision:** When product dirt is empty and the only remaining paths are
engine-known non-product scratch (challenge-response dumps and/or markers),
**proceed** with archive evaluation. Optionally best-effort unlink or
`git clean` those scratch paths (same spirit as marker-only cleanup) so later
porcelain checks stay clean — but proceed must not depend on unlink success if
the residual is still only scratch (or document unlink as best-effort after
the block decision, matching markers).

**Rationale:** Acceptance allows “archive proceeds (or dump is unlinked first)”.
Marker path already unlinks then proceeds. Prefer: decide clean-enough first,
then best-effort cleanup of non-product residual, then archive. Do **not**
stage or commit the dump.

### D3: Product dirt and failed status stay fail-closed

**Decision:** Non-empty product dirt (including dirty tracked/untracked under
`core/`, `plugin/`, `openspec/`, other non-scratch paths, renames touching
product endpoints) still `setBlocked` with `needs-human` and does not call
`openspec archive`. Nonzero `git status` still blocks with the existing
diagnostic shape.

**Rationale:** Rollback is only lossless when real work is absent. No change to
#255 / #683 residual-other mapping for workspace dirt.

### D4: Spec surface

**Decision:**

1. **ADDED** requirement under `openspec-integration` for pre-archive
   cleanliness vs pipeline-owned non-product scratch (challenge-response +
   markers already implied).
2. **MODIFIED** the existing “dirty state outside openspec/” scenario under
   archive-commit-failure so it means **product-relevant** dirt, not
   challenge-response-only porcelain (avoids a living-spec contradiction).
3. Unit tests in `pre-merge-spec-consistency.test.ts` (or co-located archive
   tests): challenge-response-only → no `setBlocked`, archive may be attempted
   when candidates exist; mixed product + dump → still blocks on product;
   status failure unchanged.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Over-broad scratch if classifier drifts | Engine set is narrow; #1013 tests lock pattern; no `artifacts/**` |
| Agents invent new dump basenames | Same residual as #1013; prefer `.agent-pipeline/` write path elsewhere |
| Unlink fails and later step re-blocks | Decide clean-enough on product emptiness, not post-unlink emptiness alone |
| Stale plugin mirror | tasks require `node scripts/build.mjs` with `core/` edits |
| Composing markers + scratch incorrectly double-counts or drops product rename endpoints | Use `parsePorcelainPaths` (both rename ends) then product classification |

## Migration Plan

- No config migration. Engine-known scratch already includes the dump pattern
  after #1013; this change only consumes it at archive.
- Existing worktrees with only challenge-response dumps become archive-clean
  on next pre-merge advance without operator cleanup.
- Rollback: revert pre-merge dirt decision + tests; no durable format change.

## Open Questions

None that block implementation. Whether scratch is unlinked vs left on disk is
an implementation detail as long as challenge-response-only porcelain does not
`setBlocked` and dumps are never auto-committed.
