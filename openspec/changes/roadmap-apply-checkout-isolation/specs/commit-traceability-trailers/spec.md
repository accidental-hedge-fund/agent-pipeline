## ADDED Requirements

### Requirement: Roadmap docs commits SHALL NOT invent fossil Issue or Pipeline-Run trailers

Roadmap docs PR commits SHALL NOT hardcode historical issue numbers or pipeline run
identifiers from past feature work. Automated commits created by roadmap docs PR writeback
(`openRoadmapPr` / `pipeline roadmap` with `pr_docs`) SHALL include the standard `Issue:`
and `Pipeline-Run:` trailers only when both a current issue number and pipeline run id are
available to the writeback call. When that context is not fully available (the normal
no-issue-number `roadmap` sub-command), the commit message SHALL omit both trailers rather
than inventing fossil or placeholder values. This is an intentional exception to "every
pipeline commit carries trailers" for commits produced by a no-issue-number command that
has no legitimate issue linkage.

#### Scenario: Fossil #171 trailers are forbidden

- **WHEN** roadmap docs writeback creates a commit
- **THEN** the commit message SHALL NOT contain the hardcoded strings `Issue: #171` or
  `Pipeline-Run: 171/2026-06-17T04:37:16Z` (or any other constant trailers copied from
  closed issue #171's original feature PR)

#### Scenario: Trailers present only with full current context

- **WHEN** roadmap docs writeback is given both issue number N and pipeline run id R
- **THEN** the commit message SHALL include `Issue: #N` and `Pipeline-Run: R` as git
  trailers at the end of the message
- **AND** when either value is missing, both trailers SHALL be omitted
