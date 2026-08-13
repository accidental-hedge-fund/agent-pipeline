# #1025 — Stale blocked after HEAD moves past reviewed-sha must re-review

## Status

Implementation complete for full #1025 contract on top of epic #1028 first cut.

## What changed

- `tryResumeStaleBlocked`: clear on currency `unknown` when H ≠ S (rebase / S absent / unclassifiable), not permanent keep.
- Keep when H == S, currency `current` (internal-only #98), or PR/head unreadable.
- Unit matrix expanded (13 tests): clear, same-head, internal-only, rebase-unknown, unreadable PR/head, no override, real `resolveReviewedShaCurrency` shared helper.
- Advance enter-path wiring already present in `pipeline-run.ts` (continue after clear).

## Remaining

- [ ] `openspec validate` + `npm run ci`
- [ ] Commit with Issue/Pipeline-Run trailers
