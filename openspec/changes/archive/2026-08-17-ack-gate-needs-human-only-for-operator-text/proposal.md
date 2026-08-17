## Why

`findUnacknowledgedComments` plus `setBlocked(..., "needs-human")` parks an item whenever a post-plan comment looks like a human objection. Overnight `pipeline single` and `train --merge` then stop. That park is wrong when the comment is pipeline output or an operational note, not a real operator scope decision.

#1098 already rebinds Review-2 `bodyHash` after engine-owned banners. This change is the residual **gate policy**: failed hash, missing `## Pipeline:` grill/lock notes, and other trusted-author bodies that trip `NEGATION_PATTERNS` must not become `needs-human` STOP. False `needs-human` is a large part of “cannot sleep through a ship.”

## What Changes

- The unacknowledged-human-input gate SHALL set `needs-human` only when a post-plan comment is **not** verified pipeline output, **and** is **not** a registered pipeline heading/sentinel (trusted author), **and** reads as operator-authored product/scope change. Same `gh` actor is not enough — that login is the pipeline poster.
- A trusted-actor `## Review N` (or other registered review/delta heading) body that still carries a **terminal** `review-artifact` blob SHALL never count as unacknowledged human input, even when `bodyHash` does not match. Hash failure is engine integrity, not human authority.
- Verified `review-artifact` and `pipeline-attest` bodies SHALL never count, including objection wording in findings. This restates the #1098 happy path; this change does not re-fix the hash bind.
- Grill / ship-halt / “don’t comment” operational notes without `## Pipeline:` SHALL NOT `setBlocked` with kind `needs-human` when they are not a scope change the implementer must ack. If the engine cannot tell operational note from scope change, it SHALL fail **recover** (in-engine re-plan), not `needs-human` STOP.
- Real operator text after the plan (no pipeline marker, not a trusted override/unblock) SHALL still block. `pipeline unblock` and scope-override SHALL still clear it.
- `fix.ts` and `review-routing.ts` SHALL share the same predicate. `pipeline single`, `train --merge`, and later `pipeline ship` (#1096) inherit it. No host janitor.

**BREAKING (policy):** this supersedes the #1098 residual rule that an unverified trusted-actor review-shaped body with `NEGATION_PATTERNS` still counts as human. The living “no heading-only exemption” sentence is replaced by the heading + terminal artifact rule below.

## Acceptance Criteria

- [ ] A Review-2-shaped body with `instead` and a valid matching `review-artifact` is **not** returned by `findUnacknowledgedComments`.
- [ ] A Review-2-shaped body with `instead`, a present **terminal** `review-artifact` blob, and an **invalid** `bodyHash`, authored by the trusted `gh` actor, is **not** counted as unacknowledged and does **not** `setBlocked` with kind `needs-human`.
- [ ] A grill / ship-halt / “don’t comment” operational note without `## Pipeline:` after a plan does **not** `setBlocked` with kind `needs-human`.
- [ ] A plain “please also change X” comment from a **non-pipeline** author after the plan is still returned as unacknowledged.
- [ ] `pipeline unblock` (verified trusted-actor operator-surface comment) still clears a real human comment and still acts as an acknowledgement anchor.
- [ ] Unit tests cover the cases above, inject deps, and do no real network, git, or subprocess. If `core/` changes, `plugin/` is regenerated. `npm run ci` is green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `issue-context-snapshot`: Change the unacknowledged-human-input predicate so `needs-human` fires only for verified operator-authored scope-change text. Trusted registered headings with a terminal artifact blob never count. Operational notes never park as `needs-human`. Residual ambiguity recovers in-engine.
- `human-plan-feedback`: Post-revised-plan blocking SHALL use the same unacknowledged-human-input predicate. Operational notes and unverified-but-structurally-pipeline comments SHALL NOT require a human re-plan or scope-override before the next stage.

## Impact

- **Primary:** `findUnacknowledgedComments` in `core/scripts/issue-context-snapshot.ts`. Call sites in `core/scripts/stages/fix.ts` and `core/scripts/stages/review-routing.ts` keep one shared predicate. Tests in `core/test/issue-context-snapshot.test.ts` (and any call-site composition tests that assert `needs-human` on this gate).
- **Depends on:** #1098 (merged). Do not duplicate the hash-after-banner bind.
- **Out of scope:** Claude-session retry loops in Hermes; auto-override of HIGH/CRITICAL review findings; implementing #1096; host janitor scripts.
- **Program:** v1.39.2 (with #1098). Do not put on v1.39.3 — this gate fires on the current FRG/train before in-engine ship exists.
- **Class vs site:** this is a **class** fix. The class is “false `needs-human` from the human-ack gate on pipeline-authored or non-operator operational comments.” The #1095 Review-2 hash miss and #1073-era grill/lock notes are sites. The next unverified review heading or unmarked operational note must not need a new mole issue.
