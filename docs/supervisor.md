# External supervisor contract

This document is the **portable bootstrap** for multi-issue / milestone automation
from any outer host: Hermes, OpenClaw, Slack bots, shell cron, or a human.

**Rule:** supervisors compose the Pipeline CLI. They do not invent a second state
machine, model matrix, or merge authority in chat.

Related:

- [Ship-path autonomy doctrine](./ship-path-autonomy.md) (recovery ladder; false vs real human)
- [Factory simplification plan](./factory-simplification-plan.md)
- [CLI reference](./cli.md) (`train`, `single`, `merge`, `status`, `logs`)
- Examples: [`examples/supervisor/`](../examples/supervisor/)

## Goals

| Goal | How |
|---|---|
| Single issue | `pipeline single <N>` |
| Ordered group / milestone | `pipeline train --issues …` or `--milestone …` |
| Integrate between items | `pipeline train … --merge` |
| Status without re-prompting | Poll train/loop JSON or `pipeline logs` / events |
| Other users / platforms | Same CLI; only the adapter I/O changes |

## Non-goals

- Shipping a Hermes/Buzz/Slack **product** inside this repository
- Grant schemas, durable outer journals, or MCP as a startup requirement
- `auto_merge` in `.github/pipeline.yml`
- Supervisors choosing implementer/reviewer models (those live in `pipeline.yml`)

## Prerequisites (any deployment)

1. Install agent-pipeline for the host that will run CLI processes.
2. `gh` authenticated to the target repo with enough permission to advance and (if using `--merge`) merge.
3. Repo has `.github/pipeline.yml` (models, harnesses, base branch).
4. Prove the path once by hand:

```bash
pipeline doctor --json
pipeline train --issues <N> --json          # no merge
# only after you accept merge authority for that session/machine:
pipeline train --milestone vX.Y.Z --merge --json
```

5. Optional: wire a messenger that can run a command or call a small wrapper script.

## Intent → CLI map

Supervisors SHOULD parse operator text into one of these intents. Prefer
**explicit** flags over free-form LLM invention of issue sets.

| Intent | Example phrases | Command |
|---|---|---|
| Single issue | `do #874`, `pipeline 874` | `pipeline single 874` |
| Issue list train | `train 905 874 870` | `pipeline train --issues 905,874,870` |
| Milestone train | `run milestone v1.34.0` | `pipeline train --milestone v1.34.0` |
| Integrate train | same + `and merge` / `integrate` | add `--merge` |
| Status | `status`, `train status` | last train JSON, or `pipeline status <N>` / loop logs |
| Stop | `stop` | stop the host process / systemd unit running train; do not invent force-merge cleanup |
| Release prepare | `release prepare 1.34.0` | `pipeline release 1.34.0 --no-edit` (opens PR; no merge/tag) |
| Release finish | `release finish 123` | `pipeline release finish 123` (merge release PR only; workflows tag) |
| Engine promote | `engine-promote 1.34.0` | `pipeline engine-promote --for 1.34.0` (pin + install to **all** hosts by default after published Release; `--host <name>` to scope) |

**Merge is opt-in.** Never default `--merge` from a vague “run the milestone”
unless the deployment policy explicitly allows it for that channel and operator.

## Authority boundary

| Action | Who may invoke |
|---|---|
| `pipeline single` / `train` without `--merge` | Operator session or supervised worker with normal advance rights |
| `pipeline train --merge`, `pipeline merge`, `merge-queue --apply` | Same, but only when the **deployment** intentionally allows automated merge (private channel, allowlisted sender, or human in the loop) |
| Models / effort | **Only** `.github/pipeline.yml` — supervisors MUST NOT pass ad-hoc model overrides unless the operator explicitly requested a documented CLI flag |

Chat identity is **not** a cryptographic security boundary on a shared UID.
Document allowlists and tokens in the **host** config, not in repository files.

## Stable train status JSON (`schema_version: 1`)

`pipeline train … --json` prints one JSON object on stdout (human progress on stderr).

```json
{
  "schema_version": 1,
  "kind": "train_status",
  "ordered_issues": [1, 2],
  "current_issue": 2,
  "current_index": 1,
  "next_action": "merge",
  "merge_mode": true,
  "items": [
    {
      "issue": 1,
      "pr": 101,
      "terminal": "ready-to-deploy",
      "merge_result_oid": "abc…",
      "integrated": true
    }
  ],
  "blocker": null,
  "complete": false
}
```

| Field | Meaning |
|---|---|
| `schema_version` | Always `1` for this shape |
| `kind` | Always `"train_status"` |
| `ordered_issues` | Dependency-ordered issue numbers |
| `current_issue` / `current_index` | Item in progress, or `null` / last when complete |
| `next_action` | `advance` \| `merge` \| `wait-for-base` \| `next-item` \| `complete` \| `stopped` \| … |
| `merge_mode` | Whether this run used `--merge` |
| `items[]` | Per-issue terminal, PR, merge oid, `integrated` |
| `blocker` | Human-readable stop reason, or `null` |
| `complete` | All items finished successfully for this mode |

