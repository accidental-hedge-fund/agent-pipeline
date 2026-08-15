## Context

Planning already produces OpenSpec or freeform plans, optional plan-review, and assumption statements. #702 emits versioned planning-leverage telemetry (`planning_depth` ∈ `minimal|standard|deep|unknown`, `risk_class` from pre-code vocabulary + `unknown`), assumption lineage with stable ids, and material-rework classifications. #576 records production/rework outcomes with observed vs inferred attribution. Stage-policy-lifecycle already defines `draft|observe|required|enforcing|retired` with validated promotion lineage.

What is missing is an **evidence-backed policy** for when planning should stay light, deepen, zoom, park assumptions for review, or require human authority — evaluated **offline** before any automated selection of `planning_depth` in the advance path.

See proposal.md for motivation and acceptance criteria.

## Goals / Non-Goals

**Goals:**

- Closed candidate work/risk classes grounded in observable or declared evidence.
- Closed routing-action vocabulary and escalation rules with safe defaults under uncertainty.
- Offline evaluation design that reuses #702/#576 joins without inventing causation.
- Explicit human-authority boundaries separate from agent plan-review.
- Staged-policy placement so automation cannot jump to `enforcing` without evidence lineage.
- Research note + specs that a later implementation issue can execute without re-litigating scope.

**Non-Goals:**

- Enabling automated planning-depth routing in this change.
- One opaque numeric risk score for all repositories.
- Equating longer planning wall time or longer plans with better outcomes.
- Changing merge authority, advance→R2D stop, or review rigor defaults.
- Replacing `stage_accounting`, #702 emitters, or #576 outcome stores.

## Decisions

### D1 — Research package is the primary deliverable; automation stays off

**Decision:** Implementation of #703 produces durable research artifacts (note + offline eval design + specs) and, only if useful, pure offline analysis helpers. The advance/planning stage continues to use existing depth selection (config / explicit / unknown). Progressive-planning **automation** remains a future staged policy, default non-enforcing.

**Rationale:** Issue non-goals forbid implementing automated routing now; measurement-first sequencing is the point.

**Alternatives:** Ship a shadow router that writes recommendations but never applies them — deferred until offline eval harness exists and evidence windows are defined; may appear in a follow-up after the research note lands.

### D2 — Work/risk classes are multi-label evidence classes, not a single score

**Decision:** Classes are a closed, versioned vocabulary of **evidence dimensions**, not a single ordinal risk score. Candidate classes (research note may refine names; specs pin the contract):

