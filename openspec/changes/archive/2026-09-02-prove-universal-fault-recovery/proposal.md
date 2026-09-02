## Why

Island unit tests and named incident regressions do not prove that unknown errors and inconsistent states travel through every public entry point to the same recovery owner. Legacy command-local retry, parking, and STOP paths can survive unnoticed. Factory Reliability Gate (FRG) unique-operation scoring already fail-closes on missing #1333 coverage, but production still stamps the five required lifecycle classes without an executable matrix.

## What Changes

- Add one executable fault-and-state matrix whose dimensions are operation, fault/state, public entry point, and host. Known GitHub, CI, conflict, auth, and worktree incidents become fixtures inside generic fault classes. They are never production dispatch keys.
- Prove every required lifecycle class through three coverage layers: adapter contracts, installed-CLI black-box entry points, and host conformance. FRG promotion fails when a required class lacks coverage.
- Delete obsolete command-local retry, recovery, parking, and STOP implementations only after replacement matrix rows pass. Add static guards against direct stage lifecycle writes, command-local lifecycle exits, and retired-controller imports.
- Supersede living requirements that terminalize mechanical exhaustion or project it as human ownership. Mechanical fixtures must end in Cooling, an external-condition wait, or a valid typed request. Genuine decision, capability, and authority fixtures must stop before unauthorized action.
- Cover both #1024 ship models. Absence of SemVer-only phases is a correct continuous outcome, not missing proof.
- Keep #740 hidden evals out of production lifecycle proof.

## Capabilities

### New Capabilities

- `universal-fault-recovery-matrix`: executable operation × fault/state × entry-point × host matrix; three coverage layers; checked `not_applicable` cells; FRG 100% required-class coverage; static guards against legacy lifecycle exits; mechanical fixtures produce no false-human projection and no ownerless terminal.

### Modified Capabilities

- `factory-reliability-gate`: consume matrix-produced coverage as the #1333 proof. Stub helpers that stamp every required lifecycle class without matrix rows SHALL fail promotion.
- `operation-reliability`: `covered_lifecycle_classes` SHALL come from executed matrix rows. Passing unique-operation fixtures SHALL NOT declare coverage they did not prove.
- `autonomous-recovery-controller`: mechanical, unknown, and strategy exhaustion SHALL enter Cooling, an external-condition wait, or a valid typed request. They SHALL NOT terminate as engine-owned STOP or human ownership.
- `durable-loop-supervisor`: `recovery_exhausted` SHALL NOT be a terminal run stop. Strategy-cursor exhaustion SHALL remain owned Cooling or an external wait.
- `durable-run-reconciliation`: resume and catch-up law SHALL treat former `recovery_exhausted` stops as owned Cooling rather than a terminal ledger stop.
- `integrated-train-mode`: train SHALL NOT STOP solely because a nested loop records mechanical or recovery exhaustion.
- `outer-host-lifecycle-contract`: the matrix host dimension SHALL reuse the existing outer-host conformance kit and compare typed lifecycle outcomes, not prompt text.

## Impact

- **Reuse first:** extend `REQUIRED_LIFECYCLE_CLASSES_1333`, `REQUIRED_PUBLIC_ENTRYPOINTS`, and `aggregateUniqueOperationReliability` in `core/scripts/operation-reliability.ts`. Reuse the ship-path composition inventory/drift-guard pattern, FRG Layer A hermetic probes, the outer-host conformance kit, and `COMMAND_REGISTRY` / #1329 operation inventory. Do not add a second RecoverySupervisor, FRG runner, scheduler, or fault-matrix CLI verb.
- **CLI:** no new public verb. Coverage feeds existing `pipeline factory-gate` / `operation_reliability`.
- **Tests:** adapter-contract unit tests with injected I/O; installed-CLI black-box rows; host-conformance rows. Unit tests perform no real network, git, or subprocess. Installed-CLI and host layers use the existing install-smoke / conformance seams.
- **Docs:** `CONTEXT.md`, FRG runbook, CLI docs, generated host SKILLs, and living specs must agree. Run `node scripts/build.mjs` after `core/` edits.
- **Sequencing:** consumes RecoverySupervisor (#1323), operation inventory (#1329), host-neutral liveness (#1332), unique-operation reliability (#1368), and both #1024 ship models. #1301 live train linkage remains a separate FRG proof. #1362 and #1344 contribute fixtures and typed behavior to this matrix.

## Acceptance Criteria

- [ ] One executable manifest declares operation, fault/state, public-entrypoint, and host dimensions. Adding a dimension creates failing uncovered cells. Impossible cells carry a checked `not_applicable` reason.
- [ ] Required fault/state classes include exception, rejection, nonzero exit, signal, timeout, malformed or contradictory output, interrupted or uncertain side effect, stale or corrupt durable state, event or ledger partial writes, candidate movement, remote mutation, dependency cycle, no progress, clock or lease ambiguity, unavailable harness, observer failure, unseen provider error shape, process death at each side-effect boundary, and strategy exhaustion.
- [ ] Lifecycle cases run through numeric drive, `single`, `loop`, `train`, `merge`, merge queue, `ship`, and every supervised disposition from the operation inventory.
- [ ] Installed-host parity covers every supported host. Hermes and OpenClaw remain conformance fixtures, not silently promoted shipped hosts.
- [ ] Coverage has three layers: adapter contracts, installed-CLI black-box entry points, and host conformance. FRG requires 100% of required lifecycle classes. Missing coverage is an integrity failure, not an exclusion.
- [ ] Every mechanical fixture produces zero false-human projections and zero ownerless terminals. No mechanical fixture ends as a terminal supervisor STOP.
- [ ] A fresh-process restart never replays a completed side effect. Workflow continuation occurs only after the target invariant is proven.
- [ ] Genuine decision, capability, and authority fixtures stop before unauthorized action.
- [ ] Known incident details appear only in fixtures, not in production routing. Production routing contains no incident or provider string keys.
- [ ] Obsolete command-local retry, recovery, parking, and STOP paths are removed only after replacement rows pass. Static guards reject direct stage lifecycle writes, command-local lifecycle exits, and retired-controller imports.
- [ ] Living requirements that terminalize mechanical exhaustion or project it as human ownership are superseded by Cooling, external-condition waits, or valid typed requests.
- [ ] The matrix covers both #1024 ship models. Absence of SemVer-only phases is a correct continuous outcome, not missing proof.
- [ ] FRG promotion fails when a required lifecycle class lacks coverage. Stub helpers that stamp all five classes without matrix rows fail the same gate.
- [ ] `#740` hidden evals do not count as production lifecycle proof. Island unit tests alone do not declare success.
- [ ] Living specs, durable docs, `CONTEXT.md`, CLI docs, generated host artifacts, and implementation agree.
- [ ] `node scripts/build.mjs` and `npm run ci` pass.
- [ ] No second RecoverySupervisor, FRG runner, scheduler, or public fault-matrix command is introduced.
