# review-layer Specification

## Purpose
The foundational review behavior: a two-round review (standard `review-1`, adversarial `review-2`) driven by a pluggable backend selected by `reviewMode` (default `prompt-harness` — the reviewer CLI invoked directly with the pipeline's JSON-returning prompt; companion modes optional), with structured-verdict parsing that fails conservatively so findings are never silently dropped, and verdict-driven routing. (SHA-binding of verdicts is refined by `review-sha-gating`; the zero-findings re-review/normalization by `verdict-normalization`; post-harness commit invariants by `harness-step-verification`.)
## Requirements
### Requirement: reviewMode selects the review backend
The review backend SHALL be selected by `cfg.review_mode`. `prompt-harness` (the only valid value) SHALL invoke the reviewer-role harness CLI directly with the pipeline's own review prompt and require no companion plugin. The companion modes (`claude-companion`, `codex-companion`) are removed: `isCompanionMode`, `buildCompanionReviewCommand`, and `invokeCompanionReview` SHALL NOT exist in the codebase. The review prompt SHALL be assembled by a prompt-building function that substitutes `{{schema_block}}` with the shared `REVIEW_VERDICT_SCHEMA_BLOCK` constant before sending the prompt to the reviewer.

`parseProseReview` SHALL be retained — it parses Codex's native prose review output into structured findings and is called by the prompt-harness path when the reviewer is `codex`.

#### Scenario: prompt-harness review
- **WHEN** a review round runs with `review_mode: "prompt-harness"`
- **THEN** the reviewer harness CLI SHALL be invoked directly with the JSON-returning review prompt and no companion plugin SHALL be required

#### Scenario: schema block is substituted in the prompt
- **WHEN** the review prompt is assembled for either review round
- **THEN** the `{{schema_block}}` placeholder SHALL be replaced with the current `REVIEW_VERDICT_SCHEMA_BLOCK` text before the prompt is sent

#### Scenario: companion mode is not reachable
- **WHEN** any shipped profile is loaded
- **THEN** there SHALL be no code path that routes review through a companion plugin invocation

### Requirement: Two review rounds with verdict-driven routing
Review SHALL run as two rounds — `review-1` (standard) then `review-2` (adversarial). An `approve`
verdict advances (`review-1`→`review-2`, `review-2`→`pre-merge`). A `needs-attention` verdict's
findings SHALL be evaluated against the repo's `review_policy` (severity threshold, confidence floor)
and any active operator overrides: when at least one finding **blocks**, the issue routes to the
matching fix stage (`review-1`→`fix-1`, `review-2`→`fix-2`) on the blocking subset; when no finding
blocks (all advisory or overridden), the issue advances as if approved with an audited record. Under the
default policy every finding blocks, so routing is unchanged from prior behavior. (The policy and
override semantics are specified by `review-severity-policy`.)

When `review_policy.risk_proportional` is enabled, the `review-2` round SHALL evaluate its findings
against a **risk-scaled effective threshold** rather than the configured `block_threshold` directly: the
`review-1` round's structured risk tier (low when `review-1` approved with zero findings, standard
otherwise) SHALL be captured and propagated to `review-2`, and a **low** tier SHALL raise the effective
`review-2` threshold to the stricter of the configured `block_threshold` and `high`. The scaling SHALL
never produce an effective threshold looser than `high` for a low-risk change, never produce one
stricter than the configured `block_threshold`, and SHALL leave the configured threshold unchanged for
`review-1` and for any standard-risk `review-2`. (The capture, propagation, and effective-threshold
semantics are specified by `review-risk-proportional-blocking`.)

#### Scenario: round 1 approves
- **WHEN** `review-1` returns `approve`
- **THEN** the issue SHALL advance to `review-2`

#### Scenario: round 2 needs attention with a blocking finding
- **WHEN** `review-2` returns `needs-attention` with a finding that blocks under the active policy
- **THEN** the issue SHALL route to `fix-2`

#### Scenario: round 2 needs attention but nothing blocks
- **WHEN** `review-2` returns `needs-attention` with findings that are all advisory or overridden under
  the active policy
- **THEN** the issue SHALL advance to `pre-merge` with an audited "advanced under severity policy" record

