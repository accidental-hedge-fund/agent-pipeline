# #1021 — file engine-class live sibling on current train milestone

## Status

Implementation complete for full #1021 contract on top of epic #1028 first cut.

## Inventory (epic first cut)

Living code already had:
- `core/scripts/stages/engine-class-live-sibling.ts` (marker, ready+engine-class+bug, Depends on, dedup, rate-cap, train context)
- `unlink_engine_scratch` best-effort `onEngineClassRecovered` / default filer
- `pipeline train` set/clear train milestone context

## What changed this PR

- Recover-path coupling tests: invoke once with evidence_key; filer throw non-fatal; product dirt + human-authority never call filer
- Filer unit tests: exact labels, empty-string milestone fail-closed, train context set/get/clear, createIssue failure non-fatal
- OpenSpec change tasks checklist completed

## Verification

- [x] `openspec validate file-engine-class-live-sibling` — valid
- [x] `openspec validate --all` — 289 passed
- [x] `node scripts/build.mjs --check` — mirror up to date (no scripts change)
- [x] `npm run ci` — green (exit 0)

## Review

No production-code gap beyond test lock-in. #538 backlog-only papercut path untouched. Filing remains non-fatal relative to recover.
