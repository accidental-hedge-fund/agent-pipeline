# pipeline-comment-harness-identity Specification

## Purpose
Defines how pipeline-posted stage-transition and blocked comments attribute the active harness label and skill footer so multi-harness runs (including grok) are not shown as unassigned or forced to a Claude-only hardcode.
## Requirements
### Requirement: Harness label parsing SHALL accept any harness prefix value

The engine SHALL parse issue labels that begin with `harness:` and return the non-empty suffix as the harness identity string. The parser SHALL NOT restrict accepted values to `claude` and `codex` only. When no `harness:` label with a non-empty suffix is present, the parser SHALL return a null/absent result so callers may fall back to an unassigned display.

#### Scenario: grok harness label is recognized

- **WHEN** issue labels include `harness:grok`
- **THEN** harness label parsing SHALL return `grok`

#### Scenario: opencode and pi harness labels are recognized

- **WHEN** issue labels include `harness:opencode` or `harness:pi`
- **THEN** harness label parsing SHALL return `opencode` or `pi` respectively

#### Scenario: claude and codex harness labels remain recognized

- **WHEN** issue labels include `harness:claude` or `harness:codex`
- **THEN** harness label parsing SHALL return `claude` or `codex` respectively

#### Scenario: absent harness label is null

- **WHEN** issue labels contain no `harness:` entry with a non-empty suffix
- **THEN** harness label parsing SHALL return null/absent
- **AND** a stage-transition comment SHALL display the existing unassigned harness fallback

---

### Requirement: Stage-transition comments SHALL display the parsed harness label

When the engine posts a stage-transition comment, the `**Harness**` field SHALL show the parsed harness identity from the issue's labels, or the unassigned fallback when no harness label is present. A stamped `harness:grok` (or other non-claude/codex) label SHALL NOT be rendered as unassigned.

#### Scenario: transition comment shows grok

- **WHEN** the engine builds a stage-transition comment for an issue labeled `harness:grok`
- **THEN** the comment body SHALL contain `**Harness**: grok`
- **AND** SHALL NOT contain `**Harness**: unassigned`

#### Scenario: transition comment falls back when unlabeled

- **WHEN** the engine builds a stage-transition comment for an issue with no `harness:` label
- **THEN** the comment body SHALL contain `**Harness**: unassigned`

---

### Requirement: Stage-transition and blocked comments SHALL use the config marker footer

Stage-transition comment bodies and blocked comment bodies SHALL append the active pipeline config's `marker_footer` (with the same `---` separator style used by other pipeline comment builders). Those builders SHALL NOT append a hardcoded Claude-only skill footer string that bypasses config. Attestation markers and audit sentinels already required for pipeline comments SHALL remain present after the footer.

#### Scenario: transition footer follows codex profile config

- **WHEN** the active config's `marker_footer` is `*Automated by Codex Pipeline Skill*`
- **AND** the engine builds a stage-transition comment
- **THEN** the comment body SHALL include that footer text
- **AND** SHALL NOT require a hardcoded Claude-only footer string to be present

#### Scenario: transition footer follows configured custom footer

- **WHEN** the active config's `marker_footer` is a non-empty custom string
- **AND** the engine builds a stage-transition comment
- **THEN** the comment body SHALL include that custom footer string

#### Scenario: blocked comment footer follows config

- **WHEN** the engine builds a blocked pipeline comment under a config with a non-Claude `marker_footer`
- **THEN** the blocked comment body SHALL include that config footer
- **AND** SHALL NOT append a Claude-only hardcoded footer in place of the config value

---

### Requirement: Pipeline label bootstrap SHALL include harness labels for all built-in adapters

`ensurePipelineLabels` SHALL idempotently ensure a `harness:<name>` GitHub label exists for every built-in harness-adapter name shipped with the engine (at least `claude`, `codex`, `grok`, `opencode`, and `pi`), in addition to stage labels and the blocked label. Re-running SHALL not fail when those labels already exist.

#### Scenario: missing grok harness label is created

- **WHEN** `ensurePipelineLabels` runs against a repo that lacks `harness:grok`
- **THEN** it SHALL create `harness:grok`
- **AND** already-present pipeline labels SHALL be left unchanged

#### Scenario: all built-in harness labels are in the desired set

- **WHEN** `ensurePipelineLabels` computes its desired label set
- **THEN** that set SHALL include `harness:claude`, `harness:codex`, `harness:grok`, `harness:opencode`, and `harness:pi`