| Class | Typical evidence (observable or declared) |
| --- | --- |
| `ambiguity` | Conflicting issue/AC statements; missing acceptance criteria; open_question count high at plan end |
| `reversibility` | Destructive ops, data migration, irreversible config, force-push / shared-state mutations in scope |
| `blast_radius` | Cross-package/path-prefix growth; public API/schema; multi-repo; infra/deploy surface |
| `novelty` | No in-repo pattern match; new subsystem; first use of external integration |
| `dependency_uncertainty` | Unresolved external deps; blocked-on open issues; declared `Depends on` without closed targets |
| `security_compliance` | Auth, secrets, PII, regulated data, permission model, attestation triggers (`auth`, etc.) |
| `observed_rework_cost` | Historical material rework / production follow-up rates for similar depth×risk cohorts (from #702/#576) |
| `unknown` | Insufficient evidence after declared sources checked |

A run may carry **multiple** classes (same pattern as `risk_classes[]` on planning-leverage). Routing uses the **most restrictive** applicable action among matched classes (see D4), not an average score.

**Rationale:** Issue forbids one opaque risk score; multi-label matches pre-code multi-trigger practice.

**Alternatives:** Single expected-pain float — rejected. Free-text risk prose only — rejected (not evaluable offline).

### D3 — Signals are evidence sources with authority, not model intuition alone

**Decision:** Each class lists allowed **signal sources**:

1. **Declared** — issue labels, body markers, OpenSpec design decisions, operator annotations, pre-code risk_classes.
2. **Observed structural** — path globs, diff size thresholds, design-gate trigger matches, declared dependency grammar.
3. **Observed historical** — planning-leverage + material-rework + production_outcome joins with `authority: observed` preferred; inferred joins labeled and down-weighted in eval.
4. **Missing** — explicit `unknown` / conflict markers; never invent signal values.

LLM free-text “this feels risky” is **not** a standalone class assignment for automation design. It MAY appear as an advisory note under research only.

**Rationale:** Policy must be offline-evaluable and auditable.

### D4 — Closed routing actions and most-restrictive composition

**Decision:** Routing action vocabulary (closed):

| Action | Meaning |
| --- | --- |
| `lightweight_plan` | Minimal planning depth; short AC + approach; no extra feasibility zoom |
| `standard_plan` | Current default planning treatment |
| `deepen_product` | Extra product/AC alignment before technical design |
| `deepen_technical` | Extra technical design (interfaces, data model, failure modes) |
| `zoom_feasibility` | Explicit feasibility / spike / interface contract section |
| `zoom_vertical_slice` | Plan a thin vertical delivery slice first |
| `preserve_assumptions` | Force open/deferred assumptions into carry-forward review surfaces |
| `request_human_authority` | Park or hard-gate until human authority (not agent plan-review) |

Composition: when multiple classes match, select the **maximum severity action** on a fixed partial order:

`lightweight_plan` < `standard_plan` < `deepen_product` ≈ `deepen_technical` < `zoom_*` < `preserve_assumptions` (can stack) < `request_human_authority`.

`preserve_assumptions` **stacks** with any depth action (does not replace deepen). `request_human_authority` always wins when its class criteria fire.

Selected action(s) map to recommended `planning_depth` (`minimal` / `standard` / `deep`) for **evaluation and future policy only** — not applied automatically in this change.

**Rationale:** Gives falsifiable routing without a continuous score.

### D5 — Safe defaults under missing or conflicting evidence

**Decision:**

| Evidence state | Default |
| --- | --- |
| No signals matched | `standard_plan` + `preserve_assumptions` if any open questions exist, else `standard_plan` |
| Conflicting signals (e.g. “low risk” label vs `auth` path globs) | Prefer the **more restrictive** action; record conflict diagnostic |
| Historical rework data unavailable | Do not invent rates; use structural/declared signals only; label `observed_rework_cost` as unavailable |
| Irreversible / security / compliance class matched with any missing sub-signal | `request_human_authority` or at least `deepen_technical` + `preserve_assumptions` (research note pins which class → which floor) |
| Lightweight recommended but open assumptions remain | MUST attach `preserve_assumptions` |

**Rationale:** Fail closed for high-blast and security; fail standard (not minimal) when unknown.

### D6 — Assumption lineage is mandatory carry-forward under progressive depth

**Decision:** Progressive routing never deletes open/deferred assumptions. Lightweight paths still emit and carry `assumption_lineage` records. Review and implementation phases remain consumers of open items. Escalation to human authority includes the open-assumption set in the handoff surface.

**Rationale:** Issue acceptance criterion; reuses #702 lineage rather than inventing parallel storage.

### D7 — Offline evaluation design (pre-automation)

**Decision:** Evaluation is **batch/offline** over host-local run stores + outcome stores. Dimensions (primary outcomes — not proxies):

1. First-pass acceptance (plan-review approve / implement without replan; define operationally in research note)
2. Review effort (blocking/advisory findings, re-review count)
3. Fix rounds
4. Material rework rate (`materiality: material` criteria)
5. Post-merge production outcomes (`follow_up_rework`, incidents, reverts) via #576 joins

**Comparisons:**

- Cohort by selected `planning_depth` × primary `risk_class` / multi-class sets
- Counterfactual framing is **associational** until an observe-mode policy exists: report conditional rates with sample size and confidence bands; **do not** claim “deeper planning caused lower rework” without experimental design
- **False positive (over-planning):** deep/zoom/human gate where outcomes would have been ordinary under lighter depth (cost of delay/effort)
- **False negative (under-planning):** lightweight/standard where material rework or production follow-up followed, or human authority was later required

**Banned success proxies (alone):** plan file byte length, planning wall-clock alone, token spend, number of plan sections, presence of long prose.

**Calibration loop:** hold-out by time window; report FP/FN; revise class thresholds and action floors; re-run offline; only then consider staged-policy `observe` (recommendations logged, depth not auto-applied).

### D8 — Human-authority boundaries are closed and distinct from plan-review

**Decision:** Human authority is required (policy floor) when any of:

1. **Irreversible** production/data/shared-state mutation without an automated rollback path
2. **High blast radius** multi-tenant or cross-system schema/API breaks
3. **Security-sensitive** authZ/authN, secret handling, privilege elevation
4. **Compliance-sensitive** regulated data processing or audit-required changes

Agent plan-review, same-harness plan-review fallback, and the optional human feedback window are **not** human authority (per `plan-review-authority-boundary`).

### D9 — Staged policy lifecycle for any future automation

**Decision:** Name the future policy id (e.g. `progressive_planning_depth`) under stage-policy-lifecycle. This research change may document the id and required evidence-sufficiency checklist. It SHALL NOT add a config key that sets the policy to `enforcing`. Minimum path to automation later: `draft` (this research) → `observe` (log recommended action; keep selected depth as today) → `required` / `enforcing` only after validated lineage with non-empty `evidence_refs` from offline eval windows.

### D10 — Artifact locations

**Decision:**

| Artifact | Path (implementation) |
| --- | --- |
| Research note | `docs/research/risk-calibrated-progressive-planning.md` (or `docs/risk-calibrated-progressive-planning.md` if research/ dir absent) |
| Offline evaluation design | section of the research note **or** sibling `docs/research/progressive-planning-offline-eval.md` |
| Specs | this OpenSpec change |
| Optional pure helpers | `core/scripts/progressive-planning/` only if offline fixtures need them |

Link from `docs/concepts.md` when the research note lands.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Research overfits one dogfood repo | Require multi-window sample-size floors; mark external-repo transfer as out of scope until fleet data exists |
| Class vocabulary drifts from pre-code risk_classes | Prefer reuse/extension of existing closed sets; document mapping table |
| Offline eval confuses association with causation | Specs ban causal claims; require observe-mode before enforcing |
| Operators treat research defaults as live routing | Explicit “automation off” in docs + stage-policy non-enforcing |
| Proxy metric capture (plan longer → looks better) | Banned proxy list + primary outcome list in eval design |
| Under-specified human authority vs plan-review | D8 + scenarios distinguishing the two |

## Migration Plan

1. Land OpenSpec change (this planning step) and research artifacts under `docs/`.
2. Optionally add pure offline analysis helpers + fixture tests (no advance behavior change).
3. Run offline evaluation when #702/#576 data volume meets the evidence-sufficiency checklist; record results as `evidence_refs` for a future policy promotion issue.
4. Separate future issue for `observe`-mode recommendation logging; separate issue for any `enforcing` routing.
5. Rollback: delete or archive research docs; no runtime flag to unset if none was set.

## Open Questions

- Exact numeric sample-size floors for evidence sufficiency (per class) — set in research note after first scoreboard inventory of #702 data, not in this design’s hard constants.
- Whether `deepen_product` and `deepen_technical` need distinct `planning_depth` enum values later, or both map to `deep` with a sub-action field — deferred; current #702 enum stays `minimal|standard|deep|unknown`.
