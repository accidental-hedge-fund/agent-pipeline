## 1. Core evidence_subject module

- [x] 1.1 Add a pure `evidence-subject` helper module under `core/scripts/` defining the schema_version 1 type, build/canonicalize/compare APIs, and structured comparison outcomes (`match` | `mismatch` | `malformed` | `legacy_unbound`)
- [x] 1.2 Document (in code comments + tests) which runtime inputs fold into `policy_hash`, `engine_fingerprint`, `verifier_fingerprint`, and `required_evidence_set_revision` for v1
- [x] 1.3 Unit tests: exact match (including hex case normalization); candidate mismatch; diff mismatch; policy mismatch; verifier mismatch; malformed missing fields; unsupported schema_version; legacy_unbound when subject absent
- [x] 1.4 Prove comparison is pure (no network/git/subprocess) via injectable inputs only

## 2. Tester evidence binding

- [x] 2.1 Emit nested `evidence_subject` from the deterministic Tester producer; keep top-level `candidate_sha` / `run_id` / `issue` / `pr` consistent with the subject
- [x] 2.2 Extend acquisition to prefer subject comparison; preserve `candidate_sha` fallback with `legacy_unbound` for historical records
- [x] 2.3 Unit tests: subject match + pass; candidate subject mismatch → stale; post-fix regeneration required for new candidate; legacy record without subject

## 3. Review artifact binding

- [x] 3.1 Include `evidence_subject` in newly encoded `ReviewArtifact` JSON; keep `reviewedSha` / `diffHash` consistent with subject fields
- [x] 3.2 Extraction remains backward compatible for artifacts without subject (`legacy_unbound`)
- [x] 3.3 Unit tests: encode/decode subject; consistency with reviewedSha/diffHash; legacy artifact path

## 4. Correction event binding

- [x] 4.1 Emit `evidence_subject` on new `correction_event` records from runtime state (digests + SHAs only; never trust a caller-supplied subject object)
- [x] 4.2 Staleness helpers prefer subject comparison when present; align with reviewed_sha vs head legacy checks; explicit `null` quarantines (not `legacy_unbound`); omit key only for historical records
- [x] 4.3 Unit tests: subject present from digests; missing digests → explicit null; candidate mismatch vs pin; historical omission → legacy_unbound; explicit null → quarantine

## 5. Evidence bundle diagnostics

- [x] 5.1 At finalize, write structured subject diagnostics (per readiness artifact: present?, outcome, mismatched_fields) into `summary.json` / legacy `evidence.json`
- [x] 5.2 New review/override bundle rows carry `evidence_subject` when written
- [x] 5.3 Unit tests: match diagnostics; policy-only mismatch fields; legacy_unbound labeling; no invented subjects

## 6. Invalidation and post-fix regeneration coverage

- [x] 6.1 Add regression coverage that a candidate-changing fix invalidates prior tester/review subject currency until regeneration
- [x] 6.2 Add coverage that policy_hash / verifier_fingerprint / required_evidence_set_revision mismatches surface in diagnostics without claiming full match
- [x] 6.3 Ensure partial legacy evidence in a mixed bundle is labeled per-artifact (not silently upgraded)

## 7. CI and mirror

- [x] 7.1 Run targeted `core` unit tests for new/changed files
- [x] 7.2 Run `npm run ci` from repo root and fix failures
- [x] 7.3 If any `core/` file changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
- [x] 7.4 `openspec validate unify-immutable-evidence-subject` (and `--strict` if used in CI) remains green