#### Scenario: round 2 blocking is risk-scaled when review-1 was low-risk
- **WHEN** `review_policy.risk_proportional` is enabled, `review-1` approved with zero findings, the
  configured `block_threshold` is `medium`, and `review-2` returns `needs-attention` with only
  `medium`-severity findings
- **THEN** the issue SHALL advance to `pre-merge` under the risk-scaled effective threshold rather than
  routing to `fix-2`

### Requirement: Structured verdict parsing with a conservative fallback
`parseStructuredVerdict` SHALL extract a verdict from the reviewer output by trying, in order: a fenced ```json block, an inline `{…"verdict"…}` object, then a recognized Codex prose review. When none parse, it SHALL fall back conservatively — defaulting the verdict to `needs-attention`, emitting a warning, and attaching the raw output (`_raw`) — so a structured verdict is never silently treated as an approval.

#### Scenario: fenced JSON verdict
- **WHEN** the output contains a fenced ```json block with a valid `verdict`
- **THEN** the structured verdict SHALL be returned without the `_raw` fallback marker

#### Scenario: unparseable output
- **WHEN** the output contains no JSON and no recognized prose review
- **THEN** the verdict SHALL default to `needs-attention`, a warning SHALL be logged, and the raw output SHALL be attached as `_raw`

### Requirement: The review comment is posted before routing
The formatted review comment (verdict, summary, findings) SHALL be posted to the issue before any advance or block transition occurs.

#### Scenario: comment precedes the transition
- **WHEN** a review round completes with a parsed verdict
- **THEN** the review comment SHALL be posted before the stage transitions or blocks

### Requirement: Both review prompts SHALL scope findings to the diff and its blast radius

Both `review_standard.md` and `review_adversarial.md` SHALL instruct the reviewer to scope findings to code introduced or modified by the diff and to call sites / callers that are materially affected by those changes (blast radius). Pre-existing code that is neither changed nor a direct blast-radius call site is out of scope and SHALL NOT be the subject of a finding.

This instruction SHALL appear in both prompts before the finding bar / checklist so the reviewer scopes before they assess.

#### Scenario: Reviewer suppresses a finding about unchanged pre-existing code

- **WHEN** the reviewer identifies a potential issue in code that is not in the diff and not a blast-radius call site
- **THEN** the reviewer SHALL NOT emit a finding for it

#### Scenario: Reviewer reports a blast-radius finding

- **WHEN** a change in the diff directly alters the contract of a caller that is not changed in the diff
- **THEN** the caller constitutes blast radius and the reviewer MAY emit a finding scoped to that blast-radius effect

### Requirement: Both review prompts SHALL frame the cost of a false-positive finding

Both prompts SHALL state, before the finding bar, that a wrong finding causes a full fix cycle (re-run, harness call, CI wait, human review). When uncertain whether a finding is real:
- The reviewer SHALL lower `confidence` to the advisory band rather than emitting a high-confidence speculative finding.
- The reviewer MAY omit the finding entirely if they cannot articulate a concrete defect and impact.

#### Scenario: Reviewer lowers confidence on an uncertain finding

- **WHEN** the reviewer suspects a problem but cannot trace it to a specific code path
- **THEN** the reviewer SHALL set `confidence` below the `min_confidence` floor (advisory band) rather than emitting a blocking finding

#### Scenario: Reviewer omits a finding they cannot substantiate

- **WHEN** the reviewer has a vague concern with no concrete evidence in the diff
- **THEN** the reviewer SHALL omit the finding rather than emit a low-quality one

### Requirement: The standard review prompt SHALL assess overall risk before evaluating findings

`review_standard.md` SHALL begin its review method with an overall risk assessment — a one-line statement of the change's risk tier (high / medium / low) and the primary reason — before listing individual findings. The depth of coverage SHALL scale proportionally: high-risk changes receive exhaustive coverage of all checklist dimensions; low-risk changes receive abbreviated coverage focused only on the dimensions materially affected by the diff.

#### Scenario: Standard reviewer states risk tier before findings

- **WHEN** the standard review round produces a verdict
- **THEN** the summary field SHALL include the stated risk tier and the findings list SHALL reflect coverage proportional to that tier

