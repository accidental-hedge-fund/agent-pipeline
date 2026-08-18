# #1137 — frg-1394-clean-openspec (implementation)

## Feedback Incorporated

- [ADDRESSED] Name exact OpenSpec artifacts under `openspec/changes/frg-1394-clean-openspec/` — kept and scenario language clarified.
- [ADDRESSED] Concrete test strategy: resolve and read only the run-scoped fixture path, parse JSON, assert `release_version === "1.39.4"`.
- [ADDRESSED] Replace ambiguous “sole copy under a different `pack_run_id`” language with: this pack’s fixture lives only at the stated run-scoped path.
- [ADDRESSED] Keep `SHALL` on the requirement first line; keep scenarios; validate with `openspec validate`.
- [ADDRESSED] Scope stays fixture + unit test + this issue’s OpenSpec change only (no `core/scripts/` production edits).
- [ADDRESSED] Resolve fixture path from the test file location (`fileURLToPath`), not process cwd.
- [ADDRESSED] Require `npm run ci` green before handoff; make no suite-pass claim without that evidence.

## Plan status

- [x] OpenSpec change `frg-1394-clean-openspec` authored and committed
- [x] Revise OpenSpec scenario language (fixture location)
- [x] Add fixture JSON
- [x] Add unit test
- [x] Run `openspec validate` + `npm run ci`
- [ ] Commit (no push) and hand off for review / pipeline advance

## Review

- Added `core/test/fixtures/frg/pack-1394-tugboat-ship-1.39.4/clean-openspec.json` with `release_version: "1.39.4"`.
- Added `core/test/frg-1394-clean-openspec.test.ts` (path-scoped read + pass/fail assertion helpers).
- No `core/scripts/` production edits. Mirror check reports plugin up to date.
- Evidence: `openspec validate frg-1394-clean-openspec` passed; `npm run ci` exited 0.
