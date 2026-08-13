## Context

See proposal.md for motivation. Current human-attention surface is multi-layered but incomplete:

| Surface | What it stores | Gap |
|---|---|---|
| Labels (`pipeline:needs-human`, `pipeline:blocked`) | Authoritative stage/hold | No question, eligibility, or resume target |
| Ceiling / human-decision comments | Human-readable evidence | Not a versioned resume contract; stale risk |
| `human_intervention` events | Metrics/reporting kinds | Not authority; not resumable state |
| Fix `human-decision-required` declaration (#787 path) | Authority predicate (key, fingerprint, reviewed SHA) | No durable handoff lifecycle after park |
| Durable pause/waiting human-input request | Loop-item hold request | Loop ledger only; not full issue/PR factory handoff |
| #575 pre-code attestation | Policy-bound approve for high-risk pre-code | Distinct control; must not be satisfied by context answers |

Post-#787 rule this design must honor: **only** a current `human-decision-required` diagnostic with finding key, fingerprint, and reviewed SHA establishes human authority. Generic `needs-human` and engine exhaustion do not.

## Goals / Non-Goals

**Goals:**

- One versioned handoff record type that parks work with a bounded question and safe resume contract.
- Clear split: **authority-bearing** vs **non-authority** (context / expertise / manual-repair) classes.
- Deterministic eligibility or documented unresolved-routing fail-closed evidence.
- Operator list/inspect/answer/reject/supersede + resume revalidation.
- Queue visibility of waiting-human without capacity-failure misclassification.
- Compatibility with labels-as-authority for workflow stage.

**Non-Goals:**

- Hosted inbox UI or org knowledge base.
- Auto-picking a human when policy cannot resolve one.
- Second workflow state machine or new stage labels for answer lifecycle.
- Replacing #575 attestation or override disposition evidence.
- Letting agents infer release/product authority from a context answer.

## Decisions

### 1. Handoffs complement labels; they do not own stage

**Decision:** GitHub labels remain the authoritative workflow stage (`needs-human`, `blocked`, active stage). Handoff status is a **side contract**: `pending | answered | rejected | superseded | expired`. Creating a handoff never replaces stage transitions; answering never alone sets `ready-to-deploy`. Resume uses existing advance/unblock paths after revalidation succeeds.

**Why:** Issue forbids a parallel state machine. Labels already drive dispatch.

**Alternatives:** New stage labels per handoff status — rejected (duplicates SM). Handoff as sole authority for hold — rejected (breaks existing label consumers).

### 2. Schema version 1 — required fields

**Decision:** Persist handoffs as schema-versioned JSON (`schema_version: 1`) with at least:

| Field group | Contents |
|---|---|
| Identity | `handoff_id` (stable, unique within repo+issue), `created_at` |
| Scope | `domain`/`repo`, `issue_number`, `run_id`, `attempt_id` (nullable when not in durable loop), `blocked_stage` |
| Question | `question` (bounded non-empty single question text), `reason` (why human required) |
| Class | `handoff_class` closed set (see decision 3) |
| Authority | `authority_mode`: `authority` \| `non_authority`; optional `human_decision_required` evidence (finding key, fingerprint, reviewed SHA) when authority |
| Scope hashes | `candidate_sha`, optional `plan_revision`/`dossier_hash`/`policy_hash`/`spec_hashes[]`/`content_hashes[]` |
| Eligibility | `required_capability` (role/expertise/component ownership tokens), `resolution_evidence` (deterministic eligible set or `unresolved` fail-closed record) |
| Lifecycle | `status`, `expires_at` (nullable or policy default), `supersedes` / `superseded_by` handoff ids |
| Answer | `responder`, `identity_source`, `decision` (`answer` \| `reject`), `answer_text` / structured payload, `answered_at`, `supporting_evidence` (bounded) |
| Resume | `resume_target` (stage or deterministic recipe id), `resume_preconditions[]` |

Malformed records fail closed on read for resume/advance; they remain readable for audit dump with a parse error.

**Why:** Matches acceptance criteria field list without inventing a free-form document store.

### 3. Closed handoff classes (product + repair)

**Decision:** `handoff_class` is a closed string set for v1:

- `missing_context` — non-authority
- `product_judgment` — authority-bearing when backed by `human-decision-required` evidence; otherwise refuse create or force non-authority reclassification
- `domain_expertise` — non-authority by default
- `risk_authority` — authority-bearing (reuse #575-style resolution when policy-defined)
- `override_disposition` — authority-bearing; composes with existing override keys; does not replace override sentinel format
- `manual_repair` — non-authority; engine/recovery exhaustion with no decision question, or typed repair ask
- `unknown` — non-authority reporting escape; MUST NOT grant authority

**Create gate:**

1. `question` non-empty and bounded (single primary ask; max length enforced in schema).
2. `required_capability` or authority class present.
3. Current candidate evidence present (`candidate_sha` when a worktree/PR tip exists; for pre-code waits, dossier/policy hashes as applicable).
4. If `authority_mode: authority` or class is authority-bearing: require current `human-decision-required` evidence **or** an equivalent already-specified authority gate (e.g. pre-code attestation wait already policy-bound). Engine exhaustion alone → `manual_repair` + `non_authority`.

Depend on #760 canonical reason taxonomy for *why* automation stopped; handoff class maps from reason + site context, never invents product judgment from unknown failure.

**Why:** Recommendation upsert + post-#787 reconciliation.

### 4. Storage and audit trail

**Decision:**

- **Primary durable store:** issue-scoped under the existing run evidence / durable run-store layout (host-local files keyed by domain+issue+handoff_id), plus a **pipeline-attested issue comment** (or dedicated sentinel block) that carries the handoff id and machine-readable summary so operators can discover handoffs without host access.
- **Append-only audit:** each create/answer/reject/supersede/expire/resume-attempt writes an immutable event to a handoff audit log (jsonl or evidence-bundle array). Mutations of lifecycle status update the current record via copy-on-write or status field change **and** always append an audit event. Never rewrite historical answer bodies.
- **Idempotency keys:** `(handoff_id, operation, payload_hash)` or explicit `client_request_id` on answer/reject/supersede; duplicate delivery returns the same terminal state without double-append of semantic answer (audit may record `duplicate: true`).

**Why:** Issue allows comments as interaction mechanism initially; durability needs more than comment prose.

**Alternatives:** GitHub Issues only as store — rejected (hard to revalidate hashes, concurrent edits). New external DB — rejected for v1.

### 5. Eligibility and #575 composition

**Decision:** Export pure helpers:

- `resolveHandoffEligibility(handoff, policy, identityInputs) → { eligible: Actor[], unresolved: boolean, evidence }`
- `authorizeHandoffAnswer(handoff, actor, identitySource) → { ok, reason }`

For `authority_mode: authority`, reuse pre-code attestation **approver resolution patterns** (identity / group_ref / role / path_owner / risk filters) and `getGhActor` (or injectable) identity. Unauthorized → refuse; do not record as satisfying answer.

For `non_authority`, eligibility may be broader (any authenticated actor, or required_capability match when policy defines it). Success still records actor; it **never** upgrades to approval/attestation/override.

Unresolved routing when policy cannot determine any eligible actor: fail closed for authority-bearing creates/answers; for non-authority, allow create with `resolution_evidence: unresolved` and surface for operator assignment — **do not invent** an assignee.

**Why:** Issue requires reuse of #575 and forbids auto-choosing humans without policy.

### 6. Resume revalidation

**Decision:** Before any advance after answer, `validateHandoffResume(handoff, currentContext)` checks:

1. Status is `answered` (not rejected/superseded/expired/pending).
2. `candidate_sha` matches current worktree/PR head (or explicit superseding SHA if policy allows rebinding — default: mismatch fails).
3. Bound dossier/policy/spec content hashes still match current artifacts when present on the handoff.
4. Authority policy hash / ownership mapping still authorizes the recorded responder for authority-bearing handoffs.
5. Not past `expires_at`.
6. Not superseded (`superseded_by` null).
7. `resume_target` is unambiguous and stage preconditions hold (same rules as normal advance entry).
8. For authority-bearing human-decision handoffs: current diagnostic still matches key+fingerprint+SHA or a recorded override has been applied through the **existing** override path when that was the intended resolution.

Failure → leave labels/state unchanged; append resume-refusal audit; never advance.

**Why:** Acceptance criteria for stale/superseded answers.

### 7. Operator CLI surface

**Decision:** Register commands (names exact in implementation; proposed surface):

| Command | Mutating? | Behavior |
|---|---|---|
| `handoff list` | no | Filter by issue / run / repo / queue-batch; human table + `--json` |
| `handoff show <id>` | no | Full question, evidence, eligibility, status, resume target |
| `handoff answer <id>` | yes | Authenticated answer; eligibility + authority checks |
| `handoff reject <id>` | yes | Authenticated reject; remains blocked; audit |
| `handoff supersede <id>` | yes | Create/link superseding handoff; old → `superseded` |

Optional: answer may auto-invoke resume validation + advance only when flags/policy say so; default for authority overrides continues to compose with existing `override` / unblock flows rather than inventing a silent resume.

Registry: add entries to command-registry with explicit `allowedFlags` (`--json`, `--repo`, filters, etc.).

### 8. Queue / budget projection

**Decision:** Extend batch-summary (and any durable-loop scoreboard fields that already surface needs-human) with:

- `waiting_human_count`
- `waiting_human_oldest_age_seconds` (optional)
- per-item `pending_handoff_ids[]` when useful

Waiting-human items are **not** counted as agent/compute capacity failures and **not** charged against failure-rate halt thresholds solely for being in human wait. Other ready items continue to dispatch subject to existing concurrency/budget caps.

### 9. Integration points (create sites)

**Decision:** Create handoffs at existing park sites that already have a bounded question:

1. Fix-stage accepted needs-human-decision declaration → authority-bearing handoff + existing evidence comment.
2. Other stages that already emit structured human-input / product-judgment parks with a concrete question text.
3. Engine exhaustion without decision question → only if a human must act: `manual_repair` non-authority; otherwise keep engine-owned recovery without a handoff.

Do **not** create handoffs for every `setBlocked` or transient retry.

### 10. Relationship to durable-pause human-input request

**Decision:** When durable-loop items enter `waiting` with a human-input request, the request id SHOULD reference or equal `handoff_id` when both apply. Advance-path (label-driven) issues use handoffs without requiring durable-loop ledger. No requirement to force all parks through the durable-loop SM.

### 11. Escalation inventory

**Decision:** New production sites (create-fail-closed, unauthorized answer, resume refuse, malformed record) get `escalation-site-dispositions` rows. Unauthorized/integrity → `deliberately-fail-closed`. Pending wait is not a retry wrapper target.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Comment + file store drift | Handoff id is canonical; resume reads validated store first; comment is discovery/provenance |
| Operators treat any answer as authority | Schema + authorize path; tests; status shows `authority_mode` |
| Stale resume after force-push | SHA revalidation; supersede path |
| Queue metrics double-count blocked | Separate waiting-human counters; document non-capacity semantics |
| Scope creep into inbox product | Non-goals; no UI; list/show only |
| Confusion with #575 attestation | Design decision 5 + pre-code delta: context answers never clear attestation |

## Migration Plan

1. Ship schema + pure helpers + store + CLI as additive.
2. Wire create at fix human-decision park first (highest authority value).
3. Wire status/list/queue projections.
4. Wire answer/reject/supersede + resume revalidation.
5. Expand create sites only when they already have bounded questions.
6. Backward compatible: old issues without handoffs keep ceiling-comment / override behavior; status degrades gracefully when no handoffs exist.

Rollback: disable create sites via feature flag or simply stop calling create (records remain read-only); labels unchanged.

## Open Questions

None that block specs. Exact CLI keyword (`handoff` vs `question`) and default expiration hours can follow existing config patterns during implementation without changing requirements.
