# Historical session notes: v1.33.0 ship and v1.34.0 notifier incident

**Date:** 2026-08-09 → 2026-08-10  
**Hosts:** Grok Build (this session), Hermes/Buzz on `agent-ubuntu-us-den-01`, agent-pipeline repo  
**Historical outcome:** Product ship of **v1.33.0** (FRG + release + promote)
completed; the first v1.34.0 ship attempt failed correctly on milestone hygiene
while stage-watch mis-notified unrelated FRG history.

This document preserves the incident record. Its host paths, command sequences, and
architecture diagrams describe the system **at the time of the incident** and are not
current operating instructions. PR #946 replaced that architecture with a signed,
Pipeline-owned ship coordinator after PR #944 fixed the immediate notifier scope bug.
Normative contracts are:

- [supervisor.md](../supervisor.md) — thin supervisor CLI contract  
- [ship-milestone.md](./ship-milestone.md) — train → release → promote playbook  
- [frg-pack-checklist.md](./frg-pack-checklist.md) — Factory Reliability Gate  
- [hermes-supervisor-deployment.md](./hermes-supervisor-deployment.md) — Hermes/Buzz host  

---

## Current correction after PR #946

The current path deliberately removes the host-side lifecycle described later in this
postmortem:

```text
Buzz gateway verifies sender/channel/thread and signs one exact, expiring request
    → thin ship-milestone adapter submits pipeline ship to bounded user systemd
        → Pipeline freezes the milestone plan and owns train/reconciliation
        → candidate-bound FRG validation
        → typed release prepare + exact release finish
        → published-release verification
        → engine-promote exact version
```

- A root-owned Ed25519 public key is the Pipeline trust root. A document fingerprint
  proves integrity only; it is not authorization.
- Pipeline serializes shipments by repository and base branch, persists one coordinate-
  keyed status record, and rechecks authorization expiry before every mutating phase.
- Progress follows only the exact `events_file` returned by typed ship status through
  `material-filter.mjs`. The watcher neither scans global run history nor parses train
  output to infer scope.
- The nested engine-promotion installer lock noted below is fixed with a targeted
  launcher-lock exemption; the broad `--skip-install` workaround is no longer the
  recommended path.
- Post-v1.33 FRG evidence still needs producer-native candidate provenance. Ship fails
  closed at that boundary rather than rebinding provenance-free evidence.

Use the normative runbooks above for commands and deployment. The remaining sections are
historical evidence explaining why those contracts exist.

---

## 1. What “done” means for a version

Operator mental model (confirmed by live 1.33.0 work):

```text
product work on milestone (train / loop / single)
    → Factory Reliability Gate (FRG) evidence on main
        .agent-pipeline/frg/<X.Y.Z>/latest.json  (pass: true)
    → pipeline release  → release PR → merge → GitHub Release + tag
    → pipeline engine-promote --for <X.Y.Z>  → production pin + host install
```

| Layer | Artifact | Authority |
|---|---|---|
| Product | Issues/PRs, labels, `pipeline:ready-to-deploy` | Pipeline engine + GitHub |
| FRG | `.agent-pipeline/frg/<ver>/latest.json` | `factory-gate` / pack run; **required** for release prepare |
| Release | `release: X.Y.Z` PR, then tag `vX.Y.Z` | `pipeline release` + GH Actions auto-tag |
| Production pin | `.agent-pipeline/production-engine-pin.json` | `factory-pin` / `engine-promote` |
| Host CLI install | `~/.codex/skills/pipeline` (etc.) | `npx … install` via `engine-promote` |

**Hard rules from product contract:**

1. **Advance never merges.** Ship merge uses train `--merge` / explicit merge commands only when `ALLOW_MERGE=1` on the host.  
2. **Release does not invent FRG.** Missing `latest.json` → stop after train; do not mint fake FRG.  
3. **Supervisors compose CLI.** Hermes/Buzz must not reimplement the state machine, grants, or a second scheduler.  
4. **Ground truth is disk + GitHub**, not the chat agent’s narrative of a long turn.

---

## 2. Architecture at the time of the incident (superseded)

