# #1025 — Stale blocked after HEAD moves past reviewed-sha must re-review

## Status

Implementation complete for full #1025 contract on top of epic #1028 first cut.

## What changed

- `tryResumeStaleBlocked`: clear on currency `unknown` when H ≠ S (rebase / S absent / unclassifiable), not permanent keep.
- Keep when H == S, currency `current` (internal-only #98), or PR/head unreadable.
- Unit matrix expanded (13 tests): clear, same-head, internal-only, rebase-unknown, unreadable PR/head, no override, real `resolveReviewedShaCurrency` shared helper.
- Advance enter-path wiring already present in `pipeline-run.ts` (continue after clear).

## Verification

- [x] `openspec validate stale-blocked-after-head-rereview` — valid
- [x] `npm run ci` — green (exit 0)
- [x] Commit `030a4bc1` with Issue/Pipeline-Run trailers (not pushed)

## Review

### Inventory (epic first-cut vs #1025)

| Site | Status |
|------|--------|
| `tryResumeStaleBlocked` | Fixed D2 gap: `unknown` + H ≠ S clears |
| `pipeline-run.ts` enter-path | Already wired: resume before STOP; `continue` after clear |
| train / loop / single | Reach `runAdvance` enter-path; post-advance park only if still blocked |
| `needs-human` co-label | Residual uses blocker *kind*; stage stays pre-merge; clear enough |

### Residual risk

None for the dogfood class. Force-push / incomplete commit lists re-review more often when H ≠ S — intentional conservative path.