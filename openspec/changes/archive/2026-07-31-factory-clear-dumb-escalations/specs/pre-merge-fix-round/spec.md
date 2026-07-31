## MODIFIED Requirements

### Requirement: Pre-merge SHALL gate the auto-fix on a fixed finding-category allowlist

The pipeline SHALL partition blocking pre-merge delta-review findings into an **auto-fixable**
subset and a **residual human-required** subset using the fixed category allowlist
`{ correctness, missing-dep, concurrency }` (case-insensitive, trimmed), **plus** any finding
whose `category` is `spec-divergence` and whose structured
`spec_divergence_direction` is `code-behind-spec`. A finding is auto-fixable if and only if
its category is in that allowlist **or** it is a `code-behind-spec` directed
`spec-divergence`. A finding is residual human-required when it is outside that set —
including `security`, `scope`, `product-judgment-required`, direction-less
`spec-divergence`, `spec-divergence` with direction `spec-behind-code`, `data-loss`,
`observability`, an unrecognized token, or an absent/empty category (fail-closed for that
finding).

The pipeline SHALL attempt the bounded pre-merge auto-fix when **all** of the following hold:
the auto-fixable subset is non-empty; an implementer harness is configured; and no prior
auto-fix attempt is recognized for the entry (prefix commit or durable attempt/noop marker).
The presence of residual human-required findings in the **same** blocking batch SHALL NOT by
itself veto the auto-fix attempt for the auto-fixable subset (**partition**, not
all-or-nothing). When the auto-fixable subset is empty, the pipeline SHALL skip the auto-fix
harness and escalate to `needs-human` without a harness call.

The auto-fix attempt SHALL be scoped to the auto-fixable subset only: residual findings SHALL
NOT be included in the fix prompt. Residual findings remain subject to human disposition when
they still block after the attempt (or immediately when no auto-fixable subset exists). The
living allowlist membership and rationale remain the category matrix requirement; expansions
require an OpenSpec change and tests, not an undocumented string add.

#### Scenario: all blocking findings are correctness — auto-fix eligible

- **WHEN** the pre-merge delta review returns `needs-attention` with one or more blocking findings
- **AND** every blocking finding's `category` is `correctness`, `missing-dep`, or `concurrency`
- **AND** no auto-fix has been attempted for the current pre-merge entry
- **THEN** the pipeline SHALL perform exactly one bounded auto-fix attempt (see the bounded-attempt
  requirement) rather than escalating to `needs-human`

#### Scenario: pure code-behind-spec residual is auto-fix eligible

- **WHEN** every blocking finding has `category` `spec-divergence` and
  `spec_divergence_direction` `code-behind-spec`
- **AND** no prior auto-fix attempt is recognized for the entry
- **AND** an implementer harness is configured
- **THEN** the pipeline SHALL perform exactly one bounded auto-fix attempt for that set
- **AND** SHALL NOT first-hop to `needs-human` solely because the category token is
  `spec-divergence`

#### Scenario: direction-less or spec-behind-code remains residual

- **WHEN** every blocking finding has `category` `spec-divergence` and either lacks
  `spec_divergence_direction` or has direction `spec-behind-code`
- **THEN** the pipeline SHALL NOT invoke the implementer auto-fix harness for that residual set
- **AND** SHALL set `blocked`/`needs-human` without that harness call (spec-behind-code MAY be
  handled by a separate bounded spec-repair path; it is not implementer autofix)

#### Scenario: pure residual non-allowlisted batch — escalate without auto-fix

- **WHEN** every blocking finding has a residual non-allowlisted category (including
  `security`, `scope`, `product-judgment-required`, direction-less `spec-divergence`,
  `spec-behind-code`, `data-loss`, `observability`, or absent/empty/unrecognized)
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL set `blocked`/`needs-human` without a harness call

#### Scenario: pure security-only batch still escalates without auto-fix

- **WHEN** the only blocking findings have `category` `security`
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL set `blocked`/`needs-human` immediately
