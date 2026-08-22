# Ship milestone (`pipeline ship --milestone`)

**Primary path:** `pipeline ship --milestone vX.Y.Z`. That command is the
in-engine ship product. It composes existing verbs: `train --merge` →
(semver) `release` → wait checks (`ship-release-check-wait`) →
`release finish` → `release ensure-tag` → wait GitHub Release →
`engine-promote`. It does not invent a second merge policy or grant schema.

Phrase: **`Ship milestone vX.Y.Z`** → `pipeline ship --milestone vX.Y.Z`
(detach if the CLI is blocking).  
Status: **`pipeline ship status --milestone vX.Y.Z`** (Pipeline ship ledger).
Tugboat `--status` / `ship-vX.Y.Z/` is not the product status surface.

Tugboat may remain a thin notify or detach adapter. It is **not** the product
owner. Closed #1001 Option 1 and open #971 must not be read as a ban on
in-engine `pipeline ship`.

**Live ship (#1062):** a second detach is refused only when a live process
cmdline is `train --merge` for that milestone, or the owning tugboat. Bare
`playbook.pid` + `kill -0`, per-issue `pipeline N` locks, and stale state alone
are **not** live ships — Ship still detaches once. Buzz and TUI paste share
that path (no paste detector).

**Concurrent Ship (#1111):** two overlapping `--detach` invocations for the
same repo + milestone serialize on a host-local flock at
`$PIPELINE_SUPERVISOR_STATE/admission/<repo-token>/vX.Y.Z.lock`. That lock
is not a live ship. The loser waits, then refuses with the live-ship probe
(`already running … not detaching a second copy`). Leftover lock files with
no live flock holder do not block a later Ship.

**`REPO_DIR`:** pin the live control checkout at tugboat start. Paths matching
`*factory-control*` are refused.

Contract: [supervisor.md](../supervisor.md)  
Epic / hardening: #1096 (in-engine durable ship). #1001 / #971 do not ban this path.

## Ownership

| Concern | Owner |
|---|---|
| Train, merge policy, release, promote decisions | Pipeline CLI (`train`, `release`, `release finish`, `engine-promote`) |
| Phase sequence, wait CI / Release, failure detail, notify | **Pipeline ship ledger** (hosts notify from exact child-run identities) |
| Detached process, logs, state dir | host (`nohup` + `PIPELINE_SUPERVISOR_STATE`) |
| Material progress during train (optional) | shared `ship-stage-watch.sh` + `material-filter.mjs` |
| Buzz delivery | shared `ship-notify.sh` (no-op without messenger env; best-effort with retry + audit) |

GitHub and Pipeline run state remain authoritative. Tugboat does not implement
a grant factory, durable outer ledger, or merge-from-advance.

## Install (Option 1 primary)

```bash
ROOT=/path/to/agent-pipeline
install -d -m 0755 "$HOME/.local/bin"
for f in tugboat ship-notify ship-stage-watch pipeline-launcher; do
  install -m 0755 "$ROOT/examples/supervisor/shell/${f}.sh" \
    "$HOME/.local/bin/$f"
done
install -m 0755 "$ROOT/examples/supervisor/shell/train-status-complete.py" \
  "$HOME/.local/bin/train-status-complete.py"
install -m 0755 "$ROOT/examples/supervisor/shell/release-checks-green.py" \
  "$HOME/.local/bin/release-checks-green.py"
```

Keep installed copies in sync with repo examples after `main` moves — host
files are not generated. Doctor check
`supervisor:tugboat-install-parity` fails closed when
`~/.local/bin/tugboat` is present but its content (or sibling
`release-checks-green.py` / `train-status-complete.py`) does not match the
repo examples under `examples/supervisor/shell/`. Marker-only forks are not
accepted. Refresh with the same `install` loop (includes **`ship-notify`** —
post-merge reinstall so hosts pick up delivery retry/audit changes).

Host env (mode-0600 profile):

```bash
export REPO_DIR=/path/to/control-checkout   # required; not *factory-control* (#1062)
export PIPELINE=$HOME/.local/bin/pipeline   # production pin: train + engine-promote
export ALLOW_MERGE=1                        # required for mutating ship
# After train-complete, FRG pack / release / finish use the candidate engine
# (clean REPO_DIR HEAD at the FRG-bound SHA, $REPO_DIR/.worktrees/ship-candidate-<sha>,
# or PIPELINE_CANDIDATE_ENGINE_ROOT). They do not use the previous production pin.
# optional:
# export PIPELINE_CANDIDATE_ENGINE_ROOT=/path/to/candidate-checkout
# Tugboat and the host pipeline launcher export AGENT_PIPELINE_PRODUCTION_PIN
# when unset to $REPO_DIR/.agent-pipeline/production-engine-pin.json so
# engine-promote and the next train doctor share one pin file (#1127).
# Do not default a second live pin
# (~/.local/state/hermes-factory/production-engine-pin.json is not authority).
# optional, and only if it is the control-checkout pin:
# export AGENT_PIPELINE_PRODUCTION_PIN=$REPO_DIR/.agent-pipeline/production-engine-pin.json
# export ENGINE_PROMOTE_HOST=all            # default all (codex/claude/grok/opencode)
# export PIPELINE_SUPERVISOR_STATE=$HOME/.local/state/pipeline-supervisor
# optional override; Tugboat presents <skillDir>/scripts/material-filter.mjs
# when unset. engine-promote does not write supervisor env.
# export PIPELINE_MATERIAL_FILTER=…/material-filter.mjs
# export TUGBOAT_SKIP_FRG=1                 # escape only; requires TUGBOAT_SKIP_FRG_REASON
# export TUGBOAT_SKIP_FRG_REASON="…"
# export TUGBOAT_BASE_BRANCH=main           # optional override; default is
#                                          # .github/pipeline.yml base_branch.
#                                          # Required when that file is absent.
#                                          # origin/HEAD is not used.
```

## Operator usage

```bash
# Detach (Buzz: Ship milestone v1.37.0)
tugboat --milestone v1.37.0 --detach

# Serial multi-milestone (promote between; no parallel fat state machine)
tugboat --milestones v1.37.0 v1.38.0 --detach

# Status (no train/FRG pack/release/promote side effects)
tugboat --milestone v1.37.0 --status

# Operator escape only (requires a logged reason):
# tugboat --milestone v1.37.0 --skip-frg --skip-frg-reason "hotfix without pack"
```

State and logs:

```text
~/.local/state/pipeline-supervisor/ship-vX.Y.Z/
  state.json      # phase, status, detail (failure reasons enriched)
  playbook.log
  train.json / release-*.err / engine-promote.err …

~/.local/state/pipeline-supervisor/admission/<repo-token>/
  vX.Y.Z.lock     # flock for concurrent --detach (not a live-ship probe)

~/.local/state/pipeline-supervisor/notify/   # shared ship-notify state
  <dedupe-key>    # TTL dedupe (epoch + content); not proof of remote delivery
  audit.log       # terminal send outcomes: ok / fail + attempts + reason
  failed/<id>     # supervisor-visible marker after exhausted retries
```

If the Buzz channel is quiet during a ship, check `notify/audit.log` and
`notify/failed/` under `PIPELINE_SUPERVISOR_STATE` before assuming the helper
never ran. Notify is still best-effort (exit 0 after failure); ship/train do
not block solely on messenger delivery. Reinstall `ship-notify` from
`examples/supervisor/shell/` after `main` moves (same install loop as Tugboat).

Issues on the milestone must be `pipeline:ready` before train dispatch.

### Phase sequence (fixed)

1. `pipeline train --milestone vX.Y.Z --merge --json` (complete gate + resume)
2. FRG pack: uncredentialed `pipeline factory-release prepare --request <abs.json> --json`, then (when unsigned) `pipeline factory-gate --for X.Y.Z --from-run <loop>` in a separate credentialed child; re-invoke until pack-done. While prepare is `in_progress` and the bound pack loop is live (`lock.json` pid alive or ledger not terminal), wait is wait-until-terminal with a heartbeat. A CI-length poll cap (about 20 minutes) is not pack-fail. Re-detach is not the resume path. Wait-budget expiry may fail the pack only when the bound loop is not live.
3. `pipeline release X.Y.Z --no-edit` (**bare** version — leading `v` is invalid; **no** `--skip-frg`)
4. In-engine `pipeline ship` waits until open release PR checks are green before `release finish` (`ship-release-check-wait`: `gh pr checks --json name,state,bucket,link`; never `conclusion`). Classification is `green` / `pending` / `rerun` / `fail`. `pending` keeps waiting in the coordinator (same-argv retry may resume). A first flake-eligible `test` fail requests one bounded `gh run rerun --failed` per head SHA (budget at most two), then waits again. Non-test product fails STOP and do not finish. Bare `pipeline release finish` stays one-shot fail-closed; **ship** owns the wait. Tugboat may keep calling `release-checks-green.py`; Tugboat is not the only waiter. After merge, refresh installed Tugboat and `release-checks-green.py` from `examples/supervisor/shell/`.
5. `pipeline release finish <pr>` (only after the waiter classifies `green`, or when finish evidence is already observed)
6. `pipeline release ensure-tag <X.Y.Z> <mergeCommitOid> --packed-candidate <integrated_candidate.git_sha>` (candidate engine; on-disk HMAC `latest.json`)
7. Wait until GitHub Release `vX.Y.Z` is published (non-draft)
8. `pipeline engine-promote --for X.Y.Z --host all` (or `ENGINE_PROMOTE_HOST` override; **no** `--skip-frg`)

Hardened behaviors (preserve):

| Item | Behavior |
|---|---|
| #989 | Promote defaults to **all** hosts when `ENGINE_PROMOTE_HOST` unset |
| #996 | Never call release-finish while checks are pending/failed |
| #997 | Failed phase notify/state includes blocker or err tail (not only `exit N`) |
| Idempotent | Existing open PR titled `release: X.Y.Z …` is reused |
| Thinness | No grant factory or second merge policy inside Tugboat. Tugboat is not the ship owner. |

## FRG pack is part of thin ship

Default Tugboat sequence is train → FRG pack → release (no `--skip-frg`) →
finish → `release ensure-tag` → publication wait → promote. **Train and
engine-promote use the production-pin CLI** (`$PIPELINE`). **After
train-complete, FRG pack, `pipeline release`, `release finish`, and
`release ensure-tag` use the candidate engine** at the FRG-bound SHA
(`SHIP_END_CLI` = `node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs"`).
Tugboat does not invoke `git tag` or `gh release create`. Tag create is
candidate `pipeline release ensure-tag` from on-disk HMAC `latest.json`.
`.agent-pipeline/frg/` is gitignored, so auto-tag must not stall the ship for
a missing tree file. `release finish` still does not tag. The pack phase composes
`pipeline factory-release prepare --request <abs.json> --json` in a child that
has `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE`
**unset** (the parent supervisor env may keep the credential). When prepare
returns `awaiting_frg_attestation` or unsigned eligible artifacts exist,
Tugboat runs `pipeline factory-gate --for X.Y.Z --from-run <loop>` in a
**separate** child that has the producer credential (inherit `KEY`, or present
`KEY_FILE` contents as `KEY` in that child only). The engine applies that same
recipe for HMAC-verify, so Claude Code / Hermes hosts with only `KEY_FILE` do
not need a Tugboat wrap. After `release finish`,
candidate `release ensure-tag` uses that same recipe so HMAC verify has `KEY`
when the supervisor set only `KEY_FILE`. It does not pass
`--observations`. Pack-done is this version's `latest.json` `pass: true` bound
to the request candidate SHA (and `action_id` when recorded), or prepare
`complete` with an open release PR. `awaiting_frg_attestation` alone is **not**
pack-done. While prepare stays `in_progress` and the bound pack loop is live,
Tugboat and in-engine `pipeline ship` keep re-invoking the same request and
keep `state.json` at `frg-pack` / `running` (heartbeat). They do not fail the
ship for wait-budget expiry and do not require a human re-detach. The numeric
`FRG_WAIT_*` cap applies only when the bound loop is not live. CI /
release-PR check wait (`RELEASE_WAIT_*`) stays a CI poll. Unsigned eligible
`latest.json` `pass: false` caused only by omitted HMAC is **attest**, not
pack-fail: prepare returns `awaiting_frg_attestation` and Tugboat runs
`factory-gate --from-run` in a separate child. Real ineligible scoreboards
stay pack-fail. A failed or missing pack that is not omitted-HMAC-only
stops the ship **before** `pipeline release`.
If the candidate engine cannot be resolved, Tugboat fails closed and does **not**
fall back to the production-pin `$PIPELINE` for those verbs. Tugboat does not
write the key body into `state.json`.

`--skip-frg` / `TUGBOAT_SKIP_FRG=1` is an operator escape only. It requires a
non-empty `--skip-frg-reason` / `TUGBOAT_SKIP_FRG_REASON`. Missing reason fails
closed and does not skip. A valid escape omits the pack phase, passes
`--skip-frg` to release and promote, and writes the reason into ship state or
log. A skip promote writes `frg_run_id` `no-frg-<X.Y.Z>` and
`frg_evidence_path` null. That pin is not production-quality. Default promote
requires a real FRG `run_id` and evidence path.

## Thin adapters (not the product owner)

### Chain playbook (`pipeline-ship-playbook.sh`)

Documented **alternate** launcher for hosts that still install it. It execs
`$REPO_DIR/examples/supervisor/shell/tugboat.sh` and must not retain a second
ship-end compose. **Not** the product owner. After that exec, Tugboat uses the
candidate engine for FRG / release / finish / ensure-tag. A selected stale full playbook
fails doctor `supervisor:ship-end-candidate-engine`.

```bash
install -m 0755 "$ROOT/examples/supervisor/shell/pipeline-ship-playbook.sh" \
  "$HOME/.local/bin/pipeline-ship-playbook"
```

### Grant-style `ship-milestone.sh --authorization`

Parked unused grant admission. **Not** the operator surface. Operator
invocation is `pipeline ship --milestone vX.Y.Z` with no grant file.

## Doctor

```bash
pipeline doctor
# Expect (when ~/.local/bin/tugboat is installed):
#   supervisor:tugboat-install-parity → pass
#   supervisor:ship-end-candidate-engine → pass (or skip with no bound SHA)
# When only a thin launcher playbook is installed:
#   supervisor:ship-end-candidate-engine → pass
# When a stale full playbook is selected for ship-end:
#   supervisor:ship-end-candidate-engine → fail (refresh launcher or exec repo tugboat.sh)
# Neither installed → checks skip
```

## Exact-run progress (optional)

When Pipeline status returns an **exact** absolute `events.jsonl` path for a
run, optional progress posts may stream only that file through the installed
`material-filter.mjs` via `ship-stage-watch`:

```bash
ship-stage-watch \
  --events-file /absolute/path/from/status/events.jsonl \
  --label "ship v1.37.0"
```

Do not guess a path or select the most recently modified run. Notification
failure is observational and must not stop or advance a ship.

## Parked non-goals

- Auto-file ship failures onto the milestone
- Gateway/session heartbeat product tuning as a ship feature
- Grant factory / MessagingPort / Slack / ship-auth issuer (#966–#968, #973)
- Shared NL intent platform (#974 beyond phrase → argv)
- Grant factory / signed-authorization operator surface (parked)

Historical context: [session-2026-08-ship-factory-lessons.md](./session-2026-08-ship-factory-lessons.md).
