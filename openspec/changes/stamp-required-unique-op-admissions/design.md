## Context

See `proposal.md` for motivation and the delta specs for normative behavior.

The first reusable holding rung already exists. `persistPublicEntrypointAdmission` resolves the control-host generic root and writes through `initRunDir`; direct `pipeline single`, `pipeline merge`, and `pipeline merge-queue` already call it. `initRunDir`, however, intentionally catches initialization errors as non-fatal telemetry behavior, and the public helper currently returns a path without proving that `run.json` and its `run_start` record were persisted with the requested identity. The direct call sites therefore cannot treat return as a durable admission acknowledgment.

Train has a separate outer generic-run session with a `logicalOperationId`, but production `mergeIssuePr` calls the shared merge surface without recording a distinct nested `merge` admission. The collector already recognizes `run.json.kind`, `run_start.entrypoint`, and `single-*`, `merge-*`, `merge-queue-*` / `mq-*` prefixes. `REQUIRED_PUBLIC_ENTRYPOINTS` already contains `drive`, `single`, `loop`, `train`, `merge`, `merge-queue`, and `ship`, but that list has no machine-checked correspondence to admission producers.

Existing constraints remain in force:

- The generic run store and its injected I/O seam remain the persistence surface; no second store is introduced.
- General run-store events and train-stream observability retain their existing best-effort rules. Admission acknowledgment for a protected operation is a narrower, stricter contract.
- RecoverySupervisor remains the lifecycle owner. Advance and loop never merge, and no record grants merge or release authority.

## Goals / Non-Goals

**Goals:**

- Turn the existing public-admission helper into the one acknowledged admission path used by direct `single`, `merge`, `merge-queue`, and train-nested `merge` work.
- Preserve one root Logical Operation across outer train and nested merge records while retaining both entrypoint identities.
- Make a missing required-entrypoint admission producer a deterministic CI failure.
- Keep collection artifact-driven and fail-closed.

**Non-Goals:**

- Replacing the generic run store, collector, mapper, merge invariant, or RecoverySupervisor.
- Making all best-effort telemetry writes control-critical.
- Treating admission as postcondition proof, replay authority, merge authority, or release authority.
- Backfilling historical coverage by replaying or fabricating commands.
- Adding a public verb, per-verb markdown pack, host engine, or scheduler.

## Decisions

### D1 — Pre-bind identity and crash-durably publish through the strict admission path

Keep `persistPublicEntrypointAdmission` as the shared admission contract and keep the artifact in the existing control-host generic run-store layout. Before any persistence I/O, `bindPublicEntrypointAdmission` creates an immutable admission context containing the public entrypoint, distinct physical `runId`, non-empty `logicalOperationId`, domain, repository, and optional issue. A direct admission mints the root Logical Operation identity during this binding step when no parent identity is supplied. A nested admission must supply its non-empty parent identity and is not allowed to mint a replacement. The persistence result carries the same binding on both its acknowledged and typed-failure variants, so callers can propagate or report the identity even when no artifact was acknowledged.

The strict acknowledgment is scoped to this helper. It shares the generic store's schema, sanitization, and directory layout, but it does not call the error-swallowing `initRunDir` or `appendEvent` functions and does not change their best-effort contract. A dedicated injected admission-store seam supplies non-optional temp-file write, rename, file-fsync, directory-fsync, and read operations. For both `run.json` and the initial `events.jsonl`, production writes a unique same-directory temporary file, fsyncs it, renames it atomically to the final name, and fsyncs the final file. After both final files are published, it fsyncs the containing run directory and the parent `runs` directory so both file entries and a newly created run-directory entry survive host crash. Only then does it read the final files back and validate exact `run_id`, kind, `run_start.entrypoint`, and `logical_operation_id` equality before returning acknowledgement.

Failure of directory creation, either temporary write, either file flush, either rename/publication, either directory flush, either read-back, or identity validation returns one typed admission-persistence failure with the pre-bound context. A partial artifact is not acknowledged and is not qualifying because the collector requires the matching final `run.json` and `run_start` record. Hermetic tests inject failure at every publication and flush step and prove the protected adapter is never invoked.

