## Why

Operator `Ship milestone vX.Y.Z` on Buzz did not detach a live ship. The supervisor probed a **dead** playbook pid / stale state and treated a per-issue `pipeline N` lock as an already-running ship, so it refused to launch. A TUI paste of the same thread then stacked a second playbook with `REPO_DIR=…/agent-pipeline-factory-control` (wrong plane; live ship target is the control checkout such as `ap-main-control`). Live ship must mean a detached `pipeline train --merge` for that milestone (or the tugboat that owns it). Anything else must still detach once.

## What Changes

- Define **live ship** for a milestone as a live process whose cmdline is `train --merge` for that milestone, or the tugboat that owns that process — **not** bare `playbook.pid` + `kill -0`, **not** a per-issue `pipeline N` / `pipeline single N` lock, **not** `--status` on a dead pid or stale `state.json` alone.
- Make the **live-ship probe** the only gate that may refuse a second detach for that milestone.
- Unify Buzz and TUI paste on one path: live ship present → report status + notify, no second detach; else detach once. No paste detector.
- Pin **ship origin**: resolve `REPO_DIR` once at tugboat start from install/env; refuse paths matching `*factory-control*`; session/model text cannot retarget after start.
- Fix `examples/supervisor/hermes/env.example` so the default is not `agent-pipeline-factory-control`.
- Ensure dead-pid / stale-state `--status` does not report the ship as **running**.
- Unattended Ship remains non-blocking in the Buzz thread (detach and return). Real park/block surfaces via train STOP with quoted class (existing #1074 contract); this change does not re-open that.
- Regression tests for the probe and REPO_DIR refusal via injected/fixture deps where the CLI surface is in-repo; full `npm run ci` when core changes.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `tugboat-thin-ship`: Live-ship definition and probe for Option 1 detach; shared Buzz/TUI detach path; REPO_DIR pin + factory-control refuse; status must not claim running from dead pid / stale state alone; per-issue pipeline lock is not a live ship.

## Acceptance criteria

- [ ] Live-ship probe treats only a live pid whose cmdline is `train --merge` for the requested milestone (or the tugboat that owns it) as already-running.
- [ ] Bare `playbook.pid` + `kill -0` alone does **not** refuse detach when no live train/tugboat ship exists.
- [ ] A held per-issue `pipeline N` / `pipeline single N` lock does **not** refuse detach; Ship still detaches once for the milestone.
- [ ] Second identical `Ship milestone` (Buzz or TUI paste) while a live ship exists reports status + notify and does **not** stack a second detach.
- [ ] When no live ship exists, Ship detaches exactly once (Buzz and TUI paste share this path; no paste detector).
- [ ] `REPO_DIR` is resolved once at tugboat start from install/env; a path matching `*factory-control*` is refused; session/model text cannot retarget the ship root after start.
- [ ] `examples/supervisor/hermes/env.example` does not default `REPO_DIR` to `*factory-control*`.
- [ ] `--status` for a milestone with a dead recorded pid / stale “running” state does **not** report the ship as running solely from that artifact.
- [ ] Automated tests cover the probe and REPO_DIR refuse rules (injected deps / fixtures for in-repo surfaces); `openspec validate ship-milestone-live-detach` and `npm run ci` are green when core changes land.

## Impact

- **Primary surface:** `examples/supervisor/shell/tugboat.sh` (Option 1 primary ship composer — detach probe, status liveness, REPO_DIR pin).
- **Config template:** `examples/supervisor/hermes/env.example` (default `REPO_DIR` plane).
- **Docs / skill:** `examples/supervisor/hermes/SKILL.md`, `docs/runbooks/hermes-supervisor-deployment.md` / ship runbook notes only as needed so operators and the skill do not treat issue locks or dead pids as live ships, and do not point `REPO_DIR` at factory-control.
- **Tests:** extend `core/test/tugboat.test.ts` (and helpers if extracted) so probe / refuse rules bite without real network or live systemd.
- **Out of scope:** #1059 notify send swallowed; #974 shared NL parser; #1077 factory brain; MessagingPort / grant factory; making advance/loop merge; second recoverer inside `train.ts`; paste-specific detector.

## Class vs site (engine / ship-path dogfood)

| Question | Answer |
|----------|--------|
| Class vs site? | **Class:** “already running ship” must mean live `train --merge` (or owning tugboat) for the milestone — not host scratch (`playbook.pid`, issue-run lock, stale status). **Site:** Tugboat is the Option 1 detach gate that must enforce the class law. |
| Shared surface? | Live-ship probe + REPO_DIR pin in Tugboat (and hermes env template). Hermes skill maps phrase → same detach path; no second probe in chat. |
| Next identical fault? | Dead pid / issue lock / factory-control default cannot refuse or mis-target a Ship again without failing the probe/refuse regressions. |
