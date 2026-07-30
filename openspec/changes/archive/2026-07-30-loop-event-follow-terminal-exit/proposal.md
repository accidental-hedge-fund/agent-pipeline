## Why

Durable `pipeline:loop` already has a terminal event (`loop_run_stopped`) and a
terminal result JSON, but **event-follow processes do not terminate with the
run**. CLI help and `loop-logs-follow` currently document that
`pipeline loop logs … --events -f` keeps streaming until interrupt with **no
auto-exit on terminal**. Host skill §4b.f says harnesses must stop Monitors on
`loop_run_stopped`, yet persistent Monitors and dual-follow tails keep running
after the supervisor is gone unless the operator kills them. Dogfood 2026-07-29:
operators twice had to ask agents to stop monitors after completed loops
(`loop-e640995c20b8f046`, `loop-9481a87374ecd4cc`). The loop has a terminal
state; the follow process does not — that mismatch burns operator trust and
leaves zombie follows.

## What Changes

- **Skill / host orchestration (packaging).** Strengthen §4b (and dual-follow
  guidance) so that on material `loop_run_stopped` (any reason) or supervisor
  process exit, the host **stops all loop and advance Monitors/follows for that
  `run_id` in the same turn** — not wait for the operator. Dual-follow scripts
  **exit 0** after observing `loop_run_stopped` and printing a final summary
  line (not `print TERMINAL` and keep looping). Final operator summary for a
  completed loop includes run terminal reason + “follows stopped”.
- **CLI follow (engine) — BREAKING default.** Change
  `pipeline loop logs <run-id> --events --follow` so it **exits successfully
  when a `loop_run_stopped` event is read** by default (until-terminal). Provide
  an explicit opt-out (e.g. `--no-until-terminal`) for long-lived dashboards that
  want interrupt-only behavior. Update help text so it no longer claims
  unconditional “no auto-exit on terminal” without documenting the
  until-terminal default.
- **Tests / drift guards.** Skill/prompt drift test (or packaging check) that
  dual-follow / §4b.f language requires stop-on-`loop_run_stopped`. Unit or
  integration test that `loop logs --events --follow` exits on
  `loop_run_stopped` when until-terminal is on (the default).
- **Docs.** Align README / command-surface one-liners with the new follow
  contract; regenerate `plugin/` when packaging or mirrored CLI help changes.

## Acceptance criteria

- [ ] Host skill text (Claude and Codex) requires that on `loop_run_stopped` or
      supervisor process exit the harness stops **all** loop and advance
      Monitors/follows for that loop `run_id` **in the same turn** (no operator
      kill step required).
- [ ] Documented dual-follow (or equivalent multi-stream follow) pattern
      **exits the follow process** after observing `loop_run_stopped` and printing
      a final summary line — not an infinite `while true` that only prints
      `TERMINAL` and continues.
- [ ] Final operator summary for a completed loop includes the run’s terminal
      reason **and** an explicit “follows stopped” (or equivalent) confirmation.
- [ ] `pipeline loop logs <run-id> --events --follow` **auto-exits successfully**
      when a `loop_run_stopped` event is read, by default (or via a documented
      `--until-terminal` default-on path).
- [ ] An explicit flag restores interrupt-only follow (e.g.
      `--no-until-terminal`) for long-lived dashboards.
- [ ] CLI help / command one-liners no longer claim unconditional “no auto-exit
      on terminal” without documenting the until-terminal default; help matches
      behavior.
- [ ] A regression test proves follow exits on `loop_run_stopped` under the
      default until-terminal path (fails without the implementation).
- [ ] A packaging/skill drift-guard fails if §4b stop-on-terminal / dual-follow
      exit language is removed or weakened to “interrupt only / operator must
      kill”.
- [ ] After a dogfood-style stop (e.g. `supervisor_no_progress` or any
      `loop_run_stopped` reason), no loop/advance follow for that `run_id`
      remains running without an operator kill (observable via process list or
      Monitor teardown in the same turn).
- [ ] `npm run ci` is green (core tests, mirror check when packaging changes,
      install smoke, `openspec validate --all`).

## Capabilities

### New Capabilities

- (none) — this change tightens existing loop follow and skill-orchestration
  contracts rather than introducing a new surface family.

### Modified Capabilities

- `loop-logs-follow`: follow mode default becomes exit-on-`loop_run_stopped`
  (until-terminal); interrupt-only remains available via explicit opt-out; help
  text matches.
- `loop-skill-orchestration`: host stop-on-terminal is same-turn mandatory for
  all loop+advance follows of the run; dual-follow patterns must exit the
  process; final summary must report terminal reason + follows stopped; drift
  guard covers stop language.

## Impact

- **CLI:** `core/scripts/pipeline.ts` (or extracted loop-logs helper) —
  follow/until-terminal parsing, JSONL line classification for
  `loop_run_stopped`, exit path; Commander help strings.
- **Tests:** `core/test/` — loop logs follow until-terminal regression;
  packaging/skill drift for §4b stop language (and dual-follow exit if that
  pattern is checked in-repo).
- **Hosts / packaging:** `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`,
  generated `plugin/pipeline/commands/pipeline:loop.md` / skill mirrors /
  command-surface one-liners; `README.md` follow notes.
- **Out of scope:** supervisor stop reasons or merge policy; auto-killing
  unrelated Monitors in the session; replacing #611 stage progress surface;
  changing advance `pipeline logs --follow` (single-issue) unless a shared
  helper is reused without changing advance default.
- **Related issues (context only):** #665–#668 followability, #684 dual-follow
  skill, #682 gate sub-events on loop stream — not required deliverables here.
