## Why

Per-issue advances already expose structured observation via `pipeline logs <run-id>
--events --follow` against `.agent-pipeline/runs/<id>/events.jsonl`. The durable loop
supervisor appends the same class of JSONL events under the loop state home
(`<state-home>/runs/<loop-id>/events.jsonl` — kinds such as `loop_item_started`,
`loop_schedule_evaluated`, `loop_reconciled`, `loop_item_transitioned`,
`loop_run_stopped`), but there is no first-class CLI to dump or follow that stream.
Operators and harnesses must know an undocumented path and use `tail -F`, which breaks
parity with single-issue monitoring and blocks skill orchestration that only has a
loop `run_id` (see the v1.28.2 harness cluster: #665 handoff → #666 logs → #667
dispatch linkage → #668 skill).

## What Changes

- **First-class loop event log surface.** Add a CLI path that resolves a durable loop
  `run_id` to its state-home run directory and reads or follows that run's
  `events.jsonl` — preferred shape `pipeline loop logs <run-id> --events [--follow]`,
  reusing the advance logs UX (one-shot dump vs live tail).
- **Path resolution against the loop state home.** Resolve the run through the existing
  durable-loop-store home order (`AGENT_PIPELINE_STATE_HOME` → legacy override →
  `XDG_STATE_HOME/agent-pipeline/loop` → `~/.local/state/agent-pipeline/loop`) and the
  existing `runs/<run-id>/events.jsonl` layout; never against `.agent-pipeline/runs/`.
- **List + error diagnostics.** With no run id, list available durable loop run ids.
  Unknown or unsafe run ids fail non-zero with a clear error naming the expected
  state-home layout.
- **Read-only observation.** The surface is observation-only: no lock acquisition, no
  ledger write, no GitHub call, and no run-liveness lock reservation (same discipline as
  advance `pipeline logs`).
- **Tests + mirror.** Unit tests cover path resolution and dump/follow contracts with
  injected FS (and follow seam); regenerate `plugin/` if CLI surface is mirrored.

## Acceptance criteria

- [ ] `pipeline loop logs <run-id> --events` (or the chosen equivalent first-class name)
      prints the current contents of the durable loop run's `events.jsonl` and exits 0
      when the run directory exists.
- [ ] `pipeline loop logs <run-id> --events --follow` streams newly appended event lines
      (tail semantics) until the process is interrupted (SIGINT/SIGTERM); it does **not**
      require the supervisor process to still be alive, and it does **not** auto-exit when
      the run becomes terminal (document that interrupt is the stop condition — matching
      advance `pipeline logs --follow`).
- [ ] Without `--follow`, a one-shot dump of the current `events.jsonl` works for offline
      inspection (and an empty or missing file fails with a diagnostic naming
      `events.jsonl`).
- [ ] An unknown, missing, or path-unsafe run id exits non-zero and the error message
      names the expected layout under the resolved loop state home
      (`…/runs/<run-id>/events.jsonl` or the state-home root).
- [ ] Invoking the command with no run id lists durable loop run ids available under the
      loop state home (most recent first when ordering is available) and exits 0; empty
      home reports that no loop runs are available and still exits 0.
- [ ] The command is read-only: it acquires no durable loop lock, writes no ledger or
      process-identity artifact, makes no GitHub call, and holds no
      `pipeline-starting-<pid>.lock` (or other run-liveness reservation).
- [ ] Unit tests cover path resolution (state-home override, default layout, unsafe id
      rejection) and dump/follow contracts with injected FS / follow seams — no real
      network, git, or live supervisor process.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync when
      applicable, install smoke, `openspec validate --all`).

## Capabilities

### New Capabilities

- `loop-logs-follow`: first-class CLI observation of a durable loop run's append-only
  `events.jsonl` — resolve by loop `run_id` under the Pipeline loop state home, one-shot
  dump or live follow, list available runs, clear missing/invalid-id diagnostics, and
  read-only / no run-liveness-lock classification.

### Modified Capabilities

- (none) — advance `log-follow-command` requirements stay scoped to
  `.agent-pipeline/runs/`; this change adds a parallel surface for the durable loop store
  rather than changing advance logs behavior.

## Impact

- **CLI / dispatch:** `core/scripts/pipeline.ts` (or a small extracted helper) gains a
  `loop logs` subpath under the existing `pipeline loop` command family; Commander /
  positional parsing must accept a second keyword before treating remaining args as a
  loop selector.
- **Command registry / lock classification:** the observation path must remain classified
  as read-only (no starting lock), including nested forms if the registry keys by command
  name.
- **Loop store:** reuses `resolveStateHome`, `runDir`, and the events path conventions in
  `core/scripts/loop/store.ts` — no new durable schema; optional thin export of a
  path-resolution helper if one is not already public for readers.
- **Tests:** new/extended co-located tests under `core/test/` with injected FS and
  follow seams.
- **Hosts / skill:** docs or skill text may mention the new command once CLI exists;
  full skill orchestration rewrite remains #668.
- **Out of scope:** redesign of `pipeline loop --audit`; bridging per-item advance
  `events.jsonl` into the loop stream (#667 territory); live-process `--json-events`
  mirror on the supervisor (optional stretch, not required for done).
