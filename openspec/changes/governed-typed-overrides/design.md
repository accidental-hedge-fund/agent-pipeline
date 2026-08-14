## Context

See `proposal.md` for motivation. Current override surface:

| Surface | Behavior today |
|---|---|
| CLI | `pipeline override N "<key\|scope>: <reason>"` (and deprecated `--override`) |
| Parse | Free-form reason → normalized disposition token `rejected` / `deferred` / `deferred-#N` |
| Trust | Comment author ∈ {current `getGhActor`, `trusted_override_actors`} |
| Sentinel | `pipeline-override` / `pipeline-override-scope` HTML comments |
| Validity | Last-wins per key/scope; no expiry; no class; no evidence subject currency gate |
| Record | `OverrideRecord { key, reason, kind?, evidence_subject? }` — subject binding from #692 exists; authority/expiry/class do not |

Landed patterns to **reuse, not fork**:

- **#575 / `pre-code-attestation`** — policy-bound approver resolution (`identity` / `group_ref` / `role` / path-owner style rules), SoD, expiry, invalidation events, strict config parse.
- **#692 / `evidence-subject`** — immutable readiness identity and mismatch → non-current.
- **#760 / `escalation-site-dispositions`** — closed site dispositions; integrity fail-closed; no new unrecoverable park classes.
- **#576 / outcome linkage** — downstream consumers of override outcome events (compose only).

Human comment (2026-07-31 audit): naïve expiry/renewal would convert one-time audited dispositions into **recurring mandatory human touches**. This design therefore requires **renewal-lite** (auto-renew while finding fingerprint + code region unchanged) and routes expiry through #760 rather than inventing a janitor park class.

## Goals / Non-Goals

**Goals:**

- Typed class taxonomy + per-class policy with parse-time fail-closed validation.
- Authenticated, policy-bound authority on record and on every use as unblock evidence.
- Append-only decision ledger with supersession and renewal lineage.
- Subject-bound currency: candidate / policy / ownership / component / verifier drift invalidates.
- Renewal-lite default path; human renewal only on drift or when class policy forbids auto-renew.
- Explicit compatibility mapping for existing free-form low-risk dispositions.
- Machine-readable lifecycle states and analytics-friendly events.

**Non-Goals:**

- Warrant UI / dashboard / org admin of groups (consume Pipeline facts only).
- Auto-approving remediation or inventing human authority from Warrant.
- Replacing non-reproducing machine dispositions or `human-decision-required` evidence comments.
- Changing merge authority or advance-never-merges.
- Forcing every historical free-form override to re-fire as high-risk authority.

## Decisions

### 1. Config block: `override_governance`

**Decision:** Optional strict block under `.github/pipeline.yml`:

```yaml
override_governance:
  schema_version: 1
  # When block omitted: compatibility mode (see decision 7)
  classes:
    low_risk_deferred:
      max_duration_hours: 720          # 30d default ceiling
      required_evidence: []            # none beyond key/scope + non-empty explanation
      renewal:
        mode: lite                     # lite | human | none
        require_human_on: [fingerprint_drift, region_drift, subject_mismatch]
      approvers:
        - kind: identity               # same family as #575 rules
          # OR trusted_override_actors_allowlist: true
      separation_of_duties:
        enabled: false
    high_risk_accept:
      max_duration_hours: 72
      required_evidence: [remediation_issue_url, risk_acceptance_ref]
      renewal:
        mode: human
        require_human_on: [fingerprint_drift, region_drift, subject_mismatch, policy_change]
      approvers:
        - kind: role
          roles: [risk_authority]
      separation_of_duties:
        enabled: true
        forbid_roles: [implementer, finding_author]
  # Optional default class for bare free-form reasons under migration
  default_class: low_risk_deferred
  # Closed set of known class ids; unknown class id at parse or CLI → error
```

Unknown keys and unknown class ids fail parse. Per-class `max_duration_hours` ≥ 1. `renewal.mode` closed: `lite` | `human` | `none`.

**Why:** Mirrors #575 strict opt-in schema; keeps taxonomy repository-owned.

**Alternatives:** Hard-code classes in engine only — rejected (repos need different risk bars). Free-form class strings without config — rejected (no policy attachment).

### 2. Versioned override decision record (append-only)

