## Why

The `pipeline:loop` host command is mis-classified as a seconds-long synchronous
operation. Generated packaging (`scripts/build.mjs` → `plugin/pipeline/commands/pipeline:loop.md`
and the installed Claude command surface) currently says “Run synchronously
(completes in seconds). No background process or Monitor needed.” That is false for
multi-item durable runs: live v1.28.2 evidence includes a ~32-minute loop that wrote
events the whole time while harnesses were instructed not to stream them. Single-issue
`/pipeline N` already has detach + `logs --events --follow` + material Push guidance;
loop harness UX needs parity so operators and harnesses see item starts, transitions,
blocks, and terminal stop without guessing.

## What Changes

- Reclassify the `loop` operation in the single-source command surface so generated
  host command docs **do not** claim seconds-only duration or forbid Monitor /
  background following.
- Author explicit **loop orchestration** guidance (command shim + host `SKILL.md`
  variants) matching single-issue advance shape: start/resume loop → parse early
  handoff (`run_id` + events path) → follow loop events → optional follow of active
  item advance events when published → stop on terminal loop outcome / process exit →
  print summary / `--audit`.
- Document the **material loop event kinds** worth notifying on (at minimum
  `loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`,
  `loop_run_stopped`, plus schedule/reconcile kinds as appropriate).
- Document an **interim follow path** against the loop state-home events file
  (`<state-home>/runs/<run_id>/events.jsonl`) when a dedicated loop logs CLI is not
  yet available — so skill text never requires a non-existent CLI, and never forbids
  monitoring.
- Add a **drift-guard** test (and/or install/check assertion) that fails if the
  forbidden “completes in seconds / no Monitor” guidance returns on the loop surface.
- Regenerate `plugin/` (and host install projections) in the same change as the
  packaging source edits.

## Acceptance criteria

- [ ] Generated `pipeline:loop` command docs (plugin + installed Claude surface after
      build/install) contain **neither** “completes in seconds” **nor** “No background
      process or Monitor needed” (case-insensitive substring match).
- [ ] Loop orchestration docs state the ordered harness steps: start/resume → parse
      early handoff (`run_id` + events path) → follow loop events → optional per-item
      advance-event follow when published → stop on terminal loop outcome or process
      exit → print summary/`--audit`.
- [ ] Docs list material loop event kinds including at least `loop_item_started`,
      `loop_item_transitioned`, `loop_item_blocked`, and `loop_run_stopped`.
- [ ] Docs provide a working interim follow path to the loop store
      `events.jsonl` (state-home layout) that does not depend on a not-yet-shipped CLI,
      and do not require a CLI that does not exist.
- [ ] Read-only `--audit` (and other true seconds-long loop modes, if any) remain
      documented as synchronous; only multi-item drive/resume is long-running.
- [ ] A unit/install drift-guard fails when the forbidden seconds/no-Monitor phrase is
      reintroduced for the `loop` operation.
- [ ] `plugin/` mirror (and host packaging sources) are updated in the same change;
      `npm run ci` is green.

## Capabilities

### New Capabilities
- `loop-skill-orchestration`: harness-facing orchestration contract for
  `pipeline:loop` — long-running classification, handoff parsing, event following,
  material notification kinds, interim follow path, and drift-guard against
  seconds-only / no-Monitor packaging.

### Modified Capabilities
- `namespaced-command-surface`: the `loop` entry’s generated orchestration note is
  long-running (not the shared “fast” seconds/no-Monitor template); other true-fast
  operations remain unchanged.
- `pipeline-loop-facade`: packaging/docs for the facade command SHALL describe
  durable multi-item runs as long-running and SHALL point harnesses at loop-event
  streaming rather than synchronous fire-and-forget.

## Impact

- `scripts/build.mjs` — `OPERATION_SURFACE` entry for `loop` (`fast` flag and/or
  dedicated orchestration note for `inRepoLoop`); `renderClaudeCommand` output for
  `pipeline:loop.md`.
- `plugin/pipeline/commands/pipeline:loop.md` — regenerated.
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and the plugin SKILL mirror —
  loop orchestration section (parity with single-issue Monitor guidance).
- `core/test/namespaced-commands.test.ts` (and/or a dedicated packaging test) —
  drift-guard regression.
- **Out of scope for this change:** implementing early handoff CLI (#665), loop logs
  follow CLI (#666), or dispatch→advance `run_id` linkage (#667). Skill text may
  document interim file follow and “when published” optional item streams without
  requiring those CLIs to ship first.
- **Not changing:** loop supervisor algorithms, event emission semantics, merge
  policy, or single-issue advance orchestration.
