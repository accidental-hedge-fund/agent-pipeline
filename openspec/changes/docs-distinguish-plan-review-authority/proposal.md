## Why

Product documentation and a few code/comment surfaces currently blur two different
controls: (1) independent agent plan-review with an optional human feedback window,
and (2) affirmative human review / sign-off. The front-door README even calls
`plan-review` "the human sign-off before implementation starts," while the same
document later correctly describes opportunistic human comments during the reviewer
run — not a required approval gate. Overstating that boundary weakens the product's
trust story and confuses operators about who has authority at each stage.

This is a docs/terminology follow-up from the July 2026 assessment of maintainability
and agentic engineering controls (issue #574). Behavior of plan-review itself is
unchanged; the goal is consistent, falsifiable language about authority.

## What Changes

- Define a **closed vocabulary** for four distinct concepts used on operator surfaces:
  **independent agent plan review**, **human feedback window**, **human attestation**,
  and **human approval / sign-off**.
- **Audit and rewrite** product docs, host skills, CLI help/status prose, examples, and
  architecture language that imply plan-review is human approval when no affirmative
  human action is required.
- State clearly what happens when the **feedback window ends with no human input**
  (revision proceeds from independent agent review only; lack of human comments is not
  a block and is not treated as approval).
- Keep **human-attestation** (pipeline output markers, operator capability attestations)
  and **human-approval** (merge button, needs-human dispositions, future graduated
  autonomy checkpoints such as #23) named separately from plan-review.
- Add a **practical regression check** (forbidden-phrase / drift guard on the highest-
  traffic operator surfaces) so future docs do not re-collapse these concepts.
- Align misleading **inline comments** in engine code that call plan-review a
  "human-judgment checkpoint" or claim plan-review waiting means "a human must review
  the plan," without changing runtime stage edges or auto-loop eligibility policy.

No stage-machine edges, review schema, `review_policy`, merge path, or plan-review
runtime algorithm changes. Not **BREAKING**.

## Capabilities

### New Capabilities

- `plan-review-authority-boundary`: Normative terminology and operator-surface language
  rules that keep independent agent plan-review, human feedback windows, human
  attestation, and human approval distinct; feedback-window expiry semantics; and a
  docs drift-guard so plan-review is not re-described as human sign-off without an
  affirmative human action.

### Modified Capabilities

- `human-plan-feedback`: Clarify requirement-level wording so human comments during
  plan-review are optional feedback folded into revision, not affirmative approval or
  sign-off, and so empty feedback (window expired / no human input) remains a no-op
  that does not block and does not count as human approval.

## Acceptance criteria

- [ ] `README.md` Lifecycle (and any equivalent front-door band table) no longer
  describes `plan-review` as "human sign-off" or equivalent human-approval language;
  it describes independent agent plan review plus an optional human feedback window.
- [ ] Grep-equivalent audit of operator surfaces (`README.md`, `hosts/*/SKILL.md`,
  generated CLI/command help that documents plan-review, status prose) finds **no**
  claim that plan-review *is* human approval / human sign-off unless the surface is
  describing a control that actually requires an affirmative human action.
- [ ] Operator docs use the four named terms consistently: independent agent plan
  review, human feedback window, human attestation, human approval (or sign-off),
  without treating any two as synonyms.
- [ ] Docs explicitly state that when the human feedback window ends with **no** human
  comments, plan revision proceeds from independent agent review feedback only, does
  **not** block for missing human input, and does **not** record human approval.
- [ ] Human attestation surfaces (pipeline output attestation markers, loop/native-goal
  operator attestation) remain documented as attestation, not as plan-review sign-off.
- [ ] Human approval surfaces (merge at `ready-to-deploy`, `needs-human` dispositions,
  deferred graduated-autonomy checkpoints such as #23) remain documented as distinct
  from plan-review.
- [ ] Relevant examples (README configurable-steps plan-review section and any status
  / architecture examples touched in the audit) show the actual authority boundary:
  agent review is required evidence when `steps.plan_review` is on; human comments are
  optional steering; human merge remains the terminal human gate.
- [ ] A regression check covered by `npm run ci` fails if high-traffic operator copy
  reintroduces a forbidden phrase equating plan-review with human sign-off/approval
  (at minimum the README Lifecycle band text; extend to mirrored host packaging if
  practical).
- [ ] Engine comments that currently call plan-review a human-judgment checkpoint or
  "a human must review the plan" are corrected to match real authority (docs/comment
  only — auto-loop eligibility and stage behavior stay as today unless already wrong
  relative to shipped behavior, in which case comment-only still unless a separate
  bug is filed).

## Impact

- `README.md` — Lifecycle table and any related plan-review positioning copy.
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` (and regenerated `plugin/` mirror of
  Claude packaging if host skill text is edited) — architecture / stage language only
  as needed for consistent terms.
- CLI help / status prose that describe plan-review authority (e.g. `status-json`
  stage blurbs, pipeline-run auto-loop comments) — wording only.
- `core/scripts/pipeline-run.ts` (and matching tests' comments if any) — comment
  accuracy for plan-review vs human judgment.
- New or extended unit test under `core/test/` for the docs drift-guard.
- OpenSpec living specs: new `plan-review-authority-boundary`; delta on
  `human-plan-feedback`.
- Out of scope for this change: implementing deferred #23 approval checkpoints;
  changing plan-review harness invocation; SKILL.md stage-count / diagram SSOT
  completeness (pairs with #597 / stage-count work — may cross-link, not absorb).
