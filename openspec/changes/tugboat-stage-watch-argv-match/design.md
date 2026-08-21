## Context

See `proposal.md` for why. Current law and code:

- Bundled `examples/supervisor/shell/ship-stage-watch.sh` accepts
  `--events-file` (absolute), optional `--label` / `--channel` /
  `--reply-to` / `--once` / `--pid-file`. It rejects `--milestone` with
  `unknown argument` and exit 2. It waits for that exact file; it does
  not glob latest runs.
- Tugboat defaults `SHIP_STAGE_WATCH_BIN` to that sibling, then launches
  it with `--milestone "v$version" --since … --pid-file …` and immediately
  logs `stage-watch started pid=$!`.
- Hermes skill, ship-milestone runbook, and `examples/supervisor/README.md`
  already document `--events-file` and “do not discover latest.”
- Living `integrated-train-mode`: `train --json` stdout is one
  `train_status` object. Nested singles SHALL NOT write handoff JSON to
  that stdout. Child progress MAY use stderr or the child run’s events.
- Train advance-wave `onRunReady` already holds `ctx.events`. It logs
  `[train] advance-wave loop ready ${runId}` on stderr and does not emit
  `events` or a `loop_run_handoff` line.
- Site: ship v1.39.8 `stage-watch.log` at `2026-08-21T01:51:23Z`.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is Tugboat’s train watch spawn passing
   `--milestone` on v1.39.8. The class is: any composer that launches the
   bundled stage-watch MUST use argv that script accepts, MUST bind to the
   live train/loop handoff absolute `events` path, and MUST treat argv
   reject as a named failure. A PATH leftover `--milestone` binary or a
   human restart of that binary is not the class fix.
2. **Shared surfaces.** Argv contract lives in `tugboat-thin-ship`. The
   live `events` path is `loop-early-run-handoff` field `events`. Train
   SHALL emit that handoff on stderr so a composer can read it without
   mixing JSON onto `train --json` stdout (`integrated-train-mode`). The
   extract test binds Tugboat launch to bundled `usage` / argv parser.
3. **Next identical fault.** A later Tugboat (or thin launcher) that
   passes `--milestone` while bundled usage only documents `--events-file`
   fails the same living spec and extract test. A later train advance-wave
   that omits `events` on the stderr handoff fails the train-side check.
   No new mole issue for the same argv mismatch.

## Goals / Non-Goals

**Goals:**

- Tugboat train watch argv matches bundled `ship-stage-watch.sh`.
- Tugboat binds `--events-file` to the live handoff absolute `events`
  path and still starts watch in time to observe train stage events.
- Immediate argv-reject spawn is a named failure, not “started.”
- Train emits that `events` path on stderr without changing
  `train --json` stdout.

**Non-Goals:**

- Adding `--milestone` / `--since` to the bundled script.
- Host-global latest-run discovery.
- Changing `train --json` stdout to mixed handoff + `train_status`.
- Failing the ship because watch notify is down.
- Requiring `~/.local/bin/ship-stage-watch` on PATH.
- KEY_FILE loader, `train.complete.json`, second production pin, killing
  an in-flight ship, human `git tag` / `--skip-frg`.

## Decisions

### 1. Align Tugboat to `--events-file`; do not restore `--milestone` on the bundled script

**Choice:** Product watch stays `--events-file` only. Tugboat SHALL pass
`--events-file <absolute>` plus documented optional flags (`--label`,
`--pid-file`). Tugboat SHALL NOT pass `--milestone` or `--since`.

**Why:** The bundled script, Hermes skill, and ship-milestone runbook
already forbid latest discovery. Restoring `--milestone` on the helper
would either reintroduce discovery or still need an events path inside
the helper. The leftover PATH binary is not the product.

**Alternatives considered:**

- Teach bundled `ship-stage-watch.sh` to accept `--milestone` / `--since`
  → rejected. That leftover contract discovers runs. Out of scope, and
  it would keep two argv dialects.
- Keep `--milestone` in Tugboat and document PATH install of the old
  binary → rejected. AC 4 forbids requiring that leftover.

### 2. Train emits `loop_run_handoff` on stderr; Tugboat consumes `events`

**Choice:** When a train advance-wave loop is ready, train SHALL write
one flushed JSON line to stderr with `kind: loop_run_handoff` and the
absolute `events` field from `ctx` (same formatter as `pipeline loop`).
Tugboat SHALL parse that line from this train’s stderr capture and pass
`--events-file` with that path. Tugboat SHALL NOT glob
`~/.local/state/agent-pipeline` or pick newest mtime. Tugboat SHALL
start watch after the first such path is known, while train is still
running. The bundled watch already waits if the file is not created yet.

**Why:** `train --json` stdout must stay one `train_status`. Nested
handoff on that stdout is forbidden. `onRunReady` already has
`ctx.events`. Emitting the same handoff kind on stderr is the live
handoff, not a reconstructed path. Reconstructing
`<state-home>/runs/<runId>/events.jsonl` from a prose ready line would
drift when state-home resolution changes.

**Alternatives considered:**

- Reconstruct events path from `[train] advance-wave loop ready <runId>`
  → rejected. That is not the handoff `events` field. State-home
  precedence is easy to get wrong.
- Change train stdout to stream `loop_run_handoff` then `train_status`
  → rejected. Living `integrated-train-mode` forbids nested handoff on
  train `--json` stdout. `train-status-complete.py` expects the last
  `train_status`.
