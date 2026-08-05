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

- [ ] Before every covered pipeline-owned candidate-moving operation, a pre-mutation manifest with canonical per-path patch records (status, base_blob, candidate_blob, rename old_path) is durable under the run `candidate-integrity/` store; mutation does not start until pre-persist succeeds.
- [ ] All covered sites use the mandatory lifecycle: `pre_persisted → mutation_claimed → authoritative_post_read → classified`; mutation errors still re-read authoritative PR head/base.
- [ ] After each mutation, classification is exactly one of: `semantically_equivalent`, `expected_scoped_change`, `scope_expansion`, or `unverified`, driven by candidate-side map equality plus declared scope (not raw diff size alone).
- [ ] Pure restack/rebase with preserved candidate-side map is `semantically_equivalent`, re-evaluates current-head gates, and does **not** preserve ready-to-deploy solely from equivalence; no false scope-expansion.
- [ ] `scope_expansion` / `unverified` invalidate prior review and readiness, emit structured diagnostics + `candidate_integrity` events with fields `computeCandidateIntegrityMetrics` already reads, route to scoped review/bounded recovery, and never create a human-authority hold solely for integrity.
- [ ] `expected_scoped_change` forces fresh review (delta path when already routed) at the new SHA; declared scope is frozen exact paths/directory prefixes; restack/rebase cannot declare non-empty scope.
- [ ] Restart hydrates incomplete lifecycle states without reseeding pre-manifest from post head; stale review cannot authorize readiness.
- [ ] Repeated expansion/unverified is budget-bounded (default 2 extra mutations) without human hold, merge, or readiness on the failing head.
- [ ] Call-site inventory covers every head-moving path; Covered sites only wrap through the shared helper (contract test); Out-of-scope sites documented.
- [ ] Self-contained #793-class fixture denies undeclared README expansion via integrity; composition may also fail #855 readme-landing-contract without forking product ownership.
- [ ] Clean rebase, intended auto-fix, restart hydration, multi-item isolation, base movement, rename/delete, binary/unreadable → unverified, and partial-failure re-read fixtures pass under injected deps.
- [ ] No provider-specific behavior; no line-count-only threshold; no unattended merge; no #691/#737 ownership change.
- [ ] `openspec validate preserve-approved-candidate-scope` and root `npm run ci` green with `plugin/` regenerated when `core/` changes.

## Impact

- **Control plane (implementation phase):** shared candidate-integrity module (manifest build/compare/classify/persist/hydrate); call sites in pre-merge restack/rebase, conflict repair, pre-merge auto-fix, recovery `repair_pipeline_item`, and merge-queue repair/restack paths.
- **Gates:** review-SHA / readiness paths observe invalidation from integrity classification; docs and other deterministic invariants re-checked on current head after mutation.
- **Evidence:** run ledger / evidence bundle gain structured `candidate_integrity` events; #763 scoreboard already reports them when present.
- **Tests:** injected-deps unit tests and deterministic fixtures under `core/test/` (and composition harness as designed); no real network/git in unit tests.
- **Out of scope:** #855 README content restoration; #763 metric math (already shipped as consumer); #691 trusted policy resolution; #737 prompt quality; #740 cross-provider eval holdout shape; provider-specific harness behavior.
