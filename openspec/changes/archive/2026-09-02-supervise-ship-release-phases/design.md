## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `core/scripts/stages/ship.ts` — `runShipCoordinator`, atomic status, reconcile-then-converge, `persist()` that writes `last_error` and infers `human_authority` from `/needs-human|missing-authority|human.authority|specification-decision/i`, then rethrows.
- `core/scripts/stages/ship-adapter.ts` — production `ShipCoordinatorDeps`. Each converge seam already re-observes GitHub/FRG/pin truth before mutation.
- `core/scripts/stages/engine-promote.ts` — pin, install, version-string verify; on install/verify failure after pin mutation it calls `rollbackProductionPin` and tries to reinstall the previous tag.
- `core/scripts/production-engine-pin.ts` — `promoteProductionPin` / `rollbackProductionPin` with retained `previous` snapshot.
- `core/scripts/stage-diagnostic.ts` — `projectStageDiagnostic` already projects `human_authority` from canonical diagnostics without inspecting prose (`core/test/porcelain-dirt-sites.test.ts`).
- `core/scripts/loop/recovery.ts` — Cooling, claimed attempts, strategy cursor, `HUMAN_AUTHORITY_CLASSES`.
- `core/scripts/loop/reconcile.ts` and `durable-run-reconciliation` — observe live truth before replay.
- `config.roadmap.release_model` — `'semver' | 'continuous'`, default `'semver'` (`pipeline-configuration`).
- ADR 0003 (supervised operations retain ownership), ADR 0005 (shipment intent and Candidate Lineage).
- RecoverySupervisor (`CONTEXT.md`, #1323) as sole lifecycle owner. This change does not invent a second owner.

Class vs site: persist-and-rethrow, regex-inferred authority, version-string deploy proof, and auto-rollback on generic install failure are one post-ready supervision class. Shared invariants, claims, observers, and crash fixtures are the class fix. A release-only mole would miss tag, promote, and rollback.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: keep `runShipCoordinator` as the compatibility projector. Add Candidate Lineage nodes and operation invariants onto existing ship evidence records. Report observations through `projectStageDiagnostic` and RecoverySupervisor. Reuse `rollbackProductionPin` as the rollback mutation adapter, not as a hidden promote side effect.
- Replace persist-and-rethrow with owned Cooling / external wait / typed request.
- Bind authority to operation, repository, candidate, scope, actor, and expiry.
- Prove deployment by live digest, not `pipeline --version`.
- Interpret the existing `roadmap.release_model` key. Do not add `ship.model`.

**Non-Goals:**

- A second RecoverySupervisor, ship controller, grant schema, or scheduler.
- Making `advance` / `single` / `loop` merge or deploy.
- Bypassing FRG, release-integrity, or tag observers.
- Treating observational notify as lifecycle authority.
- Reimplementing #1323 recovery policy, #1330 merge exactness, #1332 liveness, or #1333 matrix ownership.
- Changing standalone `pipeline release` operator exit codes except where they are ship-phase adapters.

## Decisions

### D1 — Ship coordinator is the projector; RecoverySupervisor is the owner

Keep `pipeline ship --milestone` as the public composer. Do not add `pipeline supervise-ship` or a new ledger family. `ShipStatus` stays the restart checkpoint and host-facing projection. Lifecycle treatment (Cooling, wait, typed request, verified completion, cancellation) belongs to RecoverySupervisor (#1323).

If the RecoverySupervisor module is not yet landed, ship phases SHALL still emit the same typed observations and claims that module will consume (`operation observation`, side-effect certainty, candidate epoch). Do not fork a ship-local policy table.

Alternative considered: make `engine-promote` and `release` own their own recovery. Rejected: that is the current command-local failure semantics.

Alternative considered: replace `ship.ts` with a generic RecoverySupervisor driver. Rejected: ship already has typed evidence, reconcile, and converge seams. First holding rung is to stop those seams from declaring terminal policy.

### D2 — Candidate Lineage is typed evidence fields, not a new graph store

Extend `ShipProgress` with explicit lineage nodes and observers:

| Node | Observer |
| --- | --- |
| integrated base candidate | GitHub base containment / merge proof already used by train observation |
| FRG candidate | HMAC `latest.json` packed SHA |
| release PR head | GitHub PR number + head SHA + base |
| release merge result | merged PR merge-commit OID |
| tag | origin annotated tag peeled commit |
| published artifact | non-draft GitHub Release bound to that tag |
| promoted pin | production pin version + `git_sha` digest |
| deployed artifact and environment | live installed engine digest for the selected host set |

Do not add `core/scripts/lineage/` as the ship-path store. Intent-lineage-graph is a different product surface. Invalidation is per-edge: movement of a node makes downstream verification non-current.

Alternative considered: one SHA for the whole ship. Rejected by ADR 0005.

### D3 — Replace persist-and-rethrow with owned states on the existing status record

Change `run()` in `ship.ts` so mechanical faults persist Cooling / wait and return status. Keep the pending-check wait checkpoint. Delete the product path that writes `last_error` and rethrows as ownerless terminal.

Reuse loop recovery claim shape (item/operation + candidate + evidence fingerprint + `outcome: "started"`) for post-ready mutations. Charge the claim before the side effect. Crash after `started` reconciles the postcondition against the observer.

Host adapters already re-invoke the same `pipeline ship --milestone` argv on non-human failure. Returning owned status (instead of thrown failure) is compatible with that. `human_authority` true remains the host stop bit, produced only from typed authority.

Alternative considered: convert every ship failure into `pipeline:needs-human`. Rejected: false-human projection.

### D4 — Authority comes from `projectStageDiagnostic`, never error regex

Delete the `lastError` regex in `persist()`. Set `human_authority` only when a current diagnostic/request projects `human_authority`. Keep the status field so hosts and #1096-era consumers still see a boolean, with opposite meaning for prose-only errors.

Existing tests that throw `needs-human: missing-authority...` and expect `human_authority: true` MUST flip: that fixture becomes a false-human regression.

Alternative considered: parse structured error classes from `Error.name` only. Rejected: `projectStageDiagnostic` is already the canonical projection and forbids prose inspection.

### D5 — One `roadmap.release_model` policy, no `ship.model`

`ship-adapter` / coordinator reads `resolveReleaseConfig` / `config.roadmap.release_model`. Continuous: after train evidence proves exact-candidate integration, `next_action` is `complete` and SemVer converge functions are not called. SemVer: keep the current post-train sequence and add deployment as the live-digest proof currently approximated by engine-promote verify.

Do not add `ship.model` or a parallel intent enum in config. Discriminated intent in the ship record may name `semver` vs `continuous` as a projection of that one key.

Alternative considered: keep forcing every ship through versioned release. Rejected by ADR 0005 and #1024.

### D6 — Rollback is `factory-pin rollback`, never a promote catch block

Remove auto-`deps.rollback()` from the engine-promote install/verify failure paths. Those paths report observation + certainty and leave the pin for reconciliation.

`rollbackProductionPin` remains the mutation helper. RecoverySupervisor admits it only as the rollback operation with:

- operator argv `pipeline factory-pin rollback` (existing envelope: operator invocation + retained `previous` or `--to`), or
- an authenticated ship/authorization document that names rollback and the retained target.

Generic deployment failure grants neither.

Trade-off: a half-promoted pin can remain until authorized rollback. That is required. Cooling plus status `next_action` naming rollback-needed is the operator-visible state. Do not silently restore the previous pin.

### D7 — Live digest is the deployment observer

Reuse production pin `git_sha` and engine-identity / peeled tag SHA as the authorized digest. Deployment observe MUST compare that digest to the live installed engine identity (same evidence `engine-promote` and doctor already use for pin coherence), not `installedVersion() === version`.

Installer exit 0 plus matching version string is ingress evidence. Completeness requires digest match for the selected host set (`all` by default).

### D8 — Crash tests extend `ship.test.ts` with injected seams

Every external side effect already has a converge function. Add fresh-process fixtures that:

1. Run until the mutation is `started` or the observer shows complete.
2. Drop the process (new `runShipCoordinator` call on the same store).
3. Assert no second mutation and owned lifecycle if the postcondition is unproven.

Cover: train merge, FRG pack/attest, release PR create, release merge, tag push, GitHub Release, pin write, install, rollback. Use the existing memory store. No real network, git, or subprocess.

## Risks / Trade-offs

- **[Risk] #1323 RecoverySupervisor is still a forthcoming module.** → Mitigation: emit the observation/claim types CONTEXT.md already names. Do not ship a second policy owner. Implementation tasks that call RecoverySupervisor APIs wait on that module in the same milestone graph, matching #1333's sequencing.
- **[Risk] Removing auto-rollback leaves a promoted pin with a failed install.** → Mitigation: that state is owned Cooling with a typed next action. Operator `factory-pin rollback` remains. Tests prove install failure does not call rollback.
- **[Risk] Hosts currently treat thrown ship errors as re-invoke signals.** → Mitigation: keep non-zero CLI exit optional for mechanical Cooling, but persist resumable status first. Hosts already re-invoke the same argv. Status `human_authority` stays the stop bit.
- **[Risk] Existing #1096 regex test will fail.** → Mitigation: replace it with a biting false-human regression. Keep a positive fixture that a canonical diagnostic still sets the bit.
- **[Risk] Continuous ship records are still version-shaped.** → Mitigation: derive version from milestone only for SemVer; continuous keys repository + base + milestone and MUST NOT require a release version for completion.
- **[Trade-off] Standalone `pipeline release` still exits non-zero.** → Acceptable. Command-local operator UX stays. Ship-phase adapters MUST NOT turn that exit into ownerless ship terminal.

## Migration Plan

1. Add lineage fields and operation-invariant tables next to existing `ShipProgress` evidence. Keep `schema_version: 1` compatible if new fields are additive; bump only if old readers would misread Cooling as complete.
2. Stop regex authority. Flip #1096 test. Wire `projectStageDiagnostic`.
3. Stop persist-and-rethrow. Persist Cooling/wait. Add crash fixtures per side effect.
4. Read `roadmap.release_model` in the coordinator. Continuous completes at integration.
5. Change engine-promote verify to digest comparison. Remove auto-rollback catch. Keep `factory-pin rollback` as the protected operation.
6. Align CLI / FRG runbook / `CONTEXT.md` terms. Run `node scripts/build.mjs` after `core/` edits.
7. `openspec validate supervise-ship-release-phases` and `npm run ci`.

Rollback of this change: revert the coordinator and engine-promote patches. Prior regex and auto-rollback behavior would return. Do not restore a second scheduler.

## Open Questions

None. Deployment in this product is pin plus host-skill install. There is no separate cloud target in scope. Digest vs version is decided in D7.
