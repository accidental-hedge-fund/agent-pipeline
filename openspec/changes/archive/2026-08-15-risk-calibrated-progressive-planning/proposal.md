## Why

The pipeline has a plan/review/revise loop and (via #702) planning-leverage, assumption-lineage, and material-rework telemetry, plus (#576) production/rework outcome linkage — but planning **depth** is still not calibrated to ambiguity, reversibility, blast radius, novelty, dependency uncertainty, security/compliance impact, or observed correction cost. Uniform planning wastes effort on low-risk work or under-specifies expensive, hard-to-reverse changes. Routing must be designed from measured outcomes, not a hand-authored opaque “risk score.”

## What Changes

- Author a **research note** that defines candidate **work/risk classes** using only observable signals or explicitly declared evidence (no invented universal pain score).
- Specify a **progressive-planning policy**: when to use lightweight plan, deepen product/technical planning, zoom into feasibility/interfaces/vertical slices, preserve unresolved assumptions for explicit review, or request **human authority** before implementation.
- Define **routing actions**, **escalation boundaries**, and **safe defaults** for missing or conflicting evidence (fail toward more planning or human gate — never toward silent under-planning of irreversible work).
- Specify how **assumption and open-question lineage** remains traceable through implementation and review under progressive depth choices (compose with existing `assumption-lineage` / #702 emitters).
- Define an **offline evaluation design** that compares planning investment against first-pass acceptance, review effort, fix rounds, material rework, and post-merge outcomes — using #702/#576 joins — before any automated depth routing is enabled.
- Require **calibration**, false-positive/false-negative analysis, and safeguards against optimizing proxy metrics (plan length, planning wall time, token spend as “quality”).
- Pin **human-authority boundaries** for irreversible, high-blast-radius, security-sensitive, and compliance-sensitive work (distinct from agent plan-review and optional human feedback window).
- Gate promotion of automated routing: **no enabling of automated planning-depth routing** until evidence sufficiency criteria from #702/#576 representative windows are met and recorded; default staged-policy state remains non-enforcing.
- **Not in scope for this change:** implementing automated planning-depth routing in the advance loop; a single opaque risk score for all repos/work types; treating longer planning time as inherently better; merge-in-advance or review-rigor demotion.

## Acceptance Criteria

- [ ] A research note artifact (under `docs/` or the change’s research package) defines candidate work/risk classes, each with observable or explicitly declared evidence sources and non-goals (what does **not** assign the class).
- [ ] The proposal/design/spec package names closed **routing actions** (at least: lightweight plan, deepen product/technical plan, feasibility/interface/vertical-slice zoom, preserve assumptions for review, request human authority) and maps class × evidence states to actions.
- [ ] Escalation boundaries and **safe defaults** for missing, stale, or conflicting evidence are explicit: irreversible / high-blast / security / compliance classes default to human authority or deep planning, not to lightweight plan.
- [ ] Assumptions and open questions remain lineage-traceable (`assumption_id`, status, introduced/resolved phase) under every routing action; progressive depth SHALL NOT drop open/deferred items solely because planning was light.
- [ ] An offline evaluation design document specifies joins from selected `planning_depth` / `risk_class` to first-pass acceptance, review effort, fix rounds, material rework (#702), and production/rework outcomes (#576), with observed vs inferred authority preserved.
- [ ] The evaluation design includes calibration procedure, false-positive (over-planning) and false-negative (under-planning) definitions, and explicit bans on treating plan length / planning wall time / token spend alone as success proxies.
- [ ] Human-authority boundaries are written as a closed checklist for irreversible, high-blast-radius, security-sensitive, and compliance-sensitive work, and are distinct from agent plan-review and the optional human feedback window.
- [ ] Specs state that automated planning-depth routing SHALL NOT be enabled (config/policy state remains non-enforcing / observe-or-draft only) until an evidence-sufficiency checklist for #702 and #576 windows is satisfied and recorded; this research change itself does not flip automation on.
- [ ] No single collapsed “risk score” or universal expected-pain field is introduced as the routing input.
- [ ] `openspec validate risk-calibrated-progressive-planning` passes; implementation of research artifacts later keeps `npm run ci` green and regenerates `plugin/` only if `core/` changes.

## Capabilities

### New Capabilities

- `risk-calibrated-progressive-planning`: Research-backed progressive-planning policy contract — work/risk classes from observable evidence, routing actions and escalation, safe defaults, offline evaluation and calibration, human-authority boundaries, evidence-sufficiency gate before automated depth routing, and explicit anti-score / anti-proxy safeguards.

### Modified Capabilities

- `assumption-lineage`: Require that progressive-planning routing and lightweight paths preserve open/deferred assumption lineage for later phases rather than dropping items when depth is reduced.
- `planning-leverage-telemetry`: Require offline evaluation consumers to join selected planning depth and risk class to correction and production outcomes without collapsing to a productivity/leverage score or claiming causality before calibration.
- `stage-policy-lifecycle`: Progressive-planning depth routing, if ever automated, SHALL be a staged policy subject to draft → observe → required → enforcing lineage and SHALL NOT be declared `enforcing` without validated evidence-sufficiency lineage.

## Impact

- **Research/docs (implementation of this change):** living research note + offline evaluation design under `docs/` (or equivalent research package); optional scoreboard/eval notes cross-links; no required CLI for automation.
- **Specs:** new `risk-calibrated-progressive-planning`; deltas on `assumption-lineage`, `planning-leverage-telemetry`, `stage-policy-lifecycle`.
- **Code (later, only if needed for pure helpers):** optional pure offline eval helpers or schema constants under `core/scripts/`; unit tests with fixtures; **no** advance-loop auto-routing of `planning_depth` in this issue.
- **Dependencies:** consumes #702 planning-leverage / assumption / material-rework telemetry and #576 outcome linkage as evidence sources; composes with plan-review authority vocabulary (agent plan review ≠ human authority).
- **Operators:** no forced config change; automation remains off by default; research outputs inform a future gated rollout.
- **Does not:** auto-select planning depth in advance/loop; invent a single risk score; weaken review rigor; grant merge authority; reverse papercut backlog policy.
