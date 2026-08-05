## 1. Manifest types, canonical patch evidence, pure comparison

- [x] 1.1 Add versioned `CandidateIntegrityManifest` + per-path patch records (`status`, `path`, `old_path`, `base_blob`, `candidate_blob`) under `core/scripts/` with injected-deps construction (prefer git object OIDs)
- [x] 1.2 Implement candidate-side map comparison: `semantically_equivalent` | `expected_scoped_change` | `scope_expansion` | `unverified`; raw size diagnostic-only; incomplete digests → `unverified`
- [x] 1.3 Implement `DeclaredRepairScope` (exact paths + directory prefixes; rename requires both sides; freeze at pre-persist)
- [x] 1.4 Unit tests: clean rebase with base movement, add/delete/rename, undeclared README append, large in-scope delta, binary/unreadable → unverified, missing pre-manifest → unverified

## 2. Lifecycle wrapper and authoritative durable store

- [x] 2.1 Implement mandatory wrapper state machine: `pre_persisted → mutation_claimed → authoritative_post_read → classified → disposed`
- [x] 2.2 Pre-persist failure aborts mutation; mutation error still forces authoritative post-read + classify
- [x] 2.3 Atomic durable store under `.agent-pipeline/runs/<run-id>/candidate-integrity/` (temp+fsync+rename); key by domain/issue/PR/run/mutation_id
- [x] 2.4 Restart hydration tests for each incomplete lifecycle state; never reseed pre-manifest from post head

## 3. Events and evidence surface (#763-compatible)

- [x] 3.1 Emit `type: "candidate_integrity"` with `mutation_method`, `classification`, `before_sha`/`after_sha`, `changed_path_summary` (bounded), `invalidated_review`/`invalidated_readiness` booleans, `invalidation_reason`, optional `path_class`/`engine_version`
- [x] 3.2 Injected-deps test that scope-expansion events move `computeCandidateIntegrityMetrics` counters
- [x] 3.3 Evidence-bundle/summary surfaces events; bundle write non-authority for disposition

## 4. Call-site inventory and wrappers

- [x] 4.1 Freeze inventory from design D7; contract test lists Covered sites
- [x] 4.2 Wrap `runDeterministicConflictRebase` / merge-queue restack (`rebase`/`restack`)
- [x] 4.3 Wrap pre-merge conflict rebase + CI one-shot rebase (`rebase`)
- [x] 4.4 Wrap pre-merge auto-fix with declared scope (`pre_merge_autofix`) → expected_scoped_change forces delta re-review
- [x] 4.5 Wrap `repair_pipeline_item` / merge-queue mechanical repair (`recovery_repair`/`conflict_repair`)
- [x] 4.6 Merge-queue re-gate: scope_expansion/unverified not merge-eligible; no mergePr success on that head

## 5. Gate composition and bounded failure

- [x] 5.1 Integrate invalidation records into review-SHA / readiness so expansion/unverified/expected_scoped_change cannot reuse pre-mutation approve; semantic equivalence re-evaluates gates and does not preserve ready-to-deploy
- [x] 5.2 Prevent internal-commit residual exemption from laundering pre-mutation review onto post-mutation SHA after covered mutations
- [x] 5.3 Bounded retry (default N=2) for repeated expansion/unverified; no human-authority hold solely for integrity; durable diagnostics
- [x] 5.4 Stale CI / Tester / invariants / readiness markers cannot authorize new SHA

## 6. Regression fixtures

- [x] 6.1 Self-contained #793-class integrity fixture: undeclared README expansion → scope_expansion + readiness denied (protocol-owned)
- [x] 6.2 Composition: same transition fails `readme-landing-contract` when content supplied (#855 helper, not a forked product contract)
- [x] 6.3 Clean rebase fixture: new SHA, equal candidate-side maps → semantically_equivalent, no false expansion, readiness not auto-preserved
- [x] 6.4 Intended auto-fix → expected_scoped_change → fresh review at new SHA
- [x] 6.5 Restart hydration fixture
- [x] 6.6 Multi-item composition: item A intact after item B mutation
- [x] 6.7 Partial mutation failure still re-reads head; no-op autofix does not invent expansion

## 7. Mirror, validation, and CI

- [x] 7.1 Regenerate `plugin/` via `node scripts/build.mjs` when `core/` changes
- [x] 7.2 `openspec validate preserve-approved-candidate-scope` and `openspec validate --all`
- [x] 7.3 Root `npm run ci` green before done
