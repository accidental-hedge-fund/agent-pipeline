## Context

Shipped plan-review behavior (when `steps.plan_review` is true):

1. Implementer posts `## Implementation Plan`.
2. Independent **reviewer harness** (secondary/cross-harness role) reviews the plan
   and posts `## Plan Review` with a structured verdict.
3. Any **human** issue comments after the plan (non-pipeline headers) are collected
   opportunistically and folded into the plan-revision prompt (`human-plan-feedback`).
4. Implementer revises the plan; if human comments were present, a
   `## Human Feedback Acknowledgement` section is required.
5. Stage advances to implementing. **No human LGTM is required** for that advance.

Despite that, high-traffic copy still over-claims:

| Surface | Misleading claim |
| --- | --- |
| `README.md` Lifecycle band | "`plan-review` is the human sign-off before implementation starts" |
| `core/scripts/pipeline-run.ts` auto-loop comment | plan-review is a "human-judgment checkpoint"; waiting means "a human must review the plan" |
| `bounded-auto-loop` / #23 language nearby | confuses deferred graduated-autonomy **approval checkpoints** with today's plan-review feedback window |

The README later (configurable `steps.plan_review` section) already describes the
correct optional-feedback model. This change makes the front door, skills, and
comments match that model and freezes the vocabulary.

Related but **not absorbed**: SKILL.md diagram/stage-count completeness (#597 /
stage-count SSOT). This change may note plan-review in prose where authority is
discussed; it does not own the diagram generator or stage-count SSOT.

## Goals / Non-Goals

**Goals:**

- One closed vocabulary for agent plan review vs human feedback vs attestation vs approval.
- Operator-facing surfaces stop equating plan-review with human sign-off.
- Explicit expiry semantics: no human comments → proceed on agent review only.
- Practical CI drift-guard so the README (and, if cheap, sibling packaging) cannot
  reintroduce the worst phrase.
- Comment-level accuracy in engine code that documents auto-loop policy around
  plan-review without changing that policy unless it is already a pure wording bug.

**Non-Goals:**

- Implementing #23 graduated-autonomy approval checkpoints.
- Changing plan-review harness invocation, revision contracts, or
  `human-plan-feedback` capture algorithm.
- Changing auto-loop eligibility sets, merge authority, or attestation crypto.
- Full SKILL.md state-machine diagram regeneration / stage-count SSOT (#597).
- Rewriting ROADMAP historical notes about #23 (historical backlog text may keep
  "approval checkpoints" as the name of that deferred feature).

## Decisions

### D1 — Closed vocabulary (normative terms)

