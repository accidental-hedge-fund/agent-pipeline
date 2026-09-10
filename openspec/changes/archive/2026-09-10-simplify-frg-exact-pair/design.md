## Context

See `proposal.md` for motivation. The current release path concentrates fixture rendering, candidate preparation, remote creation, detached pack-loop ownership, observation, scoring, attestation, and cleanup in and around `factory-release-prepare.ts`, `factory-reliability-gate.ts`, and `frg-pack-observations.ts`. It also makes the staged installed-CLI qualification matrix a pre-create gate. Package 1 already preserved the two admitted templates and the no-change Tester behavior needed by this package.

Existing seams already own most required behavior: candidate `resolve-and-prepare` binds an exact SHA and nested lockfile; ordinary loop compilation accepts explicit issue identities; ordinary advance uses the domain-aware issue-run lock; CI, review, Tester, forge, and run-store artifacts provide authoritative observations; and the release/factory state area can hold observer-owned records outside fixture branches. The first holding rung is to compose those seams and delete release-specific choreography as callers move, not to create another scheduler.

## Goals / Non-Goals

**Goals:**

- Define one durable candidate-epoch and intended-pair aggregate that supports create reconciliation, ordinary dispatch, independent observation, and restart.
- Separate fixture-worker progress from release-owned evidence authority.
- Give every non-pass observation a deterministic class and lifecycle consequence owned by existing ordinary or release supervision.
- Make old score, attestation, matrix, lease-transfer, and owner-observation machinery unnecessary on the new release path.
- Preserve the underlying CLI, exact-source, accounting, admission, and recovery invariants as normal CI tests.

**Non-Goals:**

- Changing ordinary loop stage semantics, review rigor, worker selection, or issue locking.
- Adding cross-host coordination, a second ledger, a new retry controller, or a model-driven recovery policy.
- Performing real fixture runs during implementation, merging fixture PRs, or implementing package-3 release/tag/publication flow.
- Deleting observability owned by #1482 or all legacy callers scheduled for package 4.

## Decisions

### 1. Model FRG as one candidate epoch with two immutable slots

The release-owned record starts with candidate SHA `C`, a candidate-input fingerprint, and two slot keys: `clean-docs` and `clean-openspec`. Each slot progresses monotonically from intended provenance to issue identity, ordinary logical run identity, PR head, and observed result. The pair cardinality is a schema invariant, not a runtime threshold.

This identity-first shape makes uncertain creates reconcilable. Before creating a slot, the runner lists and classifies remote matches by release/candidate epoch and template provenance. One match is adopted, zero authorizes one create, and multiple matches fail as a gate defect. Create attempts reuse the same slot identity. An issue number is never inferred from newest issue order or a broad label.

Alternative considered: reuse the old pack-run generator and cap its count at two. Rejected because its successor-pack and scoring abstractions preserve the state machine this change is intended to remove and make exact-two a policy value rather than an invariant.

### 2. Select and prepare C once, then consume only candidate-owned inputs

Candidate selection performs a fresh remote observation of `origin/main`, records the full SHA, and calls the shared resolve-and-prepare seam. The returned canonical candidate root supplies the launcher, manifest/templates, and nested lockfile identity. The record keeps engine `C` separate from both fixture PR heads.

The observer rechecks `origin/main` at verification and resume boundaries. A move ends the epoch's release eligibility; it does not mutate the old record. Starting a new epoch means a new candidate preparation and new intended pair after ownership-safe reconciliation of the old epoch.

Alternative considered: accept the operator checkout when its HEAD matches. Rejected as a separate policy because resolve-and-prepare already defines when that checkout is a valid candidate root and revalidates cleanliness and readiness.

### 3. Dispatch the existing ordinary loop with an explicit two-issue selector

After both issues are durably bound, the runner invokes the candidate launcher using the ordinary loop's explicit work-list surface. The runner records the ordinary logical run identity returned by that path and relies on ordinary domain-aware issue locks and lifecycle supervision. It does not copy loop scheduling, stage transitions, repair, or locking into FRG.

Candidate execution receives effective repository worker policy with FRG-specific auto-file surfaces disabled through the existing supported invocation/config boundary. Any attempted broad selector or merge-capable command is rejected before spawn and is covered by deterministic argv tests.

Alternative considered: two sequential `single` invocations. Rejected because the approved contract requires the unchanged ordinary loop and sequential shells would create a release-specific lifecycle owner.

### 4. Derive pass from a fresh observer snapshot, not fixture output

The release observer obtains issue/PR state and merge status from the forge, required-check conclusions from CI, accepted independent review evidence from the current review artifact/forge state, passed Tester evidence from the deterministic engine producer, and expected template provenance from the candidate-bound slot. Every candidate-bearing datum is matched to the current fixture PR head. The compact result includes normalized facts and source identities/digests but does not treat those public digests as authority.