No secret, credential, authority grant, candidate authorization, or command arguments beyond existing sanitized run metadata are added to the artifact.

Alternative considered: make every `initRunDir` caller fail on any write error. Rejected because it changes the established best-effort telemetry contract far beyond protected unique-operation admission.

Alternative considered: add a unique-operation-only ledger or marker directory. Rejected because the generic run artifact already carries the identity the collector consumes.

### D2 — Require an approved control-host root and hand the root identity to child work

`persistPublicEntrypointAdmission` resolves its target through the same factory-control authority used by `defaultResolveUniqueOperationRunsRoots`. An injected resolver may supply the equivalent approved root in tests, but an empty result is a typed persistence failure. The strict path removes `resolvePublicAdmissionPersistRoot`'s `repoDir` fallback: it must prove that the target canonicalizes to the approved control-host generic root before writing. A candidate worktree is valid only when the authority resolver identifies it as the control root itself; merely receiving that worktree as `repoDir` never approves it. Candidate-worktree-only and unavailable-control-root fixtures must therefore fail before direct `single`, direct `merge`, `merge-queue --apply`, or a train-nested merge reaches protected work.

Direct `single`, `merge`, and `merge-queue` bind identity before persistence and consume the acknowledged result. `single` passes the acknowledged `logicalOperationId` into `RunLoopEngineInput.logicalOperationId`, so the child loop contract and the `single` artifact have artifact-level equality. Direct `merge` and `merge-queue` pass the same pre-bound logical id and physical run id into their merge supervision and observation context. `single` admits before launching its supervised drive. Direct `merge` admits before invoking the merge adapter. `merge-queue` admits after argument/config validation but before apply-mode merge or repair work; dry-run remains non-mutating, and apply mode can never reach a protected side effect after a failed stamp.

Train pre-binds its root `logicalOperationId` and attempted physical train `runId` before `initTrainRunStore` and passes the logical identity into that initialization. Merge mode may use the identity only when the published outer session read-back succeeds and returns the same non-empty value. It does not substitute an empty session or mint a nested replacement when outer publication fails. Before each `mergeIssuePr` invocation, train writes a distinct `merge-*` artifact through the injected shared-admission seam with that established outer identity. The physical record remains `merge`; its root identity remains the train admission. The existing outer `train` record is not rewritten, and the merge call continues to use the existing merge supervision and exact-candidate gates. When the outer train store is unavailable or degraded, train uses its existing mechanical observation route with the pre-bound train identity and refuses every nested admission and merge submission; advance-only behavior remains outside this merge-boundary change.

Artifact-level tests read the direct `single` plus child loop contracts and the outer `train` plus nested `merge` records and assert exact Logical Operation equality. A degraded train-store fixture proves that no nested admission or merge occurs and that no second root is minted.

### D3 — Report every persistence refusal through a pre-bound RecoverySupervisor route

Add `reportPublicEntrypointAdmissionFailure`, a callable adapter over the existing `reportMechanicalFault` / `ReportOperationObservation` seam. It requires the pre-bound `logicalOperationId`, physical `runId`, domain, repository, entrypoint, optional issue, and typed persistence failure. It emits an owned, non-human, incomplete mechanical observation with known-absent side-effect certainty because the protected boundary was refused. It never mints identity, chooses retry policy, creates a typed human request, or grants authority.

Each direct command dependency surface and `TrainDeps` carries an injectable `reportObservation` sink. On an unavailable approved root, publication/flush failure, or read-back failure, direct `single`, `merge`, and `merge-queue --apply`, plus the train-nested `merge` path, invoke the adapter before returning nonzero or handing control back to RecoverySupervisor. The command-local catch may render the error only after this owned observation exists; it is not the lifecycle owner. Hermetic tests inject the persistence failure and memory observation sink for all four sites, then assert the reported domain, repository, logical id, and run id equal the pre-bound admission context, `human_owned` is false, and no protected adapter ran. Failed outer-train publication is not a nested admission failure; it uses the existing train mechanical observation route described in D2 and prevents the nested admission site from being called.

Alternative considered: infer nested merge coverage from `train_merge_attempted` or `train_merge_proven`. Rejected because those events do not prove that a public-entrypoint admission record was durably established before the mutation boundary.