#### Scenario: Low-risk change gets abbreviated coverage

- **WHEN** the standard reviewer assesses the change as low-risk
- **THEN** the reviewer SHALL focus on the dimensions directly affected by the diff, not walk the full checklist at equal depth

### Requirement: The standard review prompt SHALL NOT include deterministic checklist items

`review_standard.md` SHALL NOT contain checklist items that CI already answers deterministically (e.g., "Acceptance criteria met?" and "CI expectations?"). Items whose pass/fail is determined by CI run status add no reviewer judgment value and SHALL be removed.

#### Scenario: Standard reviewer does not check CI-answered items

- **WHEN** the standard reviewer evaluates the diff
- **THEN** the reviewer SHALL NOT emit findings solely about whether CI passed or whether acceptance criteria are formally checked off — those are CI's domain

### Requirement: The adversarial review prompt SHALL instruct repo-tailored attack-surface selection

`review_adversarial.md` SHALL present a two-tier attack-surface structure:

1. **Core (always apply):** data loss, corruption, or irreversible state; auth / trust boundary violations; rollback safety and partial-failure idempotency; ordering assumptions and race conditions; null / timeout / degraded-dependency handling; version skew and schema drift.
2. **Repo-tailored (apply when relevant):** additional attack surfaces the reviewer SHALL derive from the `{{conventions}}` context and the diff itself (e.g., PHI handling only when the repo processes health data; tenant isolation only when the repo is multi-tenant; observability gaps only when the change touches instrumentation paths).

The adversarial prompt SHALL NOT mandate the full enterprise-flavored catalogue on every run.

#### Scenario: Adversarial reviewer applies core tier always

- **WHEN** an adversarial review runs for any repo type
- **THEN** the reviewer SHALL evaluate the diff against every item in the core attack-surface tier

#### Scenario: Adversarial reviewer skips inapplicable enterprise attack surfaces

- **WHEN** the repo's `{{conventions}}` and diff contain no evidence of multi-tenancy or PHI handling
- **THEN** the reviewer SHALL NOT emit findings about tenant isolation or PHI retention

### Requirement: The adversarial review prompt SHALL reduce overlap with round-1 findings and preserve the round-2 ratchet

`review_adversarial.md` SHALL instruct the reviewer to avoid re-raising findings already present in `{{review1_section}}` unless new evidence materially changes the assessment. The adversarial round's budget SHALL be directed toward attack vectors and failure modes not yet covered by the standard round.

When `{{prior_review2_findings}}` is present (this is a re-review after a fix), the ratchet obligation overrides de-duplication: the reviewer SHALL re-raise every prior finding that the fix left unresolved or regressed. De-duplication applies only to new findings that are entirely unrelated to the prior round-2 findings. A reviewer SHALL NOT suppress a still-failing prior finding solely on the basis that it appeared before.

Both prompts SHALL include a round-role summary at the start: standard = "broad risk survey, first pass"; adversarial = "targeted deep-dive on high-risk vectors not yet resolved by round-1".

#### Scenario: Adversarial reviewer does not duplicate a round-1 finding

- **WHEN** a finding is already present in `{{review1_section}}` with the same code location and description
- **THEN** the adversarial reviewer SHALL NOT re-emit an identical finding

#### Scenario: Adversarial reviewer escalates a round-1 finding with new evidence

- **WHEN** the adversarial reviewer finds new evidence that materially changes the severity or scope of a finding already present in `{{review1_section}}`
- **THEN** the adversarial reviewer MAY re-raise the finding with the new evidence explicitly stated

#### Scenario: Adversarial re-reviewer re-raises an unresolved prior round-2 finding

- **WHEN** this is a re-review (prior adversarial findings are present) and a prior finding is still unresolved or regressed after the fix
- **THEN** the reviewer SHALL re-raise that finding regardless of whether it appeared in the prior round, and SHALL NOT suppress it on de-duplication grounds

#### Scenario: Adversarial re-reviewer suppresses a fully-resolved prior round-2 finding

- **WHEN** this is a re-review and a prior finding is demonstrably fixed in the new diff
- **THEN** the reviewer SHALL NOT re-emit it

