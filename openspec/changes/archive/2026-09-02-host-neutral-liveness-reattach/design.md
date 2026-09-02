## Context

See `proposal.md` for why.

Existing surfaces this change composes:

- `core/scripts/loop/pack-loop-liveness.ts` — pid, starttime, boot identity, heartbeat, and `not-live` vs ledger. A non-terminal ledger is already not liveness proof.
- `core/scripts/lock.ts` and `issue-run-lock` — host-local `(domain, issue)` fence with `pid starttime` markers. No cross-host claim.
- Durable-loop store lock — exclusive token, hostname, pid; same-host dead-pid recovery; recovery invalidates the old token.
- `driveSupervisor({ resume })` / `recoverLock` — attach the same loop run after a provably dead holder.
- Detached wrapper + `sentinel.json` — process-exit evidence for `pipeline run --detach`.
- Outer-host `reattach` / `wait_cancel.recovery = reattach_or_portable_follow` and the conformance kit.
- `pipeline logs --events --follow` — read-only observation; does not hold a run-liveness lock.
- `pipeline doctor` injectable checks.
- `renderHostSkill` / `SKILL_HOST_IDS` — four generated SKILLs; OMP argv-only; no Hermes/OpenClaw install.

`CONTEXT.md` already names Liveness Provider as distinct from Host and RecoverySupervisor. #1333 host-matrix rows consume this contract. #1302 observational delivery must stay unable to change lifecycle.

Class vs site: worker or machine death without restoring the same durable supervisor is one liveness class. Shared classifier, fence, doctor check, and host conformance are the class fix. A Hermes-only restart recipe would be a site mole.

## Goals / Non-Goals

**Goals:**

- First holding rung: compose the primitives above into one Liveness Provider. Extract a shared worker-identity probe from pack-loop liveness rather than forking a second classifier or a new lock family.
- Give systemd, launchd, containers, harness workers, builtin hosts, and direct CLI one discover / claim / reattach / follow / relinquish contract.
- Keep dead-worker and keep-alive-absent outcomes as typed liveness or capability conditions, never human authority.

**Non-Goals:**

