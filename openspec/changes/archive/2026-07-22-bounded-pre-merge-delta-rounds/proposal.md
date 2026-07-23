## Why

Pre-merge delta reviews (`pre-merge-delta-recheck`) have **no round ceiling**. `review_policy.max_adversarial_rounds` bounds review-2 loops and is explicitly *not* consumed by delta rounds, so a converging item can loop on reviewer oscillation indefinitely — each round costing a fix/override cycle, an operator recovery-budget unit, and (under goal-loop supervision) a consecutive-blocked increment.

The #389/#464 settled-trade-off guard is also escapable. It demotes a blocking finding only when the finding *itself* re-raises a specific settled finding (key equality or title similarity on the same surface). On PraxisIQ/fuseiq-core#95 (2026-07-21, engine v1.16.0) pre-merge ran **five** delta rounds: rounds 1–4 produced real defects (including a `fresh is connection` identity-map aliasing bug at 0.96 confidence), then round 5 re-raised the snapshot-ordering axis under **fresh finding keys with re-worded titles** at *declining* confidence (0.82/0.78) and recommended "serialize remote fetches per connection" — precisely the design **round 2 had required removed** (a lock held across remote I/O that stalled admin writes). Neither guard fired: new keys defeat key matching, re-framing defeats title similarity, and nothing in the digest records *which design alternative a settled finding ruled out*. An operator had to break the loop by hand with a documented override.

## What Changes

- **Bounded delta rounds.** A new `review_policy.max_delta_rounds` config key caps pre-merge delta rounds **per item**, counted durably from the issue's delta-review comment thread (crash-safe, survives a fresh clone) rather than from run-local state. At the ceiling the pipeline does **not** run another delta review; it applies the existing `ceiling_action` semantics (`park` → `needs-human` with an unresolved-blocker punch list; `demote_and_advance` → demote below-high blockers to audited advisory, file the single tracked follow-up issue, and advance), with high/critical blockers hard-parking regardless, exactly as at the review-2 ceiling (#233). Delta rounds still do **not** consume the `max_adversarial_rounds` budget — the two ceilings are independent.
- **Rejected-alternative registry + reinstatement guard.** The reviewer verdict schema gains an optional per-finding `rejected_alternatives` array: when a finding's recommendation requires *removing or replacing* a design, the reviewer names the alternative being ruled out. Those alternatives ride the durable `blockingFindings` review artifact into the prior-round digest, and a new pure matcher demotes a later blocking finding whose own `recommendation` reinstates an alternative a settled finding ruled out — reason `settled-alternative-reinstated` — unless it carries a `prior_round_acknowledgment`. This closes the new-key/re-framed-axis escape that key- and title-matching cannot see.
- **Override-settled trade-offs are first-class in the digest.** Digest entries settled by an operator OVERRIDE render as binding settled constraints alongside fix-settled ones, with their disposition rationale and their rejected alternatives, and the reviewer preamble states explicitly that an override settles a trade-off as firmly as a fix does.
- **Confidence-trend churn flag (audit-only).** Digest entries carry the finding's `confidence`. When every blocking finding of a delta round sits on an **axis** (`surfaceKey`) whose prior findings are all settled, and every new confidence is strictly lower than the axis's prior maximum, the round is flagged as **suspected churn**: recorded in the comment, the events log, and the evidence bundle. The flag is advisory-in-audit only — it does not by itself unblock the round.
- **Observability.** Delta round number, cap, ceiling hits, churn flags, and reinstatement demotions appear in `events.jsonl` and in the evidence bundle / `summary.json`.

## Capabilities

### New Capabilities

None — this extends existing capabilities.

### Modified Capabilities

- `pre-merge-delta-recheck`: adds a durable per-item delta-round ceiling governed by `review_policy.max_delta_rounds` + `ceiling_action`, and the audited surfacing of suspected-churn rounds.
- `review-cross-round-memory`: adds `confidence` and `rejected_alternatives` to digest entries, the settled-alternative reinstatement guard, the pure confidence-trend churn detector, and an explicit override-settles-trade-offs statement in the reviewer-facing digest preamble.
- `pipeline-configuration`: adds the `review_policy.max_delta_rounds` key with a default, schema entry, and key allowlist coverage.
- `events-jsonl-streaming`: adds `delta_round`, `delta_round_ceiling`, `delta_churn_suspected`, and `settled_alternative_reinstated` event types.
- `evidence-bundle`: records delta-round counts, the cap, ceiling disposition, and churn flags in `summary.json`.

