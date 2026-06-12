## MODIFIED Requirements

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