**Source of truth** remains GitHub labels, PRs, and base history. Status JSON is
observational. A supervisor MUST NOT treat chat memory as stage authority.

Exit codes: `0` success; non-zero stop (needs-human, merge failure, containment, etc.).

## Progress without prompting

Recommended pattern:

1. Start train in a long-lived process (foreground, `systemd`, or host job runner).
2. On a timer (e.g. 5–15 minutes) or on process exit, post a short summary:
   - issue list / milestone
   - `complete` / `blocker` / current issue
   - link to PR if known
3. Prefer `pipeline train --json` final output and/or `pipeline loop logs <run-id> --events --follow` for mid-flight detail when using `single`/`loop`.

Do not spam full logs or secrets into chat.

## Failure and stop semantics

| Situation | Supervisor action |
|---|---|
| `needs-human` / blocked — **recoverable engine/workflow** (scratch, stale identity/labels, capacity, workflow-engine defect) | Report `blocker` with class if known. Expect **loop recovery / re-train after the deterministic recipe** (unlink scratch, resync, pin head, clear stale block) — not operator file-delete or label surgery as the default. Re-run train when the recipe or engine recoverer has run; already-integrated items are skipped when safe. See [ship-path autonomy](./ship-path-autonomy.md). |
| `needs-human` / blocked — **residual review park at current HEAD** (after deterministic resume) | Call **`pipeline recover-parked <N>` once** (train does this automatically). It reflows only stale/DNR/below-high via audited override; **never** auto-overrides HIGH/CRITICAL/security/authority. If still parked → STOP + notify human. Do **not** invent `pipeline override` or drop `blocked` from the host. |
| `needs-human` / blocked — **true human authority** (product judgment, missing authority/sign-off, external capability the run cannot obtain) | Report `blocker`; **wait for human** / handoff (e.g. #647 path). Do not invent workarounds. Re-run train after the human disposition. |
| Merge / checks / containment failure | Report exact error; do not force-merge or delete worktrees |
| Process crash mid-train | Re-run the same selector; rely on GitHub + train idempotency for merged items |
| Operator stop | Kill the train process only; do not run destructive git cleanup |

Do **not** treat every `needs-human` / blocked outcome as unconditional “wait for
human.” Classify first. Supervisors still do **not** gain merge authority, a
second durable scheduler, or a second state machine from this guidance.

## Multi-platform bootstrap

```text
Messenger (Slack / Buzz / OpenClaw / …)
    → thin adapter (auth, channel, format reply)
        → same intent → CLI map
            → pipeline …
```

| Piece | Location |
|---|---|
| Intent map + status schema | This doc (product contract) |
| Shell wrapper | `examples/supervisor/shell/` |
| Hermes / OpenClaw skill sketches | `examples/supervisor/hermes/`, `examples/supervisor/openclaw/` |
| Slack notes | `examples/supervisor/slack/` |
| Production secrets & allowlists | Your host — never commit |

Copy an example; point `PIPELINE` at your installed launcher; set `REPO_DIR`.
Do not fork the engine into the chat product.

## Self-correction boundary

Pipeline's durable `single` and loop recovery controllers own regressions on an
issue that is already in the authorized train. Buzz does not classify the
failure, select a model, or add stage-specific retries.

New papercut, correction, and durable-run blocker issues remain
`pipeline:backlog` by design. They do not silently join the current signed
shipment. An operator or one deterministic policy step must triage the issue
and assign its GitHub milestone before a later ship can include it. Free-form
feature requests can use `pipeline intake --description … --release vX.Y.Z`;
existing issues can use `pipeline triage <N> --stage ready|backlog` plus explicit
milestone assignment. This keeps self-correction useful without letting a model
widen release authority.

## Minimal checklist for a new team

- [ ] `pipeline doctor` green in the service environment  
- [ ] Hand-run `train` without `--merge` on one issue  
- [ ] Decide whether this deployment may use `--merge`  
- [ ] Wire one adapter from `examples/supervisor/`  
- [ ] Heartbeat posts status, not raw logs  
- [ ] Document who can send merge-capable commands  

## Release finish JSON (`schema_version: 1`)

`pipeline release <X.Y.Z> --no-edit --json` emits one prepare identity after it
creates and re-reads the release PR:

```json
{
  "schema_version": 1,
  "kind": "release_prepare",
  "version": "1.34.0",
  "pr": 123,
  "base": "main",
  "head_oid": "…"
}
```

Automated finalization binds to this exact PR, base, version, and head. It does
not scrape human output or search for a title match.

`pipeline release finish <pr> --json`:

```json
{
  "schema_version": 1,
  "kind": "release_finish",
  "pr": 123,
  "version": "1.34.0",
  "title": "release: 1.34.0 — theme",
  "headRefOid": "…",
  "mergeCommitOid": "…",
  "alreadyMerged": false
}
```

Does **not** create git tags or GitHub Releases. After finish, ship-end
composers invoke candidate `pipeline release ensure-tag` from on-disk HMAC
`latest.json`. Tugboat presents `PIPELINE_FRG_ATTESTATION_KEY_FILE` as
`PIPELINE_FRG_ATTESTATION_KEY` in that child (same recipe as the FRG pack
attestor). `.agent-pipeline/frg/` is gitignored, so auto-tag must not stall
the ship for a missing tree file. `release.yml` still publishes the GitHub
Release after the annotated `v*` tag exists.

## Hermes production (Phase 2b)

Host runbook: [runbooks/hermes-supervisor-deployment.md](./runbooks/hermes-supervisor-deployment.md).  
Skill template: [examples/supervisor/hermes/SKILL.md](../examples/supervisor/hermes/SKILL.md).

## Ship milestone (`pipeline ship --milestone`)

**Primary path:** `pipeline ship --milestone vX.Y.Z`. Operator phrase:
`Ship milestone vX.Y.Z`. Status: `pipeline ship status --milestone vX.Y.Z`
(Pipeline ship ledger). Tugboat may remain a thin notify/detach adapter. It is
not the product owner. #1001 / #971 do not ban in-engine ship.

| Script | Role |
|---|---|
| `pipeline ship --milestone vX.Y.Z` | **Product** durable ship (train `--merge` → release → finish → ensure-tag → promote) |
| `examples/supervisor/shell/tugboat.sh` | Thin notify/detach adapter only; not the ship owner |
| `examples/supervisor/shell/ship-notify.sh` | Optional messenger posts; no-op without Buzz env |
| `examples/supervisor/shell/ship-stage-watch.sh` | Optional exact-run posts; shared install |
| `examples/supervisor/shell/train-status-complete.py` | Train complete gate helper |
| `examples/supervisor/shell/release-checks-green.py` | Shared ship-release check waiter (`green`/`pending`/`rerun`/`fail`, `bucket`+`link` schema) |
| `examples/supervisor/shell/pipeline-ship-playbook.sh` | Thin launcher to repo `tugboat.sh` (not the owner) |
| `examples/supervisor/shell/ship-milestone.sh` | Parked grant-style adapter; not the operator surface |

Required env for mutating ship: `REPO_DIR`, `PIPELINE`, `ALLOW_MERGE=1`.  
`REPO_DIR` is the live control checkout; Tugboat refuses `*factory-control*`
and treats only live `train --merge` (or owning tugboat) as an already-running
ship (#1062). Promote defaults to all hosts (`ENGINE_PROMOTE_HOST` default `all`).
Tugboat and the host `pipeline` launcher export `AGENT_PIPELINE_PRODUCTION_PIN`
when unset to the factory pin file
(`$REPO_DIR/.agent-pipeline/production-engine-pin.json`) so `engine-promote`
and the next `pipeline train` / `pipeline doctor` share one path (#1127).
The factory plane has **one** live pin file. Host supervisor SKILL MUST NOT
default that env to `~/.local/state/hermes-factory/production-engine-pin.json`
(that leftover file is not pin authority). `pipeline doctor` check
`install:production-pin-path` **fails** when the env pin `version` or `git_sha`
disagrees with the control-checkout pin. v1.40.1 packaging MAY template
supervisor env from `examples/supervisor/hermes/env.example` and MUST NOT
reintroduce a second live pin path.

Runbooks: [runbooks/ship-milestone.md](./runbooks/ship-milestone.md),  
[runbooks/frg-pack-checklist.md](./runbooks/frg-pack-checklist.md).

Pipeline CLI owns train/merge/release/promote policy and the ship ledger.
Tugboat does not add a grant factory or second merge policy. Doctor:
`supervisor:tugboat-install-parity` (installed Tugboat + CI/train helpers match
repo example content),
`supervisor:ship-playbook-promote-host` (legacy playbook promote default),
`supervisor:ship-composer-skip-frg` (installed Tugboat/playbook must not
hard-code default `--skip-frg`),
and `supervisor:ship-end-candidate-engine` (ship-end uses the candidate engine;
selected stale playbook fails). Train and promote stay on the production pin.

**Notify policy:** observational only; notification failures must not alter ship
phase decisions. Prefer shared `ship-notify.sh` / `ship-stage-watch.sh` siblings
— one install set, not dual divergent binaries. `ship-notify` retries transient
messenger failures (default 3 attempts), appends `notify/audit.log`, and writes
`notify/failed/*` markers on final failure while still exiting 0. When Buzz is
quiet, inspect `$PIPELINE_SUPERVISOR_STATE/notify/` before assuming silence means
“never invoked.” Keep `~/.local/bin/ship-notify` in sync with
`examples/supervisor/shell/ship-notify.sh` after merge.

Historical context for the v1.33 ship and v1.34 notifier-attribution incident:
[runbooks/session-2026-08-ship-factory-lessons.md](./runbooks/session-2026-08-ship-factory-lessons.md).

## Versioning

- Intent map and CLI flags may grow; prefer additive changes.
- `train_status.schema_version` bumps only on breaking JSON shape changes.
- Outer adapters SHOULD tolerate unknown fields on status objects.
