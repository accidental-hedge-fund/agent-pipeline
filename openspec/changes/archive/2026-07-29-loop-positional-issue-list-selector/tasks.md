## 1. Regression test first (prove it bites)

- [x] 1.1 Add a unit/CLI regression that multi-issue positionals after `loop`
      (`649 551 541 334` or equivalent) are **not** rejected as
      `pipeline: unexpected argument(s): …` and that the loop path receives
      `issues: ["649","551","541","334"]` (or produces a `work-list` with that
      value). Prefer a pure helper or injected `LoopCliDeps` path over a live
      supervisor drive.
- [x] 1.2 Cover a single-issue form (`pipeline loop 649` → work-list `["649"]`)
      and a non-numeric form that still fails with a loop issue-number error
      (not a false "unexpected arguments" for a valid multi-list shape).
- [x] 1.3 Run the new test(s) against the unfixed tree and confirm they FAIL
      for the multi-issue case (guard default of 1).

## 2. Fix the top-level positional guard

- [x] 2.1 In `core/scripts/pipeline.ts`, extend the `maxPositionals` computation
      so `cmd.args[0] === "loop"` allows `1 + MAX_RANGE_SPAN` positionals
      (`loop` + up to `MAX_RANGE_SPAN` issue numbers). Import/reuse
      `MAX_RANGE_SPAN` from `loop-preflight.ts` rather than hard-coding 1000.
- [x] 2.2 Confirm `runLoopCommand(opts, cmd.args.slice(1))` remains the handoff
      (no duplicate issue parsing at the dispatcher).
- [x] 2.3 Re-run the new tests and confirm they pass; re-run nearby loop /
      CLI positional tests for non-regression on other commands' caps.

## 3. Mirror + full gate

- [x] 3.1 Regenerate the plugin mirror: `node scripts/build.mjs` from the repo
      root; include regenerated `plugin/` in the same change if `core/`
      content changed.
- [x] 3.2 Run `npm run ci` from the repo root and confirm green (core tests,
      mirror check, install smoke, `openspec validate --all`).

## 4. Verify observable outcomes

- [x] 4.1 Confirm `pipeline loop 649 551 541 334` no longer exits 2 with
      unexpected-argument rejection of the trailing issue numbers before
      preflight (engine/native-goal may still fail later on a non-capable
      host — that is out of scope).
- [x] 4.2 Confirm flag selectors, `--resume`, `--audit`, and `--new-run` are
      unchanged, and that combining an issue list with another selector or
      `--resume` still fails mutual-exclusion in `normalizeLoopArgs`.
