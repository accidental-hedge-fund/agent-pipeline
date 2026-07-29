## Context

Advance runs already have a mature observation path:

- Store: `.agent-pipeline/runs/<run-id>/{terminal.log,events.jsonl}`
- CLI: `pipeline logs [<run-id>] [--events] [--follow|-f]` in `runLogs`
  (`core/scripts/pipeline.ts`)
- Follow implementation: `spawn("tail", ["-f", logFile], { stdio: "inherit" })`
  until the child exits or errors; no auto-exit when the advance process dies

Durable loop runs store a different artifact tree under the Pipeline loop state
home (capability `durable-loop-store`):

```
<state-home>/runs/<run-id>/
  contract.json
  ledger.json
  lock.json?          # exclusive writer token
  events.jsonl        # dense append-only event log (target of this change)
  decisions.jsonl
  supervisor.json?    # process identity
  action-evidence.jsonl?
```

State-home resolution (already implemented in `loop/store.ts`):

1. `AGENT_PIPELINE_STATE_HOME` (verbatim)
2. legacy `PIPELINE_STATE_HOME` (migration fallback)
3. `$XDG_STATE_HOME/agent-pipeline/loop`
4. `~/.local/state/agent-pipeline/loop`

The supervisor already appends event kinds such as `loop_item_started`,
`loop_schedule_evaluated`, `loop_reconciled`, `loop_item_transitioned`, and
`loop_run_stopped`. Operators today must open
`~/.local/state/agent-pipeline/loop/runs/<id>/events.jsonl` by hand.

