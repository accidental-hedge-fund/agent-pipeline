# review-ensemble Specification

## Purpose
TBD - created by archiving change review-ensemble-parallel-harnesses. Update Purpose after archive.
## Requirements
### Requirement: Review ensemble config SHALL be opt-in and default off

The pipeline config schema SHALL accept an optional `review_ensemble` object. When the block is
absent or `enabled` is false, every review round that uses the shared reviewer invoke seam SHALL
invoke exactly one reviewer agent and SHALL preserve today’s single-reviewer latency, cost, and
disposition behavior. When `enabled` is true, the engine SHALL resolve an ordered agent list and
run the ensemble path defined by the other requirements in this capability.

The schema SHALL reject invalid ensemble configuration at config-resolve time with an actionable
message (empty agent list when enabled, empty harness string, agent count above the configured
maximum, unknown merge mode if a merge field is present, or `stage_executors` assignments for
plan-review / review-1 / review-2 while ensemble is enabled). v1 SHALL support only
union-blocking merge semantics and SHALL NOT expose a majority-vote approve mode.

#### Scenario: ensemble disabled is a no-op

- **WHEN** `review_ensemble` is absent or `enabled: false`
- **AND** a plan-review, review-1, or review-2 round runs
- **THEN** the engine SHALL invoke exactly one reviewer path
- **AND** SHALL NOT launch additional ensemble agents

#### Scenario: ensemble enabled resolves agent list

- **WHEN** `review_ensemble.enabled` is true and `agents` lists a primary role agent and one
  additional harness agent
- **THEN** config resolution SHALL succeed
- **AND** the ensemble agent list SHALL include the configured primary reviewer and the additional
  harness in config order

#### Scenario: enabled with empty agents is rejected

- **WHEN** `review_ensemble.enabled` is true and `agents` is empty or missing
- **THEN** config resolution SHALL fail with a message that names `review_ensemble` and the empty
  agent list

#### Scenario: majority-vote merge mode is not available

- **WHEN** an operator supplies a merge mode other than the v1 union-blocking semantics (if a
  merge field exists in schema)
- **THEN** config resolution SHALL reject the configuration
- **AND** the engine SHALL NOT provide a majority-vote approve configuration path

#### Scenario: stage_executors on review seam stages is rejected when ensemble is enabled

- **WHEN** `review_ensemble.enabled` is true
- **AND** `stage_executors` assigns plan-review, review-1, or review-2
- **THEN** config resolution SHALL fail with a message that names `review_ensemble` and the
  conflicting stage_executors assignment(s)
- **AND** the engine SHALL NOT silently run a single stage executor in place of ensemble fan-out

---

### Requirement: Ensemble fan-out SHALL run independent read-only agents concurrently at the shared reviewer seam

When ensemble is enabled, the engine SHALL fan out at the shared reviewer invoke seam used by
plan-review, review-1, and review-2 (the `invokeReviewer` seam in `self-review.ts` /
`review-routing.ts` and any wrapper that replaces a single call there). Each agent SHALL be a
read-only harness or custom reviewer CLI invoke against the same worktree/cwd and the same prompt
material (optional identity/role suffix only; no divergent untrusted context). Agents SHALL run
concurrently (for example via `Promise.allSettled` or equivalent). Agent count and timeouts SHALL
be bounded by configuration (maximum agents; per-agent or stage timeout).

Pre-merge SHA-gate re-review that already uses the same shared invoke seam SHALL inherit ensemble
when ensemble is enabled, without introducing a second multi-verdict comment protocol.

#### Scenario: concurrent multi-agent invoke

- **WHEN** ensemble is enabled with N agents and a review round starts
- **THEN** the engine SHALL start N agent invokes against the same worktree
- **AND** SHALL wait for all agents to settle before merge
- **AND** unit tests with injected invoke fakes SHALL observe N concurrent calls for that round

#### Scenario: shared prompt material

- **WHEN** two ensemble agents run for the same round
- **THEN** both SHALL receive the same core review prompt content (schema block, diff/plan/context)
- **AND** any prompt difference SHALL be limited to an optional identity/role suffix
- **AND** neither agent SHALL receive the other agent’s findings as input in the same round

#### Scenario: plan-review and both code-review rounds use the seam

