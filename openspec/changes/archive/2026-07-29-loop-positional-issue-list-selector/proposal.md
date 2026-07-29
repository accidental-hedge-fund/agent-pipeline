## Why

`pipeline loop`'s documented selector surface includes an explicit issue-number positional
list (`pipeline loop 649 551 541 334`), and `loop-preflight` already normalizes those
positionals to a `work-list` selector. The top-level extra-positionals guard in
`pipeline.ts` never allows more than one positional for `loop`, so every multi-issue
list is rejected with `pipeline: unexpected argument(s): …` **before** preflight runs.
Flag-based selectors (`--milestone`, `--label`, `--range`, `--roadmap-slice`) work;
only the documented issue-list form is dead. Same class of defect as #610
(`--new-run` allowlist): the contract is implemented behind a gate that fires first.
Ship after the v1.28.x loop flag/positional hotfixes so the CLI surface is one coherent
contract (maintainer note on #554).

## What Changes

- Teach the top-level extra-positionals guard that `loop` accepts unbounded (or
  `MAX_RANGE_SPAN`-bounded) issue-number positionals after the `loop` keyword, so
  `pipeline loop 649 551 541 334` reaches `runLoopCommand` / `normalizeLoopArgs` instead
  of exiting 2 at the dispatcher.
- Keep invalid non-numeric positionals as a preflight/`normalizeLoopArgs` concern
  (already rejects non-`/^\d+$/` tokens) — the dispatcher fix only stops treating a
  multi-issue list as "unexpected arguments."
- Add a regression test that fails on the pre-fix guard (multi-issue positionals
  rejected at the top level) and passes after the fix (positionals threaded through as
  `issues` / `work-list`).
- No change to selector mutual-exclusion rules, `--resume` / `--audit` / `--new-run`
  semantics, range expansion, durable-loop engine behavior, or any other command's
  positional cap.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `pipeline-loop-facade`: the explicit issue-list selector form SHALL be reachable from
  the CLI end-to-end — the top-level positional guard SHALL NOT reject a multi-issue
  list before loop argument normalization, and `pipeline loop <N> [<N>…]` SHALL normalize
  to a `work-list` selector with those issue numbers.

## Acceptance criteria

- [ ] `pipeline loop 649 551 541 334` no longer exits 2 with
      `pipeline: unexpected argument(s): 551, 541, 334` (or equivalent) before loop
      preflight; control reaches `runLoopCommand` with positional issues
      `["649","551","541","334"]`.
- [ ] `normalizeLoopArgs` (via the real CLI path or an equivalent unit of the dispatcher
      contract) produces `{ type: "work-list", value: ["649","551","541","334"] }` for
      that invocation when no other selector flag is set.
- [ ] A single issue still works: `pipeline loop 649` is accepted as a one-element
      work-list (not treated as an advance of issue 649 or as "missing selector").
- [ ] Non-numeric trailing positionals after `loop` still fail with a clear loop error
      (e.g. `expected an issue number`) rather than silently starting a run.
- [ ] Combining an issue list with another selector (`--milestone`, `--label`,
      `--range`, `--roadmap-slice`) or with `--resume` is still rejected by existing
      mutual-exclusion rules in `normalizeLoopArgs`.
- [ ] Flag-only selectors (`--milestone` / `--label` / `--range` / `--roadmap-slice`),
      `--resume`, `--audit`, and `--new-run` behavior are unchanged.
- [ ] Other commands retain their existing positional caps (`run|release|…` = 2,
      `unblock|override|evals` = 3, default = 1); only `loop` gains multi-issue
      positionals.
- [ ] A unit/regression test fails without the guard fix and passes with it.
- [ ] `npm run ci` is green from the repo root, including the regenerated `plugin/`
      mirror when `core/` changes.

## Impact

- `core/scripts/pipeline.ts` — extra-positionals `maxPositionals` (or equivalent early
  return / skip) for the `loop` keyword; already calls
  `runLoopCommand(opts, cmd.args.slice(1))`.
- `core/test/` — regression coverage for multi-issue loop positionals (and non-regression
  for other commands' caps if the guard is shared).
- `plugin/` — regenerated mirror (`node scripts/build.mjs`) if `core/` is touched.
- `openspec/specs/pipeline-loop-facade` — delta making CLI reachability of the issue-list
  form an explicit, falsifiable requirement (today the living scenario assumes
  normalization runs; the guard prevents that).
- No durable-loop store, engine, or selector-resolution semantic change; no GitHub API
  surface change.