`pipeline loop` today owns start/resume/audit for durable runs; there is no
`logs` sub-verb. Issue #666 asks for first-class follow parity so harnesses that
receive a loop `run_id` (#665 handoff) can observe the run without path trivia.

## Goals / Non-Goals

**Goals:**

- Give operators and harnesses a first-class CLI to dump or follow a durable
  loop run's `events.jsonl` by `run_id`
- Resolve paths exclusively through the loop state-home contract (same as
  store/status)
- Match advance follow UX: interrupt-stopped tail, works after supervisor exit
- Clear missing/invalid diagnostics that name the expected layout
- Read-only observation (no lock, no writes, no run-liveness reservation)
- Unit-testable with injected seams

**Non-Goals:**

- Redesigning `--audit` or the action-evidence report format
- Merging child advance stage events into the loop event stream (#667)
- Skill packaging / orchestration rewrite (#668)
- Emitting live `--json-events` from the supervisor process (stretch; may land
  later without changing this CLI contract)
- Following `decisions.jsonl` or `action-evidence.jsonl` in v1 (events only)
- Changing advance `pipeline logs` behavior or the `.agent-pipeline/runs/` layout

## Decisions

### D1 — Nested CLI: `pipeline loop logs …` (not overloading `pipeline logs`)

**Choice:** Primary surface is `pipeline loop logs [<run-id>] [--events]
[--follow|-f]`.

**Why over extending `pipeline logs`:**

| Option | Pros | Cons |
| --- | --- | --- |
| A. `pipeline loop logs <id>` | Store is unambiguous; groups with loop family; no ID collision with advance run ids | Slightly longer; needs nested dispatch under `loop` |
| B. `pipeline logs <id>` tries advance then loop | One command | Silent dual-home lookup; confusing errors; accidental read of the wrong store if ids ever collide |
| C. `pipeline logs --loop <id>` | Reuses `logs` verb | Flag soup; still couples two stores in one handler |

Issue acceptance criteria allow either. Nested wins because the two stores are
intentionally separate namespaces (`durable-loop-store` never writes under
`.agent-pipeline/runs/`), and operators already think in `pipeline loop …`
terms for multi-item work.

### D2 — `--events` is required-or-default for the stream selection

Loop runs do **not** have a `terminal.log` in the store contract. Therefore:

- The selected artifact for this command is always `events.jsonl`
- `--events` is accepted for parity with advance `pipeline logs --events` and
  may be the documented form
- Omitting `--events` still reads `events.jsonl` (there is no other default log
  file); the command SHALL NOT invent a terminal.log path or fail solely because
  `--events` was omitted

If a future change adds a loop terminal stream, a new flag or default can be
introduced without breaking the events path.

### D3 — Follow stop condition: interrupt only (not terminal auto-exit)

**Choice:** `--follow` keeps streaming until SIGINT/SIGTERM (or the tail child
exits/errors), matching advance `runLogs`. It does **not** watch for
`loop_run_stopped` and exit automatically.

**Rationale:** Auto-exit on terminal requires parsing JSONL, handling partial
lines, and deciding what “terminal” means for held/paused runs. That is a
behavior product decision and a divergence from advance logs. Document the
interrupt stop condition in help text and the skill once #668 lands. A later
`--until-terminal` flag can be additive if operators need it.

### D4 — Reuse store path helpers; inject FS + follow seams

**Path resolution:** Call existing `resolveStateHome` / `runDir` (and a thin
events-path helper if exported, or `path.join(runDir(…), "events.jsonl")`) so
state-home precedence and unsafe-id rejection stay single-sourced with the
store. Do not reimplement path rules in the CLI.

**Dump mode:** read the file through an injectable read/stat seam (loop store
deps or a small `LoopLogsDeps` mirror of `RunStoreDeps`).

**Follow mode:** inject a follow/tail starter (default: `tail -f` like advance)
so unit tests assert “follow was invoked with the resolved absolute path” without
spawning a real `tail`. Failure to start follow (missing file, spawn error)
exits non-zero rather than hanging forever — same invariant as #155 advance logs.

### D5 — List mode when run id is omitted

`pipeline loop logs` with no run id enumerates directories under
`<state-home>/runs/` that look like durable runs (at minimum: directory present;
prefer those with `contract.json` or `events.jsonl` if cheap). Order most recent
first when mtime is available through the injected seam; otherwise a stable
sort is acceptable. Empty → friendly message, exit 0 (mirror advance list
behavior).

### D6 — Error copy names the state-home layout

On missing run directory:

```
pipeline loop logs: unknown run-id '<id>'
  Expected: <resolved-state-home>/runs/<id>/
```

On missing events file when the run dir exists:

```
pipeline loop logs: events.jsonl not yet written for run '<id>'
  Path: <resolved>/events.jsonl
```

Unsafe run ids (path separators, `..`) are rejected with the store's validation
message (or equivalent), never used as a path segment.

### D7 — Read-only / no liveness lock

The command is pure observation. Implementation MUST NOT call
`acquireLock` / ledger writers / supervisor attach. Launcher classification:
whatever path nests under `loop logs` must not create
`pipeline-starting-<pid>.lock`. If the registry currently treats any `loop`
invocation as run-mutating, refine classification so the `logs` sub-verb is
read-only (pure function of argv), without weakening genuine
start/resume mutation paths.

### D8 — CLI dispatch shape

Today `numArg === "loop"` routes entirely into `runLoopCommand`. Extend that
branch (or pre-branch) so when the next positional is the literal `logs`,
dispatch to `runLoopLogs` and do **not** enter preflight/supervisor drive.
Flags: reuse global `--follow` / `-f` and `--events` already registered on the
root Commander program (same as advance logs). No new global flags required.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Nested `loop logs` confuses operators who try `pipeline logs <loop-id>` | Error on advance logs for unknown advance id can later hint "if this is a loop run, use `pipeline loop logs …`" (optional polish; not required for AC) |
| `tail -f` on missing file hangs or errors OS-dependently | Pre-stat the file in follow mode; fail non-zero if absent (advance already documents this) |
| State-home env differs between supervisor host and observer host | Document that observation uses the **local** state home resolution; cross-host log follow is out of scope (loop store is host-local by design, #459) |
| Command-registry still classifies all `loop` as mutating | Explicit sub-verb classification test; fix registry/classifier |
| Partial JSONL line during follow | Dump/follow streams raw bytes/lines like advance; no JSON parse required for v1 |

## Migration Plan

- Additive CLI only; no durable schema change; no archive of old logs
- Existing runs immediately observable once CLI lands (same files already written)
- Rollback: remove the sub-verb; store layout unchanged

## Open Questions

- None blocking implementation. Optional later: auto-exit on `loop_run_stopped`,
  `--json-events` on the live supervisor, and advance-logs hint when a loop id is
  passed to `pipeline logs`.
