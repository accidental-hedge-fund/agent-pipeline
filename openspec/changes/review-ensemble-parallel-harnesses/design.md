## Context

Today every review round funnels through `invokeReviewer` in `self-review.ts`: one configured
reviewer CLI, optional same-harness self-review fallback (#39) on `spawn_error`, then a single
parsed `ReviewVerdict` that `partitionFindings` routes into fix / approve / ceiling / needs-human.
Call sites: plan-review (`stages/planning.ts`), review-1/review-2 (`stages/review-routing.ts`), and
pre-merge SHA-gate re-review (`stages/pre-merge-sha-gate.ts`).

The product doctrine is **cross-harness rigor**, not single-model speed. Cross-issue throughput
already exists (`pipeline:loop`, queue). What is missing is **intra-stage, read-only fan-out** at
the reviewer seam: multiple independent harnesses reading the same worktree, each emitting a
verdict, with findings union-merged into the **existing** single disposition surface.

Review is the highest-leverage insertion point because:

- plan-review / review-1 / review-2 already share prompt-carried context,
- `partitionFindings` already merges multi-finding sets under policy,
- harness adapters already support multiple CLIs,
- writers (implement/fix) must **not** share a worktree concurrently.

Related landed work: #39 self-review, #40/`configurable-review-harness`, #608 harness roles,
scoreboard self-review tracking. Explicitly deferred to v1.36: #694 (quorum/lineage accounting) and
#692 (immutable evidence subject binding).

## Goals / Non-Goals

**Goals:**

1. Config opt-in ensemble (default **off**) so existing repos see no cost/latency change.
2. Concurrent read-only agent invokes at the shared reviewer seam for plan-review, review-1, and
   review-2 (and any other `invokeReviewer` consumer, including SHA-gate re-review when that path is
   used).
3. Union-merge findings + `findingKey` dedupe; rigor-first blocking (no majority-vote approve).
4. Deterministic severity/confidence merge when the same key appears from multiple agents.
5. Soft-fail when ≥1 agent is usable; fail-closed when zero usable agents.
6. Per-agent self-review fallback, labeled; multi-agent identity on the single disposition artifact.
7. Scoreboard/accounting for ensemble size, per-agent cost, and merge summary.
8. Pure merge helpers + injected invoke fakes for unit tests; `plugin/` mirror + `npm run ci`.

**Non-Goals:**

- Parallel implement/fix writers on one worktree.
- Parallel stage labels or multi-PR-per-issue.
- Majority-vote approve / confidence averaging that demotes rigor.
- Design-gate multi-challenger and shipcheck multi-judge.
- Changing `partitionFindings` phase order beyond accepting a merged finding list.
- #694 independent-quorum enforcement and #692 evidence-subject binding (follow-ups).

## Decisions

### Decision 1 — Fan-out at (or immediately wrapping) `invokeReviewer`, not per-stage forks

**Chosen:** Implement ensemble orchestration as a single shared function used by all current
`invokeReviewer` call sites — either by expanding `invokeReviewer` itself or by a thin
`invokeReviewEnsemble` that stages call when ensemble is enabled and that reuses per-agent
`invokeReviewer` (so #39 self-review stays per-agent). Prefer the wrapper shape so the single-agent
path remains byte-for-byte the existing function when ensemble is off.

**Rejected:** Duplicating fan-out inside `planning.ts` / `review-routing.ts` / SHA-gate separately
(drift risk). **Rejected:** Fan-out only for review-1/2 and not plan-review (issue requires all
three; shared seam is simpler).

**Why.** One seam, one test surface, self-review stays local to each agent, SHA-gate re-review
inherits rigor when ensemble is on without a second protocol.

### Decision 2 — Config shape: `review_ensemble` opt-in block

**Chosen (illustrative; exact Zod lands in implementation):**

```yaml
review_ensemble:
  enabled: false
  agents:
    - role: primary          # resolves to cfg.harnesses.reviewer (+ model/effort)
    - harness: claude        # additional agent; optional model/effort overrides
  # merge mode fixed to union_blocking in v1 (no config switch that can demote rigor)
  min_usable_agents: 1       # soft-fail threshold; fail-closed when usable < this (default 1)
  max_agents: <small cap>    # hard upper bound (e.g. 4) to bound cost
  agent_timeout_sec: optional override; else existing review/plan_review timeouts
```

- `role: primary` is the configured reviewer (respects `review_harness` / `harnesses.reviewer`).
- Additional agents name a harness string (built-in or custom CLI), optional model/effort.
- Default `enabled: false` / absent block → zero behavioral change.
- Validation: at least one agent when enabled; no empty harness strings; cap length; reject unknown
  merge modes if any field is reserved.

**Rejected:** Implicit ensemble from “multiple harnesses on PATH” (non-deterministic, surprising cost).
**Rejected:** Config switch for majority-vote merge in v1 (rigor-demoting footgun).

### Decision 3 — Concurrent execution with `Promise.allSettled` (or equivalent)

**Chosen:** Launch all agent invokes concurrently; wait for all to settle (or per-agent timeout
already enforced by harness invoke). Bound concurrency by agent count (small N) rather than a
worker pool.

**Rejected:** Sequential multi-review (defeats the point). **Rejected:** First-success short-circuit
(would drop findings from slower agents).

**Why.** Read-only agents share a worktree safely; wall-clock ≈ slowest agent, not sum.

### Decision 4 — Usable agent definition and partial failure

**Chosen:** An agent is **usable** when its harness result is successful **and** yields a
parseable structured verdict (same conservative parse path as today: JSON / prose fallback;
unparseable → not usable for merge, but raw diagnostics may be retained). Soft-fail: if
`usable.length >= min_usable_agents` (default 1), merge those verdicts and attach
`agent_failures[]` diagnostics for the rest. Fail-closed: if `usable.length < min_usable_agents`,
block the stage with an error naming every agent and failure class — **never** silent approve.

**Rejected:** Hard-fail the whole ensemble if any agent fails (makes ensemble strictly worse than
single-reviewer availability). **Rejected:** Soft-fail with zero usable agents (silent approve risk).

### Decision 5 — Union merge, `findingKey` dedupe, deterministic field merge

**Chosen pure function** (e.g. `mergeEnsembleVerdicts(agentVerdicts[]): MergedVerdict`):

1. Concatenate all findings from usable agents.
2. Group by `findingKey(f)` (single implementation in `review-policy.ts`).
3. Within a key group:
   - **Severity:** max by `severityRank` (critical > high > medium > low).
   - **Confidence:** **max** among members of the group (keeps the strongest claim; does not
     average down a high-confidence blocker with a low-confidence echo). Documented and unit-tested.
   - **Title/body/recommendation:** prefer the finding that contributed the winning severity; on
     severity ties prefer higher confidence; on full ties prefer first agent in config order
     (deterministic).
   - **Line range / file:** prefer the winner’s location fields; do not invent ranges.
   - Retain `payload_fingerprint` on the **chosen** finding for downstream settled-surface /
     disambiguation (same as single-reviewer path).
4. **Top-level verdict string for routing input:**
   - If any usable agent produced findings that survive into the merged list, treat the merged
     verdict as `needs-attention` when any finding exists (or more precisely: pass merged findings
     into existing `partitionFindings`; routing remains policy-driven). Do **not** set `approve`
     solely because a majority (or any single agent) approved while another agent contributed
     findings.
   - If **all** usable agents approve with zero findings, merged verdict is `approve` with empty
     findings.
5. Summary text: short merge summary (agent count, usable count, failure diagnostics) plus optional
   concatenation of agent summaries truncated for comment size — exact wording is implementation
   detail; tests assert presence of multi-agent identity, not prose style.

**Rejected:** Majority vote on `approve`. **Rejected:** Confidence average (can demote a 0.95
blocker with a 0.2 echo). **Rejected:** Min confidence for blockers (over-demotes when one agent
is uncertain but another is certain of a real issue — max preserves the stronger claim; policy
`min_confidence` still filters after merge).

**Note on confidence max:** After merge, `partitionFindings` still applies `min_confidence`. A
duplicate that only one agent reported at high confidence remains high; a sole low-confidence
finding stays advisory under policy. This is rigor-preserving relative to majority-vote demotion.

### Decision 6 — Single disposition surface; multi-agent audit identity

**Chosen:** Post **one** review comment / one review-round artifact per stage, same schema version
family as today. Extend the round record with:

- `ensemble: { size, usable, merge: "union_blocking", agents: [{ role?, harness, effectiveHarness,
  model?, selfReview, costUsd?, status: "usable"|"failed", failureClass? }] }`
- Findings list = **merged** set only (not N copies).
- Self-review banner: if **any** agent is self-review, disclosure remains required; wording may
  name which agent(s) fell back without inventing a second comment protocol.

**Rejected:** N GitHub review comments (breaks override/SHA-gate/settled-surface parsers).
**Rejected:** Changing `schema_version` to a new major solely for ensemble (prefer additive optional
fields so single-agent runs stay `schema_version` compatible per existing finding-records rules).

### Decision 7 — Prompt identity: shared material, optional role suffix only

**Chosen:** All agents receive the same prompt body (same schema block, diff, plan, context). An
optional short identity suffix (e.g. “You are ensemble agent B (claude)”) MAY be appended for
auditability; agents MUST NOT receive divergent untrusted context (no different issue bodies,
no private prior findings from other agents in v1 — independence preserved).

**Rejected:** Feeding agent A’s findings into agent B in the same round (creates coupling and
hides independent miss rates; multi-round memory already exists for review-2).

### Decision 8 — Scoreboard accounting

**Chosen:** When ensemble data is present on a review round, scoreboard SHALL:

- count harness invocations / cost across **all** agents (not only primary),
- record ensemble size and usable/failure counts as diagnostics or metrics fields,
- continue to count same-harness fallbacks **per agent** (existing self-review rate remains
  meaningful).

Single-agent runs stay valid inputs with no ensemble fields.

### Decision 9 — Test strategy

**Chosen:**

| Layer | What |
| --- | --- |
| Pure merge unit tests | Two verdicts → union + key dedupe; max severity; max confidence; blocking from either agent; all approve → approve; empty usable → fail-closed signal |
| Orchestration unit tests | Injected invoke fakes: concurrent call count == agent count; timeout/spawn_error partial path; self-review flag per agent; disabled config → single invoke |
| Config tests | Schema `.describe()`, defaults, invalid agents, enabled with empty list rejects |
| Regression | Existing single-reviewer paths unchanged when ensemble off |

No real network/git/subprocess in unit suite (repo convention).

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| **Cost/latency** when enabled | Default off; small `max_agents`; concurrent wall-clock ≈ max agent, not sum |
| **Noisy false positives** from union | Policy `block_threshold` / `min_confidence` / overrides still apply; confidence max does not invent findings; future #694 can add risk-based quorum without undoing union default |
| **Worktree contention** if a “reviewer” mutates | Review prompts already require read-only; preflight/smoke reviewer contracts assert no mutation; ensemble does not grant write |
| **Dedupe hides distinct bugs at same key** | Existing `payload_fingerprint` disambiguation remains for same-key distinct payloads; merge picks one canonical body by severity/confidence/order — document that operators can still see agent diagnostics; do not invent a second key algorithm |
| **SHA-gate inherits ensemble cost** | Acceptable for rigor; operators who enable ensemble opt into that cost; document in config describe |
| **Partial parse success shapes differ** | Define usable = successful + parseable; unparseable counts as agent failure diagnostic |
| **Config footguns** | No majority-vote mode in v1; strict Zod; init template comments |

## Migration Plan

1. Land config schema + defaults (`enabled: false`) with no call-site behavior change.
2. Land pure merge helper + unit tests (can ship behind flag).
3. Wire orchestration wrapper; stages already go through shared invoke.
4. Extend comment/artifact identity + scoreboard readers (additive fields).
5. Template/docs note for operators who opt in.
6. Rollback: set `enabled: false` or remove block — single-reviewer path restored.

No data migration; no label machine change; no break of override key format.

## Open Questions

1. **Exact `max_agents` default cap** — recommend 4 unless implementation finds a stronger existing
   constant; pin in config tests.
2. **Whether agent identity suffixes are mandatory in prompts** — optional for v1; independence
   does not require them; audit prefers recording identity in the artifact either way.
3. **Comment size when many agent summaries exist** — prefer compact merge summary + per-agent
   status lines over full N-way summary dump; exact truncation policy can follow existing review
   comment size practices during implementation.
4. **#694 / #692 integration points** — leave explicit hooks (ensemble agent list + merge mode in
   the round record) so quorum/evidence-subject work can attach later without rewriting fan-out.
