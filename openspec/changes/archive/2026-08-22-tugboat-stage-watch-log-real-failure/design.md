## Context

See `proposal.md` for why. Current law and code:

- Living `tugboat-thin-ship` (#1184) logs `stage-watch argv rejected` (or
  equivalent) when the bundled watch exits non-zero on argv parse **or the
  spawn otherwise fails immediately**. `observe_stage_watch_pid` sleeps
  0.2s, then on a dead pid always logs that token and unlinks the pid
  file. `start_train_stage_watch` also logs that token when the events
  path is not absolute, before spawn.
- Bundled `ship-stage-watch.sh` exits 2 for argv reject (`unknown
  argument:` plus usage) **and** for missing/non-executable material
  filter (`material filter not found on PATH: …`). Exit 2 alone does not
  distinguish those deaths.
- Sibling #1212 already skips spawn when no executable installed filter
  can be resolved (`material filter missing`). This change does not
  re-present `PIPELINE_MATERIAL_FILTER`. It owns the playbook line after
  a spawned watch dies, and the pre-spawn relative-path message.
- Site: ship v1.39.10 `playbook.log` `stage-watch argv rejected` at
  `2026-08-21T21:38:51Z`. `stage-watch.log` had
  `material filter not found on PATH: material-filter.mjs`. Argv was
  already `--events-file`.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is Tugboat’s v1.39.10
   `observe_stage_watch_pid` logging `stage-watch argv rejected` for every
   dead watch pid (and `start_train_stage_watch` reusing that token for a
   relative events path). The class is: a named stage-watch failure log
   MUST carry the child’s actual fail reason (stderr tail and/or exit).
   The argv-rejected token is reserved for real usage/parser reject.
   Relabeling only the v1.39.10 filter line is a mole.
2. **Shared surfaces.** Log-contract law lives in `tugboat-thin-ship`.
   The gate is `core/test/tugboat.test.ts` (extract/fixture observe and
   start helpers). This change does not add a recovery classifier,
   recipe, or second recoverer. Watch remains observational
   (`supervisor-ship-notify`).
3. **Next identical fault.** A later observe that logs `stage-watch argv
   rejected` for a non-argv death whose stderr is
   `material filter not found on PATH: material-filter.mjs` fails the
   first unit test. A later relative-path start that does not log the
   distinct refusal fails the second test. No new mole issue for the
   same mislabeled death.

## Goals / Non-Goals

**Goals:**

- Post-spawn dead pid logs the watch fail reason from stderr and/or
  exit status.
- `stage-watch argv rejected` is used only for usage/parser reject
  (exit 2 plus usage text).
- Relative events path is refused before spawn with a distinct message.
- Tests fail on the v1.39.10 mislabel and on a silent relative-path
  refusal.

**Non-Goals:**

