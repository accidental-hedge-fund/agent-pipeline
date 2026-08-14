## Why

#645 shipped opt-in review ensemble: concurrent fan-out, union-merge findings, single disposition. Configured agent count is still not the same as effective independent coverage. Reviewers time out, fall back to same-harness self-review, share provider/model lineage, or fail before a usable verdict. Readiness evidence must state what coverage actually occurred — lineage, independence, quorum, and aggregation outcome — not only what the repository requested. Project Warrant can visualize fleet health later; Agent Pipeline must compute and emit the typed facts first (#694).

## What Changes

- **Per-attempt lineage and usability.** Every reviewer attempt records provider family, model family, configured and effective harness, authoring/implementer harness relationship, self-review flag, usability, latency, cost coverage class, and failure/fallback reason when not usable.
- **Typed independence rules.** Independence is a pure function of documented lineage fields (not Project Warrant inference, not free-text). Self-review and same-lineage collisions never count as independent when policy forbids it.
- **Coverage counts.** Each ensemble (or single-reviewer) round records explicit counts: `configured`, `attempted`, `usable`, `independent`, and `required` (required may be 0 when no risk-class quorum is armed).
- **Optional risk-based independent quorum.** Config MAY set a minimum independent reviewer count by risk class. When armed and unmet, the round fails safely with a typed aggregation outcome — it does not invent majority approve and does not erase union-merged blocking findings from usable agents.
- **Deterministic aggregation outcomes.** Every round emits exactly one of: `complete`, `partial_quorum`, `same_lineage_fallback`, `quorum_unmet`, `no_usable_reviewers`, with a short machine-readable reason that explains complete / degraded / blocked.
- **Cost accounting dimensions.** Reviewer work is classified as requested, attempted, completed, and billable (when known), so scoreboard/accounting can separate planned fan-out from actual spend.
- **Recovery path for fail-closed quorum outcomes (audit note).** `quorum_unmet` and `no_usable_reviewers` are fail-closed for disposition (no silent approve). They are **not** bare `needs-human` product judgment by default. Recovery follows a bounded ladder: optional one-shot substitute independent attempt when configured → re-evaluate coverage → escalate through the typed escalation inventory (#760) with a new `BlockerKind` / stage-diagnostic projection and a static unblock recipe. Explicit opt-in degrade-to-usable-only (advisory coverage note) MAY exist only when config allows it and never drops union blockers.
- **Preserve #645 rigor.** Union-merge, `findingKey` dedupe, rigor-first blocking, single disposition surface, and no majority-vote approve remain mandatory.

**Non-goals:**

- Majority-vote approval or confidence averaging that demotes rigor.
- Individual agent trust scores or reputation.
- Requiring multiple providers for every repository or risk class by default.
- Building the Project Warrant quorum dashboard / fleet UI.
- Changing merge authority or auto-merge eligibility.

## Capabilities

### New Capabilities

- `reviewer-independence-quorum`: Typed reviewer lineage, independence computation, coverage counts (`configured` / `attempted` / `usable` / `independent` / `required`), risk-class minimum independent quorum, deterministic aggregation outcomes, cost coverage classes, and fail-closed recovery / escalation for unmet quorum and no usable reviewers.

### Modified Capabilities

- `review-ensemble`: Extend ensemble identity, merge summary, and soft-fail / fail-closed paths so usable-agent minimum and independent quorum are both explicit; record aggregation outcome; keep union-blocking merge and single disposition.
- `review-finding-records`: Persist per-agent lineage, independence flags, coverage counts, aggregation outcome, and cost coverage fields on the round record (additive; single-agent rounds remain valid).
- `stage-cost-accounting`: Distinguish requested vs attempted vs completed vs billable reviewer work for ensemble and single-reviewer rounds when accounting records are emitted.
- `blocked-recovery-recipes`: Add blocker kind(s) and static recipes for independent-quorum unmet and no-usable-reviewers so fail-closed coverage blocks are not recipe-less terminals.
- `escalation-site-dispositions`: Register the new production escalation site(s) for quorum / no-usable outcomes with closed safety dispositions and typed reason projection (inventory + drift guard).

## Impact

- `core/scripts/review-ensemble.ts` — extend agent identity, compute independence and coverage, emit aggregation outcome; optional substitute attempt hook
- Pure helpers (new or co-located) for lineage mapping, independence partition, quorum evaluation, and aggregation outcome classification — unit-testable without network/git/subprocess
- `core/scripts/config.ts` + init template — optional risk-class `min_independent` (or equivalent) under `review_ensemble` / review policy; defaults preserve current min-usable-only behavior when unset
- Review comment formatting / run-store / `events.jsonl` / `summary.json` — additive coverage and lineage fields; bind to existing `evidence_subject` when present (#692)
- `core/scripts/scoreboard.ts` and stage cost accounting paths — requested/attempted/completed/billable reviewer dimensions
- Blocker / escalation inventory — new kind(s), recipes, disposition rows
- Unit tests under `core/test/` for provider-family overlap, self-review non-independence, timeout/partial success, quorum met/unmet, union-preserved blockers, aggregation outcomes, cost classes
- Regenerate `plugin/` after any `core/` edit; `npm run ci` green
- Product boundary: Pipeline emits coverage facts; Warrant visualizes later

## Acceptance criteria

Observable, falsifiable outcomes that make #694 done:

- [ ] Every reviewer attempt on an ensemble (or single-reviewer) round records typed lineage fields: provider family, model family, configured harness, effective harness, self-review flag, usability, latency (or explicit unknown), cost coverage class, and failure/fallback reason when not usable.
- [ ] Independence is computed by a documented pure rule over those fields (self-review never independent; same lineage_key does not double-count; implementer same-harness fallback never independent when policy forbids it). Project Warrant is not consulted for the computation.
- [ ] Each round persists explicit counts: `configured`, `attempted`, `usable`, `independent`, `required`.
- [ ] Optional config can require a minimum independent count for a risk class; when required > independent, the round does not advance as a normal approve solely on usable/min_usable success.
- [ ] Aggregation outcome is exactly one of `complete` | `partial_quorum` | `same_lineage_fallback` | `quorum_unmet` | `no_usable_reviewers`, and the persisted reason explains why the set was complete, degraded, or blocked.
- [ ] Union-merge still keeps a policy-blocking finding from any usable agent; missing or non-independent agents cannot erase that finding via majority or omission.
- [ ] Same-harness / self-review fallback remains labeled, remains visible on the disposition surface, and does not increment `independent` when policy forbids counting it.
- [ ] Cost / accounting fields distinguish at least requested, attempted, completed, and billable (when known vs unknown) reviewer work for the round.
- [ ] `quorum_unmet` and `no_usable_reviewers` escalate through a typed blocker/escalation site with a recovery recipe (bounded substitute attempt when configured, then typed park — not silent approve and not recipe-less human-only by default).
- [ ] Unit tests cover: provider-family overlap, self-review fallback, timeout, partial success, quorum met, quorum unmet, no usable reviewers, and union-preserved blockers. Injected deps only.
- [ ] `npm run ci` green; any `core/` change regenerates and commits `plugin/` in the same change.
