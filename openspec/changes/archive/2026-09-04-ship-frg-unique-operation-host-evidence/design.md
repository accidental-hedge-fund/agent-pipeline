## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `core/scripts/operation-reliability.ts` — `REQUIRED_PUBLIC_ENTRYPOINTS` includes `ship`; `aggregateUniqueOperationReliability` increments `missing_required_coverage` for every unobserved required entrypoint, every uncovered #1333 class, and missing live train-link when `train` is required; `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure` already return diagnostic strings.
- `core/scripts/factory-reliability-gate.ts` — `runFactoryGate` calls `collectUniqueOperationsFromRunStore(opts.repoDir, …)` which reads `repoDir/.agent-pipeline/runs`. Ship FRG scores the **candidate worktree** as `repoDir`. Train, loop, and merge events live on the **control host**.
- `core/scripts/factory-release-prepare.ts` — already scans pack-loop artifacts via `resolveStateHome` (control-host state home). Terminal score uses `defaultScoreBoundPackLoop` → `runFactoryGate({ repoDir: args.repoDir })`. Structural fail text names composition/scenario gaps but not unique-operation SLO/binding strings.
- `filterAttemptsBoundToCandidate` and `attemptsFromRunArtifacts` already omit other-candidate and unbound artifacts.
- `bindExecutedMatrixRowsForCandidate` / `coveredLifecycleClassesFromExecutedRows` already exist. Live `runFactoryGate` leaves `executed_matrix_rows` unset, which scores as zero #1333 coverage.

## Goals / Non-Goals

**Goals:**

- First holding rung: point unique-operation collection at the same control-host state-home / run-store root factory-release already uses for pack loops. Reuse the collector, binder, SLO functions, and `isReleaseEligibleFrgPass`.
- Stop in-flight `ship` from incrementing missing required coverage for its own FRG pack.
- Score #1301 live train-link from the control-host train stream bound to the candidate.
- Pass candidate-bound #1333 executed rows through the existing aggregator seam when they exist on the control host / engine evidence.
- Name unique-operation SLO/binding failure on the prepare hard gate.
- Keep fail-closed behavior when the host store is actually empty.

**Non-Goals:**

- Weakening unique-operation SLOs when durable evidence is missing.
- Treating pack-issue `pipeline:ready-to-deploy` labels as unique-operation proof.
- Skipping HMAC attestation on tag/promote.
- A second aggregator, FRG runner, scheduler, or unique-operation CLI.
- Changing merge authority or adding a merge stage.
- Dropping `ship` from `REQUIRED_PUBLIC_ENTRYPOINTS` globally.
- Inventing a new executed-row store format when the existing `executed_matrix_rows` seam can be fed.

## Decisions

### D1 — Reuse `collectUniqueOperationsFromRunStore`; change the root, not the classifier

Point collection at the control-host run-store root used for train/loop/merge events (the `resolveStateHome` / generic `.agent-pipeline/runs` root on the host that admitted those operations), then keep `filterAttemptsBoundToCandidate`.

Do not scan the candidate worktree as the unique-operation source of truth. The candidate worktree MAY be empty of runs after a clean checkout; that is not evidence that train never ran.

Alternative considered: copy host runs into the candidate worktree before scoring. Rejected: duplicates durable identity and risks stale copies.

Alternative considered: a new unique-operation store. Rejected: the generic run-store already holds train/loop/merge events.

### D2 — In-flight `ship` is a coverage deferral, not an exclusion and not verified success

When aggregation is scoring an FRG pack nested under an admitted in-flight ship, do not increment `missing_required_coverage` for unobserved `ship`. Do not add `ship` to `entrypoint_coverage.missing`. Do not record a stable exclusion. Do not count the in-flight ship as `verified_success`.

A completed prior ship attempt bound to the candidate still observes `ship`.

Keep `ship` in `REQUIRED_PUBLIC_ENTRYPOINTS`. Do not special-case other entrypoints.

