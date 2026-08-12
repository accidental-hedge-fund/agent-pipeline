## Why

Agent Pipeline already pins many readiness inputs (reviewed SHA, diff-hash cache, Tester SHA match, correction-event SHAs, engine/template fingerprints), but each family uses a different partial identity. A readiness dossier can therefore combine review, test, eval, visual, shipcheck, override, and policy evidence that were produced for different candidates, policies, verifier surfaces, or required-evidence sets. Issue #692 is the Wave 3 correctness foundation: one versioned, immutable `evidence_subject` contract that every assurance artifact carries and that every consumer can compare without re-deriving identity.

## What Changes

- Introduce a versioned **`evidence_subject`** contract with deterministic canonicalization and comparison semantics.
- Require every readiness-relevant producer (review, test/tester, eval, visual, shipcheck, policy disposition, override, readiness/bundle composition) to attach a subject derived from **authoritative runtime state**, never model prose.
- Require consumers to **reject or explicitly quarantine** missing, malformed, or mismatched subjects before treating evidence as current for readiness.
- Document invalidation rules: candidate-changing work invalidates prior readiness evidence and forces regeneration; policy, verifier/prompt, or required-evidence-set changes invalidate only the affected evidence families under those rules.
- Surface structured **mismatch diagnostics** on evidence bundles suitable for Project Warrant without forcing Warrant to recompute identity.
- Define explicit **backward compatibility** for historical artifacts (`legacy_unbound`, migration path, or hard refusal by schema version).
- **Not changing:** Project Warrant UI/collector (#801+), per-artifact domain schemas (findings, suite rows, rubric scores), merge authority, or treating a run ID alone as sufficient identity.

## Acceptance criteria

- [ ] A single versioned `evidence_subject` shape (schema version + documented fields) is defined and is the same object type across readiness-relevant artifact families; no family invents a competing subject vocabulary.
- [ ] Deterministic producers (engine code) can build a subject from runtime inputs (repo/domain, issue/PR, run id, candidate SHA, canonical diff hash, effective policy/config hash, engine+prompt/verifier fingerprint, required-evidence-set revision) without reading harness prose.
- [ ] Subject serialization is canonical: same logical inputs yield byte-stable comparable form; comparison classifies exact match vs which identity dimensions differ.
- [ ] A readiness consumer that sees a candidate SHA or diff-hash mismatch against the live evaluation pin refuses to treat that evidence as current for readiness (quarantine or regenerate path).
- [ ] A candidate-changing fix (new product HEAD) invalidates earlier readiness evidence bound to the prior candidate subject until producers regenerate for the new candidate.
- [ ] Policy-hash change, verifier/prompt fingerprint change, and required-evidence-set revision each invalidate only the evidence families those dimensions govern, with documented diagnostics naming the mismatched field(s).
- [ ] Finalized evidence bundles expose per-artifact subject mismatch diagnostics (matched / mismatched fields / legacy_unbound / malformed) without requiring an external consumer to recompute hashes.
- [ ] Historical artifacts without a subject are handled under an explicit legacy rule (`legacy_unbound`, migration fill, or hard refuse by schema version)—never silently treated as full subject match.
- [ ] Unit tests cover: exact match; candidate mismatch; diff mismatch; policy mismatch; verifier mismatch; partial legacy evidence; post-fix regeneration. Tests use dependency seams only (no real network/git/subprocess).
- [ ] `npm run ci` green after implementation; if `core/` is edited, `plugin/` is regenerated in the same change.

## Capabilities

### New Capabilities

- `evidence-subject`: Versioned immutable evidence-subject contract; deterministic derivation, canonicalization, comparison, invalidation rules, mismatch diagnostics, and legacy binding semantics shared by all readiness-relevant assurance artifacts.

### Modified Capabilities

- `tester-evidence`: Require producers to emit a nested `evidence_subject` derived from runtime state; require acquisition/consumers to validate subject currency (not only `candidate_sha`) before treating suite evidence as current.
- `review-artifact-record`: Carry the shared `evidence_subject` on new review artifacts (in addition to existing `reviewedSha` / `diffHash` fields) so gates and dossiers share one identity object.
- `evidence-bundle`: Record subject identity and expose structured mismatch diagnostics for composed readiness evidence so Warrant can refuse stale dossiers without recomputing identity.
- `correction-event-ledger`: Bind correction events to `evidence_subject` (or an explicit null/legacy disposition) so staleness is not limited to bare `reviewed_sha` / `head_sha` string compare.

## Impact

- **New module (expected):** pure helpers under `core/scripts/` (e.g. `evidence-subject.ts`) for build, canonicalize, compare, and diagnostic classification—injectable in unit tests.
- **Producers:** Tester evidence, review artifact encoding, evidence-bundle/review/override records, correction-event emission; later readiness families (eval/visual/shipcheck) attach the same nested object when they write structured readiness artifacts.
- **Consumers:** review acquisition, pre-merge SHA/diff gates, tester acquisition, readiness composition / `finalizeRun` diagnostics.
- **Existing fingerprints:** composes with `engine-identity`, treatment fingerprints, review policy digests, and Tester `config_digest`—does not replace those internal digests; folds their effective values into subject fields under documented hashing rules.
- **Out of scope:** Warrant dossier UI (#801+); replacing ReviewArtifact/TesterEvidence domain fields; auto-merge; treating `run_id` alone as readiness identity.
- **Dependents:** #691 trusted verifier surface, #693–#695 / #575 / #599 / #647 composition work; #646 Tester identity must use this shared subject rather than a Tester-only vocabulary (already reserved).
