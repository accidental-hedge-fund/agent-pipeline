## 1. Manifest types and pure comparison

- [ ] 1.1 Add a versioned `CandidateIntegrityManifest` type and serializers (schema_version 1, identity, base/candidate SHAs, path surface, path/content digests, optional enrichments, producer id) under `core/scripts/` with injected-deps construction from tree inputs
- [ ] 1.2 Implement pure compare/classify: `semantically_equivalent` | `expected_scoped_change` | `scope_expansion` | `unverified`; path+content+declared scope drive results; raw size is diagnostic-only
- [ ] 1.3 Implement durable persist/hydrate helpers for pre- and post-mutation manifests in the run-scoped store (document chosen path against `run-directory-layout`)
- [ ] 1.4 Unit tests for classify matrix: clean rebase, undeclared path append, in-scope large delta, missing pre-manifest → `unverified`, incomplete digests → `unverified`

## 2. Events and evidence surface

- [ ] 2.1 Emit run-ledger `candidate_integrity` events with before/after SHA, mutation_method, classification, changed-path summary, invalidation reason/flags; align field names with #763 scoreboard consumer
- [ ] 2.2 Surface events in evidence-bundle / summary path without making bundle write authoritative for disposition
- [ ] 2.3 Injected-deps tests that a scope-expansion transition produces a parseable event #763 metrics can count

## 3. Call-site wrappers

- [ ] 3.1 Wrap deterministic restack/rebase paths with capturePre → mutate → capturePost → classify → dispose (`restack` / `rebase`)
- [ ] 3.2 Wrap conflict repair with the same protocol (`conflict_repair`)
- [ ] 3.3 Wrap pre-merge auto-fix with declared repair scope and protocol (`pre_merge_autofix`); wire expected_scoped_change to existing delta re-review
- [ ] 3.4 Wrap recovery `repair_pipeline_item` / mechanical remediation (`recovery_repair`)
- [ ] 3.5 Wrap merge-queue restack/repair re-gate path so scope_expansion/unverified cannot become merge-eligible
- [ ] 3.6 Contract test listing covered mutation methods and asserting each known call site invokes the shared helper

## 4. Gate composition

- [ ] 4.1 Integrate integrity invalidation into review-SHA / readiness paths so scope_expansion and unverified block readiness authority without inventing human holds
- [ ] 4.2 Ensure semantically_equivalent still re-evaluates current-head gates (CI, review blockers, Tester pin when present, docs/invariants)
- [ ] 4.3 Restart/reattach hydration: incomplete post-classification cannot reuse pre-mutation review for readiness
- [ ] 4.4 Regression tests for gate dispositions (invalidation, re-gate, no human-hold-only path for mechanical integrity class)

## 5. Regression fixtures

- [ ] 5.1 #793-class fixture: lean README surface → monolith append after restack/repair → scope_expansion and/or docs invariant red → readiness denied
- [ ] 5.2 Clean rebase fixture: new SHA, identical digests → semantically_equivalent, no false expansion
- [ ] 5.3 Intended auto-fix fixture: declared-scope content change → expected_scoped_change → fresh review required at new SHA
- [ ] 5.4 Restart hydration fixture: pre-manifest survives reload; stale review cannot authorize readiness
- [ ] 5.5 Multi-item composition fixture: item A invariant survives later mutation of item B only

## 6. Mirror, validation, and CI

- [ ] 6.1 Regenerate `plugin/` via `node scripts/build.mjs` when `core/` changes; commit mirror with core
- [ ] 6.2 `openspec validate preserve-approved-candidate-scope` and `openspec validate --all` green after any spec edits
- [ ] 6.3 `npm run ci` green from repo root before marking implementation done
