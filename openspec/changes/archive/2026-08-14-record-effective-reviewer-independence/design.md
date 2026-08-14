## Context

See proposal.md for motivation (#694). #645 is archived as living `review-ensemble`: concurrent fan-out at `invokeReviewer`, union-merge + `findingKey` dedupe, `min_usable_agents` soft-fail, fail-closed at zero usable, per-agent self-review labeling, single disposition. Identity today is roughly `EnsembleAgentIdentity` (`harness`, `effectiveHarness`, `model`, `selfReview`, usable/failed, optional cost) plus `EnsembleMergeSummary` (`size`, `usable`, `failed`). That is not enough to prove independence or risk-class quorum.

#692 (`evidence-subject`) binds readiness artifacts to one subject; this change attaches coverage facts to the same round / subject and does not invent a second identity vocabulary.

Human audit note (issue comments): `quorum_unmet` / `no_usable_reviewers` must not land as recipe-less terminal blocks. Recovery and typed escalation (#760 inventory) are in scope for the **spec and design**, even if the first substitute attempt is a thin bounded recipe.

## Goals / Non-Goals

**Goals:**

- Pure, documented lineage → independence → coverage counts → aggregation outcome pipeline.
- Config-optional independent quorum by risk class; default preserves #645 min-usable-only behavior when quorum is unset/zero.
- Fail-closed outcomes with typed escalation + recovery recipe (and optional one-shot substitute independent attempt).
- Additive persistence (events/summary/comment disclosure) without breaking single-agent consumers.
- Cost classes: requested / attempted / completed / billable (unknown allowed).

**Non-Goals:**

- Warrant UI or fleet quorum dashboard.
- Trust scores, majority vote, or demoting union blockers.
- Forcing multi-provider for all repos.
- Cross-host durable coverage store.
- Full autonomous multi-retry “heal until quorum” loops (budgeted one-shot substitute only).

## Decisions

### 1. New capability + thin deltas on ensemble / records / cost / blockers

**Decision:** Primary behavioral contract lives in new `reviewer-independence-quorum`. `review-ensemble` gains only the hooks that change fan-out / soft-fail / disposition behavior. Persistence, cost, and escalation deltas own their surfaces.

**Why:** Independence/quorum is a distinct readiness concern; ensemble remains the execution substrate. Keeps archive merges clean.

**Alternatives:** Stuff everything into `review-ensemble` only — rejected (overloads #645 scope and living purpose). Separate runtime module without a capability — rejected (OpenSpec would not capture the contract).

### 2. Lineage fields and lineage_key

**Decision:** Each reviewer attempt records at least:

| Field | Source |
|---|---|
| `configured_harness` | config agent entry |
| `effective_harness` | post–self-review harness that produced output (or would have) |
| `provider_family` | deterministic map from harness/model config (closed table + `unknown`) |
| `model_family` | deterministic map from model id / slot (prefix/family table + `unknown`) |
| `model` | resolved model string when known |
| `self_review` | boolean (#39 path for that agent) |
| `implementer_harness` | run’s implementing harness (for self-review comparison) |
| `status` | `usable` \| `failed` (plus failure class when failed) |
| `latency_ms` | measured or `null` if unknown |
| `cost_class` | see decision 6 |
| `failure_reason` | closed failure class when not usable; optional fallback reason when self-review |

`lineage_key` for independence partitioning is the tuple `(provider_family, model_family)` with `unknown` treated as its own partition (does **not** invent independence). Two usable non-self-review agents that share the same key share one independence slot.

**Why:** Matches issue language (provider + model-family lineage) without requiring every deployment to have multi-cloud providers. Unknown is honest, not optimistic.

**Alternatives:** Harness-name-only independence — rejected (Claude/Codex can still share a provider family when both map to the same backend). Opaque LLM “are they independent?” — rejected (must be typed rules).

### 3. Independence pure function

**Decision:** An attempt is **eligible independent** iff all hold:

1. `status === usable`
2. `self_review === false`
3. `effective_harness` is not the implementer harness (defense in depth with self_review)
4. Policy does not mark the attempt non-independent (no override that forces independence)

Among eligible independents, **count** unique `lineage_key` values in config order (first agent for a key occupies the slot; later same-key agents are usable but not additional independents).

Independence is never inferred from Project Warrant or free text.

**Why:** Operator-auditable; unit-testable; matches “self-review cannot count as independent when policy forbids it” (v1 forbids always).

### 4. Coverage counts

**Decision:** Persist on every review round that runs the shared reviewer seam:

- `configured` — resolved agent list length (1 when ensemble off)
- `attempted` — agents the engine actually started (or tried to start)
- `usable` — parseable structured/plan verdict under existing usable rules
- `independent` — count from decision 3
- `required` — min independent from risk-class policy for this round (0 if unset / not armed)

### 5. Aggregation outcomes (closed enum)

**Decision:** Exactly one outcome per round after attempts settle (and after optional substitute attempt):

| Outcome | Meaning |
|---|---|
| `complete` | `usable >= min_usable` AND `independent >= required` AND `usable === configured` (all configured usable) |
| `partial_quorum` | `usable >= min_usable` AND `independent >= required` AND `usable < configured` |
| `same_lineage_fallback` | `usable >= min_usable` AND `required === 0` (quorum not armed) AND every usable agent is either self-review or shares one lineage_key (independence degraded / single lineage) — **or** `independent < configured` usable peers solely due to lineage collision while `required` still met with `independent >= required` and at least one self-review or lineage collapse is present. Prefer this label when independence is degraded but not below `required`. |
| `quorum_unmet` | `usable >= min_usable` (or usable > 0 with min_usable satisfied) AND `required > independent` |
| `no_usable_reviewers` | `usable === 0` (or `usable < min_usable_agents`) |

Clarified routing:

- `complete` / `partial_quorum` / `same_lineage_fallback` → proceed to existing single disposition path with union-merged findings. Coverage is disclosed. `same_lineage_fallback` is degraded but **not** a hard block when `required` is 0 or still met.
- `quorum_unmet` → **do not** treat as normal approve advance solely because min_usable succeeded. Fail closed for readiness of this review round’s “coverage OK” signal; still **retain and surface** any union-merged blocking findings from usable agents (findings are not erased). Escalation uses the quorum blocker path.
- `no_usable_reviewers` → existing fail-closed (no approve); typed escalation.

When both blocking findings exist and quorum is unmet, the operator-visible surface MUST show both: findings disposition path **and** coverage failure — coverage failure does not suppress findings.

**Why:** Closed enum matches the issue exactly; separates “we had reviewers but they were not independent enough” from “nobody produced a verdict.”

**Alternatives:** Collapse all non-complete into one `degraded` — rejected (operators need quorum vs zero usable). Block on any same-lineage even when `required=0` — rejected (breaks default single-reviewer and soft multi-same-family setups).

### 6. Cost coverage classes

**Decision:** Per attempt and rollup:

- `requested` — configured agents for the round (planned fan-out)
- `attempted` — invoke started
- `completed` — harness returned (success or failed with terminal result); excludes never-started
- `billable` — completed with known cost (`actual` or `estimated` per stage-cost-accounting); unknown cost is completed but not billable

Round rollup records counts (and optional USD sums when known). Accounting remains observational for routing except where coverage outcomes already block.

### 7. Risk-class `required` resolution

**Decision:** Config under `review_ensemble` (preferred, next to `min_usable_agents`):

```yaml
review_ensemble:
  enabled: true
  min_usable_agents: 1
  min_independent_by_risk:
    low: 0
    standard: 0
    high: 2
```

Unset map or missing class → `required = 0` (current behavior). Risk class for the round is resolved from existing structural signals already owned by the engine, in this order when available:

1. Explicit ensemble/policy override for the stage (if later added)
2. Pre-code / design / high-risk structural triggers already computed for the issue when present
3. Default `standard`

v1 MUST document the resolver as pure over structured inputs (no prose). If no high-risk signal is available, default `standard` with `required=0` unless config sets standard > 0.

**Why:** Optional by risk class; does not force multi-provider on every repo; aligns with issue non-goal “not every repository.”

**Alternatives:** Always `required = configured` — rejected (too strict, expensive). Derive risk only from reviewer free-text “Risk: high” — rejected (review-risk-proportional-blocking already bans prose for tier).

### 8. Recovery ladder for `quorum_unmet` / `no_usable_reviewers`

**Decision (addresses audit comment):**

1. **Classify** outcome (`quorum_unmet` or `no_usable_reviewers`).
2. **Deterministic recipe — one-shot substitute (optional):** If config lists `substitute_agents` (or unused configured agents remain that could improve independence), attempt **at most one** additional concurrent or sequential substitute independent invoke for agents that would change `lineage_key` coverage. Recompute counts/outcome once. No unbounded retry.
3. **If still `no_usable_reviewers`:** escalate `deliberately-fail-closed` or `transient-retryable` only for spawn/timeout class per #760 inventory — default inventory disposition for zero usable after substitute is **`reconcile-owned` / engine-owned park** with `BlockerKind` such as `review-no-usable-reviewers`, recipe: fix harness CLIs / capacity, clear block, re-run. **Not** product-judgment `needs-human` by default.
4. **If still `quorum_unmet`:** escalate with `BlockerKind` such as `review-independent-quorum-unmet`, disposition **`deliberately-fail-closed`** for the coverage integrity site (do not auto-approve). Recipe: add an independent provider/harness, lower `min_independent_by_risk` only via config change with audit, or operator override if an explicit coverage override mechanism is later added (out of band). Optional config `allow_quorum_degrade: true` (default **false**) permits proceeding with `same_lineage_fallback` / partial usable disposition **only when** findings path still blocks on union findings; degrade MUST emit a loud advisory coverage note and MUST NOT mark coverage complete.
5. **Bounded wait** is **not** the primary path (no janitor sleep-for-quorum). Capacity/auth failures use existing capacity/auth recipes if that is the true class.

Union findings from usable agents always remain on the artifact even when coverage blocks.

**Why:** Specs a recovery story before implementation; avoids new human-only dead ends; keeps integrity fail-closed for unmet independent quorum on high-risk work.

### 9. Persistence and disclosure

**Decision:** Additive fields on existing ensemble identity / merge summary / review_verdict event / summary — no new well-known run file solely for coverage. Comment disposition includes a one-line coverage disclosure (counts + outcome). Single-agent rounds populate counts with `configured=1` and lineage for that one attempt.

Bind to `evidence_subject` when the round already carries it (#692); do not redefine subject fields here.

### 10. Tests

**Decision:** Pure unit tests for lineage map, independence count, outcome classifier, quorum required resolution, substitute recomputation, and union blockers under quorum_unmet. Orchestration tests inject invoke fakes (no network/git/subprocess). Prove tests fail if independent is over-counted on same lineage or self-review.

## Risks / Trade-offs

- **[Risk] Conservative lineage map marks distinct models as same family** → Mitigation: document map; prefer under-count independence; operators raise `required` only when multi-family is real.
- **[Risk] `same_lineage_fallback` over-broad** → Mitigation: use only when degraded independence is present and `required` still met or unarmed; unit-test boundary vs `partial_quorum` / `complete`.
- **[Risk] High-risk repos enable `high: 2` without two families** → Mitigation: config validation warning when enabled ensemble cannot possibly meet max configured `required` given distinct lineage keys in agent list (optional hard reject).
- **[Risk] Double block (findings + quorum)** confuses operators** → Mitigation: single comment surface with both sections; recipes name both paths.
- **[Risk] Cost billable unknown for many harnesses** → Mitigation: allow unknown; never invent `$0` as actual.
- **[Trade-off] One-shot substitute only** — may still leave quorum unmet; preferred over unbounded retry cost.

## Migration Plan

1. Land pure helpers + types + tests (no behavior change when `min_independent_by_risk` absent).
2. Wire recording of lineage/counts/outcome on ensemble and single-reviewer paths (disclosure additive).
3. Arm fail-closed quorum routing + blocker kinds + escalation inventory when `required > 0`.
4. Optional substitute attempt + degrade flag last.
5. Default config remains quorum-unarmed → production behavior matches #645 until operators opt in.

Rollback: disable `min_independent_by_risk` / set all zeros; coverage fields remain observational.

## Open Questions

None that block the specs. Resolver order for risk class may gain additional structured inputs later without changing the closed outcome enum or independence rules.
