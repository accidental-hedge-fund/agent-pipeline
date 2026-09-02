## 1. Lifecycle state contract

- [ ] 1.1 Add a closed lifecycle-state union (`active`, `cooling`, `external-condition-wait`, `typed-input-wait`, `succeeded`, `cancelled`) next to existing RecoverySupervisor observation types, and verify a unit test round-trips those six values and fails if a seventh member is accepted
- [ ] 1.2 Map compatibility projections (`pipeline:needs-human`, `pipeline:blocked`, `ledger.stop.reason`, train `STOP`) onto that union without treating labels as lifecycle truth, and verify a fixture with a leftover `needs-human` label and no typed request does not become `typed-input-wait`
- [ ] 1.3 Keep `STAGES` and `TERMINAL_STAGES` membership unchanged, and verify the existing stage-inventory drift guard still passes

## 2. False-human and ownerless guards

- [ ] 2.1 Add injected-I/O fixtures that mechanical failure, unknown failure, malformed output, process death, no progress, capacity, and retry exhaustion stay `cooling` or `external-condition-wait`, and verify each fixture fails if the outcome is `typed-input-wait`, `cancelled`, or ownerless
- [ ] 2.2 Add a static or seam guard that production park sites cannot set human-owned `needs-human` without the shared classifier, and verify a synthetic bypass fixture fails that guard
- [ ] 2.3 Keep `DecisionRequest`, `CapabilityRequest`, and `AuthorityRequest` structurally distinct on typed-input wait, and verify a raw failure fixture emits none of those types
- [ ] 2.4 Prove a reversible in-scope authorized recommendation auto-settles and an `AuthorityRequest` stays candidate-bound with no default grant, and verify those existing classifier tests still pass

## 3. Legacy terminal migration

- [ ] 3.1 Treat a live first `run_fatal` record as Cooling with optional historical `ledger.stop` projection, and verify independent siblings remain schedulable and the Logical Operation is not cancelled
- [ ] 3.2 Treat live `recovery_exhausted` as Cooling, keep historical evidence, and verify the existing GitHub-ready `--resume` catch-up still repair-forwards without treating the record as human ownership
- [ ] 3.3 Treat `repeated_no_progress` as Cooling for that item, and verify a fixture that previously recorded a run-level terminal stop now leaves siblings schedulable
- [ ] 3.4 Treat `MAX_ITERATIONS` and auto-loop round/wall-clock exhaustion as process-stop plus Cooling, and verify those paths no longer transition to human-owned `needs-human`
- [ ] 3.5 Keep operator `--resume` of historical `run_fatal` as the wake for that projection, and verify eligible re-drive and ineligible refusal tests still distinguish those cases

## 4. Inventory and observer binding

- [ ] 4.1 Assert every mutating `OPERATION_SURFACE` verb has a `COMMAND_FORM_INVENTORY` disposition, and verify the existing missing-form contract test still fails on a host-table-only verb
- [ ] 4.2 Bind verified success to the existing observer catalog (git, forge, checks, reviews, merge, release, deploy, orchestration), and verify an exit-0 fixture without observer proof is not `succeeded`
- [ ] 4.3 Document why no new inventory, classifier, observer package, or RecoverySupervisor is added, and verify no new public CLI verb is registered

## 5. Docs and conflicting-spec alignment

- [ ] 5.1 Align `CONTEXT.md` and `openspec/project.md` so `needs-human` is a compatibility projection of typed-input wait, and verify those files no longer describe mechanical exhaustion as human-owned terminal
- [ ] 5.2 Align durable operator docs (`README.md`, `docs/concepts.md`, `docs/cli.md` as needed) with the migration table, and verify `TERMINAL_STAGES` membership text still matches code constants
- [ ] 5.3 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes

## 6. Validation and CI

- [ ] 6.1 Run `openspec validate define-universal-recovery-ownership` and `openspec validate --all`, and verify both exit 0
- [ ] 6.2 Run `npm run ci` from the repo root, and verify the full gate passes