**Decision:** Each successful override attempt appends a **decision record** (comment sentinel + run-store / evidence-bundle entry). Records are never mutated in place.

Minimum fields (schema_version 1):

| Field | Notes |
|---|---|
| `decision_id` | Stable unique id within domain+issue (or global run) |
| `class` | Taxonomy id |
| `disposition` | `rejected` / `deferred` / `deferred-#N` (existing tokens) |
| `target` | key or scope (type+value) |
| `explanation` | Bounded free text (existing reason, length-capped) |
| `actor` | Authenticated identity |
| `identity_source` | How actor was authenticated (e.g. gh actor) |
| `authorization` | Rule matched + resolution evidence |
| `evidence_refs` | Class-required links/refs |
| `remediation_refs` | Optional/required by class |
| `evidence_subject` | Engine-built #692 subject at record time |
| `finding_fingerprint` | Payload fingerprint at record time (key path) |
| `code_region` | Normalized file + line band (or scope value) |
| `created_at` | ISO time |
| `expires_at` | `created_at + class.max_duration` (or explicit shorter) |
| `lifecycle` | `active` \| `expired` \| `superseded` \| `renewed` \| `rejected` \| `invalidated` |
| `supersedes` / `renewed_from` | Prior `decision_id` or null |
| `invalidation_reason` | Closed set when invalidated |

Supersession: a new decision for the same target marks prior active as `superseded` via a new event; prior body remains. Renewal: new decision with `renewed_from`; prior keeps original `expires_at`.

**Why:** Issue requires append-only history and lineage; last-wins active view is a projection over the ledger.

**Alternatives:** Mutate expiry on old record — rejected by issue. In-memory only — rejected (no audit/resume).

### 3. Sentinel / CLI evolution (compatibility-first)

**Decision:**

- Keep posting audited comments with heading + machine sentinel.
- Extend sentinel (or adjacent structured line) to carry `class`, `decision_id`, `expires_at`, and fingerprint/region digests required for renewal-lite — without breaking extractors that still need key/scope.
- CLI accepts optional class: `"<key>: <class>: <explanation>"` or flag/form documented in tasks; bare `"<key>: <reason>"` maps through **default_class** under compatibility rules (decision 7).
- Extractors build an **active projection**: for each target, the latest decision that is still `active` under validity evaluation.

**Why:** Existing comments and operator muscle memory stay usable; migration is progressive.

**Alternatives:** Break CLI to require class always — deferred; default_class covers low-risk.

### 4. Validity evaluation is pure and fail-closed

**Decision:** Export pure `evaluateOverrideValidity(decision, pin, finding_or_scope_context, policy, now) → { status, reason }` used by:

1. Record path (reject unauthorized / missing evidence before post)
2. `partitionFindings` / unblock path (only `active` + current excludes from blocking)
3. Auto-resume path (resume does not promote invalid decisions)

Status closed set: `active` | `expired` | `superseded` | `renewed` | `rejected` | `invalidated` | `unauthorized` | `malformed` | `scope_mismatch`.

Only `active` unblocks. Subject mismatch → `invalidated`. Wall-clock past `expires_at` without successful renewal-lite or human renewal → `expired`.

**Why:** Deterministic gate; unit-testable without network.

### 5. Renewal-lite vs human renewal

**Decision:**

| Mode | Behavior at/near expiry or re-evaluation |
|---|---|
| `lite` | If `finding_fingerprint` and `code_region` still match the live finding/scope **and** evidence subject currency matches on governed dimensions, engine appends an auto-renew decision (new id, `renewed_from`, new `expires_at`, same class/actor lineage marked `renewal: lite`). No new human click. On any configured drift, do **not** auto-renew; emit typed escalation and finding becomes blocking again until human renewal. |
| `human` | Never auto-renew; expiry requires authorized human with class evidence rules. |
| `none` | No renewal; after expiry always expired until a **new** superseding decision (not a renewal link) is recorded. |

Auto-renew **SHALL NOT** invent a new authorized actor: it inherits authorization evidence from the prior decision and re-checks subject currency only. If policy or approver rules changed such that the prior actor would no longer authorize, auto-renew SHALL fail and require human.

**Why:** Satisfies factory minimal-escalation goal from the 2026-07-31 audit without dropping enterprise expiry.

### 6. Authority resolution reuses #575 patterns

