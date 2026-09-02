## Context

See `proposal.md` for why.

Existing surfaces that this change extends:

- `core/scripts/operation-reliability.ts` — `REQUIRED_PUBLIC_ENTRYPOINTS`, `REQUIRED_LIFECYCLE_CLASSES_1333` (`mechanical`, `workflow`, `infrastructure`, `authentication`, `unknown`), `aggregateUniqueOperationReliability`, and FRG fail-closed on `missing_required_coverage`. `passingUniqueOperationAttempts()` and `passingUniqueOperationManifest()` currently stamp every required class without matrix rows.
- `core/scripts/ship-path-composition-coverage.ts` — machine-readable inventory plus drift-guard that fails CI when a hard class has no covering test.
- FRG Layer A hermetic probes and the outer-host conformance kit (`outer-host-lifecycle-contract`).
- `COMMAND_REGISTRY` and the forthcoming #1329 operation-inventory dispositions.
- RecoverySupervisor (`CONTEXT.md`, #1323) as the sole lifecycle owner. This change does not invent a second owner.
- Unique-operation SLOs already landed in #1368. This change supplies the #1333 proof that gate consumes.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: one executable matrix that feeds existing `covered_lifecycle_classes` / FRG integrity counts. Reuse the composition-inventory drift-guard, Layer A probes, outer-host kit, and public-entrypoint list.
- Prove every required fault/state class through adapter contracts, installed-CLI black-box entry points, and host conformance.
- Delete obsolete command-local terminal paths only after replacement rows pass. Guard the deletion with static tests.
- Make mechanical exhaustion Cooling (or an external wait / valid typed request), not STOP or human ownership.

**Non-Goals:**

- A new RecoverySupervisor, FRG runner, scheduler, or public `pipeline fault-matrix` verb.
- Treating #740 hidden evals as production lifecycle proof.
- Reimplementing #1301 live train linkage, #1323 supervisor, #1329 inventory, #1332 liveness, or #1024 ship-model switching.
- Preserving obsolete terminal behavior for internal convenience.
- Declaring success from island unit tests alone.
- Provider- or incident-string dispatch in production routing.
- Changing merge authority or advance-never-merges.

## Decisions

### D1 — One executable manifest, same inventory pattern as ship-path composition

Keep a versioned TypeScript inventory next to `ship-path-composition-coverage.ts` (for example `fault-recovery-matrix.ts`). Each row names operation, fault/state class, public entry point, host, FRG lifecycle class, coverage layer, covering test module and title substring, expected unique-operation terminal, and either a covering proof or a checked `not_applicable` reason.

Do not add `.agent-pipeline/fault-matrix/` or a new CLI verb. FRG already aggregates coverage through `operation_reliability`. The matrix is the producer of `covered_lifecycle_classes`.

Alternative considered: expand the FRG Layer B pack with live network cells. Rejected: the issue requires production-shaped proof without treating live GitHub writes as the CI gate, and FRG already forbids a second runner.

Alternative considered: a JSON/YAML sidecar. Rejected: the composition inventory is TypeScript so covering-module drift-guards can import it in `node --test`. Stay on that rung.

### D2 — Four dimensions; five FRG classes remain the promotion axis

Dimensions:

1. **Operation** — every supervised disposition from the #1329 / `COMMAND_REGISTRY` inventory, plus numeric drive, `single`, `loop`, `train`, `merge`, merge queue, and `ship`.
2. **Fault/state** — exception, rejection, nonzero exit, signal, timeout, malformed or contradictory output, interrupted or uncertain side effect, stale or corrupt durable state, event or ledger partial writes, candidate movement, remote mutation, dependency cycle, no progress, clock or lease ambiguity, unavailable harness, observer failure, unseen provider error shape, process death at each side-effect boundary, and strategy exhaustion.
3. **Public entry point** — `REQUIRED_PUBLIC_ENTRYPOINTS` (`drive`, `single`, `loop`, `train`, `merge`, `merge-queue`, `ship`).
4. **Host** — builtin registered outer hosts (`claude`, `codex`, `grok`, `opencode`, `omp`) plus direct CLI. Hermes and OpenClaw remain example-supervisor conformance fixtures with checked `not_applicable` or example-only rows. They are not silently promoted shipped hosts.

Each required fault/state class maps to exactly one FRG lifecycle class:

| FRG class | Fault/state members |
| --- | --- |
| `mechanical` | exception, rejection, nonzero exit, signal, timeout, interrupted or uncertain side effect, process death at a side-effect boundary, strategy exhaustion |
| `workflow` | malformed or contradictory output, stale or corrupt durable state, event or ledger partial writes, candidate movement, dependency cycle, no progress |
| `infrastructure` | unavailable harness, observer failure, clock or lease ambiguity, remote mutation |
| `authentication` | authentication fixtures (revoked token, login required) expressed as generic auth-class faults, never provider strings |
| `unknown` | unseen provider error shape |

FRG promotion requires 100% of those five classes. The matrix also requires 100% of the listed fault/state classes. Adding a dimension value without a row or a checked `not_applicable` reason creates a failing uncovered cell.

Impossible cells (for example continuous `ship` × SemVer-only phase, bounded atomic administration × durable Cooling, Hermes × shipped-host install) MUST carry a closed `not_applicable` reason. Absence of SemVer-only phases under `roadmap.release_model: continuous` is a correct continuous outcome, not missing proof.

### D3 — Three coverage layers; unit tests alone are not success

1. **Adapter contracts.** Hermetic unit tests inject exceptions, rejections, nonzero exits, signals, timeouts, malformed output, and unknown shapes at the operation-adapter seam. They assert the observation reaches RecoverySupervisor and that the adapter does not declare the run terminal. No real network, git, or subprocess.
2. **Installed-CLI black-box.** Spawn the installed `pipeline` CLI through the existing install-smoke / host-entry seams with injected gh/harness/worktree fakes. Prove numeric, `single`, `loop`, `train`, `merge`, merge queue, `ship`, and supervised inventory dispositions. This layer is what island unit tests cannot substitute.
3. **Host conformance.** Drive the existing outer-host conformance kit. Compare typed lifecycle outcomes (Cooling, external wait, typed request, verified success, cancellation), not prompt text.

A required lifecycle class is covered for FRG only when every required layer that applies to that class has a passing row. `not_applicable` for a layer still requires a checked reason.

`#740` hidden eval fixtures MUST NOT be registered as covering modules.

### D4 — Coverage is earned, never stamped

`passingUniqueOperationAttempts()` and `passingUniqueOperationManifest()` MUST stop declaring `covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333]` unless the matrix inventory reports those classes covered for the scored candidate.

`aggregateUniqueOperationReliability` already increments `missing_required_coverage` when a required class is absent. FRG already refuses `pass: true`. This change makes that path honest: unit fixtures that lie about coverage fail the same way a missing matrix class fails.

Known GitHub, CI, conflict, auth, and worktree incidents are fixture payloads inside the generic classes above. Production routing, recipe selection, and RecoverySupervisor classification MUST NOT switch on incident titles, provider names, or HTTP-string keys.

### D5 — Expected terminals are the unique-operation closed set

Mechanical rows expect `cooling_recovery` or `external_wait`. Genuine decision/capability/authority rows expect `typed_request` and MUST prove that no unauthorized mutation occurred. Cancellation rows expect `cancellation`. Success rows expect `verified_success` only after the exact-candidate postcondition is proven.

A mechanical row that records `false_human_projection` or `ownerless_terminal`, or that issues a supervisor STOP, fails the matrix and fails FRG.

Fresh-process restart of a row whose side effect is known complete MUST NOT replay that mutation. Continuation after uncertain side effects MUST reconcile against the authoritative observer before replay.

### D6 — Delete legacy controllers only after replacement rows pass

Inventory command-local retry, recovery, parking, and STOP sites (including `process.exit` lifecycle exits, direct stage-label writes from command modules, and retired recovery-controller imports). For each site:

1. Register the replacement matrix row.
2. Prove the row.
3. Delete the site.
4. Add a static guard so the site cannot return.

Static guards:

- No command module writes stage labels or `needs-human` / `blocked` directly.
- No command-local lifecycle `process.exit` on a supervised mutation (read-only and bounded atomic administration keep documented exits).
- No imports of retired recovery controllers.
- No production `switch` / map keyed by provider or incident strings.

`#1362` (typed preflight refusal) and `#1344` (candidate-engine provision) land as fixtures in this matrix. They are not a second recovery policy.

### D7 — Supersede living terminal-exhaustion law with Cooling

Conflicting living requirements, named and superseded:

- `autonomous-recovery-controller`: "Engine-owned exhaustion SHALL terminate as a typed system failure"; scenario "Mechanical exhaustion is not human authority" records a terminal failure; scenario "Repair-budget exhaustion stays engine-owned" records a typed engine-owned failure or stop.
- `durable-loop-supervisor`: "A live drive that first records `recovery_exhausted` SHALL remain stopped".
- `durable-run-reconciliation`: "A live drive that first records `recovery_exhausted` SHALL still stop under existing recovery policy".
- `integrated-train-mode`: train STOP text may still quote `recovery_exhausted` as evidence, but train MUST NOT STOP the wave solely because a nested loop recorded mechanical or recovery exhaustion.

Replacement: strategy-cursor exhaustion remains owned Cooling (or an external-condition wait when a live probe exists, or a valid typed request when a genuine condition matches). Historical `recovery_exhausted` records MAY remain as evidence. Resume catch-up that repair-forwards already-ready GitHub identity stays. Live drive does not become ownerless or human-owned.

### D8 — Installed-host parity reuses the outer-host kit

Do not invent a second host table. Builtin registry hosts plus direct CLI are required. Host cells compare RecoverySupervisor outcomes. Unsupported host capability is a typed CapabilityRequest, matching #1332.

### D9 — Tests bite the stub and the missing cell

Hermetic tests MUST fail when:

- a required fault/state or lifecycle class has no row and no checked `not_applicable` reason
- a new dimension value is added without coverage
- `passingUniqueOperationManifest` stamps classes the matrix did not cover
- a mechanical fixture projects human ownership or an ownerless terminal
- a completed side effect is replayed on fresh-process restart
- a genuine authority fixture mutates before the answer
- production code contains provider/incident string dispatch keys
- a retired controller import or command-local lifecycle exit returns

Installed-CLI / host layers MAY spawn the installed CLI. They MUST NOT perform live GitHub writes or use production credentials.

## Risks / Trade-offs

- **[Risk] Prior v1.40.1 issues (#1323, #1329, #1332, #1024) are still open.** → Mitigation: this change consumes those owners and fail-closes FRG until their proofs plus this matrix exist. It does not reimplement them. Implementation tasks that call RecoverySupervisor or the operation inventory are blocked until those artifacts exist in the same milestone graph.
- **[Risk] Cartesian explosion of cells.** → Mitigation: required cells are the listed fault/state classes × required entry points × required hosts × supervised operations, with checked `not_applicable` collapsing impossible combinations. Do not require every host to execute every CLI verb when the host cannot launch it; that cell is `not_applicable` with a typed capability reason.
- **[Risk] Black-box layer is slower than unit tests.** → Mitigation: keep adapter contracts in `npm test`. Run installed-CLI/host rows in existing install-smoke / conformance jobs. FRG still requires all three layers for promotion.
- **[Risk] Historical `recovery_exhausted` ledgers exist.** → Mitigation: treat the field as historical evidence. Live ownership is Cooling. Resume catch-up remains. Do not rewrite old ledgers.
- **[Trade-off] Attempt-based scoreboard metrics remain.** → Unique-operation rates stay the SLO surface. The matrix does not invent a parallel score.

## Migration Plan

1. Land the inventory with failing uncovered cells (red).
2. Add adapter-contract rows until required classes have Layer 1 coverage.
3. Add installed-CLI and host rows. Stop stamping `covered_lifecycle_classes` from helpers.
4. After each replacement row passes, delete the matching command-local path and enable the static guard.
5. Supersede living terminal-exhaustion requirements in the same change.
6. Refresh `CONTEXT.md`, FRG runbook, CLI docs, and generated host SKILLs (`node scripts/build.mjs`).
7. `npm run ci` must pass. FRG promotion remains fail-closed until the scored candidate's matrix coverage is complete.

Rollback: the inventory and guards are additive. A bad scorer fail-closes FRG without rewriting `run.json`. Do not restore deleted command-local STOP paths.

## Open Questions

None. Remaining sequencing (#1323, #1329, #1332, #1024, #1301) is fail-closed consumption, not an open design choice.