Alternative considered: drop `ship` from required entrypoints for every FRG pack. Rejected: a completed prior ship is valid coverage, and non-ship FRG scoring must still require the public inventory.

Alternative considered: treat in-flight ship as a manifest-declared wait. Rejected: that would be a stable exclusion, which this issue forbids for coverage gaps.

### D3 — #1301 live train-link follows the host train stream, not the pack loop

`collectUniqueOperationsFromRunStore` already follows `train_loop_linked` into the child loop when the events path is present. After D1, that follow happens on the control-host train stream. The factory-gate pack loop is nested work of the in-flight ship; it is not the #1301 proof.

Keep the existing rule that a `train_loop_linked` event with only the parent logical id is not followable child linkage.

### D4 — #1333 uses the existing executed-row seam; do not stamp helpers

Live `runFactoryGate` currently leaves `executed_matrix_rows` undefined, so `coveredLifecycleClassesFromExecutedRows([], sha)` is empty and all five lifecycle classes fail. That is the same class of "scorer does not feed the validator" as the empty worktree store.

Feed candidate-bound executed rows through the existing `runFactoryGate` / `aggregateUniqueOperationReliability` input. Bind with `bindExecutedMatrixRowsForCandidate`. If durable rows for the scored SHA are absent, fail closed. Do not stamp `passingUniqueOperationManifest().covered_lifecycle_classes`.

Do not invent a second matrix runner or a new on-disk schema. If rows already exist as engine/control-host evidence for that SHA, collect them. If they do not exist, missing required coverage stays failed — this change does not mint #1333 proof.

### D5 — Hard-gate text reuses existing failure strings

When `isReleaseEligibleFrgPass(..., { requireAttestation: false })` is false, `factory-release prepare` SHALL append `uniqueOperationSloFailure(...)` and/or `uniqueOperationReleaseBindingFailure(...)` when either returns non-null. Keep composition-missing and scenario-status suffixes.

Do not reimplement SLO checks in prepare.

### D6 — Tests inject the host store; they do not hit the network

Hermetic tests MUST inject fs/run-store seams:

1. Hybrid v2 pack proofs pass + host store has train+merge bound to `C` + empty candidate worktree + no completed `ship` for this admission → `isReleaseEligibleFrgPass` true (attestation optional).
2. Empty host store, no train events → still false.
3. Prepare hard-gate message includes the SLO/binding string.
4. Other-candidate host runs do not satisfy `C`.

No real network, git, or subprocess.

## Risks / Trade-offs

- **[Risk] Control-host vs candidate SHA binding is too strict and drops real train events.** → Mitigation: keep `filterAttemptsBoundToCandidate`; do not stamp current pack provenance onto unbound runs. If live train events lack candidate SHA, that is a separate identity-stamping defect, not a reason to accept unbound artifacts.
- **[Risk] In-flight ship deferral is copied onto other entrypoints.** → Mitigation: the deferral is only `ship` and only when scoring that ship's nested FRG pack. Tests fail if `train` is also deferred.
- **[Risk] #1333 rows still absent on the live host, so v1.40.1 remains blocked after the store-root fix.** → Mitigation: this is fail-closed and honest. D4 feeds rows when they exist; it does not mint them. If live scoring still fails only on #1333 after D1–D3, that is visible missing-coverage text (D5), not a silent generic gate.
- **[Risk] State-home resolution disagrees between pack-loop scan and unique-operation collection.** → Mitigation: reuse `resolveStateHome` / the same generic runs root factory-release already uses.

## Migration Plan

- No schema migration. Evidence already on the control-host run-store becomes visible to ship FRG scoring.
- Unsigned `latest.json` with `pass: false` from the failed v1.40.1 pack remains fail. Re-invoke `factory-release prepare` after this change; do not rewrite fail into pass.
- Tag/promote HMAC path unchanged.

## Open Questions

None. Store root, in-flight `ship` deferral, #1301 host train stream, #1333 existing seam, and hard-gate text are decided. File-level collection helpers are implementation.