The observer and record directory remain outside candidate fixture worktrees and are not writable by fixture workers. Worker output, labels, comments, and run completion are useful ingress or lookup evidence only. A result is `passed` only after both slots independently satisfy the full predicate and remain unmerged.

Alternative considered: sign a worker-created result. Rejected because signing preserves a second attestation system and cannot turn missing CI, review, Tester, provenance, or merge-state observations into facts.

### 5. Map four FRG classes onto existing lifecycle ownership

- `ordinary_review_revision` delegates continued work to the same ordinary issue lifecycle and observes its next current head.
- `external_or_transient_inconclusive` remains an existing external-condition wait with a named observer and wake rule.
- `exact_candidate_regression` freezes the epoch as a demonstrated candidate failure and retains evidence; it does not launch fixture-side engine repair or a new pair.
- `gate_defect` freezes the epoch and routes correction to the shared selector, reconciler, evidence classifier, gate, or controller contract that owns the class, with a regression test.

The classifier is deterministic from normalized observations. Process failure alone is not a candidate regression, and missing evidence alone is not human authority.

Alternative considered: let `factory-release prepare` retry, score, and ask for attestation. Rejected because it duplicates RecoverySupervisor treatment and is the source of false release blockers this package removes.

### 6. Persist result before compare-and-swap cleanup

The runner writes the final normalized result atomically before cleanup. Cleanup uses only recorded identities and the existing ownership-safe worktree/branch/issue mechanisms. Remote mutations require a current identity match. Closing an owned fixture or deleting an owned branch is allowed only under the established fixture cleanup policy; merging is never allowed. Each action and uncertainty is appended as cleanup facts without rewriting the proof outcome.

Alternative considered: require cleanup success for FRG pass. Rejected because cleanup is not evidence that the candidate completed the pipeline and would let an unrelated transient failure invalidate an already proven result.

### 7. Migrate behavior tests before deleting qualification choreography

Inventory the installed-qualification tests by observable subject. Move tests for launcher routing, exact candidate source, operation accounting, parent-observed faults, and durable recovery into the closest normal CLI or recovery suites. Delete cases whose only subject is artifact matrices, scoring rows, HMAC, or release preparation ordering. Then remove the new release path's qualification dependency.

The dirty-inventory correction derives expected test/module lists from the materialized candidate root or candidate commit tree. The regression creates an uncommitted operator-side test and proves candidate validation ignores it while still detecting an actual candidate inventory mismatch.

Alternative considered: skip the inventory assertion under a dirty checkout. Rejected because it hides real candidate packaging defects and violates the exact-source contract.

## Risks / Trade-offs

- [Authoritative APIs may be temporarily unavailable] → Classify as an external-condition wait with bounded evidence and a live probe; do not fail the candidate or create another pair.
- [Legacy callers may still expect score or attestation artifacts] → Put the new verifier behind one result contract, update only package-2 callers, and leave dependency-checked removal of remaining callers to package 4 without adapting the new result back into old shapes.
- [Exactly-two reconciliation may discover historical duplicates] → Fail as a gate defect and preserve all identities; never guess which issue to delete or create another.
- [Candidate movement can waste a nearly complete proof] → Keep epochs immutable and surface stale evidence explicitly; correctness of the eventual tag target outweighs reuse of stale work.
- [Cleanup can affect shared forge resources] → Restrict it to recorded provenance with current identity checks, persist proof first, and report uncertainty as cleanup debt.
- [Migrating qualification tests can accidentally reduce coverage] → Record a test-by-test disposition and require a normal-CI replacement for every retained user-visible invariant before deleting its old case.

## Migration Plan

1. Introduce the exact-candidate FRG result schema, validator, candidate epoch, and two-slot reconciliation behind deterministic dependency seams.
2. Add the ordinary-loop runner and independent observer using shared candidate preparation, issue locking, evidence acquisition, and release-state storage.
3. Add classification, stale-epoch handling, atomic result persistence, and ownership-safe cleanup debt reporting.
4. Migrate retained installed-CLI and fault regressions into normal CI, fix candidate-root inventory enumeration, and remove choreography-only tests.
5. Switch the package-2 release-path verifier/callers to the new result contract and remove their prepare/score/attest/re-observe, factory-request, qualification, and nested handoff dependencies.
6. Regenerate host artifacts, run the full local gate, obtain independent reviews, and require green PR CI. No live fixture or release action is part of this migration.

Rollback is code rollback before package-3 integration. Release-owned result records remain immutable evidence and are not deleted or translated into legacy pass artifacts.
