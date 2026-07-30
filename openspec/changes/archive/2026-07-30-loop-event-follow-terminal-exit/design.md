## Context

Durable loop observation has two complementary surfaces:

1. **CLI** — `pipeline loop logs <run-id> [--events] [--follow|-f]`
   (`core/scripts/loop/logs.ts`, capability `loop-logs-follow`). Follow is
   implemented as `tail -f` with signal cleanup. Spec and help explicitly say
   follow remains open until SIGINT/SIGTERM and **does not** auto-exit on
   `loop_run_stopped` (decision D3 from #666 / archived change
   `loop-logs-follow`).

2. **Host skill orchestration** — §4b in `hosts/claude/SKILL.md` and
   `hosts/codex/SKILL.md` (capability `loop-skill-orchestration`). Step **f.
   Stop following** already says stop Monitors on `loop_run_stopped` or
   supervisor exit, but:
   - Hosts commonly arm **persistent** Monitors (`persistent: true`) that do
     not auto-die when the tailed process exits.
   - Dual-follow / custom `while true` tails (issue #684 guidance) can print
     `TERMINAL` and keep looping.
   - Command one-liners still advertise “interrupt stops follow; no auto-exit
     on terminal”, which teaches operators and agents the opposite of §4b.f.

Dogfood 2026-07-29: after completed loops, operators had to ask agents to kill
monitors — the run was terminal; the follow was not.

## Goals / Non-Goals

**Goals:**

- Make **CLI follow** terminate successfully when a material `loop_run_stopped`
  line is observed (default).
- Keep an explicit **opt-out** for interrupt-only / long-lived dashboard use.
- Make **host orchestration** require same-turn teardown of all loop and
  advance follows for that `run_id` on terminal or supervisor exit.
- Make documented dual-follow scripts **exit 0** on terminal after a final
  summary line.
- Align help, skill, README, and drift tests with the new contract.

**Non-Goals:**

- Changing supervisor stop reasons, ledger, merge policy, or event emission.
- Auto-killing Monitors unrelated to the loop `run_id` (or its published
  advance `run_id`s).
- Changing default behavior of advance `pipeline logs --follow` (single-issue
  store) in this change — only loop logs is required; shared helpers may be
  extracted if convenient without flipping advance defaults.
- Replacing #611 stage progress surface or redesigning dual-follow beyond
  terminal exit.

## Decisions

### D1 — Default until-terminal for loop logs follow (**BREAKING** relative to #666)

**Choice:** `pipeline loop logs … --follow` exits **0** when it reads a
JSONL line whose event kind is `loop_run_stopped` (after printing that line).
Malformed / non-JSON lines are ignored for terminal detection (keep streaming).
Interrupt still works and remains a valid stop.

**Why change D3 from #666:** Dogfood shows interrupt-only is the wrong default
for harness orchestration. Skill §4b already assumes terminal stop; the CLI
should not force zombie `tail -f` processes that the harness then forgets to
kill. Long-lived dashboards are the minority use case and can opt out.

**Flag shape:**

| Surface | Behavior |
| --- | --- |
| Default with `--follow` | until-terminal **on** |
| `--no-until-terminal` | restore #666 interrupt-only |
| Optional explicit `--until-terminal` | accepted as no-op affirm (or required if Commander needs a boolean pair); document default-on |

Prefer a single boolean with Commander-style `--until-terminal` /
`--no-until-terminal` where default for follow mode is `true`. Without
`--follow`, the flag is ignored (one-shot dump unchanged).

### D2 — Follow implementation: line-aware reader, not pure `tail -f` inherit

**Choice:** When until-terminal is on, follow MUST inspect each appended line
for the terminal kind. That rules out pure `stdio: "inherit"` `tail -f` as the
sole implementation for the default path (the parent never sees lines).

**Approach:**

1. Prefer an injectable **line-streaming follow** seam (read existing file
   from start or from current size, then poll/watch for appends) that:
   - writes each complete line to stdout,
   - parses JSON for `kind` / `type` / equivalent event-kind field used by the
     loop event schema,
   - on `loop_run_stopped`, flushes the line, stops following, resolves exit 0.
2. Keep `followFile` / signal cleanup for `--no-until-terminal` (current
   `tail -f` path) **or** use the same line reader without the exit check so
   one code path serves both.
3. Unit tests inject a fake stream of lines (or a deps method
   `followEvents(path, { untilTerminal })`) — no real `tail`, no live
   supervisor.

**Event shape:** Confirm against real `events.jsonl` writers in
`core/scripts/loop/` (do not invent field names). Detection MUST match the
same kind string already listed in skill material events (`loop_run_stopped`).

### D3 — Skill: same-turn stop is normative, not advisory

**Choice:** Strengthen §4b.f (and dual-follow guidance) to:

- On material `loop_run_stopped` **or** supervisor process exit: stop **all**
  Monitors/follows for that loop `run_id` **and** any advance follows started
  for that run’s items — **in the same harness turn**.
- Dual-follow / multi-stream scripts SHALL `exit 0` after printing a final
  summary line that includes terminal reason when available; they SHALL NOT
  continue a `while true` after terminal observation.
- Final operator summary SHALL include terminal reason + “follows stopped”.

Do not require killing unrelated Monitors (other issues, other runs).

### D4 — Drift guards cover language and CLI behavior

**CLI:** Unit test that when until-terminal is default/on and a
`loop_run_stopped` line is delivered, `runLoopLogs` completes with exit 0
without requiring a simulated interrupt. A second test that
`--no-until-terminal` does not exit solely on that line.

**Skill/packaging:** Extend packaging/skill drift tests (same family as
loop-skill-orchestration seconds/no-Monitor guards) so that §4b stop language
still requires stop-on-`loop_run_stopped` / same-turn teardown / dual-follow
exit — fail if help reintroduces unconditional “no auto-exit on terminal” as
the only documented follow stop condition.

### D5 — Docs and command surface one-liners

Update:

- Host skill command tables and §4b.f / dual-follow snippets
- `README.md` loop logs follow notes
- Operation-surface / help strings that currently say “interrupt stops follow;
  no auto-exit on terminal”

Regenerate `plugin/` via `node scripts/build.mjs` when packaging sources change.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| **BREAKING** for operators who scripted interrupt-only follow and expect hang after terminal | Document opt-out `--no-until-terminal`; keep SIGINT behavior; call out in proposal/help |
| Partial JSON lines at EOF while file grows | Only evaluate complete lines (newline-delimited); buffer incomplete tail |
| Terminal event already present before follow starts | Dump-then-follow / read existing content first: if `loop_run_stopped` already in file, print remaining lines (or at least stream existing) and exit 0 without hanging — document “historical terminal ends follow” |
| Mis-detecting non-terminal kinds | Match exact kind `loop_run_stopped` only; ignore other events |
| Harness ignores skill and keeps persistent Monitor | Drift-guard + skill text; CLI auto-exit still kills the CLI follow even if Monitor wrapper is sticky — skill must still kill the Monitor tool itself |
| Dual path (tail vs line reader) complexity | Prefer one line-reader implementation with a flag for exit-on-terminal |

## Migration Plan

1. Ship CLI default until-terminal + flag + tests.
2. Update skill/README/help in the same PR; regenerate plugin mirror.
3. No durable store schema migration; no state-home change.
4. Rollback: re-default until-terminal off would restore #666 behavior (not
   preferred); operators can use `--no-until-terminal` without rollback.

## Open Questions

- Exact Commander flag names: prefer `--until-terminal` / `--no-until-terminal`
  with default `true` when `--follow` is set. Confirm allowlist entries in
  `command-registry` / loop allowedFlags.
- Whether historical `loop_run_stopped` already present at follow start MUST
  exit immediately after replaying existing content (recommended: **yes**).
- Whether advance `pipeline logs --follow` should gain the same default later
  (out of scope unless a tiny shared helper lands without flipping advance
  defaults).
