## Context

See proposal.md for motivation (#692). Today identity is distributed:

| Surface | Identity pins today |
|---|---|
| Review comments / `ReviewArtifact` | `reviewedSha`, `diffHash`, blocking keys |
| Pre-merge SHA / delta gates | reviewed SHA, pipeline-internal commits, live-head pin |
| Tester evidence | `candidate_sha`, `config_digest`, run/issue/PR |
| Correction events | `reviewed_sha`, `head_sha`, `run_id` |
| Engine identity | version + templates fingerprint (+ optional commit_sha) |
| Production treatment fingerprint | adapter/CLI/model/effort/sandbox stamps |
| Evidence bundle | runId/issue/pr/branch; review rows carry `sha` only |

#646 already reserved an optional nested `evidence_subject` on Tester evidence and forbade a Tester-only subject vocabulary. This change defines that shared object and binds the readiness families that already write structured artifacts.

Product boundary: **Agent Pipeline creates and validates** the authoritative subject. Project Warrant may aggregate and refuse stale dossiers; it MUST NOT invent or repair subjects.

## Goals / Non-Goals

**Goals:**

- One versioned nested object (`evidence_subject`) on every readiness-relevant structured artifact.
- Pure, deterministic build/canonicalize/compare helpers with injectable inputs (no network in the pure path).
- Explicit comparison outcomes: `match`, dimension-level `mismatch`, `malformed`, `legacy_unbound`.
- Documented invalidation matrix (candidate vs policy vs verifier vs required-evidence-set).
- Bundle-level mismatch diagnostics for Warrant without recomputation.
- Explicit legacy handling for pre-subject artifacts.

**Non-Goals:**

- Warrant UI, collector, or retrieval (#801+).
- Replacing family-specific schemas (findings, suite command rows, rubric scores).
- Making `run_id` alone sufficient for readiness.
- Cross-host durable subject store; subjects live on artifacts already written by the run.
- Rewriting every gate narrative string; gates may keep SHA-specific messages while also consulting the subject.
- Implementing #691 verifier surface itself; only reserve the fingerprint field and invalidation rule so #691 can fill it.

## Decisions

### 1. Single nested object, not a parallel top-level ID scheme

**Decision:** Readiness-relevant records carry a nested `evidence_subject` (or equivalent documented field name) with `schema_version` starting at `1`. Family-specific top-level fields (`candidate_sha`, `reviewedSha`, `diffHash`, etc.) remain for local consumers and backward compatibility; when both exist, producers SHALL keep them consistent with the subject, and subject comparison is authoritative for multi-family readiness composition.

**Why:** Matches #646 reservation; avoids renaming existing fields; lets incremental adoption attach the nest without a big-bang schema rewrite.

**Alternatives:** Flatten all identity into each schema — rejected (duplicated field names and drift). Opaque single hash only — rejected (Warrant and operators need dimension-level diagnostics).

### 2. Subject field set (schema_version 1)

**Decision:** `evidence_subject` schema_version `1` SHALL include at least:

| Field | Meaning |
|---|---|
| `schema_version` | Integer, starting at `1` |
| `domain` | Repo domain / owner-repo identity string used by the pipeline for this run |
| `issue` | GitHub issue number |
| `pr` | PR number or `null` when none |
| `run_id` | Pipeline run id |
| `candidate_sha` | Full 40-char product candidate HEAD SHA |
| `diff_hash` | Canonical PR/candidate diff hash (same family as verdict-diff-cache; `null` only when diff unavailable under existing rules) |
| `policy_hash` | Digest of the effective review/readiness policy and configuration slice that governs acceptance |
| `engine_fingerprint` | Digest combining engine identity (version + templates fingerprint and related engine pin) used for this evidence |
| `verifier_fingerprint` | Digest of the verifier/prompt surface for this evidence family (reviewer prompt set, shipcheck rubric identity, etc.); may equal or refine engine fingerprint when no separate verifier applies |
| `required_evidence_set_revision` | Stable revision id/hash of the set of evidence kinds required for readiness at production time |

Optional extension fields MAY be added later; readers SHALL ignore unknown fields. Producers MUST NOT omit required v1 fields except where a field is explicitly nullable (`pr`, `diff_hash` under documented unavailability).

**Why:** Matches the issue contract; separates candidate identity from policy/verifier/requirement revision so invalidation can be selective.

**Alternatives:** One mega-hash only — rejected for diagnostics. Per-family optional subsets with different required keys — rejected (breaks “same shape”).

### 3. Authoritative runtime derivation only

**Decision:** Only deterministic engine code builds subjects. Inputs come from resolved config, git/PR head pins, computed digests, and engine identity probes already owned by the pipeline. Harness prose, reviewer free text, and model-authored JSON MUST NOT supply or override subject fields.

**Why:** Same trust boundary as Tester evidence production and ReviewArtifact footer encoding.

### 4. Canonicalization and comparison

**Decision:**

- **Canonicalize:** fixed key order, normalized SHA lowercase hex, nulls explicit, no floating timestamps inside the subject, digest fields as lowercase hex of documented width.
- **Compare:** pure function returning `{ outcome: "match" | "mismatch" | "malformed" | "legacy_unbound", mismatched_fields: string[] }` against an evaluation pin subject (or partial pin for family-local checks).
- **Exact match** requires all non-null required fields equal; null vs non-null for a required-when-available field is a mismatch for that field when the evaluation pin has a value.

**Why:** Warrant and gates need stable equality and field-level diagnostics without re-hashing source trees.

### 5. Invalidation matrix

**Decision:**

| What changed | Effect |
|---|---|
| `candidate_sha` (product HEAD moves for non-equivalent candidate) | All readiness evidence bound to the old candidate is non-current; require regeneration / re-review for families needed at the new head |
| `diff_hash` only (same SHA rare; usually moves with content) | Diff-bound review reuse and any evidence keyed to that diff is non-current |
| `policy_hash` | Policy-bound review/override acceptance and readiness composition using that policy slice is non-current; suite evidence whose acceptance does not depend on that policy MAY remain current for suite-pass facts if candidate/diff/engine still match (documented per family) |
| `verifier_fingerprint` / `engine_fingerprint` | Evidence produced under the old verifier/engine surface is non-current for families that claim verification under that surface |
| `required_evidence_set_revision` | Readiness composition is non-current even if individual family artifacts still match candidate; missing newly required kinds block readiness |
| `run_id` alone | MUST NOT be treated as sufficient identity; run change without candidate/policy/verifier change does not invent a pass |

Pipeline-internal commits that do not change product candidate content remain governed by existing `review-sha-gating` / candidate-integrity rules for approval reuse; subject comparison for **product** candidate_sha still applies when those rules classify a true product move.

### 6. Consumer dispositions

**Decision:** On missing/malformed/mismatched subject when evaluating readiness currency:

1. **malformed** → quarantine; never treat as pass or fail authority for the live pin.
2. **mismatch** on candidate/diff/engine/verifier (as applicable to the family) → stale/non-current; regenerate or re-acquire.
3. **legacy_unbound** (pre-subject artifact) → explicit disposition: family MAY fall back to existing field-level checks (`candidate_sha` / `reviewedSha`) for v1 transitional reads, but MUST label the evidence `legacy_unbound` in diagnostics and MUST NOT claim full multi-dimension subject match. Hard refusal MAY be enabled later by schema/policy bump.
4. **match** → family-local outcome rules apply as today.

**Why:** Avoids a hard cutover that strands all historical runs while still making partial identity visible.

### 7. Bundle diagnostics for Warrant

**Decision:** At finalize (and any readiness composition path that already builds summary), the bundle SHALL include a structured diagnostics section (name may be `evidence_subject_diagnostics` or equivalent) listing, per readiness artifact reference: subject present?, comparison outcome vs evaluation pin, `mismatched_fields`, and legacy flag. Digests and SHAs already on the subject are echoed; consumers MUST NOT need to recompute policy/engine hashes to detect mismatch if both subjects are present.

### 8. Adoption order

**Decision:** Implement pure helpers first; wire Tester (already reserved), review artifact, correction events, and evidence-bundle diagnostics next; eval/visual/shipcheck attach the same nest when their structured readiness records are written (even if currently comment-only, any new structured record MUST include the subject). Do not block the change on a full rewrite of every stage comment format.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Over-invalidation when only policy text changes cosmetically | `policy_hash` digests effective acceptance-relevant config only; document included keys |
| Under-invalidation if a family forgets to attach subject | Acquisition fail-closed: missing subject on **new** schema versions is malformed; legacy path only for pre-migration records |
| Diff unavailable → null diff_hash weakens match | Same as existing verdict-diff-cache null rules; null pin + null evidence is not automatic multi-family readiness pass |
| Engine fingerprint churn on unrelated template edits | Fingerprint uses existing template snapshot pin for the run; mid-run drift already has engine-identity probe semantics |
| Scope creep into Warrant | Spec and tasks exclude Warrant UI; only diagnostics shape |
| Dual authority between top-level SHA fields and subject | Producers must keep them consistent; tests assert consistency; composition uses subject |

## Migration Plan

1. Ship pure subject helpers + unit tests (no behavior change).
2. Emit subject on new Tester evidence, review artifacts, correction events, and bundle diagnostics.
3. Consumers prefer subject comparison; fall back to legacy field checks with `legacy_unbound` when subject absent.
4. No rewrite of historical run directories required.
5. Rollback = stop emitting/requiring subject; legacy paths remain.

## Open Questions

None that block specs or tasks. Exact helper module file name, diagnostic JSON key spelling, and which precise config keys enter `policy_hash` may be fixed at implementation time as long as they are deterministic, documented in code comments/tests, and match the invalidation matrix above.