- Presenting `PIPELINE_MATERIAL_FILTER` (#1212).
- Changing bundled watch argv or restoring `--milestone`.
- Failing the ship because watch notify is down.
- Deleting Tugboat. Buzz/Hermes SKILL swap. In-engine check-wait
  (#1205). Killing an in-flight ship.

## Decisions

### 1. Classify argv reject from exit 2 plus usage text, not from a dead pid

**Choice:** After spawn, Tugboat SHALL wait the watch pid (keep the
short observe window). If the pid is not live, Tugboat SHALL read the
same capture the spawn redirected (`$RUN_DIR/stage-watch.log` or
equivalent) and the wait exit status. Tugboat SHALL log
`stage-watch argv rejected` only when that death is exit 2 **and** the
capture contains usage/parser text (`unknown argument:`, `Usage:`,
`--events-file is required`, or `missing value for`). Any other death
SHALL log a named failure that includes the stderr tail (last
non-empty line) and/or `exit=<n>`. Empty capture SHALL still include
the exit status. Tugboat SHALL NOT log `stage-watch started pid=…` for
that spawn.

**Why:** The v1.39.10 watch died with valid `--events-file` argv. The
real reason was already in `stage-watch.log`. Hardcoding argv-rejected
on `! kill -0` is the class bug. Bundled watch uses exit 2 for both
argv reject and missing filter, so exit 2 alone is not a discriminator.
#1184’s named token stays valid for a true `--milestone` / usage
reject.

**Alternatives considered:**

- Keep hardcoded `stage-watch argv rejected` on any dead pid →
  rejected. That is the 1.39.10 site.
- Treat every exit 2 as argv reject → rejected. Missing filter also
  exits 2.
- Drop the argv-rejected token and always log raw stderr → rejected.
  #1184 still requires that named failure for usage/parser reject.
- Fail train on watch death → rejected. `supervisor-ship-notify` is
  observational.

### 2. Distinct pre-spawn message for a non-absolute events path

**Choice:** `start_train_stage_watch` SHALL still refuse a relative or
otherwise non-absolute events path **before** spawn. The playbook line
SHALL be `events path is not absolute` (or equivalent). It SHALL NOT
log `stage-watch argv rejected` for that refusal. It SHALL NOT spawn
the watch.

**Why:** AC 2. Today that branch reuses the argv-rejected token without
a child, so operators still chase #1184. The watch never ran, so there
is no stderr tail to quote. A distinct composer-owned message is the
class.

**Alternatives considered:**

- Keep `stage-watch argv rejected` for Tugboat’s own relative-path
  refusal (AC 1 parenthetical) → rejected. AC 2 requires a distinct
  message.
- Spawn anyway and let the bundled watch exit 2 with
  `--events-file must be an absolute path` → rejected. AC 2 is
  pre-spawn. Living argv law already forbids non-absolute events
  paths.

### 3. Regression fixtures drive observe and the relative-path start

**Choice:** Add co-located tests in `core/test/tugboat.test.ts`.

1. Extract `observe_stage_watch_pid` (and the spawn/log wiring it
   needs). Spawn a fixture watch that exits 1 with stderr
   `material filter not found on PATH: material-filter.mjs`. Fail if
   the playbook contains `stage-watch argv rejected` without that
   filter line. Prove the test fails against current Tugboat
   (hardcoded argv-rejected, no filter line).
2. Extract `start_train_stage_watch`. Pass a relative events path.
   Fail if the playbook does not contain the distinct non-absolute
   refusal. Fail if the watch binary is spawned. Prove the test
   fails against current Tugboat (logs `stage-watch argv rejected`).

Keep the existing #1184 `--milestone` argv-reject test. Keep #1212
pre-spawn `material filter missing` tests. Tests SHALL NOT start a
live train, messenger, or ship.

**Why:** AC 3. A fixture that exits 1 (not 2) with the v1.39.10 filter
line bites the class: any non-argv death must carry the reason. Using
the real bundled watch for test 1 would couple this issue to #1212
spawn-env and to the bundled exit-2 filter path.

**Alternatives considered:**

- Source-only regex that `observe_stage_watch_pid` mentions
  `stage-watch.log` → rejected. That does not prove the playbook
  line.
- Drive only the bundled watch with no filter → rejected as this
  issue’s gate. #1212 already skips that spawn. The observe path
  must still be tested for deaths that happen after spawn.

### 4. Do not re-implement #1212 on this change

**Choice:** Leave `resolve_installed_material_filter` and the
pre-spawn `material filter missing` skip in place. This change edits
the death-log and the relative-path message only.

**Why:** Issue scope and sibling #1212. Presenting the installed
filter is a different class. The log contract must still be correct
when a later spawn dies for EPERM, missing `SHIP_NOTIFY_BIN`, or a
filter that vanishes after spawn.

## Risks / Trade-offs

- **[Risk] `observe_stage_watch_pid` tests do not set `RUN_DIR`, so
  a log-tail read of `$RUN_DIR/stage-watch.log` is empty.** →
  Mitigation: observe SHALL use the same capture the spawn redirected.
  Tests that extract observe SHALL point that capture at the fixture
  stderr (set `RUN_DIR` or pass the log path). Update the #1184
  `--milestone` fixture if it needs `RUN_DIR` for argv-reject
  classification.
- **[Risk] Usage text and filter-not-found both appear in one
  capture.** → Mitigation: classify argv reject only when exit 2
  **and** usage/parser tokens are present **and** the fail reason is
  not a distinct runtime line such as `material filter not found on
  PATH`. Prefer the last non-empty runtime error line when both
  exist. The v1.39.10 capture had only the filter line.
- **[Risk] 0.2s observe window races a slow argv parse.** →
  Mitigation: keep the existing window. Argv parse and filter PATH
  check are immediate. Do not lengthen sleep as the product fix.
- **[Trade-off] Fixture watch exits 1 while the real bundled watch
  exits 2 for the same filter line.** Acceptable: the fixture bites
  the class (non-argv death) rather than the bundled exit code.

## Migration Plan

1. Land Tugboat observe/start log contract and tests on this branch.
   Regenerate `plugin/` if `core/` tests change.
2. Merge. Next `Ship milestone` uses candidate Tugboat after
   train-complete re-exec for later phases. Train-phase watch on the
   next ship uses process-start Tugboat.
3. Do not kill or restart in-flight v1.39.10 as the fix. Do not
   present `PIPELINE_MATERIAL_FILTER` again here.
