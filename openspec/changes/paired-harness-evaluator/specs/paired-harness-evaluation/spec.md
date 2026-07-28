## ADDED Requirements

### Requirement: Explicit named treatments SHALL encode valid harness-specific configurations

An experiment manifest MAY declare a non-empty `named_treatments` array instead of Cartesian `treatments`. Every named treatment SHALL carry a unique, path-safe `id` and a `primary` coordinate containing a harness plus optional model and effort. A `paired` treatment SHALL also carry a reviewer coordinate. The runner SHALL reject a manifest that declares both treatment forms, duplicate ids, a missing required paired reviewer, or an invalid coordinate before creating a worktree or invoking a harness.

#### Scenario: Named pair treatments avoid invalid cross-products

- **WHEN** a manifest names `codex-grok` with a Codex primary coordinate and a Grok reviewer coordinate
- **THEN** the expanded plan contains exactly that treatment
- **AND** it SHALL NOT create a cell that sends the Grok model to Codex or vice versa

### Requirement: A paired cell SHALL execute an isolated primary-reviewer trajectory

A paired cell SHALL require an implementing fixture artifact and, in one fresh worktree at the fixture base commit, invoke its primary implementation, provide its reviewer the resulting actual diff and structured review contract, invoke the primary with blocking findings when present, and invoke the reviewer again against the final diff. The cell SHALL use one shared deadline, SHALL perform no production GitHub write, and SHALL run declared checks only against the final worktree state.

#### Scenario: Reviewer sees the produced diff

- **WHEN** the primary changes files during paired implementation
- **THEN** the reviewer prompt SHALL contain the diff derived from that paired cell's worktree
- **AND** SHALL NOT substitute a static fixture review artifact

#### Scenario: No blocking finding skips the fix invocation

- **WHEN** the first reviewer verdict contains no blocking finding
- **THEN** the primary fix invocation SHALL be skipped
- **AND** the final check and paired result records SHALL still be emitted

### Requirement: Paired results SHALL record convergence without inventing review accuracy

A completed paired cell SHALL record requested primary and reviewer coordinates, phase outcomes, first and final diff identities, both reviewer finding sets, whether a fix invocation occurred, and the final blocking-finding count. It SHALL expose final checks and changed paths for deterministic implementation grading. It SHALL NOT report reviewer precision or recall unless a separate seeded-review grade actually supplies that evidence.

#### Scenario: Malformed reviewer output is visible

- **WHEN** a paired reviewer does not emit a parseable verdict
- **THEN** the cell record SHALL retain the output and mark the review outcome malformed
- **AND** SHALL NOT treat it as approval

### Requirement: A pipeline-paired treatment SHALL encode and execute a deployable repository policy

The evaluator SHALL reject a pipeline-paired treatment that cannot be expressed
as a complete repository model-routing policy.

An experiment manifest MAY declare `mode: "pipeline-paired"`. Such a named
treatment SHALL declare primary and reviewer harnesses plus a complete
`policy.models` and `policy.effort` object containing exactly `planning`,
`implementing`, `review`, and `fix`. The runner SHALL reject a missing slot or
a model/effort placed on the primary role coordinate instead of in the policy.
The reviewer coordinate MAY declare `model` and/or `effort` to represent the
deployable structured `review_harness` overrides. In one isolated worktree it
SHALL execute primary planning, secondary plan-review, primary plan revision,
primary implementation using that revised plan, secondary review-1, an
optional primary fix-1, secondary review-2, and an optional primary fix-2.
Every invocation SHALL use the corresponding production prompt builder.
Implementation and fix prompts MAY append an evaluation-only execution
override that disables commit, push, and GitHub publication while preserving
the production task, quality, safety, review, and validation contract.

Planning SHALL require non-empty output. Plan-review SHALL require the exact
`## Plan Review Verdict` heading. Plan revision SHALL pass the production
feedback-incorporation verifier before implementation begins. Review-1 SHALL
use the production standard-review contract; review-2 SHALL use the
production adversarial-review contract and receive the formatted review-1
context. Blocking findings SHALL be selected through the production review
policy.

`policy.models.review` SHALL be used for plan-review and both review rounds;
`policy.effort.planning` SHALL be used for planning and plan-review;
`policy.effort.review` SHALL be used for both review rounds; and
`policy.models`/`policy.effort.fix` SHALL be used for every fix round. When the
reviewer coordinate declares a model or effort, that value SHALL override the
corresponding policy value for plan-review and both review rounds, matching
structured `review_harness.model` / `review_harness.effort`.

#### Scenario: A full-pipeline policy preserves YAML slot coupling

- **WHEN** a Grok primary / Codex secondary pipeline-paired treatment sets
  `policy.models.review` to `gpt-5.6-terra`, `policy.effort.planning` to
  `high`, and `policy.effort.review` to `xhigh`
- **THEN** plan-review receives Codex / `gpt-5.6-terra` / `high`
- **AND** both code-review rounds receive Codex / `gpt-5.6-terra` / `xhigh`
- **AND** the implementation prompt contains the actual revised plan rather
  than a frozen implementing artifact

#### Scenario: Production stage contracts gate live handoffs

- **WHEN** plan-review omits its required verdict heading or plan revision
  omits its feedback-incorporation acknowledgement
- **THEN** the cell records a completed contract failure at that stage
- **AND** SHALL NOT invoke implementation or later stages

#### Scenario: Review-2 is adversarial and context-aware

- **WHEN** review-1 completes and the cell reaches review-2
- **THEN** review-1 uses the production standard-review prompt
- **AND** review-2 uses the production adversarial-review prompt with the
  formatted review-1 context

### Requirement: Pipeline-paired evidence SHALL distinguish reviewed state from post-fix state

A completed pipeline-paired result SHALL label review-2 findings and blocking
counts as review-2/pre-fix-2 evidence. It SHALL record the final post-fix-2
diff identity separately and SHALL NOT describe review-2 findings as final
post-fix-2 convergence. Comparative reporting SHALL count strict, tolerant,
and unparseable verdicts separately for each review round and SHALL derive
named-treatment grouping dimensions from the resolved treatment object rather
than parsing its arbitrary id. A non-authentication harness-stage failure
SHALL remain a completed treatment outcome with explicit stage-failure
evidence; it SHALL NOT be reclassified as evaluator infrastructure failure.

#### Scenario: Fix-2 does not fabricate a final review

- **WHEN** review-2 produces blocking findings and the primary runs fix-2
- **THEN** the result records `review_2_blocking_findings` against the
  pre-fix-2 diff and `final_diff_hash` against the post-fix-2 state
- **AND** SHALL NOT claim those findings describe the post-fix-2 state

#### Scenario: Structured reviewer effort overrides incompatible planning effort

- **WHEN** a Codex primary / Grok secondary treatment sets
  `policy.effort.planning` to `max` and the reviewer coordinate sets
  `model: grok-4.5` and `effort: high`
- **THEN** primary planning receives Codex / `max`
- **AND** plan-review plus both review rounds receive Grok / `grok-4.5` / `high`