**Decision:** Reuse the same rule kinds and authenticated identity source patterns as pre-code attestation approvers, plus explicit `trusted_override_actors` allowlist as a first-class rule kind for continuity with today’s multi-actor setups. SoD: when enabled for a class, forbid listed roles (e.g. implementer as sole overridder). Unidentified actor (`getGhActor` null) → fail closed (no post, no unblock).

**Why:** Issue names #575 for authority/expiry/SoD reuse; avoid a second policy language.

### 7. Compatibility / migration for free-form low-risk dispositions

**Decision:**

- When `override_governance` is **omitted**, engine treats dispositions under an implicit built-in `low_risk_deferred` class with: approvers = current actor + `trusted_override_actors`; `renewal.mode = lite`; generous default max duration (documented); no extra required evidence — behavior preserves today’s ability to disposition with a non-empty reason, **plus** subject binding and renewal-lite so currency still holds.
- When the block is **present**, bare free-form reasons map to `default_class` if set and valid; otherwise CLI must name a class. Unknown class → parse/CLI error.
- Historical sentinels without class/decision_id: extractors classify as `legacy_compat` under the default/implicit low-risk class; they remain active only while key/scope still matches **and** subject rules for legacy records apply (`legacy_unbound` subject → transitional rule: still honor until first subject-bound re-record OR candidate change, documented — prefer fail-soft for key match only when subject absent, but never treat as high-risk authority).

**Why:** Acceptance criterion requires explicit migration; must not force mass re-override on deploy.

### 8. Escalation sites (#760)

**Decision:** Inventory new/changed sites:

| Site | Disposition |
|---|---|
| Unauthorized / SoD / malformed / missing required evidence at record | `deliberately-fail-closed` |
| Expired / invalidated at partition (integrity of unblock) | `deliberately-fail-closed` for treating as active; escalation for operator visibility is typed reason, resume-safe hold (finding blocks again) |
| Renewal-lite success | not an escalation |
| Renewal-lite blocked by drift | typed escalate; default-resume-safe (needs human renewal or fix) — not a new park class |

No new unrecoverable park classes. Expiry does not invent `needs-human` product judgment by itself; it returns the finding to the ordinary blocking set and may emit a typed engine-visible reason for status/handoff surfaces.

### 9. Events and evidence bundle

**Decision:** Emit machine-readable events for: `override_recorded`, `override_rejected`, `override_superseded`, `override_renewed_lite`, `override_renewed_human`, `override_expired`, `override_invalidated`, with fields: class, actor, target, decision_id, lineage, subject digest, ages, and outcome hooks for #576 consumers. Evidence bundle lists override decisions with lifecycle projection for the run.

### 10. Module layout

**Decision:** Prefer a dedicated pure module (e.g. `override-governance.ts`) for taxonomy validation, validity evaluation, renewal-lite, and lineage projection; keep comment I/O and CLI wiring in `review-policy.ts` / `pipeline.ts`. Tests inject time, identity, and subject pin.

**Why:** Keeps partition path thin and pure-testable; matches engine style.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Expiry creates human thrash | Renewal-lite default for low-risk; human only on drift / high-risk classes |
| Sentinel format break | Extend with backward-compatible extract; dual-read old + new |
| Two authority languages (#575 vs overrides) | Shared rule kinds and identity source; document one conceptual approver model |
| Legacy overrides silently over-trusted | Implicit class is low-risk only; high-risk classes require explicit config + evidence |
| Clock skew on expiry | Use injectable `now`; document host clock dependence; no distributed consensus claim |
| Scope overrides + fingerprint | Scope path uses scope value + matched finding set hash or per-finding region checks; design tasks nail exact fingerprint for multi-finding scopes |

## Migration Plan

1. Land schema + pure evaluators + tests (no behavior change if projection still last-wins without expiry enforcement until wired — prefer **wire validity in the same change** so “done” means fail-closed, with implicit class preserving low-risk UX).
2. Dual-read legacy sentinels under compatibility class.
3. Emit new events; document CLI class syntax and config examples.
4. Rollback: omit config block and dual-read keeps old sentinels; if a hard bug ships, feature flag not required if implicit class path is correct — validity bugs fixed via normal fix loop.

## Open Questions

None that block specs. Implementation may choose exact CLI delimiter for class without changing requirements, as long as bare free-form mapping and unknown-class fail-closed remain true.
