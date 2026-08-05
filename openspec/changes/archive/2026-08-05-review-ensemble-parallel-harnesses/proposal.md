## Why

Review stages (`plan-review`, `review-1`, `review-2`) invoke **one** reviewer via `invokeReviewer` and advance on that single verdict. Cross-harness independence is valuable, but a single model still misses bugs, over-blocks, or under-blocks. Operators who want higher rigor have no first-class way to run **multiple independent reviewers in parallel**, union-merge their findings, and keep the existing single-disposition path (fix / approve / ceiling / needs-human). Throughput parallelism already exists across issues; what is missing is **intra-stage, read-only fan-out** at the reviewer seam — without multi-writer worktrees or a second state machine.

## What Changes

- **Opt-in review ensemble (default off).** A new config block (`review_ensemble`) lets operators list N agents (primary role + additional harness/custom CLIs). When disabled or absent, latency/cost and behavior are unchanged.
- **Read-only parallel fan-out at the shared reviewer invoke seam.** For plan-review, review-1, and review-2 (and any other caller of the shared `invokeReviewer` path, including pre-merge SHA-gate re-review when that path is used), each configured agent runs concurrently against the same worktree/cwd and the same prompt material (identity/role suffixes only). Agents are bounded by config (max agents, timeout).
- **Union-merge findings, rigor-first.** Findings are union-merged then deduped by existing `findingKey` (and existing ambiguity/fingerprint rules). **No majority-vote approve.** Any agent’s blocking finding (after policy) still blocks unless dispositioned. Severity/confidence merge is deterministic (documented and tested).
- **Partial failure is soft when ≥1 agent is usable.** If at least one agent returns a usable verdict, the stage proceeds with successful agents and records failed agents as diagnostics. If **zero** usable agents, the stage fails closed (no silent approve).
- **Per-agent self-review fallback (#39) preserved.** A missing CLI may fall back to the implementer for **that** agent only and remains labeled; ensemble identity records both the configured and effective harnesses.
- **Single disposition surface.** One review comment / review artifact schema version per round; include per-agent identity (harness, model, self_review, cost) for audit/scoreboard. Fix rounds, ceiling, settled-surface, override, and pre-merge SHA gate continue to see **one** finding set.
- **Scoreboard / accounting.** Record ensemble size, per-agent costs, and merge summary (not only the “primary” harness).
- **Tests and mirror.** Unit tests for merge/dedupe/blocking/all-fail/self-review labeling and concurrent-call partial failure; `npm run ci` green; regenerate `plugin/` after any `core/` edit.

**Non-goals (explicit):**

- Parallel **writers** on implement/fix (same worktree) — rejected; use loop/queue for multi-issue scale.
- Parallel stage labels or multi-PR per issue.
- Majority-vote approve / confidence averaging that can demote rigor.
- Design-gate multi-challenger and shipcheck multi-judge (natural follow-ups; not this issue).
- Changing `partitionFindings` phase order except as required to accept merged input.
- Provider/model/authoring lineage, independent-quorum accounting, risk-based quorum enforcement (#694), and shared immutable evidence-subject binding (#692) — those are v1.36 follow-ups that audit ensemble coverage without delaying this core fan-out/merge surface.

## Capabilities

### New Capabilities

- `review-ensemble`: Config-gated parallel multi-agent review at the shared `invokeReviewer` seam; concurrent read-only agent invokes; union-merge + `findingKey` dedupe; rigor-first blocking (no majority-vote approve); deterministic severity/confidence merge; partial-failure soft-fail when ≥1 usable agent and fail-closed when zero; per-agent self-review labeling; single disposition surface with multi-agent audit identity; ensemble size / per-agent cost / merge summary for accounting.

### Modified Capabilities

- `review-finding-records`: A review round MAY record an ensemble of agent identities (harness, model, self_review) and merge diagnostics instead of only a single effective reviewer, while remaining schema-version-compatible and still producing one finding set per round.
- `factory-scoreboard`: Scoreboard metrics and diagnostics SHALL account for ensemble size, per-agent harness costs, and same-harness fallbacks **per agent** when ensemble data is present — not only a primary harness.
- `review-layer`: When ensemble is disabled/absent, existing single-reviewer behavior is unchanged; when enabled, the structured verdict that drives comment posting and routing is the **merged** ensemble verdict (still one disposition per round).

## Impact

- `core/scripts/self-review.ts` — fan-out / ensemble orchestration at (or immediately around) `invokeReviewer`
- `core/scripts/stages/review-routing.ts`, `stages/planning.ts`, and any other `invokeReviewer` callers — consume ensemble invocation result and multi-agent identity for comment/persistence
- Merge helper (new pure module or co-located) — union + `findingKey` dedupe, severity/confidence rule, usable-agent accounting
- `core/scripts/config.ts` + init template — `review_ensemble` schema with `.describe()`, defaults off, exhaustive template tests
- Review comment formatting / run-artifact persistence — one artifact; per-agent identity + merge diagnostics
- `core/scripts/scoreboard.ts` — ensemble size, per-agent cost, merge summary
- Unit tests under `core/test/` with injected invoke fakes (no real network/git/subprocess)
- Regenerate `plugin/` after `core/` changes; `npm run ci` green
- No change to merge authority, `partitionFindings` policy order, or autonomous-merge policy

## Acceptance criteria

Observable, falsifiable outcomes that make #645 done:

- [ ] With `review_ensemble` absent or `enabled: false`, plan-review / review-1 / review-2 invoke exactly one reviewer and produce the same single-disposition behavior as today (no extra harness calls, no latency/cost regression from ensemble).
- [ ] With ensemble enabled and two agents configured, a single review round concurrently invokes both agents against the same worktree and shared prompt material and posts **one** review comment/artifact containing the merged finding set (not two independent disposition comments).
- [ ] Union-merge + `findingKey` dedupe: two agents emitting the same location-addressed finding produce one finding in the disposition set; a blocking finding present in only one agent’s verdict still appears in the merged set and blocks under the active policy unless overridden.
- [ ] No majority-vote approve: if agent A returns `approve` (or only advisory findings) and agent B returns a policy-blocking finding, the round does **not** advance as approved solely because A approved — the blocking finding still routes to fix / ceiling / needs-human as today.
- [ ] Severity/confidence merge is deterministic and unit-tested (max severity wins; documented confidence rule for blockers) with no silent demotion of a higher-severity duplicate.
- [ ] Partial failure: when ≥1 agent returns a usable verdict and others fail (spawn_error/timeout/unparseable), the stage proceeds with successful agents, records failures as diagnostics on the round, and does not silently drop successful findings; when **zero** agents are usable, the stage fails closed (blocks; never silent approve).
- [ ] Per-agent self-review: a missing configured CLI for one agent falls back to the implementer for **that** agent only, is labeled as self-review, and the ensemble record still lists every agent’s configured and effective identity.
- [ ] Downstream consumers of the round (fix, ceiling, settled-surface, override matching, pre-merge SHA gate input) see exactly one finding set / blocking-key set for the round — no multi-verdict comment protocol.
- [ ] Scoreboard / run accounting records ensemble size, per-agent costs (when available), and a merge summary when ensemble ran; single-reviewer runs remain valid scoreboard inputs.
- [ ] Config schema rejects invalid ensemble configs with actionable errors; init/template coverage documents the opt-in block; unit tests cover merge, all-fail fail-closed, concurrent call count, and partial-failure paths with injected invoke fakes.
- [ ] `npm run ci` is green; any `core/` change regenerates and commits the `plugin/` mirror.
