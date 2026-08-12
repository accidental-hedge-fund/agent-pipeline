## 1. Path-class registry and pure decision module

- [ ] 1.1 Add a pure trusted-surface module under `core/scripts/` with `path_class_schema_version` 1, built-in class ids, default matching rules, and trusted-source kinds
- [ ] 1.2 Implement path classification over a candidate changed-path set (injectable path list; no live git required in the pure path)
- [ ] 1.3 Implement trusted revision resolution for `installed_engine`, `base_ref`, and `engine_default` via injectable readers/identity
- [ ] 1.4 Implement decision aggregation (`passthrough` | `rebound` | `blocked`) and `effective_verifier_hash` construction with stable canonicalization
- [ ] 1.5 Unit tests: no sensitive paths → passthrough; policy path → rebound with base hash; missing base for required class → blocked; deterministic hash stability; engine class ignores candidate-only bytes

## 2. Configuration schema (additive only)

- [ ] 2.1 Extend config schema with optional additive `trusted_surface` block; reject disable/shrink/use-candidate keys
- [ ] 2.2 Unit tests: valid extra globs accepted; disable keys throw; omitted block defaults safe
- [ ] 2.3 Regenerate config reference / schema command output if this repo generates them from schema (keep docs freshness gate green)

## 3. Run wiring and persistence

- [ ] 3.1 Compute trusted-surface decision at run start / first readiness-relevant gate from live candidate SHA, base SHA, engine pin, and changed paths
- [ ] 3.2 Durable-persist the decision for the run; recompute on product candidate SHA advance
- [ ] 3.3 Mid-run: when engine-class effective material drifts such that `effective_verifier_hash` changes, emit diagnostic and mark prior verifier-bound readiness evidence non-current
- [ ] 3.4 Unit tests with injectable deps: head advance recomputes; mid-run hash change invalidates; blocked refuses ready-to-deploy path

## 4. evidence_subject and producer binding

- [ ] 4.1 Derive `verifier_fingerprint` from `effective_verifier_hash` (plus documented family-local slice) when a decision is present
- [ ] 4.2 Fail closed on blocked/unusable pin rather than inventing a matching fingerprint
- [ ] 4.3 Unit tests: passthrough/rebound fingerprint consistency; blocked does not invent pass subject; trusted hash change → verifier mismatch

## 5. Evidence bundle recording

- [ ] 5.1 Write `trusted_surface` (or equivalent) into `summary.json` / legacy `evidence.json` at finalize
- [ ] 5.2 Unit tests: rebound fields present; passthrough empty triggers; blocked reason visible; historical omission not auto-upgraded

## 6. Dogfood and target-repository regression matrices

- [ ] 6.1 Dogfood fixture: candidate weakens engine judging prompts/policy modules → not silent passthrough; rebound to pin or blocked; readiness cannot claim pass under weakened-only surface
- [ ] 6.2 Target-repo fixtures: edits to `.github/pipeline.yml`, gate scripts, rubrics, schemas, ownership maps → rebound or blocked with triggering paths
- [ ] 6.3 Baseline fixture: product-only paths → passthrough with unchanged judging selection
- [ ] 6.4 All tests use dependency seams only (no real network/git/subprocess)

## 7. CI and mirror

- [ ] 7.1 Run targeted `core` unit tests for new/changed modules
- [ ] 7.2 Run `npm run ci` from repo root and fix failures
- [ ] 7.3 If any `core/` file changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
- [ ] 7.4 `openspec validate bind-verification-trusted-surface` remains green
