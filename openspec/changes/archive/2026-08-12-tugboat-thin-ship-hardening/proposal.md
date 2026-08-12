## Why

Option 1 (#1001) shipped Tugboat: a thin host composer that sequences existing Pipeline CLI verbs plus wait/notify. Operator docs, Hermes skill, agent-box install, and doctor still describe or admit divergent ship paths (`pipeline-ship-playbook`, authorized `ship-milestone` / `pipeline ship`). Hardening locks one thin path, preserves #989 / #996 / #997 behavior, and makes install drift fail closed before the next Buzz ship.

## What Changes

- Canonicalize **Tugboat** (`examples/supervisor/shell/tugboat.sh` + sibling helpers) as the **only Option 1 ship path** for agent-box / Buzz `Ship milestone vX.Y.Z`.
- Align Hermes skill, SOUL phrase mapping, supervisor README, and ship runbook so operator phrase → argv is Tugboat (detach + `--status` / state dir), not a second playbook or in-engine `pipeline ship` product path.
- Preserve and regression-guard:
  - failure lines include phase + reason (blocker / err tail) — #997
  - release-finish never races pending checks — #996
  - engine-promote defaults to all hosts (codex/claude/grok/opencode) — #989
  - idempotent reuse of an existing open release PR for the version
  - serial multi-milestone (promote between; no parallel fat state machine)
  - single stage-watch + notify install (no dual divergent binaries)
- Add doctor / install-parity checks so `~/.local/bin` ship binaries match repo `examples/supervisor/shell/` sources (or fail with refresh remediation).
- Keep parked non-goals out of scope: auto-file ship failures, MessagingPort/Slack, grant factory, shared NL platform, Option 2 in-engine ship.

### Acceptance criteria

- [ ] On a host configured for Option 1 ship, `Ship milestone vX.Y.Z` (Buzz / Hermes) detaches **Tugboat** only; it does not start a second divergent ship binary as the primary path.
- [ ] Installed ship-related entrypoints under `~/.local/bin` for the Option 1 path are copies of `examples/supervisor/shell/` sources (tugboat + shared notify/stage-watch/helpers), not a host-local fork with different phase logic.
- [ ] When a ship phase fails, the operator-visible notify/state detail includes a non-empty reason drawn from the phase blocker or error capture (not only `exit N`).
- [ ] Tugboat waits until the release PR checks are green (valid `gh pr checks` schema) before invoking `pipeline release finish`.
- [ ] With no host override, engine-promote runs with `--host all` (or equivalent multi-host default); single-host `ENGINE_PROMOTE_HOST` override is still honored.
- [ ] If an open release PR already exists for version `X.Y.Z`, Tugboat reuses that PR and does not open a second release PR for the same version.
- [ ] `--milestones A B` (when used) ships serially with promote after each milestone; no parallel multi-milestone ship state machine.
- [ ] Operator docs document phrase `Ship milestone vX.Y.Z`, status via `tugboat --status` / `~/.local/state/pipeline-supervisor/ship-vX.Y.Z/`, and state/log layout.
- [ ] Automated tests fail if thin-composer markers regress (second ship brain / grant factory / `pipeline ship ` as product path, bare-version release rule, CI-wait field schema, promote default `all`, failure_detail enrichment).
- [ ] Scope stays host-thin + docs/doctor/regression: no new `pipeline ship` stage, no merge-from-advance, no MessagingPort / grant factory / NL platform work.

## Capabilities

### New Capabilities

- `tugboat-thin-ship`: Option 1 thin ship composer contract — phase sequence, failure detail, CI wait, promote-all default, idempotent release PR reuse, serial multi-milestone, single install path, operator phrase/status, and install-parity / doctor expectations.

### Modified Capabilities

- `supervisor-ship-playbook`: Clarify role under Option 1 — chain playbook remains a documented alternate composition for hosts that still install it, but it is not the primary Buzz/agent-box ship path; install/doctor guidance points operators to Tugboat as the thin canonical path when both exist.

## Impact

- **Primary surfaces:** `examples/supervisor/shell/tugboat.sh` and siblings (`ship-notify.sh`, `ship-stage-watch.sh`, `train-status-complete.py`, `release-checks-green.py`); Hermes skill / SOUL phrase map; `examples/supervisor/README.md`; `docs/runbooks/ship-milestone.md` / `docs/supervisor.md`; doctor checks (new or extended install-parity); `core/test/tugboat.test.ts` (and related doctor tests).
- **Operators:** Buzz `Ship milestone vX.Y.Z` remains the phrase; status and logs stay under the supervisor state dir; refresh of `~/.local/bin` from repo examples becomes enforceable.
- **Engine:** Prefer docs/tests only unless a real CLI bug is found; no new ship stage or auto_merge.
- **Out of scope:** Auto-file ship failures onto the milestone; gateway heartbeat product tuning; grant factory / MessagingPort / Slack / ship-auth issuer (#966–#968, #973); shared NL intent platform (#974 beyond one-liner phrase → argv); Option 2 in-engine ship.
