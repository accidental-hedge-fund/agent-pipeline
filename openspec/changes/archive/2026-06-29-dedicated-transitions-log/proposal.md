## Why

The pipeline writes all of its output — stage-transition lines, Codex/harness
prose, and the full unit-test runner stdout from the test gate — to a single
operator log (`/tmp/pipeline-<domain>-<N>.log`, the shell redirection target in
SKILL.md §4b). A 5-stage run can produce 80K+ lines, so the handful of
`[pipeline] #N:` lifecycle lines get buried. Operators monitor them today with a
fragile `tail -f … | grep -E` filter; the test gate dumps eval-gate/state-machine
fixtures that reproduce `[pipeline] #N:` and `→ ready-to-deploy` substrings for
arbitrary issue numbers, so the filter either floods (broad alternation) or risks
missing a transition whose format the pattern didn't anticipate.

The root cause is that there is no dedicated channel for pipeline state changes:
`printOutcome` (the `from → to` / `blocked` lines), the run start/`done` lines,
and the `unblocked` line all go to `console.log`, sharing one stream with every
other byte of harness/CI output.

## What Changes

- Mirror every `[pipeline] #N:` lifecycle line the orchestrator prints — run
  start (`starting at stage=…`, `run id …`), each transition (`from → to: …`),
  each blocked/idle outcome (`at <stage> — <status>: …`), `unblocked at <stage>`,
  the `pipeline label removed; stopping.` line, and the terminal `done — …` line —
  to a dedicated, append-only transitions log at
  `/tmp/pipeline-<domain>-<N>.transitions.log`, in addition to the existing full
  log.
- Make monitoring a plain `tail -f /tmp/pipeline-<domain>-<N>.transitions.log`
  with no grep filter and no false matches from test-gate fixtures.
- Update the host orchestration guidance (SKILL.md, all three variants) to point
  operators at the transitions log as the preferred monitor source.
- Have `--cleanup` remove the transitions log for each merged-PR issue it sweeps,
  so `/tmp` does not accumulate stale per-issue transitions files.

The full log's content and format are unchanged — the transitions log is a strict
addition (every transitions-log line is also a line that already appears,
verbatim, in the full log).

## Acceptance Criteria

- [ ] Every `[pipeline] #N:` lifecycle line — run-start (`starting at stage=…` and
  `run id …`), transition (`from → to: …`), blocked/idle (`at <stage> — …`),
  `unblocked at <stage>`, `pipeline label removed; stopping.`, and the terminal
  `done — …` line — is appended to `/tmp/pipeline-<domain>-<N>.transitions.log`.
- [ ] Each line written to the transitions log is byte-for-byte the same line
  written to stdout / the full log (no reformatting, no added prefix).
- [ ] The transitions log is append-only: a second dispatch for the same issue
  appends to, and never truncates, the existing file.
- [ ] The full log (stdout) still receives every line it received before — the
  transitions log is additive and removes nothing from the existing stream.
- [ ] `tail -f /tmp/pipeline-<domain>-<N>.transitions.log` shows the run's stage
  transitions in real time with no `grep` filter and contains no lines from the
  test-gate fixtures or harness/CI prose.
- [ ] The transitions-log path is derived from `cfg.domain` and the issue number
  `N` (`/tmp/pipeline-<domain>-<N>.transitions.log`), matching the existing
  `/tmp/pipeline-<domain>-…` lock/disabled/log naming convention.
- [ ] `pipeline --cleanup` removes `/tmp/pipeline-<domain>-<N>.transitions.log`
  for each issue `N` whose merged-PR worktree it sweeps.
- [ ] All three SKILL.md variants (`hosts/claude`, `hosts/codex`, generated
  `plugin/`) document the transitions log as the recommended monitor source.
- [ ] A transitions-log write failure is non-fatal: the run continues and the full
  log is unaffected.

## Capabilities

### New Capabilities
- `transitions-log`: a dedicated, append-only per-issue file that mirrors the
  pipeline's stage-transition / lifecycle lines for grep-free real-time
  monitoring, with host guidance and cleanup behavior.

### Modified Capabilities
- None. The existing full-log monitor guidance (`monitor-filter-guidance`) remains
  valid for operators who tail the full log; this change adds the transitions log
  as the preferred path without removing the full-log filter behavior.

## Impact

- `core/scripts/pipeline-run.ts` (lifecycle/`printOutcome` emission) and
  `core/scripts/pipeline.ts` (the `unblocked` line and the `--cleanup` sweep).
- A small append-only writer helper plus its unit tests under `core/test/`.
- Host skill docs (`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`) and the
  regenerated `plugin/` mirror.
- No change to the full log, JSON event stream, or run-store artifacts.

## Out of Scope

- Structured JSON transition events (tracked by the `events.jsonl` work).
- Changing the full log format or the run-store `terminal.log` contract.
- Auto-merge or any change to where the pipeline stops.
