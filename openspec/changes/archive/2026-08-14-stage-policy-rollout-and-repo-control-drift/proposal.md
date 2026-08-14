## Why

Agent Pipeline can validate configuration and treat findings as advisory or blocking, but it has no generic staged policy lifecycle and no desired-state contract for repository controls (required checks, branch/ruleset protection, required pipeline evidence gates). A repo can therefore believe a control is enforced while live forge settings have drifted, or promote a policy straight from idea to blocker without observation evidence.

## What Changes

- Add a typed **policy lifecycle** with closed states: `draft`, `observe`, `required`, `enforcing`, `retired`.
- Record effective policy state and policy hash in machine-readable **run evidence**.
- Define **promotion and retirement** rules with deterministic evidence (observation coverage, false-positive/override rate, unresolved evidence, named authority) and append-only **policy lineage**.
- Promotion or retirement **invalidates affected readiness evidence** (via `policy_hash` / subject currency rules from #692).
- Define a versioned **repository-control desired-state** snapshot covering: required checks; branch/ruleset protections available through current `gh` read surfaces; required Agent Pipeline evidence/gates; collector/version requirements when configured.
- Compare desired state to live state on relevant runs and via an explicit **read-only check command/surface**.
- Emit structured drift outcomes: `in_sync`, `drifted`, `unknown`, `unsupported`, `unavailable`, with field-level differences, freshness, repository identity, policy identity, live snapshot, timestamp, and `evidence_subject` binding.
- Make **fail-open vs fail-closed** explicit per control/risk class; never treat stale/unavailable as `in_sync`.
- Classify drift for escalation routing (observation-only vs blocking classes) without automatic remediation.
- Implement forge-control reads via **existing `gh` surfaces** only. Do **not** invent a second ForgeAdapter here; do **not** hard-depend on #648 (related, not blocking).
- **Not changing:** automatic remediation of branch/ruleset drift; Warrant Policies UI; replacing forge-native enforcement; merge inside advance/loop; inventing `auto_merge`.

## Acceptance criteria

- [ ] Policy lifecycle states are a closed typed set (`draft` | `observe` | `required` | `enforcing` | `retired`) validated at parse/load; invalid states are rejected.
- [ ] Machine-readable run evidence records the effective policy state and policy hash for active policies in scope for the run.
- [ ] Promotion into `enforcing` is impossible without append-only lineage and the required observation/authority evidence; unit tests reject illegal promotions.
- [ ] Retirement creates a lineage event and invalidates readiness evidence that depended on the prior effective policy slice (`policy_hash` mismatch / non-current).
- [ ] Desired-state snapshot schema is versioned and covers required checks, branch/ruleset protections readable via `gh`, required Agent Pipeline evidence/gates, and configured collector/version requirements.
- [ ] Live comparison emits only the closed result set `in_sync` | `drifted` | `unknown` | `unsupported` | `unavailable`, with field-level diffs and freshness; stale and permission-denied reads are not reported as `in_sync`.
- [ ] Drift results carry repository identity, policy identity, live snapshot reference, timestamp, and `evidence_subject` (or explicit non-readiness disposition when no candidate exists for a standalone check).
- [ ] A read-only CLI/doctor (or equivalent) surface reports drift without mutating forge settings.
- [ ] Fail-open vs fail-closed behavior is documented and tested per control/risk class (observation-only policies do not block readiness; enforcing controls with fail-closed risk class block when drifted).
- [ ] Unsupported control kinds degrade with `unsupported` (capability missing on the read path), not silent pass.
- [ ] Unit tests cover: lifecycle transitions; rejected promotion; retirement + invalidation; required-check drift; branch/ruleset drift; missing permissions → `unavailable`/`unknown`; stale live state; unsupported control; no forge mutation on check. Tests use dependency seams only (no real network/git/subprocess).
- [ ] `npm run ci` green after implementation; if `core/` is edited, `plugin/` is regenerated in the same change.

## Capabilities

### New Capabilities

- `stage-policy-lifecycle`: Typed policy states, promotion/retirement evidence requirements, append-only lineage, effective-state + policy-hash recording in run evidence, and readiness invalidation on policy change.
- `repository-control-drift`: Versioned desired-state snapshot, live-state reads via existing `gh` surfaces, structured compare outcomes, freshness rules, fail-open/fail-closed by control class, read-only check surface, and escalation-class mapping without remediation.

### Modified Capabilities

- `evidence-bundle`: Record effective policy lifecycle state(s), policy hashes, and repository-control drift results (or references) in finalized machine-readable run evidence.
- `evidence-subject`: Confirm that policy promotion/retirement that changes the effective acceptance slice updates `policy_hash` and renders prior policy-bound readiness non-current (composes with existing invalidation matrix; no competing subject vocabulary).
- `command-registry`: Register the read-only repository-control / policy-drift check command (or doctor sub-check entry) with correct flag/mutation metadata (`mutatesGitHub: false`).
- `escalation-site-dispositions`: Add inventory entries for drift/policy-enforcement park sites with closed safety dispositions (fail-closed for enforcing fail-closed classes; observation-only sites do not invent auto-remediation).

## Impact

- **New modules (expected):** pure policy-lifecycle helpers (state machine, lineage, promotion predicates); desired-state + compare helpers; `gh`-backed live readers behind injectable deps.
- **Config:** optional desired-state / staged-policy declarations in `.github/pipeline.yml` (or a versioned sidecar referenced by config) — exact key names fixed in design; invalid values fail parse like other schema keys.
- **CLI / doctor:** read-only check surface; no forge writes.
- **Evidence:** `summary.json` / legacy `evidence.json` gain structured policy + drift sections.
- **Related issues (non-blocking deps):** #648 ForgeAdapter (do not invent adapter here; explicit `unsupported` when a control cannot be read); #662 shadow calibration (lifecycle `observe` feeds observation evidence; does not enable unattended merge); #575 policy-bound authority (promotion authority reuses authenticated-identity patterns where authority is required); #692 evidence-subject (identity + invalidation); #760 typed escalation (drift classes route through existing escalation inventory, not a new remediator).
- **Product boundary:** Agent Pipeline observes and emits authoritative policy/drift facts. Project Warrant may aggregate them later; Warrant UI and remediation orchestration are out of scope.
- **Out of scope:** automatic ruleset/branch-protection repair; label recreation as auto-remediation; second ForgeAdapter; merge-from-advance.
