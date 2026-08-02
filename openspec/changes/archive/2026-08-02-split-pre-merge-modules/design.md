## Context

`core/scripts/stages/pre_merge.ts` is a ~5400-line stage monolith. Coarse domains visible in the current file (approximate ownership, not line-number contracts):

| Domain | Representative surface |
| --- | --- |
| Auto-fix | `performPreMergeAutoFix`, category/partition helpers, noop/attempt markers |
| CI recovery markers + types | `CiRecoveryMarkers`, load/save/hydrate, SHA-set helpers |
| Orchestration | `advance`, `advancePolling`, `AdvancePreMergeOpts` / `AdvancePreMergeDeps` |
| SHA gate | `enforceReviewShaGate`, `ShaGateDeps`, currency, delta review, notices |
| OpenSpec archive | `maybeArchiveOpenspec`, `archiveAlreadyDone`, `enforceOpenspecActiveChangeGuard` |
| CI failure / recovery paths | definitive CI failure, zero-run recovery, exhausted block reasons, archive-only prior green |
| Conflict / rebase | `recoverFromMergeConflict`, `tryRebaseAndPush`, rebase-attempted markers |

Review already demonstrates the target pattern: four focused modules + thin `review.ts` re-export facade so `pre_merge` and tests keep importing `./review.ts` without path churn.

Related but out of scope:

- **Shared harness-round / pipeline-commits** (#629 / archived extract change): classifier already lives in neutral `pipeline-commits.ts` (pre_merge re-exports). Do not re-fold classification into stage modules; do not extract harness-round here.
- **`pre-merge-offramp.ts`**: already a sibling module; leave as-is unless a move forces a one-line import fix.
- Living behavioral specs (`review-sha-gating`, `pre-merge-ci-gate`, `pre-merge-conflict-detection`, archive fail-closed, `pre-merge-fix-round`, …) remain the product truth; this change is structural.

## Goals / Non-Goals

**Goals:**

- Domain-split pre-merge into focused modules with a thin facade, mirroring review.
- Preserve public export surface via re-exports so call sites need not change import paths.
- Move-only first landing: identical runtime behavior for the same inputs/deps.
- Keep the existing pre-merge test net green; add a small structural guard if useful.
- Regenerate `plugin/`; pass `npm run ci`.

**Non-Goals:**

- Rewriting SHA-gate policy (currency, supersession, ceiling, allowlisted identity, blocking-key re-evaluation).
- Extracting shared harness-round or changing salvage/auto-fix product policy.
- Merging or inventing new living gate requirements beyond the structural capability.
- Auto-merge / unattended merge.
- Full re-homing of every test import onto deep module paths (facade is intentional).
- Opportunistic refactors, renames for taste, or “while we’re here” cleanup inside moved bodies.

## Decisions

### 1. Mirror the review facade pattern

**Decision:** `stages/pre_merge.ts` becomes a thin re-export facade (and, if needed, a short composition home for `advance` / `advancePolling` wiring). Implementation bodies live in sibling modules under `stages/`.

**Rationale:** Review’s split proved that re-exports keep dozens of import sites stable while allowing domain ownership. The issue explicitly cites that template.

**Alternatives considered:**

- *Deep imports only (delete facade).* Forces churn across `pipeline-run`, merge-queue, repair, and many tests; higher risk of missed exports; rejected for first PR.
- *Subdirectory package (`stages/pre_merge/*`).* Cleaner long-term, but heavier path/mirror churn than review’s flat siblings; prefer flat siblings unless implementers hit name collisions.

### 2. Domain cut lines (preferred module names)

**Decision:** Prefer these modules (filenames may vary if collision forces a prefix; domains must still exist):

1. **`pre-merge-sha-gate.ts`** (or `sha-gate.ts` if unambiguous) — `enforceReviewShaGate`, `ShaGateDeps`, currency resolution, delta-review helpers/types, SHA notices (`staleReviewNotice`, supersession notices, rerun notices, etc.).
2. **`pre-merge-openspec-archive.ts`** (or `openspec-archive.ts`) — active-change guard, archive-already-done, `maybeArchiveOpenspec` and archive fail-closed helpers used only by archive.
3. **`pre-merge-ci-gate.ts`** (or `ci-gate.ts`) — CI recovery markers persistence, definitive CI failure handling, zero-run recovery, exhausted block-reason builder, archive-only-prior-green evaluation tied to CI certification.
4. **`pre-merge-conflict-rebase.ts`** (or `conflict-rebase.ts`) — merge-conflict recovery, rebase-attempted markers, `tryRebaseAndPush`, `resolveRebasePushResult`.
5. **Facade / orchestration** — `advance`, `advancePolling`, shared `AdvancePreMergeOpts` / deps composition, and glue that orders gates.

**Naming preference:** Prefer `pre-merge-*.ts` prefix for new stage files so they do not collide with living-spec capability names or future non-stage helpers, unless the implementer finds short names (`sha-gate.ts`) clearly unique under `stages/`. Either naming scheme satisfies the capability as long as domains are distinct files.

### 3. Auto-fix placement

**Decision:** Auto-fix (`performPreMergeAutoFix` and pure helpers/markers) MAY:

- remain in the orchestration/facade module for the first PR if splitting it would create a circular import with SHA-gate (auto-fix triggers delta re-review), **or**
- land in a fifth module `pre-merge-autofix.ts` if import direction is acyclic (autofix → sha-gate helpers, not the reverse).

**Rationale:** Issue’s “e.g.” list names SHA/archive/CI/conflict; auto-fix is large but already partially layered and is a known consumer of shared harness-round work (sibling). Prefer no cycles over forcing a fifth file in the first PR.

**Alternative rejected:** Rewriting auto-fix onto harness-round as part of this change (sibling issue).

### 4. Dependency direction among modules

**Decision:** Enforce a one-way graph:

```
conflict-rebase  ─┐
ci-gate          ─┼─► orchestration/facade (advance, advancePolling)
openspec-archive ─┤
sha-gate         ─┘
     ▲
     │ (optional)
 autofix ─────────► sha-gate helpers / deps types only as needed
```

- Pure helpers and types flow downward (shared types may live in the module that owns the primary function, or a tiny `pre-merge-types.ts` only if needed to break a cycle).
- Facade may import all domains; domain modules MUST NOT import the facade.
- Classifier stays in neutral `pipeline-commits.ts` (already extracted); stage modules import it, not the reverse.

**Rationale:** Cycles re-create the monolith via the module graph. Review modules already follow facade-outward imports.

### 5. Public API compatibility via re-exports

**Decision:** Every symbol currently imported from `stages/pre_merge.ts` by production code or tests SHALL remain importable from `stages/pre_merge.ts` after the split (direct re-export or re-export of a named set). New code MAY import deep paths; old paths MUST keep working.

**How:** Match `review.ts`:

```ts
export * from "./pre-merge-sha-gate.ts";
// ...
```

or explicit `export { … } from "…"` when star-export would leak private helpers the monolith never exported.

**Rationale:** Zero call-site churn is the cheapest correctness proof for a move-only PR.

### 6. Move-only discipline

**Decision:** First implementation PR is mechanical:

1. Cut functions/types to domain files with minimal edit (imports adjust only as required).
2. No renames of exported identifiers.
3. No “simplify while moving” control-flow changes.
4. No comment-only drive-bys that rewrite history of scars (#16/#98/#481/#579).
5. Behavior fixes (if any are discovered) are **separate** commits/PRs or follow-ups — not bundled as silent policy edits.

**Rationale:** Issue requires no intentional behavior change; mixed move+fix diffs are unreviewable and re-trigger SHA-gate non-convergence scars.

### 7. Tests and structural guards

**Decision:**

- Keep importing tests from `../scripts/stages/pre_merge.ts` unless a test specifically targets a domain module.
- Add a lightweight regression if useful, e.g.:
  - facade file is small / contains only re-exports + thin orchestration, **or**
  - domain files exist and export the primary entry (`enforceReviewShaGate`, `maybeArchiveOpenspec`, …), **or**
  - facade re-exports a canary list of public symbols used by production call sites.
- Do **not** invent a heavyweight dependency-cruiser stack; source-scan or export-identity tests matching existing drift-guard style are enough (repo has no `tsc` graph gate).

### 8. Plugin mirror

**Decision:** After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change. CI’s `--check` must stay green.

## Risks / Trade-offs

- **[Risk] Circular imports among domain modules (SHA-gate ↔ auto-fix ↔ advance).** → Mitigation: Decision 3–4; extract shared pure types/constants first; keep orchestration as the only composer.
- **[Risk] Accidental behavior change during the move (default arg order, hoisting, missing re-export).** → Mitigation: move-only; full pre-merge test suite as oracle; explicit re-export canary; no logic edits in the same hunk as the move when avoidable.
- **[Risk] Star-export leaks private helpers or drops intentional named exports.** → Mitigation: prefer matching the previous public surface; use explicit re-exports if star-export is noisy.
- **[Risk] Scope creep into policy rewrites once the file is open.** → Mitigation: non-goals + surgical-fix discipline; policy bugs → separate issues.
- **[Risk] Facades become stale “barrel files” that re-monolith via re-export of everything.** → Mitigation: domain ownership is real (bodies live in domain files); facade stays thin; optional size/structure guard.
- **[Risk] Large PR review fatigue.** → Mitigation: single structural PR is still preferred over multi-PR half-moves that leave two homes; keep diff mechanical; no unrelated cleanup.

## Migration Plan

1. Land OpenSpec artifacts (this change) and `openspec validate split-pre-merge-modules`.
2. Inventory current exports and external importers (production + tests).
3. Extract purest leaf domains first (conflict-rebase markers/helpers, CI marker persistence, OpenSpec archive, SHA-gate), then wire orchestration.
4. Convert `pre_merge.ts` to facade re-exports; keep `advance` composition compiling.
5. Run pre-merge-focused tests, then `node scripts/build.mjs`, then `npm run ci`.
6. Rollback: revert the PR; no data migration; behavior intended identical.

## Open Questions

- Exact filenames (`sha-gate.ts` vs `pre-merge-sha-gate.ts`) — implementer choice if domains and facade contract hold.
- Whether auto-fix is a fifth file in the first PR or deferred co-location in orchestration — decide by cycle pressure at implement time (Decision 3).
- Whether `advance` / `advancePolling` stay in the facade file or move to `pre-merge-routing.ts` (review analogy: `review-routing.ts`). Prefer a routing module if the facade would otherwise remain large; either satisfies the capability if domain bodies are not left in a god-file.
