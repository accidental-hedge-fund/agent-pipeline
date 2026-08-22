## Context

See `proposal.md` for why. Current law and code:

- Bundled `examples/supervisor/shell/ship-stage-watch.sh` accepts
  `--events-file` and optional `--label` / `--pid-file`. It resolves
  `MATERIAL_FILTER="${PIPELINE_MATERIAL_FILTER:-material-filter.mjs}"`.
  A path containing `/` must be executable. A bare name must be on PATH
  (`command -v`). Missing either exits 2 with
  `material filter not found on PATH: material-filter.mjs` (or
  `material filter is not executable: …`).
- Tugboat `start_train_stage_watch` (#1184) passes `--events-file` from
  live `loop_run_handoff`. Spawn env is
  `PATH="$(dirname "$SHIP_STAGE_WATCH_BIN"):${PATH}"` plus
  `REPO_DIR`, `SHIP_NOTIFY_BIN`, `PIPELINE_SUPERVISOR_STATE`. It does
  not mention `PIPELINE_MATERIAL_FILTER`. Sibling
  `examples/supervisor/shell/` does not contain `material-filter.mjs`.
- `install.mjs` copies `hosts/_shared/material-filter.mjs` to
  `<skillDir>/scripts/material-filter.mjs` and `chmod 0755`. That
  launcher execs `../core/scripts/material-filter.ts` next to the
  installed skill tree. The repo `hosts/_shared/` copy is not that
  tree.
- Outer-host manifests already declare
  `material_progress_notify.mapping.filter` as
  `scripts/material-filter.mjs` relative to the skill dir.
- `examples/supervisor/hermes/env.example` documents
  `PIPELINE_MATERIAL_FILTER=…/material-filter.mjs`. Live
  `~/.config/pipeline-supervisor/env` does not set it.
  `engine-promote --host all` does not write that file.
- Site: ship v1.39.10 `stage-watch.log`
  `material filter not found on PATH: material-filter.mjs`. Playbook
  logged `stage-watch argv rejected` after a 0.2s death. Sibling #1213
  owns that mislabel.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is Tugboat’s v1.39.10
   `start_train_stage_watch` spawn env omitting the installed filter.
   The class is: any composer that spawns bundled `ship-stage-watch.sh`
   (or any child that execs the shared material filter for ship
   progress) MUST present an executable installed
   `material-filter.mjs` from the pin/host skill install tree in that
   spawn env. Host supervisor env is fallback, not owner. A human
   restart of `~/.local/bin/ship-stage-watch --milestone` is not the
   class fix.
2. **Shared surfaces.** Spawn-env law lives in `tugboat-thin-ship`.
   Install-artifact ownership lives in `host-neutral-progress-notify`
   (filter is the install-tree script `install.mjs` /
   `engine-promote` already writes). The extract/fixture tests in
   `core/test/tugboat.test.ts` are the gate. This change does not add
   a recovery classifier, recipe, or second recoverer. Watch remains
   observational (`supervisor-ship-notify`).
3. **Next identical fault.** A later Tugboat (or thin launcher) watch
   spawn whose env has neither `PIPELINE_MATERIAL_FILTER` pointing at
   an executable nor `material-filter.mjs` on PATH fails the same
   living spec and first unit test. A later spawn of the bundled
   watch with only `--events-file` and no filter that still logs
   `stage-watch started` fails the second test. No new mole issue for
   the same missing-filter spawn.

## Goals / Non-Goals

**Goals:**

- Tugboat watch spawn presents an executable installed
  `material-filter.mjs` without requiring live supervisor env.
- Default resolution prefers the pin/host skill install path, not a
  bare PATH name and not `examples/supervisor/shell/`.
- Operator-set `PIPELINE_MATERIAL_FILTER` is left unchanged.
- Missing executable filter is a named failure, not a started pid.
- Train/ship continue (watch best-effort).
- Tests fail on the v1.39.10 spawn env and on a started log with no
  filter.

**Non-Goals:**

- Changing bundled watch argv (`--events-file` stays).
- Teaching `engine-promote` to write supervisor env.
- Using repo `hosts/_shared/material-filter.mjs` as the runtime
  filter (that launcher cannot see installed `core/scripts/`).
- Relabeling `stage-watch argv rejected` (#1213).
- Failing the ship because watch notify is down.
- Restoring `--milestone`, latest-run discovery, or a PATH leftover
  watch binary.
- Killing an in-flight ship. MessagingPort / ship-auth. Pin JSON /
  KEY wrap.

## Decisions

### 1. Tugboat presents `PIPELINE_MATERIAL_FILTER`; host env is fallback

**Choice:** Before spawning `SHIP_STAGE_WATCH_BIN --events-file`,
Tugboat SHALL put an executable installed `material-filter.mjs` into
that child’s environment. Preferred mechanism is export
`PIPELINE_MATERIAL_FILTER=<absolute executable>`. Equivalent PATH
(directory of that executable on spawn PATH so
`command -v material-filter.mjs` succeeds) is allowed. If
`PIPELINE_MATERIAL_FILTER` is already set to a non-empty value,
Tugboat SHALL pass that value through and SHALL NOT overwrite it.

**Why:** The bundled watch already documents that env var. v1.39.10
failed because Tugboat never set it and PATH was the sibling watch
dir. `env.example` is a template. Promote does not own that file.
The composer that spawns the watch owns presentation.

**Alternatives considered:**

- Document that operators must set `PIPELINE_MATERIAL_FILTER` after
  every promote → rejected. User story forbids hand-editing
  supervisor env after promote.
- Teach `engine-promote` / `install.mjs` to write supervisor env →
  rejected. Out of scope. Host env is fallback, not owner.
- Prepend `examples/supervisor/shell` and copy or symlink the
  filter there → rejected. That is not the install tree. The
  launcher needs sibling `../core/scripts/material-filter.ts`.
- Default to repo `hosts/_shared/material-filter.mjs` via
  `AGENT_PIPELINE_ROOT` → rejected. That file is the install
  source, not a runnable skill tree.

### 2. Default path is the pin/host skill install tree

**Choice:** When `PIPELINE_MATERIAL_FILTER` is unset, Tugboat SHALL
resolve an executable at
`<skillDir>/scripts/material-filter.mjs` in a skill tree that
`install.mjs` / `engine-promote` writes. Candidates follow the same
host base-path contract as install (`CODEX_HOME` /
`CLAUDE_CONFIG_DIR` / `OPENCODE_CONFIG_DIR` and their default home
segments, including Grok’s symlink onto the Claude skill). First
executable candidate is enough. Tugboat SHALL NOT require a Node
helper or `pipeline path` for this resolve. Tugboat SHALL NOT treat
`dirname "$SHIP_STAGE_WATCH_BIN"` as a filter location.

**Why:** Install already copies and `chmod 0755` that path. Outer-host
manifests already name `scripts/material-filter.mjs` as the filter
hint. Matching that tree is the class, not a second copy.

**Alternatives considered:**

- Resolve via `pipeline path --json` → rejected for this issue.
  That command reports core/host coverage, not the filter file.
  Adding a field would broaden scope.
- Require `ENGINE_PROMOTE_HOST` to pick exactly one skill dir →
  rejected. Default promote host is `all`. Any executable installed
  copy is sufficient.

### 3. Resolve before spawn; named missing-filter failure; do not claim started

**Choice:** If the effective filter (operator-set or resolved) is
missing or not executable, Tugboat SHALL log
`material filter missing` (or equivalent), SHALL NOT spawn the
watch (or SHALL NOT treat that spawn as live), SHALL NOT log
`stage-watch started pid=…`, and SHALL continue train. Watch
failure SHALL NOT fail the ship.

**Why:** Spawning without a filter is the v1.39.10 death
(`material filter not found on PATH`). Observing that death as
`argv rejected` is #1213. This issue owns not sending a child that
cannot exec the filter, and not claiming it started. Skipping spawn
avoids a 0.2s race in `observe_stage_watch_pid`. Notify stays
observational.

**Alternatives considered:**

- Spawn anyway and rely on `observe_stage_watch_pid` → rejected as
  the product path. That is how v1.39.10 logged a false death class
  (`argv rejected`) and still posted nothing. Keep observe for
  true argv reject (#1184 / #1213).
- Fail train when the filter is missing → rejected.
  `supervisor-ship-notify` is observational.

### 4. Regression tests target spawn env, not live supervisor env

**Choice:** Add co-located tests in `core/test/tugboat.test.ts`.

1. Extract or fixture `start_train_stage_watch` with host env
   `PIPELINE_MATERIAL_FILTER` unset. Point a fake pin/host skill
   tree at an executable `scripts/material-filter.mjs`. Fail if the
   watch spawn env has neither `PIPELINE_MATERIAL_FILTER` pointing
   at an executable nor `material-filter.mjs` on spawn PATH. Prove
   this test fails against current Tugboat (PATH is the sibling
   watch dir; no filter export).
2. Fixture the bundled `ship-stage-watch.sh` with only
   `--events-file`, no filter env, PATH limited so
   `material-filter.mjs` is not found. Fail if the composer logs
   `stage-watch started`. This may already avoid `started` today
   via #1184 observe; it still guards the claim. After this
   change, the composer path SHALL log `material filter missing`
   (or equivalent) rather than claiming started.

Tests SHALL NOT require live
`~/.config/pipeline-supervisor/env` to set the var. Tests MAY
inject `CODEX_HOME` / `HOME` for the fake skill tree. Tests SHALL
NOT start a live train, messenger, or ship.

**Why:** AC 3–4. A source-only regex that `PIPELINE_MATERIAL_FILTER`
appears somewhere in `tugboat.sh` would not prove spawn env.

**Alternatives considered:**

- End-to-end live ship with Buzz → rejected. Unit tests inject I/O.
- Depend on the developer’s real `~/.codex/skills/pipeline` →
  rejected. Live host env remaining unset must not be required.

### 5. Existing `--events-file` argv and sibling watch default stay

**Choice:** Do not change bundled watch argv. Do not change default
`SHIP_STAGE_WATCH_BIN=$SCRIPT_DIR/ship-stage-watch.sh`. PATH prefix
of `dirname "$SHIP_STAGE_WATCH_BIN"` MAY remain so sibling
`ship-notify.sh` resolves. That prefix SHALL NOT be the filter
source.

**Why:** #1184 living law. This issue is spawn env, not argv.

## Risks / Trade-offs

- **[Risk] Fake or incomplete skill tree has `material-filter.mjs`
  but not `../core/scripts/material-filter.ts`.** → Mitigation:
  spawn-env contract is “executable installed filter path”. The
  launcher already errors if core is missing. Promote/install
  write both. Tests may use a stub executable that stays alive;
  they do not have to exec the real core filter.
- **[Risk] Multiple host skill trees; first executable is stale.**
  → Mitigation: any executable install-tree copy is sufficient for
  v1.39.10 silence. Operators who pin one host can set
  `PIPELINE_MATERIAL_FILTER`. Do not overwrite that.
- **[Risk] Operator-set value is not executable.** → Mitigation:
  do not overwrite; log `material filter missing`; do not claim
  started; continue train.
- **[Risk] `observe_stage_watch_pid` still says `argv rejected`
  for other deaths.** → Mitigation: out of scope (#1213). This
  change skips spawn when the filter is missing so that case does
  not hit the mislabel.
- **[Trade-off] Tugboat duplicates a short list of host skill
  bases instead of calling `install.mjs`.** Acceptable: bash
  composer, same env keys install already documents. A Node
  resolver would be a new runtime dependency for Tugboat.

## Migration Plan

1. Land Tugboat resolve/export, named missing-filter log, and
   tests on this branch. Regenerate `plugin/` if `core/` tests
   change.
2. Merge. Next `Ship milestone` uses candidate Tugboat after
   train-complete re-exec for later phases. Train-phase watch on
   the next ship uses process-start Tugboat; operators still on
   v1.39.10 Tugboat keep a silent channel until that binary is
   refreshed.
3. Do not kill or restart in-flight v1.39.10 as the fix. Do not
   require a supervisor-env edit after promote.

Rollback: revert the composer/test/spec change. Watch spawn would
again omit the filter and die on PATH.

## Open Questions

None. Fail-reason token MAY be `material filter missing` or a
documented equivalent; specs name that token as the required class.
Host probe order among installed skill trees is not operator-visible
as long as the chosen file is an executable install-tree
`material-filter.mjs`.