## Acceptance criteria

- [ ] `review_policy.max_delta_rounds` exists with a documented default of `4`, is accepted by the config schema, appears in the config key allowlist and in scaffolded/`config schema` output, and rejects non-positive values.
- [ ] Delta-round count for an item is derived purely from the durable delta-review comment thread; the same comment set yields the same count with no run-local state, no network/git/subprocess access in the counting function.
- [ ] When the count has already reached `max_delta_rounds`, `enforceReviewShaGate` does **not** invoke the reviewer for another delta round and instead applies `ceiling_action`; a test asserts the reviewer seam is never called.
- [ ] At the ceiling with `ceiling_action: park`, the item lands at `needs-human` with a punch list of the unresolved delta blockers; with `demote_and_advance`, below-high blockers become audited advisory dispositions with one tracked follow-up issue and pre-merge proceeds — while a high or critical blocker hard-parks under either setting.
- [ ] Running a delta round never increments the `max_adversarial_rounds` counter, and hitting `max_delta_rounds` never consumes review-2 ceiling budget (regression test).
- [ ] A blocking finding whose `recommendation` reinstates an alternative recorded in a settled finding's `rejected_alternatives`, carrying no `prior_round_acknowledgment`, is partitioned advisory with reason `settled-alternative-reinstated` — **even when its `findingKey` is new and its title similarity is below the reversal threshold** (regression test replaying fuseiq-core#95 round 5 vs round 2).
- [ ] The same finding carrying a non-empty `prior_round_acknowledgment` blocks exactly as it would without the guard; a finding matching no settled rejected alternative is partitioned by `review_policy` alone; with no settled entries, partitioning output is byte-identical to today's.
- [ ] Digest entries settled by OVERRIDE render with their disposition rationale and any rejected alternatives, and the digest preamble states that an override settles a trade-off as bindingly as a fix (drift-guarded assertion).
- [ ] Digest entries carry the finding `confidence` when the source artifact records it and degrade gracefully (no entry dropped, no throw) when it is absent from legacy comments.
- [ ] The churn detector is pure and deterministic: given a round whose blocking findings all sit on settled axes at strictly lower confidence than each axis's prior maximum, it reports suspected churn; given any finding on an unsettled axis, or any confidence at or above the prior maximum, or any missing confidence, it reports none.
- [ ] A suspected-churn round is labelled in the posted delta-review comment and emits exactly one `delta_churn_suspected` event; the round's blocking disposition is otherwise unchanged by the flag alone.
- [ ] `events.jsonl` contains a `delta_round` event per delta round carrying the round number and the configured cap, a `delta_round_ceiling` event when the cap is reached carrying the applied `ceiling_action`, and one `settled_alternative_reinstated` event per demotion naming the demoted key, the settled key, the settling round, and the matched alternative.
- [ ] `summary.json` reports the item's delta-round count, the cap, the ceiling disposition (if any), and any churn flags; evidence-bundle write failures remain non-fatal.
- [ ] `npm run ci` passes from the repo root, including the regenerated `plugin/` mirror and `openspec validate --all`.

## Out of scope

- Review-1/review-2 round policy (already governed by `review_policy.max_adversarial_rounds`).
- The fix-outcome disposition path (#473).
- Auto-merge: unchanged — the pipeline still stops at `pipeline:ready-to-deploy`.

## Impact

- `core/scripts/types.ts`, `core/scripts/config.ts` — new `review_policy.max_delta_rounds` field, default, zod schema, key allowlist, scaffold rendering.
- `core/scripts/review-history.ts` — digest entry `confidence`/`rejectedAlternatives`, settled-alternative matcher, churn detector, preamble text.
- `core/scripts/review-policy.ts` — `settled-alternative-reinstated` advisory reason in `partitionFindings`.
- `core/scripts/review-schema.ts`, `core/scripts/prompts/review_adversarial.md` — `rejected_alternatives` field + reviewer instruction (schema drift guard applies).
- `core/scripts/stages/review-parsing.ts`, `review-rendering.ts` — artifact extension carrying confidence and rejected alternatives.
- `core/scripts/stages/pre_merge.ts` — durable delta-round counting, ceiling enforcement, churn surfacing, events.
- `core/scripts/evidence-bundle.ts`, `event-sink.ts`/`run-store.ts` — new records and event types.
- `core/test/*` — regression coverage, including the fuseiq-core#95 five-round replay.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).