- **WHEN** ensemble is enabled
- **THEN** plan-review, review-1, and review-2 SHALL each use the ensemble fan-out path for their
  reviewer invoke
- **AND** the engine SHALL NOT require separate stage labels or multi-PR protocols for ensemble

---

### Requirement: Per-agent self-review fallback SHALL remain labeled and local to that agent

Each ensemble agent SHALL apply the existing same-harness self-review fallback (#39) independently:
only a `spawn_error` on that agent’s configured CLI may fall back to the implementing harness for
**that** agent. A successful self-review for one agent SHALL NOT force self-review on other agents.
Each self-review SHALL remain labeled in the ensemble agent identity record and in the posted
disposition disclosure when any agent used self-review.

#### Scenario: one agent falls back, another does not

- **WHEN** agent A’s configured CLI spawn-fails and agent B’s configured CLI succeeds
- **THEN** agent A MAY complete via implementer self-review when the implementer is spawnable and
  distinct
- **AND** agent B SHALL remain a non-self-review independent reviewer
- **AND** the ensemble identity record SHALL mark only agent A as self-review

#### Scenario: self-review disclosure still required

- **WHEN** any ensemble agent completed via same-harness self-review
- **THEN** the single posted review disposition for the round SHALL disclose self-review
- **AND** SHALL name the agent(s) or harness(es) that fell back so operators do not treat the
  round as fully independent cross-harness review

---

### Requirement: Ensemble findings SHALL be union-merged and deduped by findingKey with rigor-first blocking

The engine SHALL merge usable agent verdicts by **union** of findings, then dedupe by the existing
`findingKey` implementation in `review-policy.ts` (and existing ambiguity / payload-fingerprint
rules for same-key distinct payloads). The engine SHALL NOT majority-vote the top-level `approve`
outcome. Any finding that appears in any usable agent’s verdict SHALL appear in the merged finding
set (subject only to key-level field merge, not to voting it away). After merge, existing
`partitionFindings` and review policy SHALL decide blocking vs advisory; a policy-blocking finding
contributed by any single agent SHALL still block unless dispositioned by an active override or
settled-surface rule.

#### Scenario: union keeps a finding only one agent reported

- **WHEN** agent A reports no findings and agent B reports a high-severity finding at file F
- **THEN** the merged finding set SHALL include B’s finding
- **AND** under the default policy that finding SHALL be eligible to block routing to fix

#### Scenario: findingKey dedupe collapses location-equivalent findings

- **WHEN** agent A and agent B both emit findings that share the same `findingKey`
- **THEN** the merged finding set SHALL contain exactly one finding for that key (plus any
  same-key distinct payload handling already defined by finding-record fingerprint rules)
- **AND** the engine SHALL NOT invent a second finding-identity algorithm for ensemble

#### Scenario: no majority-vote approve

- **WHEN** agent A returns `approve` with zero findings and agent B returns `needs-attention` with
  a policy-blocking finding
- **THEN** the round SHALL NOT advance as approved solely because A approved
- **AND** the merged disposition path SHALL treat B’s blocking finding as blocking under the active
  policy unless overridden

#### Scenario: all agents approve with zero findings

- **WHEN** every usable agent returns `approve` with an empty findings list
- **THEN** the merged verdict SHALL be `approve` with an empty findings list
- **AND** the stage SHALL advance as a normal approve under existing routing

---

### Requirement: Same-key field merge SHALL be deterministic (max severity, max confidence)

When multiple findings share a `findingKey` during ensemble merge, the engine SHALL produce one
canonical finding with:

- **severity** equal to the maximum `severityRank` among the group (critical > high > medium > low),
- **confidence** equal to the maximum numeric confidence among members that supply confidence
  (absent confidence does not force a zero; documented pure-function behavior MUST be unit-tested),
- **title/body/recommendation/location** taken from the member that contributed the winning
  severity, breaking ties by higher confidence then by earlier agent config order.

The merge SHALL NOT average confidences and SHALL NOT demote a higher severity to a lower one
because another agent reported the same key more weakly.

#### Scenario: max severity wins

- **WHEN** agent A reports severity `medium` and agent B reports severity `high` for the same
  `findingKey`
- **THEN** the merged finding’s severity SHALL be `high`

#### Scenario: max confidence wins

- **WHEN** two findings share a `findingKey` and report confidences `0.4` and `0.9` at the same
  severity
- **THEN** the merged finding’s confidence SHALL be `0.9`

#### Scenario: tie break is deterministic

- **WHEN** two findings share a `findingKey`, severity, and confidence
- **THEN** the merged body fields SHALL come from the earlier agent in the configured agent list
- **AND** repeating the merge on the same inputs SHALL yield an identical result

---

### Requirement: Partial ensemble failure SHALL soft-fail when min usable agents succeed and fail closed otherwise

The engine SHALL soft-fail an ensemble round when at least `min_usable_agents` (default 1) agents
are usable, and SHALL fail closed when fewer than that many agents are usable. An agent is
**usable** when its harness invoke succeeds and its output yields a parseable structured verdict
under the existing conservative parse path. When soft-failing, the engine SHALL merge the usable
agents’ findings, proceed to the single disposition path, and record non-usable agents as
diagnostics (failure class such as spawn_error, timeout, nonzero exit, or unparseable). When
failing closed (including zero usable agents under the default), the stage SHALL block the item
with an error naming the failed agents and SHALL NOT treat the round as an approve.

#### Scenario: one usable agent among two proceeds with diagnostics

- **WHEN** ensemble has two agents, agent A returns a usable verdict, and agent B times out
- **THEN** the engine SHALL merge using agent A only
- **AND** SHALL record agent B’s failure as a diagnostic on the round
- **AND** SHALL NOT drop agent A’s findings

#### Scenario: zero usable agents fail closed

- **WHEN** every ensemble agent fails or is unparseable
- **THEN** the review stage SHALL block
- **AND** SHALL NOT post or route an approve verdict
- **AND** the error or block record SHALL name the agents that failed

#### Scenario: unparseable output is not usable

- **WHEN** an agent exits successfully but its stdout cannot be parsed into a structured verdict
- **THEN** that agent SHALL NOT count as usable for merge
- **AND** the failure diagnostic SHALL indicate unparseable or equivalent

---

### Requirement: Ensemble SHALL produce one disposition surface with multi-agent audit identity

Each ensemble review round SHALL post exactly one review comment / review artifact for disposition
purposes and SHALL expose exactly one merged finding set and one blocking-key set to fix rounds,
ceiling, settled-surface matching, overrides, and pre-merge SHA-gate consumers. The round record
SHALL include per-agent identity for audit: configured harness, effective harness, model when
known, self_review flag, cost when known, and usable/failed status. Schema changes for these
fields SHALL be additive so single-agent rounds remain valid.

#### Scenario: single comment for multi-agent round

- **WHEN** an ensemble round with two usable agents completes
- **THEN** the engine SHALL post one disposition review comment for that round
- **AND** SHALL NOT require operators to reconcile N independent approve/block comments

#### Scenario: downstream sees one finding set

- **WHEN** ensemble merge produces three distinct findings after dedupe
- **THEN** fix / ceiling / override / settled-surface consumers for that round SHALL observe those
  three findings (and their keys) as the round’s sole finding set

#### Scenario: multi-agent identity is recorded

- **WHEN** an ensemble round completes with agents codex and claude
- **THEN** the persisted round identity SHALL list both agents with harness and self_review fields
- **AND** SHALL record ensemble size and usable/failed counts or equivalent merge summary fields

---

### Requirement: Ensemble unit tests SHALL cover merge, fail-closed, concurrency, and self-review labeling

The implementation SHALL include unit tests that inject harness invoke fakes and perform no real
network, git, or subprocess I/O. Tests SHALL prove at least: union + `findingKey` dedupe; blocking
finding from either agent blocks under policy; all agents fail → fail-closed; one agent self-review
labeled while ensemble records both identities; concurrent call count equals agent count;
timeout/partial-failure soft-fail path with diagnostics.

#### Scenario: merge unit test bites without orchestration

- **WHEN** the pure merge helper is unit-tested with two synthetic verdicts that share one key and
  differ on a second finding
- **THEN** the test SHALL assert one deduped key and one union-only finding
- **AND** SHALL fail if merge drops the union-only finding

#### Scenario: orchestration tests use injected invoke

- **WHEN** ensemble orchestration tests run
- **THEN** they SHALL inject fake invoke functions
- **AND** SHALL perform no real network, git, or subprocess calls