- A cloud control plane, fleet lease service, or second scheduler (`execution-worker-management` stays out of this product path).
- Host-specific recovery recipes or a second RecoverySupervisor.
- Claiming physical progress while no worker is running.
- Promoting Hermes or OpenClaw to shipped hosts.
- Changing merge authority or making follow/export mutate lifecycle (#1302).
- Reimplementing #1331 ship-phase supervision, #1323 recovery policy, or #1301 train linkage.

## Decisions

### D1 — Liveness Provider is a core module that composes existing fences

Add a small core module (working name `liveness-provider`) whose deep interface is discover, probe, claim, attach, identity refresh, status, and relinquish-on-terminal. Production wiring uses:

| Step | Reused primitive |
| --- | --- |
| Discover | durable-loop store run list plus detached run-store / wrapper dirs on this host |
| Probe | shared worker-identity probe extracted from `pack-loop-liveness` (pid, starttime, boot, heartbeat) |
| Claim | issue-run lock for issue-scoped detach/advance; loop store lock token for loop/train/ship supervisors |
| Attach | existing supervisor `--resume` / `recoverLock` / detached wrapper re-entry for the same run id |
| Follow | `pipeline logs` / `pipeline loop logs --events --follow` |
| Relinquish | release fence only after terminal evidence RecoverySupervisor already owns |

Do not add `/tmp/pipeline-liveness-*.lock` or a distributed lease.

Alternative considered: reuse `execution-worker-management` fencing. Rejected: that plane is a fleet control path. This product forbids a second scheduler.

Alternative considered: only document systemd `Restart=` on the original argv. Rejected: reboot leaves non-terminal ledgers with no unit if the operator never installed one. Discover-and-restore is the class path.

### D2 — One liveness CLI family, not a recovery verb

Expose `pipeline liveness status` and `pipeline liveness restore` (names may match command-registry style, but the family is liveness, not recover/repair). Status is the doctor producer. Restore walks eligible same-host runs and attaches. Hosts, systemd, launchd, and containers exec those CLI forms. No `pipeline recover` and no host-local retry loop.

Doctor remains model-free checks. It SHALL NOT restore as a side effect of `pipeline doctor`.

Alternative considered: fold restore into `pipeline loop --resume` only. Rejected: detach, train, and ship supervisors would then need per-path moles.

Alternative considered: no new verb, library-only. Rejected: hosts would invent recipes, which is the problem statement.

### D3 — Extract shared identity evidence; keep pack-loop as a caller

Lift pid / starttime / boot / heartbeat freshness into a shared probe used by pack-loop liveness and the provider. Pack-loop-specific handoff kind and FRG prepare JSON stay in `pack-loop-liveness.ts`. Do not treat pack-loop `failed` after lost liveness as a template for Logical Operation terminal. Lost liveness is `not-live`; restore reattaches; RecoverySupervisor owns later recipes.

### D4 — Eligibility is resume-binding plus non-terminal ledger plus not-live worker

A run is eligible when all of these hold:

1. Durable resume binding (run id + handoff or ledger).
2. Logical Operation not verified-complete, not authenticated-cancelled, not a genuine typed request that forbids resume.
3. Worker probe `not-live` or same-host dead-pid lock.
4. Hostname matches this host.

Live holders stay exclusive. Cross-host locks stay unrestorable without force, matching durable-loop-store law.

Wrapper `sentinel.json` with non-zero exit is attempt evidence. Restore reattaches the same run id. A live holder still rejects duplicate `--detach`.

### D5 — Doctor reports four states as a capability check

Check id `liveness:continuous` (or equivalent stable name). Discriminant: `configured` | `available` | `active` | `degraded` | `unavailable`.

- No adapter configured (interactive one-shot CLI): `unavailable` / not-configured, `warn` or `skip`, typed capability condition. Doctor overall still passes.
- Adapter configured, no live run: `available`.
- Adapter configured, fenced worker live: `active`.
- Adapter configured but incoherent or probe broken: `degraded` / `unavailable`, remediation names the adapter.

Copy SHALL NOT say needs-human, authenticated decision, or human authority. Unit tests inject adapter and identity fakes.

### D6 — Host artifacts tighten through the shared renderer and conformance kit

Update `renderHostSkill` follow/reattach prose so generated SKILLs point at liveness restore and portable follow. Do not add per-host essays. Keep `SKILL_HOST_IDS` as `claude`, `codex`, `grok`, `opencode`. OMP stays argv-only. Example Hermes/OpenClaw packs get the same six-behavior constraint in fixtures; they are not registry builtins.

Host-parity tests compare typed outcomes from the existing outer-host kit plus liveness fixtures. Prompt-text equality is not the pass.

#971 request/receipt/follow wrappers call the same restore/follow CLI. They are not an authoritative lifecycle baseline.

### D7 — systemd, launchd, containers, and harness workers are adapters

Define a narrow adapter shape: configured?, probe, invoke restore argv, optional keep-alive. Built-in adapters may wrap systemd unit presence, launchd job presence, container restart policy, and harness-worker parent. Tests fake the adapter. The engine does not ship a daemon.

### D8 — #1302 follow stays observational

Restore may print run id and events path for hosts to follow. Follow and event-sink delivery cannot claim the fence, resume, merge, or write ledger terminal state.

## Risks / Trade-offs

- **[Risk] Detach sentinel already looks like completion to pollers.** → Mitigation: restore treats non-zero sentinel as worker-exit evidence; Logical Operation completion stays verified-completion only. Add a regression that a non-zero sentinel plus unproven postcondition remains eligible.
- **[Risk] Pack-loop prepare currently fails after lost liveness.** → Mitigation: class fix is restore then RecoverySupervisor; do not copy prepare-fail as Logical Operation terminal. Pack-loop FRG JSON may still report `not-live` as observation.
- **[Risk] New liveness CLI is mistaken for recovery.** → Mitigation: help text and command-registry disposition are bounded administration / liveness, not supervised recovery. Restore MUST NOT call `repair_pipeline_item` or classify faults.
- **[Risk] Host SKILL one-pager grows another essay.** → Mitigation: add a short restore bullet to the existing follow list; keep recovery out.
- **[Risk] Reboot restore races two units.** → Mitigation: existing fenced locks; second restore reports the live holder.
- **[Trade-off] Single-host scope remains.** → Cross-host death stays unrestorable without force, same as loop-store law. That is the documented disposition, not a missing distributed lock.

## Migration Plan

1. Extract shared worker-identity probe. Keep pack-loop tests green.
2. Add provider discover/claim/attach with injected deps. Red tests: duplicate supervisor, new Logical Operation, human-authority projection.
3. Wire `pipeline liveness status|restore` through command registry. Doctor consumes status.
4. Point detached re-entry and loop resume at the provider for eligibility. Keep live-holder duplicate rejection.
5. Tighten `renderHostSkill` and example supervisor fixtures. Run `node scripts/build.mjs`.
6. Add outer-host conformance / host-parity fixtures for typed outcomes.
7. `openspec validate host-neutral-liveness-reattach` and `npm run ci`.

Rollback: additive module and doctor check. If restore mis-attaches, disable the restore CLI and keep existing `--resume` / detach lock behavior. Do not restore a second scheduler.

## Open Questions

None. Adapter detection for systemd vs launchd is an implementation detail behind the injectable adapter seam and does not change the contract.