### 2.1 Layers (inside-out)

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  Operator surface: Buzz channel "pipeline-factory"                      │
│  (or Slack / shell / OpenClaw)                                          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ messages
┌───────────────────────────────▼─────────────────────────────────────────┐
│  Hermes gateway  (profile: pipeline-factory)                            │
│  ~/.hermes/profiles/pipeline-factory/                                   │
│  - config.yaml  (Buzz, allowlists, model)                               │
│  - SOUL.md + skills/pipeline-supervisor (thin skill)                    │
│  - sessions in state.db  (conversation memory — can go stale)           │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ terminal / intent → CLI
┌───────────────────────────────▼─────────────────────────────────────────┐
│  Host thin supervisor scripts  (~/.local/bin/)                          │
│  - pipeline              wrapper → node pipeline.mjs (+ track/repo)     │
│  - pipeline-ship-playbook  (= ship-milestone.sh)                        │
│  - pipeline-ship-stage-watch                                            │
│  - pipeline-ship-notify                                                 │
│  State: ~/.local/state/pipeline-supervisor/ship-vX.Y.Z/                 │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  agent-pipeline CLI  (installed skill, e.g. ~/.codex/skills/pipeline)   │
│  core/scripts/: train, single, loop, release, factory-gate,             │
│                 factory-pin, engine-promote, stages/*                   │
│  Control checkout REPO_DIR: agent-pipeline-factory-control              │
│  Loop events: ~/.local/state/agent-pipeline/loop/runs/loop-*/           │
│  Advance runs: $REPO_DIR/.agent-pipeline/runs/                          │
│  Pin + FRG:   $REPO_DIR/.agent-pipeline/{production-engine-pin,frg}/    │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  GitHub: issues, labels, PRs, Releases, Actions CI                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Product engine (in-repo)

| Path | Role |
|---|---|
| `core/scripts/` | Engine (TypeScript, type-strip at runtime, no tsc build) |
| `plugin/` | **Generated** mirror of `core/` (+ hosts/claude); never hand-edit |
| `hosts/` | Per-host packaging (claude, codex, grok, …) |
| `openspec/` | Living specs + in-flight changes |
| `examples/supervisor/` | **Portable** thin-supervisor examples (not a second control plane) |

**Golden rules (Agents.md / CLAUDE.md):**

- Edit `core/`, then `node scripts/build.mjs`; commit `plugin/` with the same change.  
- `npm run ci` is the done gate.  
- Worktrees for code changes; never edit on `main` in the shared checkout.  
- `pipeline train` / `single` / `loop` stop at ready-to-deploy; merge is opt-in / operator-authorized.

### 2.3 CLI commands supervisors actually use

| Intent | Command |
|---|---|
| Doctor | `pipeline doctor --json` |
| One issue | `pipeline single <N>` |
| Milestone product train | `pipeline train --milestone vX.Y.Z [--merge] --json` |
| Ordered issues | `pipeline train --issues a,b,c …` |
| FRG | `pipeline factory-gate --for X.Y.Z …` (pack/evidence) |
| Pin show | `pipeline factory-pin` |
| Release | `pipeline release X.Y.Z --no-edit` then `pipeline release finish <pr>` |
| Promote | `pipeline engine-promote --for X.Y.Z --host codex` |
| Status | `pipeline status`, train/loop JSON, ship `state.json` |

`train_status` JSON (`schema_version: 1`, `kind: train_status`) is the machine-readable ship progress contract for outer adapters.

### 2.4 Historical host ship playbook (superseded)

Source of truth in-repo: `examples/supervisor/shell/ship-milestone.sh`  
On agent-box often installed as `pipeline-ship-playbook`.

Phases:

1. **train** — `pipeline train --milestone … --merge --json`  
2. **release-prepare** — requires FRG `latest.json`  
3. **release-finish** — merge release PR only (no tag invent)  
4. **wait** — poll `gh release view vX.Y.Z`  
5. **engine-promote** — pin + install  

State directory per version:

```text
$PIPELINE_SUPERVISOR_STATE/ship-v1.34.0/
  state.json          # phase, status, detail
  playbook.log
  train.json / train.stderr
  stage-watch.log / stage-watch.pid
  stage-watch/seen-keys.txt
  stage-watch/session-since.txt   # after scope fix
```

**Trust order when Buzz and reality disagree:**

1. `$REPO_DIR/.agent-pipeline/production-engine-pin.json`  
2. `pipeline --version` / `pipeline path --json`  
3. `ship-v*/state.json` + `train.json`  
4. GitHub release / PRs  
5. Hermes chat narrative (lowest — session memory goes stale)

### 2.5 Historical stage-watch behavior

`ship-stage-watch` **does not advance issues**. It only:

- reads loop `events.jsonl` and linked advance run events  
- posts human-readable stage lines via `ship-notify` (Buzz when configured)

