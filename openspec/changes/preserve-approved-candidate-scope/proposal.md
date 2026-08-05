## Why

PR #793 reintroduced ~1,845 lines of the retired README monolith after #597 had shipped the lean landing page. The pipeline has SHA and worktree safety checks, but it does not persist or compare an **approved candidate change surface** across candidate-moving operations. A restack, conflict repair, rebase, or auto-fix can therefore produce a materially different candidate that still looks operationally healthy (CI green, locks held, worktree clean). This is a provider-neutral control-plane defect: no primary or secondary harness may be trusted to self-police this boundary.

## What Changes

- **Candidate-integrity protocol** — Before every pipeline-owned candidate-moving operation, persist a candidate-integrity manifest anchored to the authoritative base and PR head (base ref/SHA, candidate SHA, changed-path surface, deterministic path/content evidence sufficient for comparison). After mutation, re-read authoritative head/base, build the resulting manifest, and classify the transition.
- **Classification and gate response** — Classify each transition as `semantically_equivalent`, `expected_scoped_change`, `scope_expansion`, or `unverified`. Pure restacks that preserve the candidate surface may proceed only after current-head gates re-evaluate. Scope expansion or unverified comparison **MUST** invalidate prior review and readiness evidence, emit a structured diagnostic, and return to scoped review or bounded engine recovery — **not** silently reach ready-to-deploy and **not** become a human-authority hold for the mechanical failure alone.
- **Mutation coverage** — Wire the protocol around deterministic rebase/restack, conflict repair, pre-merge auto-fix, and generic recovery repair. Restart/reattach hydrates the same durable manifest rather than silently resetting it.
- **Evidence and observability** — Emit durable `candidate_integrity` run events (before/after SHA, mutation method, changed-path summary, classification, review-invalidation reason) that #763 scoreboard metrics already consume. Ready-to-deploy requires review, CI, and deterministic repository invariants all tied to the **current** authoritative candidate SHA.
- **Regression fixtures** — Deterministic fixtures for the #793-class restack append, clean rebase surface preservation, intended auto-fix re-review, restart manifest hydration, and multi-item invariant survival (item A invariant survives later repair/restack of item B).
- **Composition, not ownership of sister issues** — Reuse #646 Tester evidence when available; do not redefine trusted policy (#691) or prompt quality (#737). #855 owns README restoration; this issue owns the reusable integrity protocol and composition fixture framework.

## Capabilities

### New Capabilities

- `candidate-integrity`: Provider-neutral control-plane protocol that snapshots approved candidate surface, compares before/after every pipeline-owned candidate-moving mutation, classifies the transition, invalidates stale review/readiness on scope expansion or unverified comparison, persists/hydrates manifests across restart, and emits durable events for observability.

### Modified Capabilities

- `review-sha-gating`: Scope expansion or unverified candidate-integrity comparison MUST invalidate prior review evidence for readiness even when residual SHA/diff-hash short-circuits would otherwise look reusable; readiness must re-bind to the current candidate SHA after classification.
- `autonomous-recovery-controller`: Mechanical remediation / `repair_pipeline_item` is a candidate-moving operation and MUST run the candidate-integrity before/after protocol; post-repair re-entry MUST re-evaluate gates against the classified resulting candidate.
- `pre-merge-fix-round`: Pre-merge auto-fix that moves the candidate MUST take a pre-mutation manifest and post-mutation classification; an intended content change forces fresh review against the new SHA rather than silent readiness carry-forward.
- `merge-queue-repair-hold`: Restack, deterministic rebase, and optional surgical/mechanical repair MUST apply the same candidate-integrity protocol; scope expansion / unverified results fail closed for re-gate eligibility without inventing a human hold for the mechanical class alone.
- `evidence-bundle`: Durable run evidence records candidate-integrity transitions (or equivalent run-ledger events the bundle surfaces) so restart, summary, and #763 consumers share one structured trail.

## Acceptance Criteria

- [ ] Before every covered pipeline-owned candidate-moving operation (deterministic rebase/restack, conflict repair, pre-merge auto-fix, generic recovery repair), a candidate-integrity manifest is persisted with authoritative base ref/SHA, candidate SHA, changed-path surface, and deterministic path/content comparison evidence.
- [ ] After each such mutation, the engine re-reads authoritative PR head and base, builds a resulting manifest, and classifies the transition as exactly one of: `semantically_equivalent`, `expected_scoped_change`, `scope_expansion`, or `unverified`.
- [ ] A pure restack that preserves the candidate change surface classifies as `semantically_equivalent` (or equivalent non-expansion class) and proceeds only after all current-head gates are re-evaluated — no false scope-expansion finding.
- [ ] A scope expansion or unverified comparison invalidates prior review and readiness evidence, emits a structured candidate-integrity diagnostic, and routes to scoped review or bounded engine recovery; it does **not** silently reach `pipeline:ready-to-deploy` and does **not** create a human-authority hold solely for that mechanical class.
- [ ] Path and content evidence plus declared repair scope drive classification; raw diff size may enrich diagnostics but is **not** the sole safety boundary (legitimate large in-scope changes are not rejected merely for size).
- [ ] Restart or reattach after a claimed mutation hydrates the same durable manifest; stale review evidence from a pre-mutation SHA cannot be reused for readiness on the post-mutation head without re-classification.
- [ ] Ready-to-deploy requires review evidence, CI, and deterministic repository invariants all bound to the **current** authoritative candidate SHA (composing with #646 Tester evidence when present).
- [ ] Durable run evidence / ledger events of type `candidate_integrity` (or the schema #763 already reads) include before/after SHA, mutation method, changed-path summary, classification, and review-invalidation reason when invalidation occurs.
- [ ] Regression fixture reproduces #793-class repair/restack that appends the retired README monolith: docs landing-page invariant fails and readiness is denied.
- [ ] Regression fixture for clean rebase (commit identity changes, semantic candidate surface preserved) re-gates without a false scope-expansion finding.
- [ ] Regression fixture for intended auto-fix that changes the candidate forces fresh review against the new SHA.
- [ ] Regression fixture for restart after a claimed mutation preserves the manifest and refuses stale review reuse for readiness.
- [ ] Synthetic multi-item sequence proves an accepted invariant from item A survives a later repair/restack of item B (composition fixture framework).
- [ ] No provider- or host-specific behavior; no replacement of review with a line-count/diff-size threshold; no new unattended merge path; no change to #691 trusted-verifier or #737 prompt-quality ownership.
- [ ] `openspec validate preserve-approved-candidate-scope` passes; implementation phase later keeps `npm run ci` green with `plugin/` regenerated when `core/` changes.

## Impact

- **Control plane (implementation phase):** shared candidate-integrity module (manifest build/compare/classify/persist/hydrate); call sites in pre-merge restack/rebase, conflict repair, pre-merge auto-fix, recovery `repair_pipeline_item`, and merge-queue repair/restack paths.
- **Gates:** review-SHA / readiness paths observe invalidation from integrity classification; docs and other deterministic invariants re-checked on current head after mutation.
- **Evidence:** run ledger / evidence bundle gain structured `candidate_integrity` events; #763 scoreboard already reports them when present.
- **Tests:** injected-deps unit tests and deterministic fixtures under `core/test/` (and composition harness as designed); no real network/git in unit tests.
- **Out of scope:** #855 README content restoration; #763 metric math (already shipped as consumer); #691 trusted policy resolution; #737 prompt quality; #740 cross-provider eval holdout shape; provider-specific harness behavior.
