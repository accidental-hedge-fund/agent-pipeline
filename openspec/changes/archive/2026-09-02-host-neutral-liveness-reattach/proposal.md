## Why

Logical durability already keeps a run ledger after a worker dies, but nothing host-neutral restores that worker. Host SKILLs currently mix follow text with lifecycle advice, so Claude, Codex, Grok, OpenCode, OMP, example supervisors, and direct CLI can diverge. A dead process can look like a terminal outcome or a human hold even though the Logical Operation is still owned.

## What Changes

- Add a host-neutral **Liveness Provider** that discovers machine-local durable runs, claims a fenced same-host lease, starts or reattaches the existing supervisor, refreshes worker identity, follows events, and relinquishes on terminal evidence.
- Keep RecoverySupervisor as the sole recovery-policy owner. The Liveness Provider does not classify faults, choose recipes, answer requests, merge, or create a second ledger.
- Make systemd, launchd, containers, harness workers, builtin hosts, and direct CLI implement the same liveness contract. Do not add host-specific recovery recipes.
- Coordinate concurrent launchers through the existing host-local lock and fencing identity. Do not start a duplicate supervisor.
- Treat a dead worker as lost physical progress, never as a logical terminal and never as human authority.
- Report continuous-liveness status from `pipeline doctor` as `configured`, `available`, `active`, or `degraded` / `unavailable`, with a typed capability condition. Absence of a keep-alive adapter is not a human hold.
- Restrict host artifacts to launch, follow, reattach, answer, cancel, and notification. Compare host parity by typed lifecycle outcomes, not prompt text.
- Retrofit supported adapters onto this durable liveness path. Keep #971 wrapper artifacts as an earlier, non-authoritative request/receipt/follow baseline. Keep Hermes and OpenClaw as example-supervisor conformance fixtures, not shipped hosts or control planes.
- Keep #1302 observational delivery unable to change lifecycle state.

## Capabilities

### New Capabilities

- `liveness-provider`: host-neutral same-host contract to discover eligible durable runs, claim a fenced lease, start or reattach the existing supervisor, refresh worker identity, follow events, and relinquish on terminal evidence without owning recovery policy.

### Modified Capabilities

- `outer-host-lifecycle-contract`: host artifacts are limited to launch, follow, reattach, answer, cancel, and notification; host parity compares typed lifecycle outcomes; unsupported host capability is a typed capability condition; Hermes and OpenClaw remain example fixtures.
- `doctor-preflight`: doctor reports continuous-liveness status (`configured` / `available` / `active` / `degraded` / `unavailable`) without treating absence as human authority.
- `generated-short-host-skill`: generated host SKILLs carry only launch, follow, reattach, answer, cancel, and notification behavior; they do not encode recovery recipes or retry controllers.
- `detached-launcher`: a launcher can discover and reattach an eligible durable run after worker or machine restart through the same fenced lease, without duplicate execution.
- `durable-loop-supervisor`: a dead worker does not make the logical run terminal; reattachment resumes the same supervisor after a fenced claim.

## Impact

- **Reuse first:** extend `pack-loop-liveness.ts` identity and heartbeat evidence, `lock.ts` / issue-run lock fencing, durable-loop store lock recovery, supervisor `--resume` / `recoverLock`, outer-host `reattach` plus the conformance kit, doctor’s injectable check model, `renderHostSkill`, and `pipeline logs --events --follow`. Do not add a lease service, cloud control plane, second scheduler, or host-named recovery table.
- **Class vs site:** worker or machine death without restoring the same durable supervisor is a shared liveness class. The next identical fault on any host uses this provider. Do not file a per-host mole.
- **CLI:** no new public recovery verb and no merge verb. Reattach uses existing detach / loop resume / logs follow surfaces. Doctor gains one continuous-liveness check.
- **Hosts:** builtin registry hosts (`claude`, `codex`, `grok`, `opencode`, `omp`) and direct CLI share supervisor semantics. OMP stays argv-capable without a generated SKILL. Hermes and OpenClaw stay example packs under `examples/supervisor/`.
- **#1302:** event follow and observational export remain read-only. They cannot advance, retry, merge, or terminalize a run.
- **Tests:** hermetic unit tests inject lock, process-identity, heartbeat, and doctor deps. Host parity uses the existing outer-host conformance kit and compares typed outcomes. Install smoke and `npm run ci` must pass.
- **Docs:** `CONTEXT.md` already names Liveness Provider; keep that term. Refresh CLI / doctor docs and generated host SKILLs (`node scripts/build.mjs`) after `core/` edits.
- **Sequencing:** consumes #1331 ship-phase supervision as prior graph context. Does not reimplement RecoverySupervisor (#1323), #1301 train linkage, or #1302 export. #1333 host-matrix rows consume this liveness contract.

## Acceptance Criteria

- [ ] After a worker or machine restart, a launcher discovers each eligible non-terminal durable run on that host and reattaches the same supervisor, or reports a typed capability condition when continuous liveness is unavailable.
- [ ] Two concurrent launchers for the same durable run on one host coordinate through the existing fenced lease. Exactly one supervisor runs. The loser does not start a duplicate.
- [ ] Killing the worker process of a non-terminal Logical Operation leaves the ledger non-terminal. Doctor and status do not project human authority from that death.
- [ ] systemd, launchd, container, and harness-worker adapters implement the same discover / claim / reattach / follow / relinquish contract. No adapter owns recovery recipes.
- [ ] `pipeline doctor` and `pipeline doctor --json` report continuous liveness as `configured`, `available`, `active`, or `degraded` / `unavailable`, with a typed capability condition. Absence is not a human-authority class.
- [ ] Claude, Codex, Grok, OpenCode, OMP, and direct CLI enter the same supervisor semantics (handoff, follow, reattach, answer, cancel, notify). Hermes and OpenClaw remain example-supervisor fixtures and are not shipped as builtin hosts.
- [ ] Generated host SKILLs and example supervisor artifacts contain only launch, follow, reattach, answer, cancel, and notification behavior. They do not classify faults, retry, merge, or create a ledger.
- [ ] Host-parity tests compare typed lifecycle outcomes (verified success, Cooling, external-condition wait, typed request, cancellation). Prompt-text equality is not the pass criterion.
- [ ] An unsupported host capability is a typed capability condition (Capability Request or checked `not_applicable`). It is not a False-human projection and not an ownerless terminal.
- [ ] #971 wrapper request/receipt/follow artifacts remain a non-authoritative baseline. Supported adapters reattach through this liveness contract rather than becoming retry controllers.
- [ ] #1302 observational delivery and `pipeline logs --follow` cannot change lifecycle state.
- [ ] Physical progress is not claimed while no worker or machine is running. Liveness `not-live` is not verified completion.
- [ ] Install smoke tests and `npm run ci` pass. After `core/` edits, `node scripts/build.mjs --check` passes.
- [ ] No cloud control plane, second scheduler, or host-specific recovery recipe is introduced.
