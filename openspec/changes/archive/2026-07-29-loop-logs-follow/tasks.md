## 1. CLI dispatch and path resolution

- [x] 1.1 Add a `pipeline loop logs` dispatch branch so a second positional `logs` routes to a
      dedicated handler and never enters loop preflight or the supervisor drive path
- [x] 1.2 Implement `runLoopLogs` (or equivalent) that resolves the run via durable-loop-store
      helpers (`resolveStateHome` / `runDir`) to `<state-home>/runs/<run-id>/events.jsonl`
- [x] 1.3 Accept `--events` and `--follow`/`-f` (reuse existing root flags); treat the selected
      artifact as `events.jsonl` even when `--events` is omitted
- [x] 1.4 Inject FS + follow seams (`LoopLogsDeps` or reuse store reader deps) so unit tests need
      no real filesystem, network, git, or `tail` process

## 2. Dump, list, and error paths

- [x] 2.1 One-shot dump: print full current `events.jsonl` and exit 0 when present
- [x] 2.2 Missing run directory: exit non-zero; error names the run id and expected
      `<state-home>/runs/<run-id>/` layout
- [x] 2.3 Missing `events.jsonl` on dump: exit non-zero; diagnostic names `events.jsonl`
- [x] 2.4 Path-unsafe run ids: reject without traversing outside the runs root
- [x] 2.5 No run id: list available durable loop run ids under `<state-home>/runs/` (most recent
      first when ordering is available); empty home → friendly message, exit 0

## 3. Follow mode

- [x] 3.1 `--follow`: stream new lines as appended (default starter: `tail -f` parity with advance
      `runLogs`), remaining open until interrupt or follow failure
- [x] 3.2 Pre-check / fail closed when `events.jsonl` is absent or the follow starter errors —
      non-zero exit, no hang
- [x] 3.3 Document (help text / command comment) that follow stops on interrupt, not on terminal
      stop events

## 4. Read-only classification

- [x] 4.1 Ensure nested `loop logs` acquires no durable store lock and writes no run artifacts
- [x] 4.2 Ensure the launcher/classifier treats `loop logs` as read-only (no
      `pipeline-starting-<pid>.lock`) while genuine loop start/resume remains run-mutating;
      cover with a pure-function unit test

## 5. Tests

- [x] 5.1 Path resolution: state-home override, default/XDG layout, unsafe id rejection; never
      reads `.agent-pipeline/runs/`
- [x] 5.2 Dump contract: existing events printed; missing run / missing file error copy
- [x] 5.3 List contract: ids listed; empty home message; exit 0
- [x] 5.4 Follow contract: follow seam invoked with resolved absolute events path; missing-file
      follow fails non-zero; no auto-exit requirement on terminal events (document-only is fine
      if pure)
- [x] 5.5 Read-only classifier: `loop logs` → no reservation; loop start/resume → reservation
- [x] 5.6 Prove regressions bite where practical (e.g. wrong store path or missing nested dispatch)

## 6. Mirror, docs touch, and CI

- [x] 6.1 If any host/skill help lists loop subcommands, add a one-line `loop logs` mention
      (no full skill orchestration rewrite — that is #668)
- [x] 6.2 Run `node scripts/build.mjs` and include regenerated `plugin/` when core surfaces change
- [x] 6.3 Run `npm run ci` from the repo root; treat red as not-done
- [x] 6.4 `openspec validate loop-logs-follow` (and `--all` via ci) remains green
