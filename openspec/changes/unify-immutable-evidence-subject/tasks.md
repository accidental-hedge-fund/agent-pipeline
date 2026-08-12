## 1. Core evidence_subject module

- [ ] 1.1 Add a pure `evidence-subject` helper module under `core/scripts/` defining the schema_version 1 type, build/canonicalize/compare APIs, and structured comparison outcomes (`match` | `mismatch` | `malformed` | `legacy_unbound`)
- [ ] 1.2 Document (in code comments + tests) which runtime inputs fold into `policy_hash`, `engine_fingerprint`, `verifier_fingerprint`, and `required_evidence_set_revision` for v1
- [ ] 1.3 Unit tests: exact match (including hex case normalization); candidate mismatch; diff mismatch; policy mismatch; verifier mismatch; malformed missing fields; unsupported schema_version; legacy_unbound when subject absent
- [ ] 1.4 Prove comparison is pure (no network/git/subprocess) via injectable inputs only

## 2. Tester evidence binding

- [ ] 2.1 Emit nested `evidence_subject` from the deterministic Tester producer; keep top-level `candidate_sha` / `run_id` / `issue` / `pr` consistent with the subject
- [ ] 2.2 Extend acquisition to prefer subject comparison; preserve `candidate_sha` fallback with `legacy_unbound` for historical records
- [ ] 2.3 Unit tests: subject match + pass; candidate subject mismatch → stale; post-fix regeneration required for new candidate; legacy record without subject

## 3. Review artifact binding

- [ ] 3.1 Include `evidence_subject` in newly encoded `ReviewArtifact` JSON; keep `reviewedSha` / `diffHash` consistent with subject fields
- [ ] 3.2 Extraction remains backward compatible for artifacts without subject (`legacy_unbound`)
- [ ] 3.3 Unit tests: encode/decode subject; consistency with reviewedSha/diffHash; legacy artifact path

## 4. Correction event binding

- [ ] 4.1 Emit `evidence_subject` on new `correction_event` records from runtime state
- [ ] 4.2 Staleness helpers prefer subject comparison when present; align with reviewed_sha vs head legacy checks
- [ ] 4.3 Unit tests: subject present; candidate mismatch vs pin; historical event without subject → legacy_unbound

## 5. Evidence bundle diagnostics

- [ ] 5.1 At finalize, write structured subject diagnostics (per readiness artifact: present?, outcome, mismatched_fields) into `summary.json` / legacy `evidence.json`
- [ ] 5.2 New review/override bundle rows carry `evidence_subject` when written
- [ ] 5.3 Unit tests: match diagnostics; policy-only mismatch fields; legacy_unbound labeling; no invented subjects

## 6. Invalidation and post-fix regeneration coverage

- [ ] 6.1 Add regression coverage that a candidate-changing fix invalidates prior tester/review subject currency until regeneration
- [ ] 6.2 Add coverage that policy_hash / verifier_fingerprint / required_evidence_set_revision mismatches surface in diagnostics without claiming full match
- [ ] 6.3 Ensure partial legacy evidence in a mixed bundle is labeled per-artifact (not silently upgraded)

## 7. CI and mirror

- [ ] 7.1 Run targeted `core` unit tests for new/changed files
- [ ] 7.2 Run `npm run ci` from repo root and fix failures
- [ ] 7.3 If any `core/` file changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
- [ ] 7.4 `openspec validate unify-immutable-evidence-subject` (and `--strict` if used in CI) remains green
