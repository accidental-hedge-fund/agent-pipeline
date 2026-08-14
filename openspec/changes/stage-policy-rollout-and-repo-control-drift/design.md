## Context

See proposal.md for motivation (#695). Today:

| Surface | Behavior |
|---|---|
| `review_policy` | Advisory vs blocking findings; no staged rollout |
| Config validation | Schema reject unknown keys / bad values |
| Merge check readers | Live required/observable checks via `gh pr checks` for merge eligibility |
| Branch protection | Surface as merge BLOCKED / protection errors; no desired-state compare |
| Evidence subject (#692) | `policy_hash` invalidates policy-bound readiness; no policy lifecycle object |
| Doctor | Static preflight; no repository-control desired-vs-live report |
| #648 ForgeAdapter | Related capability/degradation contract; **not a hard dep** for this issue |

Human triage (2026-08-13): implement forge-control drift via **existing `gh` surfaces**; do **not** invent a second ForgeAdapter; do **not** add `Depends on: #648`.

Human deferred note (2026-07-31): automatic remediation is a non-goal, so some drift necessarily parks for humans. This design classifies drift into observation-only vs fail-closed enforcement and routes through typed escalation inventory — it does **not** implement remediator recipes.

## Goals / Non-Goals

**Goals:**

- Closed policy lifecycle states with pure transition/promotion predicates.
- Append-only lineage for promote/retire; no silent jump to `enforcing`.
- Desired-state snapshot + live compare with closed outcome enum and freshness.
- Explicit fail-open / fail-closed by control risk class.
- Evidence-bundle fields + subject `policy_hash` composition.
- Read-only operator check surface.
- Injectable I/O seams for unit tests (no real network/git/subprocess).

**Non-Goals:**

- Mutating GitHub branch protection, rulesets, or required checks.
- Warrant Policies UI or collector product.
- New ForgeAdapter interface (#648 stays related, optional later mapping).
- Unattended merge or `auto_merge`.
- Auto-recreate labels / re-pin rulesets as recovery recipes (future #760-class work).
- Replacing forge-native enforcement.

## Decisions

### 1. Two capabilities, one product boundary

**Decision:** Ship `stage-policy-lifecycle` (generic staged policy object) and `repository-control-drift` (desired/live control compare) as separate specs that share evidence and subject hooks.

**Why:** Lifecycle applies beyond forge controls (future review-policy rollouts can reuse it). Drift is a concrete control family with `gh` reads.

**Alternatives:** One mega-capability — rejected (harder to archive/reuse). Forge-only lifecycle — rejected (issue asks for generic staged policy).

### 2. Policy state machine

**Decision:** Closed states: `draft` → `observe` → `required` → `enforcing`, with `retired` reachable from any non-retired state under authority rules.

Legal transitions (v1):

| From | To | Extra predicate |
|---|---|---|
| `draft` | `observe` | identity valid; no observation evidence required |
| `observe` | `required` | min observation coverage met (config defaults documented) |
| `required` | `enforcing` | observation coverage + false-positive/override rate within bounds + unresolved-evidence bound + named authority record |
| any active | `retired` | named authority record |
| other edges | — | **rejected** (including any transition into `enforcing` that skips lineage) |

Promotion and retirement each append a lineage record: `{ policy_id, from_state, to_state, policy_hash_before, policy_hash_after, at, authority, evidence_refs[] }`. Lineage is append-only; consumers MUST NOT rewrite history.

**Why:** Matches issue states; makes “enforcing without lineage” impossible by construction.

**Alternatives:** Free-form strings — rejected (not typed). Auto-promote on timer alone — rejected (no authority).

### 3. Observation evidence for promotion

**Decision:** Promotion predicates are pure over injectable aggregates:

- `observation_run_count` / coverage window
- `false_positive_or_override_rate`
- `unresolved_evidence_count`
- `authority` (authenticated actor + role/capability, reusing #575-style identity when authority-bearing)

Defaults live in code constants and may be overridden by validated config. Missing aggregates fail closed for promotion (cannot promote), not open.

**Why:** Deterministic; unit-testable without live fleet data.

### 4. Desired-state snapshot (schema_version 1)

**Decision:** Versioned object `repository_control_desired_state` with at least:

- `schema_version: 1`
- `repository` (owner/name or domain string)
- `default_branch` (or protected branch name in scope)
- `required_checks: string[]` (context names expected required)
- `branch_protections` — subset expressible via current `gh`/API reads (e.g. required reviews count, dismiss stale, require conversation resolution, allow force push flags **when readable**)
- `rulesets` — identifiers/names + expected enforcement level when ruleset read is available; otherwise mark control `unsupported`/`unavailable` rather than invent fields
- `required_pipeline_gates` — Agent Pipeline evidence/gate identifiers that must be present for readiness composition
- `collector_requirements` — optional collector/version constraints when configured
- `policy_id` / binding to lifecycle object when staged
- `risk_class` per control or per snapshot section: `observation` | `fail_open` | `fail_closed`

Sources: repository config (`.github/pipeline.yml` block or referenced file). Config parse rejects unknown risk classes and malformed lists.

**Why:** Matches acceptance criteria; keeps snapshot owned by the pipeline, not by live forge defaults.

### 5. Live reads via existing `gh` surfaces only

**Decision:** Implement readers with injectable `gh` wrappers already used for PR checks / repo view. Prefer:

- Required / observable checks patterns already used by merge (`gh pr checks` and related)
- Branch protection / ruleset reads that `gh api` already supports when the token has permission

Do **not** introduce a `ForgeAdapter` type in this change. When a control kind cannot be read on the current path, emit `unsupported` or `unavailable` with reason code.

**Why:** Human triage forbids a second adapter and forbids stalling on #648.

**Alternatives:** Wait for #648 — rejected (would stall train). Silent skip — rejected (must not look like `in_sync`).

### 6. Compare outcomes and freshness

**Decision:** Closed outcome enum:

| Outcome | Meaning |
|---|---|
| `in_sync` | Live matches desired within documented equality rules; live snapshot is fresh |
| `drifted` | Live well-formed and differs on one or more fields |
| `unknown` | Compare cannot decide (partial payload, ambiguous mapping) |
| `unsupported` | Control kind not readable on this engine path / forge capability absent |
| `unavailable` | Auth, permission, network, or rate-limit prevented a live read |

Freshness: each live snapshot carries `fetched_at` (ISO 8601). A result older than the configured max age (default constant) MUST NOT be reported as `in_sync`; re-fetch or emit `unavailable`/`unknown` with `stale: true`.

Field-level diffs: `{ path, desired, live }` arrays on `drifted` (and empty otherwise).

**Why:** Stale and permission failures stay distinct from green.

### 7. Fail-open / fail-closed by risk class

**Decision:**

| Risk class | On `drifted` / `unavailable` / `unknown` for enforcing policy | On `observe`/`required` lifecycle states |
|---|---|---|
| `observation` | Record only; never block readiness | Record only |
| `fail_open` | Record + advisory diagnostic; readiness may proceed | Record only |
| `fail_closed` | Block readiness / park with typed reason when policy state is `enforcing` (and `required` when configured to gate entry) | Record only unless config explicitly gates that state |

`draft` never gates. Lifecycle state and risk class are **both** required to decide blocking.

**Why:** Matches issue and avoids mandatory human touch for pure observation drift.

### 8. Evidence and subject integration

**Decision:**

- Run evidence records `policies[]` (id, state, policy_hash, lineage_head) and `repository_control_drift[]` (or a single composite report) at finalize / check-command output.
- Each drift report binds `evidence_subject` when a candidate run exists; standalone doctor/check without a candidate MAY emit subject fields that are null for candidate/diff with explicit `standalone_check: true` and MUST NOT claim readiness pass.
- Promotion/retirement that changes effective acceptance MUST recompute `policy_hash` inputs so prior policy-bound readiness becomes non-current under existing #692 rules.

### 9. Read-only check surface

**Decision:** Add a CLI surface such as `pipeline controls check` (exact keyword fixed at implementation; registry entry required) and/or a doctor static check that runs the same pure compare when desired state is configured. `mutatesGitHub: false`. Exit non-zero only for fail-closed enforcing drift (or always non-zero on any `drifted` when `--strict` is passed — optional flag).

**Why:** Operators need a non-run path; doctor already is the static preflight home for some hosts.

### 10. Escalation inventory, no remediation

**Decision:** Register new escalation sites for fail-closed enforcing drift parks with disposition `deliberately-fail-closed` (no auto-retry that mutates forge). Observation-only emission is not an escalation site. Comment note about auto-remediable vs human classes is captured as **typed reason codes** only:

- `drift_required_checks`
- `drift_branch_protection`
- `drift_ruleset`
- `drift_pipeline_gates`
- `drift_collector`
- `drift_live_unavailable`
- `drift_unsupported`

Remediation remains human/Warrant later. No `git`/API write path for controls.

### 11. Engine dogfood class-over-site

**Decision:** Shared classifier/outcome enum and pure compare live in core helpers. Path-local mole fixes that only special-case one stage are insufficient for this class — tests must lock the shared law.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Token lacks admin read for protection/rulesets → many `unavailable` | Explicit outcome + remediation text (“needs admin:read”); fail-open vs fail-closed by class |
| `gh` field shape drift | Verify shapes with real `gh` before coding; inject fixtures in tests |
| Observation metrics hard to gather early | Config defaults + injectable aggregates; cannot promote without them |
| Over-blocking on first rollout | Default new controls to `observe` + `observation` risk class |
| Confusion with #648 ForgeAdapter | Spec language forbids inventing adapter; `unsupported` maps later if adapter lands |
| Human-comment desire for auto-remediable classes without remediator | Reason codes only in v1; remediator deferred |

## Migration Plan

1. Ship pure lifecycle + compare modules and tests (no gate behavior).
2. Config schema + parse for desired-state and staged policies (opt-in).
3. Wire evidence recording and read-only CLI/doctor check.
4. Wire fail-closed enforcing drift into readiness/pre-merge or finalize gate only when configured.
5. Default: absent config → no drift gate (backward compatible).
6. Rollback: remove config block; readers unused; no forge state changed by this feature.

## Open Questions

None that block specs. Exact CLI keyword (`controls` vs `doctor` sub-check), default observation thresholds, and the precise `gh api` endpoints for rulesets may be fixed at implementation time as long as outcomes, non-mutation, and fail-open/fail-closed law hold.