**Bug (pre-#944):** milestone mode had no issue filter and a **fresh** `seen-keys` file. On ship start it scanned host-wide loop history and stamped every “new” key with `ship v1.34.0`, including hours-old FRG pack issues (#938/#939).

**Immediate fix (PR #944, later superseded by exact-run observation in #946):**

1. **`--since` watermark** (default: process start UTC) — events before start are ignored; missing timestamp → fail closed (no notify).  
2. **Train issue allowlist** — when `train.json` has `ordered_issues` / work-list handoff, only those issues notify.  
3. Playbook passes `--since` and `--issues-file $RUN_DIR/train.json` when starting stage-watch.  
4. Scan newest loop dirs (capped), not “all history forever,” still gated by since + allowlist.

### 2.6 Hermes / Buzz integration specifics

| Item | Location / note |
|---|---|
| Profile | `pipeline-factory` |
| Gateway | `hermes … gateway run` (user systemd) |
| Buzz channel | home channel UUID in `config.yaml` |
| Credentials | profile `buzz-credentials.json` (mode 0600) |
| Operator user | `allowed_users` hash in config |
| Slash commands | `user_allowed_commands` / `group_user_allowed_commands` — **not** full admin |
| Models | often OpenRouter DeepSeek; thrash risk on long terminal tool loops |
| Retired path | grant factory / `hermes-factory.service` — do not reintroduce |

**Slash allowlist lesson:** `/stop` and `/new` were denied for non-admin because only `status` was listed. Operators need at least `status`, `stop`, `new`, `whoami` on the private factory channel so they can clear a poisoned session without a host admin.

**Steer lesson:** `/steer` “Promote …” into an in-flight Ship turn does **not** run a clean promote; it injects mid-tool-loop and can pin/rollback chaos. Promote only when idle, or run `pipeline engine-promote` on the host.

### 2.7 Host install path pitfalls

On `agent-ubuntu-us-den-01` during this session:

| Binary | Version / path | Risk |
|---|---|---|
| `~/.local/bin/pipeline` | Thin wrapper → `~/.codex/skills/pipeline` (**1.33.0** after promote) | Correct day-to-day |
| `/usr/local/bin/pipeline` | Launcher into `~/tools/agent-pipeline` (**1.30.0** stale) | Wrong if PATH prefers it |
| Production pin | `$REPO_DIR/.agent-pipeline/production-engine-pin.json` | Source of truth for “what is promoted” |
| Node | Prefer `/usr/bin/node` **v24+**; npx under wrong PATH saw Node 22 warnings | engine-promote install |

**engine-promote self-lock (fixed by #946):** full `engine-promote` could create a
`/tmp/pipeline-starting-*.lock` that the nested install then refused. The durable fix
exempts only the invoking launcher's validated reservation lock.

---

## 3. Session timeline (facts)

### 3.1 v1.33.0 — product ship completed

| Step | Result |
|---|---|
| Product / train work | Issues advanced earlier in the broader effort (#870 path, train `--json` #926, docs #929, …) |
| FRG evidence | PR **#942** merged — `chore(frg): 1.33.0 …` |
| Release | PR **#943** merged — `release: 1.33.0 …` |
| GitHub Release | Tag **v1.33.0** published |
| Hybrid FRG | 1.33 used a hybrid/pilot path for pack (policy one-off); 1.34+ must use durable FRG automation |
| Host promote thrash | Hermes ship turn + steer briefly pinned 1.33 then rolled back to 1.31.1 |
| Host promote (operator/Grok) | Pin + install reached **1.33.0**; `pipeline --version` → 1.33.0 |

FRG evidence shape (on main): `.agent-pipeline/frg/1.33.0/latest.json` with `pass: true`, `run_id` non-empty.

### 3.2 Hermes UI / admin friction

- Long DeepSeek **terminal tool loops** made Buzz show endless “Working…” even when host playbook was idle.  
- **Promote** as `/steer` mid-ship was wrong.  
- **`/stop` and `/new`** initially admin-only (allowlist). Fixed on host config for the operator user.  
- After promote, Hermes **still claimed pin was 1.31.1** from stale session memory while disk said **1.33.0**.

### 3.3 v1.34.0 — first “Ship milestone” from Buzz

Operator message: `ship milestone v1.34.0`.

**What train actually did:**

- Ordered milestone work list: **#909** only  
  (`fix(roadmap): classify SemVer from explicit impact…`)  
- Labels: `pipeline:backlog` (not `pipeline:ready`)  
- Result: `pipeline single` exit 2 — not dispatchable  
- Playbook: `phase=train`, `status=failed`, ~6 seconds  

**What Buzz showed (misleading):**

- Dozens of `ship v1.34.0: #938 → …` / `#939 → …` / PR opened **#940/#941**  
- Those issues are leftover **1.33 FRG pack** (`factory-gate`, titles still say 1.33.0)  
- Stage-watch re-emitted historical loop events under the new ship label  

**Truth:** train failed cleanly; stage-watch lied about scope.

### 3.4 Stage-watch fix

- Repo: `fix/ship-stage-watch-scope` → PR **#944**  
- Tests: `core/test/ship-stage-watch.test.ts` (historical FRG silent; only in-scope post-since)  
- Agent-box: `pipeline-ship-stage-watch` + `pipeline-ship-playbook` updated and smoke-tested  

---

## 4. Historical integration diagram (superseded)

```text
                    Buzz: "Ship milestone v1.34.0"
                              │
                              ▼
                     Hermes (thin skill)
                              │
              prefer: detach playbook, not multi-hour tool thrash
                              ▼
              pipeline-ship-playbook --milestone v1.34.0 --detach
                     │
         ┌───────────┼────────────────┐
         ▼           ▼                ▼
   stage-watch   train --merge     state.json
   (notify only)  (real work)      (phase/status)
         │           │
         │           ├─ ordered_issues from milestone
         │           ├─ require pipeline:ready per item
         │           └─ train.json (train_status)
         │                    │
         └──── reads train.json + events ≥ since ──► Buzz posts
                              │
                              ▼ train complete
                    FRG latest.json present?
                         │ no → STOP (notify)
                         │ yes
                         ▼
                    release → finish → wait tag
                         │
                         ▼
                    engine-promote --for X.Y.Z
                         │
                         ▼
              pin + host install verified
```

**Two channels of “progress” must not be confused:**

| Channel | Trust for “is work happening?” |
|---|---|
| Stage-watch / Buzz stage lines | **Notify only** — after #944 scoped; still not a work scheduler |
| train.json / playbook state / gh | **Yes** — real phase machine |

---

## 5. Lessons learned

### 5.1 Product / process

1. **FRG is a hard gate, not a narrative.** Release prepare without `frg/<ver>/latest.json` must fail loudly. Never invent FRG to unblock chat.  
2. **1.33 hybrid FRG was a one-off.** Future ships (1.34+) must use durable factory-gate/playbook automation, not ad-hoc hybrid runners.  
3. **Milestone hygiene is part of ship.** Open milestone issues on `pipeline:backlog` cause train to fail immediately. Triage to `pipeline:ready` (or remove from milestone) before Ship.  
4. **`factory-gate` issues are not product backlog.** FRG pack issues (#938/#939) must stay labeled and out of product milestone selection; leftover R2D FRG PRs should be closed/archived after the gate records them.  
5. **Promote is a separate operator act** from ship thrash. Prefer host CLI or a clean idle Buzz phrase after train+release, not mid-turn steer.

### 5.2 Supervisor design

6. **Thin supervisor = CLI composition.** Hermes should start/detach playbook and report `state.json`, not re-derive stages in a 20-step terminal monologue.  
7. **Stage-watch is attribution-sensitive.** Empty seen + global events + ship label = fake multi-issue progress. Always bind: **time watermark + work-list allowlist + ship run dir**.  
8. **Prefer stage-watch over heartbeats** for progress, but only after scope is correct; generic “still running” is worse than silence.  
9. **Detach > interactive tool loop** for multi-minute ship. Hermes “Working…” is not host progress.  
10. **Do not /steer promote into ship.** Cross-intent injection during tool batches confuses models and can thrash pin promote/rollback.

### 5.3 Ground truth vs chat

11. **Hermes session memory is not the pin.** After failed promote attempts, the agent happily restated “pin still 1.31.1” while disk was 1.33.0. Operator check: `pipeline factory-pin` / read pin JSON.  
12. **Buzz stage floods are not train success.** Six-second train fail + thirty stage lines = notifier bug, not a successful multi-issue ship.  
13. **`/status` and host logs beat UI thrash.** `ship-v*/playbook.log`, `train.stderr`, `gateway_state.active_agents`.

### 5.4 Host / platform

14. **PATH matters.** Stale `/usr/local/bin/pipeline` (1.30) vs `~/.local/bin/pipeline` (current skill) causes “missing subcommand” and wrong version stories.  
15. **Node ≥ 24** for install/runtime; verify `node -v` under the same PATH as `npx` during promote.  
16. **engine-promote can self-block** on `pipeline-starting-*.lock` during nested install — use skip-install + separate install or fix the lock interaction.  
17. **Buzz slash allowlist ≠ admin.** Give operators `stop`/`new` on the private factory channel or they cannot recover from poison without SSH.  
18. **Gateway restart reloads config** for allowlist changes; document that after config edits.

### 5.5 Engineering / collaboration

19. **Worktrees for all code changes** in this multi-agent environment (Claude + Codex + Grok + manual).  
20. **Regression tests for notifier scope** are mandatory once a notify path has caused operator pain (`ship-stage-watch.test.ts` pattern: fixture events + `--once` + assert silence).  
21. **Deploy host scripts independently of release** when the bug is operational (examples under `examples/supervisor/`); still land the PR so the next install does not regress.  
22. **Surgical fix discipline** — fix stage-watch attribution without expanding ship product scope mid-incident.  
23. **Document failures while memory is hot** (this file). Chat summaries alone do not survive the next agent.

### 5.6 Operator phrases (recommended)

| Goal | Phrase / action |
|---|---|
| Ship | `Ship milestone vX.Y.Z` → should **detach playbook**, not thrash terminals |
| Status | Prefer host `ship-milestone --status` or Buzz after playbook notify; not “guess from Working…” |
| Promote only | `Promote production pin and install engine X.Y.Z only. Do not train, FRG, or release.` (idle session) |
| Clear poison | `/stop` then `/new` (once allowlisted) |
| Verify pin | `pipeline --version` and `pipeline factory-pin` |

**Do not re-send** `Ship milestone v1.33.0` after that version is tagged and promoted.

---

## 6. Historical state snapshot (end of the incident session)

| Item | State |
|---|---|
| Tag / release | **v1.33.0** published |
| Production pin (control repo) | **1.33.0** (after successful promote) |
| Host CLI (`~/.local/bin/pipeline`) | **1.33.0** |
| v1.34.0 ship playbook | Last run **failed at train** (#909 backlog) |
| #909 | Open, milestone v1.34.0, **pipeline:backlog** |
| #938/#939, PRs #940/#941 | Leftover **1.33 FRG** pack surface — not product 1.34 |
| Stage-watch scope fix | PR **#944**; host binaries updated |
| Hermes allowlist | `status`, `stop`, `new`, `whoami` for operator |

---

## 7. Actions recorded at the time (historical)

These items are retained for incident chronology; they are not the current runbook.

1. **Do not re-ship 1.33.0.**  
2. Before next `Ship milestone v1.34.0`:  
   - Triage **#909** → `pipeline:ready` or remove from milestone.  
   - Close/archive leftover FRG issues/PRs (#938/#939/#940/#941) if FRG already recorded.  
3. Merge **#944** if not already merged; keep host scripts in sync with `examples/supervisor/shell/`.  
4. Follow-up engine work (optional):  
   - `engine-promote` nested install vs `pipeline-starting` lock.  
   - Align `/usr/local/bin/pipeline` or document PATH so only the skill install is used.  
5. Prove 1.34 with a quiet Buzz feed: train messages for real issues only; no FRG archaeology.

---

## 8. Related PRs / issues (session-relevant)

| Ref | Note |
|---|---|
| #926 | train `--json` via registry supportsJson |
| #928 / #870 | Product work in the 1.33 train |
| #929 | Supervisor docs / portable ship examples |
| #942 | FRG evidence 1.33.0 |
| #943 | Release 1.33.0 |
| #944 | Stage-watch scope fix |
| #909 | Sole open product issue on milestone v1.34.0 (backlog) |
| #938/#939 | 1.33 FRG pack instances |
| #940/#941 | FRG pack PRs |

---

## 9. File index (for the next agent)

| Concern | Where to look |
|---|---|
| Supervisor contract | `docs/supervisor.md` |
| Ship runbook | `docs/runbooks/ship-milestone.md` |
| FRG checklist | `docs/runbooks/frg-pack-checklist.md` |
| Hermes deploy | `docs/runbooks/hermes-supervisor-deployment.md` |
| Playbook source | `examples/supervisor/shell/ship-milestone.sh` |
| Stage-watch source | `examples/supervisor/shell/ship-stage-watch.sh` |
| Stage-watch tests | `core/test/ship-stage-watch.test.ts` |
| This session | `docs/runbooks/session-2026-08-ship-factory-lessons.md` |
| Host state | `~/.local/state/pipeline-supervisor/ship-v*/` |
| Host pin | `$REPO_DIR/.agent-pipeline/production-engine-pin.json` |
| Hermes profile | `~/.hermes/profiles/pipeline-factory/` |
