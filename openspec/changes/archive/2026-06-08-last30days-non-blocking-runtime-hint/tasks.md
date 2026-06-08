## 1. Read existing code

- [x] 1.1 Read `core/scripts/stages/planning.ts` `gatherCarryForward` function (lines ~569–601) to confirm the two skip branch locations and log format
- [x] 1.2 Read `core/scripts/last30days.ts` to confirm `run()` return shape and `hasSignal()` signature
- [x] 1.3 Read the README "last30days context (optional)" section to identify insertion point for the keys note

## 2. Implement runtime hints

- [x] 2.1 In `gatherCarryForward`, replace the `res.unavailable` branch `console.log` with a richer hint that names the install command and states data-source keys live in the skill
- [x] 2.2 In `gatherCarryForward`, replace the `!res.success || !hasSignal` branch `console.log` with a hint naming `BRAVE_SEARCH_API_KEY` and `SCRAPECREATORS_API_KEY` as the highest-lift keys and pointing to the skill's setup

## 3. Update README

- [x] 3.1 In README "last30days context (optional)" section, add a callout noting that data-source keys are configured in the skill (not the pipeline), naming the two recommended keys, and linking to the skill's setup documentation

## 4. Unit tests

- [x] 4.1 Add test: `last30days.enabled: true`, `run()` returns `unavailable: true` → hint emitted, `""` returned, no throw
- [x] 4.2 Add test: `last30days.enabled: true`, `run()` returns `success: true` but `hasSignal` false → hint emitted, `""` returned
- [x] 4.3 Add test: `last30days.enabled: false` → no hint, `run()` never called, `""` returned immediately
- [x] 4.4 Run `pnpm test` and confirm all tests pass