| Term | Meaning | Authority? |
| --- | --- | --- |
| **Independent agent plan review** | Cross-harness (or configured reviewer) review of the posted plan; posts `## Plan Review`. | Agent evidence only. Not human approval. |
| **Human feedback window** | Interval after `## Implementation Plan` is posted during which non-pipeline human comments are collected for revision (practical window ≈ reviewer run until revision starts). | Optional steering. Silence is not approval and not a block. |
| **Human attestation** | Verifiable pipeline output markers (`pipeline-attest` / review-artifact body hashes) or operator **capability** attestations (e.g. `loop.native_goal_attestation`). | Provenance / capability claims. Not plan sign-off. |
| **Human approval** (aka **human sign-off**) | Affirmative human action required for a control to proceed (merge at `ready-to-deploy`; `needs-human` dispositions; future #23 checkpoints if shipped). | Real human authority. |

**Alternatives considered:** Reuse informal "human gate" for both plan-review and
merge — rejected; that is the collapse this issue removes. Invent new config keys —
rejected; this is language, not a feature flag.

### D2 — Feedback window expiry (document current behavior; no new wait)

When the window ends with **no** human comments:

- Human feedback list is empty.
- Revision prompt omits the human-feedback section (existing `human-plan-feedback`).
- Pipeline does **not** block waiting for a human.
- Pipeline does **not** record human approval or sign-off.
- Independent agent plan review remains the plan-review evidence for that run.

**Alternatives considered:** Add a timed human wait before revision — out of scope
and would change product behavior (#23 territory). Document a fictional timeout
number — rejected; today's window is event-bounded (revision start), not a fixed
wall-clock approval SLA.

### D3 — Surface audit set (minimum)

Must be audited and corrected if they over-claim:

1. `README.md` (Lifecycle + plan-review sections; examples).
2. Host skills (`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`) where they describe
   plan-review authority (not every mention of the stage name).
3. Status / CLI prose that names plan-review as human approval.
4. Engine comments in `pipeline-run.ts` (and test comments that copy the same myth)
   describing auto-loop ineligibility of plan-review.

Historical ROADMAP rows about #23 "approval checkpoints" stay; they name a
deferred feature correctly.

### D4 — Drift-guard shape

Mirror the loop-skill forbidden-phrase pattern:

- A unit test under `core/test/` reads the high-traffic operator file(s) (at least
  `README.md` Lifecycle region or full file) and fails if a small set of forbidden
  substrings reappear, e.g. case-insensitive:
  - `plan-review` is the human sign-off
  - `plan-review is the human sign-off`
  - optionally broader patterns carefully tuned to avoid false positives on
    legitimate sentences like "plan-review is **not** human sign-off".
- Prefer positive + negative phrases: fail on equating plan-review **with** human
  sign-off/approval; allow explicit negation and comparison tables.
- Covered by existing `npm test` / `npm run ci`.

**Alternatives considered:** Full natural-language lint of all docs — too brittle.
Manual checklist only — fails the "regression check where practical" acceptance
criterion. Guard only OpenSpec text — misses the user-facing README bug.

### D5 — Auto-loop comment vs policy

Today `isAutoLoopEligible` hard-excludes `plan-review` and `shipcheck-gate`. That
policy can remain (plan-review is not a recovery-retry surface; shipcheck has its
own reasons). Comments MUST stop claiming the reason is "a human must review the
plan." Prefer: plan-review is an independent-agent review step with an optional
human feedback window and is not an auto-loop recovery stage; shipcheck failures
require human disposition.

No change to eligibility return values in this issue unless a test proves comments
are the only drift and behavior is already correct.

### D6 — Spec packaging

- **New** capability `plan-review-authority-boundary` owns vocabulary, surface rules,
  window expiry documentation, and drift-guard requirements.
- **ADDED** (not MODIFIED rewrite of whole capture algorithm) on
  `human-plan-feedback` for an authority-boundary requirement: human comments are
  optional feedback, not approval; empty list is not approval and not a block.
  Prefer ADDED if no existing requirement text must change; use MODIFIED only if an
  existing requirement's wording must be rewritten to remove implied approval.

## Risks / Trade-offs

- **[Risk] Forbidden-phrase guard is too broad** → Mitigation: anchor patterns to
  known bad phrases from the audit; include an allow-list for explicit "not human
  sign-off" sentences; prove the guard fails when the bad README line is restored.
- **[Risk] Over-editing ROADMAP / historical #23 language** → Mitigation: scope
  audit to operator-facing current behavior; leave historical milestone notes.
- **[Risk] Readers still miss plan-review on diagrams (#597)** → Mitigation: call
  out dependency in proposal/impact; optional one-line cross-link in README, no
  diagram ownership.
- **[Risk] Comment-only engine edits look like behavior change in review** →
  Mitigation: keep runtime returns identical; tests for eligibility unchanged;
  note "comment accuracy" in the PR.

## Migration Plan

1. Land OpenSpec change (this proposal) → implement docs + guard in a follow-on
   apply step.
2. Docs-only + test; regenerate `plugin/` only if host skill sources change.
3. Rollback: revert the docs commit; no data migration.

## Open Questions

- None blocking intent. If implementation finds a second front-door surface (e.g.
  generated install README snippet) with the same phrase, extend the same
  vocabulary and guard rather than inventing a second set of terms.
