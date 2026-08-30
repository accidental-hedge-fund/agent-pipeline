## Context

See `proposal.md` for motivation.

`implementing.md` already says “keep changes minimal” and “reuse existing repo patterns.”
`planning.md` already has a “Research first” block that requires reading in-scope files.
Neither template gives a stop-at-first-rung order. Agents still invent a helper, a wrapper, or
a new dependency when a lower rung holds.

Ponytail (https://github.com/DietrichGebert/ponytail, MIT) is that ladder. It is a **prompt**,
not a host plugin. Pipeline stages are single-turn CLI invocations. Claude / Codex / OpenCode
lifecycle hooks will not reliably fire. Grok does not use them.

**Class vs site (engine-dogfood bar):**

| Question | Answer |
| --- | --- |
| Class | Implementer or planner invents a helper, wrapper, or new dependency when skip / in-repo reuse / stdlib / native platform / already-installed dependency / one line would do. |
| Site | Any implement or plan run whose prompt only says “reuse” without an order. |
| Shared law | Pipeline-owned `implementing.md` ladder plus planning one-liners. Not a host plugin, slash command, or path-local mole. |
| Next identical fault | The next implement or plan invocation loads the same templates. A new issue per invented helper is a mole. |

This is not a recovery-classifier / recipe / gate / controller change. Class-over-site here means
shared prompt templates, not a new stage.

## Goals / Non-Goals

**Goals:**

- Give implementers an ordered 7-rung ladder after they read the touched code.
- Give planners a one-liner so the plan or OpenSpec design does not invent a layer.
- Keep intensity always full for unattended stages.
- Drift-guard implementing and planning presence, and fix-round absence.

**Non-Goals:**

- A new pipeline stage or extra review-1 / review-2 round.
- Installing `@dietrichgebert/ponytail`, its host plugin, marketplace, or `/ponytail` commands.
- `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`.
- A config key for `off|lite|full|ultra`.
- Review tags (`yagni` / `stdlib` / `native` / `shrink`) — deferred; not this change.
- Copying the ladder into `fix.md` / `test_fix.md` / `visual_fix.md` / `eval_fix.md`.
- Ponytail “YAGNI applies to tests,” “ship the one-liner and challenge the rest,” or “code then ≤3 lines.”

## Decisions

### D1: Prompt text in pipeline-owned templates, not a vendored plugin

**Decision:** Adapt the 7-rung ladder into `core/scripts/prompts/*.md`. Do not add an npm
dependency. Do not install host hooks.

**Rationale:** Stages are single-turn CLI invokes. Host lifecycle hooks are not a reliable
delivery path. The product is the pipeline CLI plus short host SKILL, not a plugin marketplace.

**Alternatives:** Vendor `@dietrichgebert/ponytail` (rejected: extra dep and hook model). Add a
`/ponytail` slash command (rejected: unattended stages have no operator). Whole-repo
`ponytail-audit` (rejected: issue-scoped pipeline; closest existing is `improve` / `sweep`).

### D2: Full ladder in implementing; one-liner in both planning templates

**Decision:** Put the 7-rung ladder and the no-unrequested-abstractions rule in `implementing.md`,
after a read-the-touched-code instruction and before writing. Put a one-liner in `planning.md`
after the existing “Research first” block. Put the same one-liner in `planning_openspec.md`
because that template has a parallel Task / Important block and its design artifacts can invent
a layer the implementer then has to build.

**Rationale:** Operator confirmed 2026-08-27. The implementer needs the ordered rungs at write
time. The planner only needs to avoid specifying a custom layer. OpenSpec planning is in scope
because it authors proposal / design / specs.

**Alternatives:** Ladder in planning too (rejected: planning already has research-first; a
one-liner is enough). Skip `planning_openspec.md` (rejected: it has a parallel instructions
block). Ladder only in conventions excerpt (rejected: conventions are a summary, not a
substitute for the stage prompt).

### D3: Always full intensity; no mode switch

**Decision:** Always enforce the full ladder. No `lite` / `ultra` / `off` config key.

**Rationale:** Unattended stages have no operator to pick a mode. Ultra (“ship the one-liner and
challenge the rest”) is illegal on an unattended implementer because it shrinks the issue.

**Alternatives:** Config key defaulting to full (rejected unless a later issue needs an off
switch). Session-level mode (rejected: no session in a single-turn CLI invoke).

### D4: Do not copy the ladder into fix-round templates

**Decision:** Leave `fix.md`, `test_fix.md`, `visual_fix.md`, and `eval_fix.md` unchanged by this
ladder. Surgical-fix discipline already requires a minimal finding-scoped diff.

**Rationale:** Ultra-style “deletion over addition” in a fix round is how MED findings become
HIGH on the next review. `surgical-fix-rounds` already owns fix-time minimality.

**Alternatives:** Paste the ladder into fix.md for consistency (rejected by operator). Weaken
surgical-fix to defer to the ladder (rejected: rigor over latency).

### D5: Keep pipeline contracts; ignore ponytail stay-worse rules

**Decision:** Completeness, the test bar, trailers, DNR / needs-human markers, design-gate, and
papercuts stay. Do not treat tests as YAGNI. Do not replace output with a 3-line contract. Never
simplify away trust-boundary validation, data-loss error handling, security, accessibility, or
anything the issue or plan explicitly requests.

**Rationale:** Pipeline review rigor is the product. Ponytail ultra / test-YAGNI / 3-line output
conflict with existing specs (`planning-grounded-research` acceptance criteria, implementer test
bar, commit trailers).

**Alternatives:** Adopt ponytail ultra for “small” issues (rejected: no operator to classify;
shrinks unattended work).

### D6: Attribution is a prompt comment, not a rebrand

**Decision:** Put an HTML comment in the implementing template (and a short pointer on the
planning one-liner if space allows) naming Ponytail, MIT, and
https://github.com/DietrichGebert/ponytail. Do not name the pipeline “ponytail.”

**Rationale:** MIT requires attribution. Rebranding would imply the plugin and slash commands,
which we are not shipping.

**Alternatives:** Add the package as a dependency solely for LICENSE (rejected: unused dep).
Put attribution only in `design.md` (rejected: the copied ladder lives in the prompt).

### D7: Drift-guard rendered builder output; no new stage

**Decision:** Add `prompt-loader.test.ts` assertions on `buildImplementingPrompt`,
`buildPlanningPrompt`, and `buildPlanningOpenspecPrompt` for presence, and on
`buildFixPrompt` / `buildTestFixPrompt` / `buildEvalFixPrompt` / `buildVisualFixPrompt` for
absence. No new pipeline stage, no new review round, no reviewer-prompt tag bullet in this
change.

**Rationale:** Matches `surgical-fix-rounds` and `planning-grounded-research` golden-prompt
guards. Review tags were optional and then explicitly out of this PR (operator 2026-08-27).

**Alternatives:** Plan-review bullet with ponytail tags (deferred). New review round (rejected:
non-goal).

## Risks / Trade-offs

- **[Risk] Harness ignores the prose ladder.** → Mitigation: existing review still flags
  unnecessary abstraction. This change reduces the rate; it is not a deterministic gate.
- **[Risk] Agent applies ultra-style shrink and drops tests or scope.** → Mitigation: explicit
  keep-rules in the implementing prompt (tests, completeness, trailers, never-simplify-away).
- **[Risk] Later “consistency” edit copies the ladder into fix.md.** → Mitigation: negative
  drift tests on fix-round builders.
- **[Risk] Ladder is applied instead of reading code.** → Mitigation: read-first instruction
  precedes the rungs; skip-the-read is not a rung.

## Migration Plan

Prompt-only. The next planning or implementing invocation loads the edited templates. No config
migration. Rollback is a git revert of the prompt files, tests, and regenerated overlay.