- Start watch only after train exits → rejected. Stage posts during
  planning/review/implement would still be missing.
- Discover latest `events.jsonl` under the loop store → rejected. Out
  of scope and living supervisor law.

### 3. Named argv-reject; do not claim a live pid

**Choice:** After spawning the watch, Tugboat SHALL observe immediate
exit (argv parse happens before the wait-for-file loop). On non-zero
exit, Tugboat SHALL log `stage-watch argv rejected` (or equivalent) and
SHALL NOT log `stage-watch started pid=…` for that spawn. Tugboat SHALL
NOT treat a pid-file from a dead process as a live watch. Train SHALL
still run. Watch failure SHALL NOT fail the ship (notify remains
observational).

**Why:** v1.39.8 logged “started” for pid 2009569 which had already
exited 2. Operators read that as a live channel. Named failure is the
visible class. Failing the ship on watch argv would couple observational
notify to the train gate.

**Alternatives considered:**

- Keep fire-and-forget `log started pid=$!` → rejected. That is the
  1.39.8 site.
- Fail the train phase on watch argv reject → rejected.
  `supervisor-ship-notify` is observational. Stage posts must not become
  a ship gate.

### 4. Regression extracts Tugboat launch and bundled usage

**Choice:** Add a co-located test in `core/test/tugboat.test.ts` that
reads `examples/supervisor/shell/tugboat.sh` (train watch spawn in
`ship_one`) and `examples/supervisor/shell/ship-stage-watch.sh` (`usage`
and argv `case`). The test SHALL fail if Tugboat’s watch argv includes
`--milestone` while the bundled usage / parser only documents
`--events-file`. Keep existing `core/test/ship-stage-watch.test.ts`
(absolute file required; no global discovery). Add a train-side unit
check that advance-wave `onRunReady` writes `kind: loop_run_handoff`
and an absolute `events` path on stderr.

**Why:** The v1.39.8 helper is exactly “Tugboat `--milestone` + bundled
`--events-file` only.” Extracting both files is the class gate. A
Tugboat-only regex would miss a later helper that re-grows `--milestone`
in the bundled script.

**Alternatives considered:**

- Source-assert Tugboat only (`assert.doesNotMatch(/--milestone/)` on
  the whole script) → rejected. Tugboat itself takes `--milestone` for
  ship. The test must target the watch spawn, not the composer CLI.
- End-to-end live ship with Buzz → rejected. Unit tests inject I/O and
  do not start a live train or messenger.

### 5. Default `SHIP_STAGE_WATCH_BIN` stays the sibling

**Choice:** Keep
`SHIP_STAGE_WATCH_BIN="${SHIP_STAGE_WATCH_BIN:-$SCRIPT_DIR/ship-stage-watch.sh}"`.
Do not prefer `~/.local/bin/ship-stage-watch` on PATH. PATH prefix of
`dirname "$SHIP_STAGE_WATCH_BIN"` may remain so the watch finds sibling
helpers. That prefix SHALL NOT select a different watch binary than
`SHIP_STAGE_WATCH_BIN`.

**Why:** AC 4. The leftover PATH binary is how a human restored posts.
That is not the product path.

## Risks / Trade-offs

- **[Risk] Tugboat misses the first handoff if it starts the waiter
  after train already wrote the line.** → Mitigation: create
  `train.stderr` (or a dedicated handoff sidecar) before starting train;
  start the waiter before or as train starts; parse the whole capture,
  not only new lines after attach.
- **[Risk] Multiple advance waves emit multiple handoffs.** → Mitigation:
  attach watch to each distinct absolute `events` path observed on this
  train’s stderr. Minimum for this issue is the first live path. Spec
  requires Tugboat to use a live handoff path, not a glob.
- **[Risk] Stderr JSON mixed with prose makes a naive parser fail.** →
  Mitigation: select lines that parse as JSON with `kind` equal to
  `loop_run_handoff` and an absolute `events` string. Ignore other
  stderr. Same discriminator as `loop-early-run-handoff`.
- **[Risk] Stale installed `~/.local/bin/tugboat` keeps `--milestone`.**
  → Mitigation: after train-complete, Tugboat re-execs candidate
  `tugboat.sh`. Train-phase watch runs on the process-start binary.
  Install/parity already covers Tugboat content. This change does not
  add a new doctor check solely for watch argv; the extract test is the
  repo gate. Operators still refresh the install pack from repo
  examples.
- **[Trade-off] Train stderr gains a JSON handoff line.** Operators who
  grep prose still see the existing ready line. Machine consumers must
  ignore unknown stderr JSON. `train-status-complete.py` reads stdout
  capture, not stderr.

## Migration Plan

1. Land train stderr handoff, Tugboat `--events-file` spawn, named
   argv-reject log, and extract tests on this branch.
2. Merge. Next `Ship milestone` uses candidate Tugboat after
   train-complete re-exec for later phases. Train-phase watch on the
   next ship uses the process-start Tugboat; operators who still run
   v1.39.8 Tugboat will keep the dead-watch log until that binary is
   refreshed or the next promote installs this SHA.
3. Do not kill or restart in-flight v1.39.8 as the fix.

Rollback: revert the composer/train/test/spec change. Tugboat would
again pass `--milestone` and log “started” for a dead pid.

## Open Questions

None. Fail-reason token MAY be `stage-watch argv rejected` or a
documented equivalent; specs name that token as the required class.
