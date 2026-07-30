## 1. Confirm event kind shape and CLI flag surface

- [x] 1.1 Confirm the exact JSON field and value for `loop_run_stopped` from loop event writers (`core/scripts/loop/`) — do not guess field names
- [x] 1.2 Add `--until-terminal` / `--no-until-terminal` (or equivalent boolean pair) to loop logs CLI parsing, command allowlist, and help; default until-terminal **on** when `--follow` is set
- [x] 1.3 Thread the until-terminal option into `runLoopLogs` / `LoopLogsDeps` without breaking dump/list paths (flags ignored without `--follow`)

## 2. Implement until-terminal follow in the engine

- [x] 2.1 Replace pure inherit-only `tail -f` as the sole default follow path with a line-aware follow that prints complete lines and detects `loop_run_stopped`
- [x] 2.2 On default until-terminal: after printing a `loop_run_stopped` line (historical or live), exit 0; keep SIGINT/SIGTERM as a valid stop
- [x] 2.3 On `--no-until-terminal`: preserve interrupt-only follow (no auto-exit solely on terminal event)
- [x] 2.4 Handle incomplete trailing lines (buffer until newline); ignore non-JSON / wrong-kind lines for terminal detection
- [x] 2.5 Update error/help strings that claim “does not auto-exit on terminal stop events” to match the new default

## 3. Unit tests for loop logs follow terminal exit

- [x] 3.1 Regression: default follow exits 0 when a `loop_run_stopped` line is delivered (would fail without the fix)
- [x] 3.2 Historical terminal: events file already contains `loop_run_stopped` → follow processes content and exits 0 without hanging
- [x] 3.3 `--no-until-terminal` does not exit solely because `loop_run_stopped` was observed
- [x] 3.4 CLI parse/allowlist tests cover the new flags; existing dump/list/read-only tests remain green
- [x] 3.5 All tests use injected seams only (no real network, git, or live supervisor)

## 4. Host skill and packaging orchestration

- [x] 4.1 Update `hosts/claude/SKILL.md` §4b.f (and dual-follow guidance if present) for same-turn stop of all run-scoped loop+advance follows on `loop_run_stopped` / supervisor exit
- [x] 4.2 Document dual-follow / multi-stream pattern as `exit 0` after terminal + final summary line (no infinite post-terminal loop)
- [x] 4.3 Final summary requirements: terminal reason + “follows stopped”
- [x] 4.4 Mirror the same guidance in `hosts/codex/SKILL.md`
- [x] 4.5 Update command one-liners (skill tables, operation surface, README loop logs notes) so they no longer claim unconditional “no auto-exit on terminal” without documenting until-terminal default

## 5. Drift guards and plugin mirror

- [x] 5.1 Add/extend packaging or skill drift-guard tests for stop-on-`loop_run_stopped` / same-turn teardown language and dual-follow exit
- [x] 5.2 Guard fails if primary follow one-liner reintroduces unconditional “no auto-exit on terminal” without until-terminal default docs
- [x] 5.3 Run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change when core/packaging sources change
- [x] 5.4 Run `npm run ci` from repo root; treat red as not-done
- [x] 5.5 `openspec validate loop-event-follow-terminal-exit` (and `--all` via ci) remains green
