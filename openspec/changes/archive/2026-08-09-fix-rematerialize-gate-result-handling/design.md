## Context

`ensureManagedWorktree` returns a fixed discriminated union:

| `result` | Meaning | `worktree` | `blockerKind` |
|---|---|---|---|
| `pass` | Recreated (or otherwise ensured) a managed tree | present | absent |
| `skipped` | Tree already on disk at ensure time | present | absent |
| `fail` | Could not ensure a usable tree | `null` | typed |

Correct consumers (fix, pre-merge archive/routing, loop repair) branch only on `result === "fail"` and continue with `remat.worktree` for both success variants.

Buggy consumers (design-gate, visual-gate, eval-gate at the #874 repro) checked for a nonexistent `"ok"` result. Both `pass` and `skipped` fell into the failure branch. Failure-reason templates interpolated `blockerKind`, which exists only on the fail variant, producing the live signature `failed (undefined)` even when the reason string described a successful recreate.

Main may already contain a partial consumer fix landed under #882 review recovery. This design still treats #874 as the authority for the required consumer contract, success-variant tests (including `skipped` with path), and living-spec binding so the false park cannot regress.

## Goals / Non-Goals

**Goals:**

- Design-gate, visual-gate, and eval-gate accept both success variants when a worktree path is present.
- Only seam `fail` (and unusable non-fail results without a worktree path, if retained as a defensive park) blocks with a typed worktree kind.
- Successful rematerialize never surfaces as `worktree-missing` with `failed (undefined)`.
- Behavioral regression tests cover `pass` and `skipped` success paths per stage.

**Non-Goals:**

- Changing the producer contract of `ensureManagedWorktree` (`pass` / `skipped` / `fail`).
- Weakening dirty/local-only reclaim safety or capacity mapping.
- Expanding rematerialize to stages that do not already call the seam.
- Changing durable event schema for `worktree-rematerialize` gate results.

## Decisions

### Decision 1: Match fix/pre-merge control flow — branch only on `fail`

**Choice:** In the three gate stages, use the same control flow as `fix.ts`:

```ts
if (remat.result === "fail") {
  // typed setBlocked from remat.blockerKind + remat.reason
} else {
  wt = { path: remat.worktree.path, slug: remat.worktree.slug };
}
```

**Rationale:** One seam, one consumer contract. Divergent success strings (`"ok"` vs `"pass"`) caused the bug; aligning on the typed fail branch removes the class of error.

**Alternatives considered:**

- Map `pass`/`skipped` → local `"ok"` at the seam: breaks durable `gate_result` vocabulary and every correct consumer.
- Check `result === "pass" || result === "skipped"` explicitly without using `else`: equivalent if exhaustive, but the fail-only branch matches existing correct sites and is harder to re-break with a new success synonym.

### Decision 2: Defensive park when non-fail lacks a worktree path

**Choice:** If a non-fail result is returned without a usable `worktree` (type-stripping or a bad injectable fake), park as `worktree-missing` with a reason that names the returned `result` and states the path was missing — not `failed (undefined)`.

**Rationale:** Production producer contract always supplies `worktree` on `pass`/`skipped`. Runtime type-stripping does not enforce the union. A defensive park avoids a throw on `remat.worktree.path` while remaining distinguishable from true rematerialize failure.

**Trade-off:** Slightly broader than a pure `result === "fail"` check. Acceptable because the park is still typed and the reason is honest.

### Decision 3: Spec the consumer contract under `worktree-rematerialize` and bind each gate

**Choice:** Add a shared consumer requirement to `worktree-rematerialize`, and add stage-local requirements under `design-interrogation-gate`, `visual-gate`, and `eval-gate` so each stage is named as a rematerialize call site that must continue on success.

**Rationale:** The living rematerialize spec already requires success-continues for pre-merge/fix. Explicitly naming the three gate consumers prevents another inventory gap.

### Decision 4: Behavioral tests over source-text greps

**Choice:** Inject production-shaped `{ result: "pass", worktree, reason }` and `{ result: "skipped", worktree, reason }` fakes; assert no `setBlocked`, stage continues, and (for visual/eval) the runner receives the returned path. Keep existing fail cases.

**Rationale:** Source greps for `!== "ok"` do not prove control flow. The live bug was a successful reason string parked as failure — tests must exercise that shape.

## Risks / Trade-offs

- **[Risk] Partial fix already on main** → Implementation phase first verifies current consumer branches; if already correct, remaining work is missing `skipped`-with-path tests, living-spec archive of this delta, and CI/mirror. Do not re-break defensive null-worktree handling.
- **[Risk] Over-narrowing fail reasons** → Keep existing typed `blockerKind` branches and reason templates on true fail; only remove false entry into that branch on success.
- **[Risk] Race `skipped` between lookup and ensure** → Accepting `skipped` with path is required; that is the intended recovery when another process recreates the tree mid-flight.

## Migration Plan

1. Align the three consumer branches (or confirm already aligned).
2. Add/extend unit tests for `pass` and `skipped` success variants.
3. Regenerate `plugin/` if `core/` changed.
4. `npm run ci` green; no rollout flag — behavior is correctness-only.

## Open Questions

- None for intent. Implementation may find main already matches Decision 1 for `pass`; confirm `skipped` with path and living-spec binding remain gaps before closing #874.
