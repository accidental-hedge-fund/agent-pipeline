## Context

Issue #575 requires a **pre-code human authority boundary** for high-risk change classes. The repository already has:

| Control | When | Who | Role |
|---|---|---|---|
| Plan-review | After plan, before implementing | Agent (optional human feedback window) | Independent agent plan critique — **not** human sign-off |
| Design-gate (#436) | After implementing, before review-1 | Agent implementer + independent reviewer | Risk-triggered decision interrogation |
| Human attestation (this change) | After plan (+ plan-review), **before** implementing | Authenticated authorized human | Architectural judgment ownership |

Related foundation already in-tree or in flight:

- **#692** — shared `evidence_subject` for binding dossier/policy/candidate identity
- **#693** — governed overrides reuse the same authority, expiry, SoD patterns (compose; do not fork a second policy language)
- **#695** — staged policy lifecycle / control drift (later consumers of effective policy hash)
- **#760** / `escalation-site-dispositions` — closed dispositions; do not invent new unrecoverable park classes
- Human comments: do not add a second planning state machine; derive a compact objective manifest from behavior contracts; non-response paths default-resume-safe

## Goals / Non-Goals

**Goals:**

- Opt-in config-driven pre-code attestation with strict parse validation and safe defaults (disabled when omitted).
- Deterministic pre-implementation risk triggers from issue metadata + plan/dossier surface.
- Compact design dossier with vertical-slice behavioral contracts, behavior diffs, stated/derived, and verification refs / `Untestable:`.
- Policy-bound authorized human approval with authenticated identity, SoD, expiry, and full evidence binding.
- Invalidation on material change; contract-to-evidence traceability through shipcheck.
- Backward-compatible autonomy for unconfigured and untriggered work.

**Non-Goals:**

- Human sign-off on every change.
- Four mandatory Product / Architecture / Program Design / Vertical Slice stages.
- Per-slice implementation orchestration beyond evidence-bearing contracts.
- Requiring Specter, EARS, CODEOWNERS, GitHub teams, or any single identity provider.
- Replacing organization identity administration or merge authority.
- Default-sandbox posture changes (separate decision per issue comment).
- A second planning state machine or competing evidence-subject vocabulary.

## Decisions

### 1. Config block name and defaults

**Decision:** Introduce optional `pre_code_attestation` under `.github/pipeline.yml`, validated by a strict zod sub-schema on `PartialConfigSchema`.

Minimum shape (v1):

```yaml
pre_code_attestation:
  enabled: false                    # default when block omitted or field unset
  triggers: [architecture, auth, storage, migration, public-api, large-diff]
  extra_triggers: {}                # name → path globs / label globs
  thresholds:
    max_files: null                 # optional pre-code blast-radius from plan estimate
    max_loc: null
  expiration:
    max_age_hours: 72               # attestation validity window once granted
    reapprove_on: [dossier_change, policy_change, scope_change, ownership_change]
  approvers: []                     # ordered resolution rules (see decision 4)
  separation_of_duties:
    enabled: false
    forbid_self_attest_roles: [implementer, dossier_author]
  wait:
    mode: resume_safe               # resume_safe | hard_block
    max_wait_hours: 168             # bounded wait before typed escalation outcome
```

Unknown keys fail parse. Omitted block → `enabled: false` and no gate behavior (including no stage harness work beyond pass-through record).

**Why:** Mirrors `design_gate` opt-in pattern; issue requires repository configuration rather than hard-coding.

**Alternatives:** Reuse `design_gate` config for human attestation — rejected (different actor, different lifecycle stage, different artifact). Silent defaults for unknown keys — rejected (fail-safe parse).

### 2. Single inert structural stage, not four stages and not a second planning SM

**Decision:** Add one structural stage `pre-code-attestation` in `STAGES` between `plan-review` and `implementing` (when plan-review is skipped, after `planning`). Like `design-gate`, it is **inert unless enabled and triggered**: disabled/untriggered runs record a skip reason and advance immediately. The dossier is stored as part of the plan/evidence artifact graph (run-store + evidence bundle), not as separate mandatory Product/Architecture stages.

Do **not** introduce a second planning state machine. A compact **objective manifest** is derived from approved behavior contracts: stable objective IDs + content hashes mapped to final test/eval/visual/shipcheck evidence, with unresolved consequential decisions preserved explicitly.

**Why:** Satisfies “no four stages” and “no second planning SM” while matching the proven design-gate structural pattern for evidence and resume.

**Alternatives:** Pure check inside planning without a stage — rejected (harder resume/evidence symmetry with design-gate). Four named stages — rejected by issue non-goals.

### 3. Pre-code trigger evaluation (plan/dossier surface)

**Decision:** Export pure `evaluatePreCodeAttestationTrigger(inputs) → { triggered, matched[], reason }` with no network/git/subprocess. Inputs:

- Issue labels
- Issue title/body risk markers only when mapped by **repository-owned deterministic rules** (not free-form LLM classification as sole authority)
- Plan/dossier declared affected paths, components, risk classes, and size estimates
- Configured built-in classes + `extra_triggers` + thresholds

Built-in risk classes (v1, aligned with design-gate vocabulary where useful): `architecture`, `auth`, `storage`, `migration`, `public-api`, `large-diff` (threshold-based), plus optional `dependency-major` when declared in plan. Each `TriggerMatch` names the class and concrete evidence (label, path glob, size threshold, dossier field).

When disabled → reason `gate-disabled`. When enabled with no match → `no-trigger-matched`. Result is always recorded.

**Why:** Issue requires evaluation **before code exists**; design-gate’s post-implement path set cannot be the sole trigger.

**Alternatives:** LLM-only risk judge — rejected as non-deterministic sole authority (MAY be advisory later, not v1 gate). Post-code only — rejected by issue.

### 4. Authorized approver resolution (provider-agnostic)

**Decision:** Approver rules are ordered, deterministic, and repository-owned. Each rule is one of:

| Rule kind | Meaning |
|---|---|
| `identity` | Exact authenticated login / subject id |
| `group_ref` | Opaque external group/team reference string (resolved by an injectable identity adapter) |
| `role` | Repository role token (e.g. `admin`, `maintainer`) resolved via injectable adapter |
| `path_owner` | Ownership over affected path/component using optional CODEOWNERS-like input **if present** — not required |
| `risk_class` | Scope filter: rule applies only when listed risk classes match |

Resolution algorithm:

1. Collect affected components/paths and matched risk classes from the dossier.
2. Evaluate rules in order; union authorized actors for coverage of **every** affected (component × risk class) obligation.
3. Attestation is valid only if the authenticated actor is authorized for **all** obligations under the effective policy revision.
4. Unresolved ownership (required coverage with no matching rule / empty resolution) → fail closed with evidence.

Identity source is the authenticated pipeline actor surface (`getGhActor` or injectable equivalent) plus attested external identity when the adapter supplies it. “Someone clicked approve” without authorization resolution is insufficient.

Adapters are injectable for unit tests; GitHub teams / CODEOWNERS are **optional inputs**, never hard requirements.

**Why:** Issue forbids hard-coding one provider while requiring deterministic authorization proof.

### 5. Separation of duties

**Decision:** When `separation_of_duties.enabled` is true, the engine refuses attestation if the authenticated actor’s attributed roles intersect `forbid_self_attest_roles` for this item (implementer identity from harness/run attribution; dossier author from dossier metadata). Conflicting multi-role satisfaction fails closed.

When SoD is disabled (default), self-attest is allowed if the actor is otherwise authorized — matching small-team repos.

### 6. Dossier and behavioral contracts

**Decision:** Schema-versioned dossier document (`schema_version: 1`) validated before the attestation wait:

- `intent` — user outcome; optional `ui_mockup` ref for UI work
- `system_boundary` and `interaction_sequence`
- `expected_delta` — call-stack and file-tree estimate
- `key_contracts` — types, interfaces, signatures
- `slices[]` — independently testable vertical slices, each with:
  - `objective_id` (stable) and `content_hash`
  - `behavior_diff` entries: `op: addition|change|removal`, target contract identity
  - `behaviors[]`: preconditions, command/input, expected state/output/event, ownership boundary, failure/retry/concurrency, `origin: stated|derived`, `verification: { kind, ref } | { kind: "untestable", reason }`
- Derived behaviors require `derived_disposition: accept|reject|pending` at attestation time; reject removes them from the approved set; pending blocks approval.

Verification refs prefer repository-native mechanisms (OpenSpec scenarios, tests, schemas, eval contracts). No universal EARS/Specter requirement.

`Untestable:` reasons require explicit human affirmation in the attestation record; downstream evidence marks `verification_status: unverified_exception` and MUST NOT report `test_proven`.

### 7. Attestation record and invalidation

**Decision:** An approved attestation record includes at least:

- `actor`, `identity_source`, `authorized_rules[]`, `resolution_evidence`
- `timestamp`, `expires_at` (from policy)
- `scope` (components, risk classes, objective IDs)
- `decision: approve|reject`
- `dossier_revision` / content hash
- `policy_revision` / effective policy hash
- Nested or linked `evidence_subject` dimensions where applicable (policy_hash includes attestation policy slice; dossier hash in scope or subject extension fields documented for v1)

Invalidation (return to gate; prior approval non-current) on material change to:

- Dossier content hash / revision
- Implementation scope or affected component/risk classification
- Ownership mapping used in resolution
- Identity authorization rules / effective policy hash
- Expiration elapsed without re-approval

Reject decisions fail closed and preserve evidence; they do not advance to implementing.

### 8. Escalation and wait dispositions (no new park classes)

**Decision:** Map gate outcomes to existing escalation vocabulary:

| Outcome | Disposition |
|---|---|
| Config parse error | Fail at resolve (run never starts) |
| Unauthorized / SoD / unresolved ownership / reject | Integrity fail-closed; typed reason; evidence preserved |
| Post-approval scope/policy/dossier mismatch | Invalidate; re-enter gate; fail-closed for implementing |
| Waiting for authorized human | `waiting` / human-input request (`authority-grant` or `decision`) via durable hold surfaces; inventory as deliberate wait, not a new park class |
| Attestor unavailable / wait budget exhausted | `wait.mode: resume_safe` (default): typed escalation that is default-resume-safe (bounded wait → operator-visible hold / advisory engine-owned outcome per #760; does **not** silently approve). `wait.mode: hard_block`: opt-in hard block. Never silent bypass. |
| Expiration of granted attestation | Invalidate; re-enter gate before implementing |

Every production `setBlocked` / needs-human / waiting emitter for this gate MUST have an `escalation-site-dispositions` inventory row. Integrity sites are `deliberately-fail-closed`. Wait sites are not open-ended auto-retry of approval.

**Why:** Operator comment (2026-07-31): high-risk attestation is legitimate; new unrecoverable block classes are the failure mode to avoid.

### 9. Contract-to-evidence traceability

**Decision:** After approval, each `objective_id` + content hash is a required trace row. Downstream implementation, review, test/eval, and shipcheck evidence SHOULD reference those IDs. Pre-merge / shipcheck composition fails safely when a triggered run’s approved contracts lack a final verification or explicit `unverified_exception` disposition. Missing rows fail closed for readiness of that triggered item.

### 10. Bypass resistance

**Decision:** No config key, comment phrase, or model prose can silently mark a triggered item approved. Only a verified attestation record that passes authorization + SoD + currency checks clears the gate. Pipeline-posted comments remain provenance (markers), not approval. Plan-review agent approve is never sufficient for a triggered pre-code gate.

### 11. Relationship to design-gate and plan-review

**Decision:**

- Plan-review remains agent review + optional human feedback; docs keep the authority vocabulary drift-guard.
- Pre-code attestation is a **distinct opt-in human control** for high-risk classes.
- Design-gate remains post-implement agent interrogation; it does not replace pre-code human judgment and is not removed by this change.
- Shared risk-class names may align for operator mental model, but trigger input surfaces differ (plan/dossier vs post-code paths).

### 12. Testing seams

**Decision:** Pure functions for trigger eval, dossier validation, approver resolution, SoD, invalidation, and trace completeness. Stage handler takes injectable `deps` (identity, ownership, clock, evidence store, gh actor). Unit tests perform no real network/git/subprocess.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Small teams blocked by SoD | SoD default off |
| Empty approver config with enabled=true | Fail closed at trigger time with clear config-error evidence |
| LLM-authored dossier invents scope | Derived markers + human accept/reject; invalidation on scope drift |
| New park class sprawl | Force inventory + resume_safe default for waits |
| Overlap confusion with design-gate | Docs + distinct stage/config names + authority vocabulary guard |
| Provider lock-in | Opaque group_ref + injectable adapters; CODEOWNERS optional |

## Migration Plan

1. Ship config schema + pure helpers + inert stage pass-through (no behavior when disabled).
2. Enable dossier validation + trigger recording in evidence without requiring human when disabled.
3. Full gate enforcement when `enabled: true` and triggered.
4. No migration of historical runs; legacy absence of attestation is `legacy_unbound` / inert for unconfigured repos.
5. Eval multi-change treatment variant remains optional when config absent.

## Open Questions

- Exact v1 built-in path glob tables for each risk class (implement from design-gate tables + plan-path projections; refine in tasks).
- Whether `group_ref` resolution ships with a GitHub-teams adapter in v1 or only the injectable seam + identity list rules (prefer seam + `identity` rules in v1 if teams adapter is large — document in tasks).
- Shared policy-schema extraction with #693: implement #575-local types first; extract shared module only if #693 lands concurrently and duplication becomes real.
)
