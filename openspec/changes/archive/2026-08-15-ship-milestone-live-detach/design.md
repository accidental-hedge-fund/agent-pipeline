## Context

See proposal.md — Why. Option 1 thin ship is Tugboat (`examples/supervisor/shell/tugboat.sh`). Today `ship_already_running` treats a milestone lock dir + `playbook.pid` / `lock/pid` with `kill -0` as “already running.” That is too weak and too broad:

- A **stale** pid file can pass `kill -0` for an unrelated process, or a dead ship can leave `state.json` as `running`.
- A **per-issue** `pipeline N` lock is unrelated to milestone ship and must never block detach.
- Hermes `env.example` still defaults `REPO_DIR` to `agent-pipeline-factory-control`, so a TUI/model paste can retarget the ship plane.

Grill-locked decisions (issue #1062 comments): live ship = detached `train --merge` for that milestone; playbook is the launcher, not the definition of live; Buzz and TUI share one detach path; REPO_DIR pinned at tugboat start.

Constraints:

- Host composes CLI; engine owns train/merge policy. Advance/loop never merge.
- Single-host supervisor locks remain host-local; this change does not claim cross-host ship mutexes.
- Surgical change: fix the probe class in Tugboat + pin origin; do not grow a second ship brain or paste detector.
- #1074 already requires STOP text to quote blocker class; do not re-implement train STOP here.

## Goals / Non-Goals

**Goals:**

- One falsifiable live-ship probe for Option 1 detach refuse.
- Idempotent detach: second Ship while live → status + notify only.
- Ship while only an issue-run lock is held still detaches.
- `REPO_DIR` refuse `*factory-control*`; env template fixed.
- Dead pid / stale state does not report “running” from status alone.
- Regression tests that fail if probe or refuse regresses.

**Non-Goals:**

- Cross-host distributed ship lock.
- Paste / NL detector (#974).
- Notify delivery reliability (#1059).
- Factory brain / durable supervisor notes (#1077).
- Changing train merge policy or recovery ladder internals.
- Deleting the alternate playbook script (Tugboat remains primary).

## Decisions

### 1. Live ship = process evidence of `train --merge` (or owning tugboat)

- **Choice:** A milestone has a live ship only when there is a live process whose cmdline contains the train ship invocation for that milestone (e.g. `pipeline train … --milestone vX.Y.Z … --merge`, or equivalent argv shape Tugboat launches), **or** a live tugboat process that owns/is about to own that train for the same milestone (parent composer pid recorded after a successful detach of this tugboat binary with matching milestone args).
- **Why:** Matches grill lock: playbook/tugboat is the launcher; live ship is the train --merge work. Pid files alone are identity-free.
- **Alternative:** Trust `playbook.pid` + `kill -0` only — **rejected**; caused the incident (dead/stale pid treated as live).
- **Alternative:** Treat any pipeline activity on the host as live ship — **rejected**; issue locks would block milestone ship forever.

### 2. Probe is the only second-detach refuse gate

- **Choice:** Before detaching, run the live-ship probe for each requested milestone. If live → print status (existing state/status surface) + notify “already running”; exit 0 without spawning. If not live → detach once. Do not consult issue-run locks, bare pid files without cmdline match, or `--status` text alone.
- **Why:** Single path for Buzz and TUI paste; no paste detector needed.
- **Alternative:** Hermes-side “already running” heuristics from chat history — **rejected** (non-deterministic; out of class).

### 3. Status liveness is process-backed, not state-json alone

- **Choice:** When `--status` would report phase status `running` (or equivalent “in progress”), Tugboat SHALL confirm a live ship via the same probe class. If the recorded pid is dead / cmdline does not match, status SHALL report a non-running terminal-or-stale outcome (e.g. `stale` / `none` / last known failed detail) rather than “running.”
- **Why:** Acceptance item: dead pid `--status` is not “running.”
- **Alternative:** Always cat `state.json` verbatim — **rejected** for the running claim when pid is dead.

### 4. REPO_DIR resolved once; refuse factory-control

- **Choice:** At tugboat process start (before detach child or ship_one), canonicalize `REPO_DIR` from the environment (install/deployment). If the resolved path matches `*factory-control*` (basename or full path substring as a simple, testable rule), refuse with a clear error and do not detach. Do not re-read or accept model-supplied overrides after that pin for the lifetime of the process.
- **Why:** Live plane must not be the retired factory-control checkout; session text rewrote REPO_DIR in the incident.
- **Alternative:** Allowlist only `ap-main-control` — **too host-specific**; refuse known-wrong plane is enough and matches the issue wording.
- **env.example:** Change default path to a non-factory-control placeholder (e.g. `ap-main-control` or a neutral `/home/YOU/dev/YOUR-control-checkout` with a comment that factory-control is refused).

### 5. Milestone lock remains for same-host mutex, separate from live-ship probe

- **Choice:** Keep the existing directory lock (`ship-vX.Y.Z/lock`) for mutual exclusion **after** a ship process is actually running this host’s tugboat for that milestone. The **detach refuse** decision uses the live-ship probe (cmdline), not “lock dir exists.” Stale lock reclaim stays process-liveness based for the **lock holder that is this tugboat**, but detach-from-outside still keys off live train/tugboat cmdline so a leftover lock file without a live ship does not block Ship.
- **Why:** Avoids conflating mutex implementation with “is ship live?” operator semantics.
- **Risk mitigation:** Tests cover: stale lock + no train → detach; live train cmdline → no second detach.

### 6. Test strategy: source/static + scripted process fixtures

- **Choice:** Extend `core/test/tugboat.test.ts` (and extract pure helpers if probe logic moves into a small testable script) so that:
  - Source/static assertions encode refuse of factory-control and presence of cmdline-based probe (not only `kill -0` on playbook.pid).
  - Where feasible, fixture-driven runs of the probe helper with fake pid/cmdline tables prove: issue lock alone → not live; dead pid → not running status; live train cmdline → live; second detach refused.
- **Why:** Unit tests inject I/O; no real network/git. Shell-heavy probe may need a thin pure helper for deterministic fixtures.
- **Alternative:** Only regex-on-source tests — useful but weaker for acceptance; prefer at least one behavioral fixture for the probe.

## Risks / Trade-offs

- **[Risk]** Cmdline matching is OS-dependent (`/proc/pid/cmdline` on Linux).  
  **Mitigation:** Document Linux/agent-box as supported host; probe fails open to “not live” (allow detach) rather than false “running” when cmdline cannot be read — false refuse was the production bug class.

- **[Risk]** Over-broad cmdline match (any `train --merge` on host) blocks unrelated milestones.  
  **Mitigation:** Match must include the milestone / version coordinate for the requested ship.

- **[Risk]** Refuse `*factory-control*` breaks a host that still legitimately uses that directory name.  
  **Mitigation:** Issue explicitly forbids that plane for live ship; rename/migrate checkout if needed. env.example fixed.

- **[Risk]** Status changing from raw state.json to process-backed “running” surprises operators scraping JSON.  
  **Mitigation:** Preserve phase/detail fields; only correct the false “running” claim when pid is dead; document in status scenario.

- **[Risk]** Scope creep into Hermes chat logic.  
  **Mitigation:** Skill docs state the shared path; no paste detector; Tugboat owns the probe.

## Migration Plan

1. Land OpenSpec + Tugboat probe/status/REPO_DIR + env.example + tests in one PR for #1062.
2. After promote/install: refresh `tugboat` (and skill/env template) on agent-box from repo examples.
3. Operator: set `REPO_DIR` to live control checkout (not factory-control); verify `Ship milestone` detaches when only issue locks exist.
4. Rollback: reinstall previous tugboat binary; no GitHub schema migration.

## Open Questions

- None that block the specs. Optional later nicety: extract probe to a tiny `live-ship-probe` helper binary shared with status — not required if Tugboat functions stay testable.