Alternative considered: give every nested merge a new Logical Operation. Rejected because nested train work must remain in the admitted root denominator; the distinct `run_id` already preserves attempt identity.

### D4 — Make admission inventory and required coverage mechanically correspond

Add one shared inventory adjacent to the required-entrypoint contract. Each `REQUIRED_PUBLIC_ENTRYPOINTS` member names its canonical durable admission producer. The entries for `single`, `merge`, and `merge-queue` route through the acknowledged public-admission contract; the `merge` entry also declares the train-nested admission site. Existing producers for `drive`, `loop`, `train`, and `ship` remain represented by their current durable admission paths.

CI performs a set-equality check between required entrypoints and inventory keys, rejects duplicate or unknown entries, and runs hermetic producer tests so adding a name-only inventory row cannot satisfy the gate. Call-site tests assert that direct merge and merge-queue cross the admission seam before their protected adapters and that train passes the outer Logical Operation to its nested merge stamp.

Alternative considered: scan source text for helper names. Rejected because source-shape regexes can pass while runtime routing bypasses the contract. The injected admission seams provide behavioral evidence.

Alternative considered: derive required coverage exclusively from the inventory. Rejected because keeping the SLO list and admission inventory independently comparable makes omission visible rather than self-consistent by construction.

### D5 — Keep collection evidence-only and separate admission from completion

Retain the existing collector and mapper. A stamped artifact may add its mapped entrypoint to `entrypoint_coverage.observed`. Multiple physical artifacts with the same `logical_operation_id`, such as outer `train` and nested `merge`, contribute both entrypoint identities to the same aggregated Logical Operation. They do not add a second success.

No collector rule maps numeric drive to `single`, and raw train merge events do not become `merge` coverage without the qualifying nested artifact. Missing artifacts remain in `entrypoint_coverage.missing`. Existing postcondition evidence remains necessary for verified completion.

Alternative considered: synthesize the three missing rows from command availability, train events, or the inventory. Rejected because availability and declarative registration are not evidence that an attempt was admitted.

### D6 — Preserve the prepare hard gate and generated surfaces

Keep `uniqueOperationSloFailure` in the release-prepare structural eligibility path. Stamp persistence failure is not a reason to demote missing coverage or request human attestation. No public command documentation is added. If shared inventory or generated FRG documentation has a generator-owned representation, regenerate it through the existing generator and keep its check mode green.

## Risks / Trade-offs

- **[Risk] The strict admission acknowledgment conflicts with best-effort run-store behavior.** → Give the protected-admission wrapper its own non-optional durability seam; leave general telemetry and train event append policy unchanged.
- **[Risk] A train merge stamp and outer train record appear to be two successes.** → Reuse the root `logical_operation_id`; aggregation retains two entrypoints but one Logical Operation, and admission alone never supplies verified completion.
- **[Risk] A declarative inventory row masks a missing runtime call.** → Pair set correspondence with injected-seam behavioral tests at every declared admission site.
- **[Risk] Persisting before gates creates artifacts for attempts that never submit a merge.** → This is intended: the record proves admission, not successful mutation. Completion still requires authoritative postcondition proof.
- **[Risk] The control-host root is unavailable or unwritable.** → Return the typed failure with its pre-bound identity, report it through `reportPublicEntrypointAdmissionFailure`, and fail before protected work. Do not fall back to a candidate-worktree artifact and claim coverage.
- **[Risk] Existing failed FRG evidence remains failed after deployment.** → Keep historical evidence immutable; only later real admissions and a new score may satisfy coverage.

## Migration Plan

1. Ship the shared acknowledged admission contract, inventory, and four admission-site integrations with hermetic regression tests.
2. Regenerate host and FRG/unique-operation documentation only through existing generators when their sources change.
3. Run the full repository CI gate before integration.
4. Re-run the ordinary authorized ship/FRG flow. Do not replay or fabricate merge, merge-queue, or single solely to populate coverage.
5. Rollback is a code rollback only; existing additive run artifacts remain readable and do not grant authority or assert completion.

## Open Questions

None. The shared store, strict boundary, identity propagation, inventory correspondence, artifact-only collection, and hard-gate behavior are fixed by the issue contract.
