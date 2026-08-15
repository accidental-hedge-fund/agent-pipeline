## ADDED Requirements

### Requirement: Soft related-work sections SHALL NOT contribute bare issue references as dependencies

The lexical grammar SHALL treat ATX headings whose titles match soft related-work forms as
**non-dependency sections**. Soft forms include (case-insensitive heading title match)
`Related`, `Related work`, `See also`, `Dogfood`, `Later`, and `Later milestone` (and clear
variants that begin with those titles). Bare `#N` references that appear only under those
sections, without a dependency phrase declaration, SHALL NOT become prerequisite identifiers.
Phrase declarations (`depends on`, `requires`, `blocked by`, `needs`) remain recognized
wherever they appear in the free text, including under soft headings. A dedicated
`Dependency` / `Dependencies` section continues to capture bare `#N` as lexical candidates
(admission to a hard wait is owned by work-list population / train-selector rules, not by
denying the lexical edge wholesale).

#### Scenario: Related section bare reference is not a dependency

- **WHEN** an issue body contains a `## Related` (or `## See also`) section that references
  `#822` with no dependency phrase
- **THEN** the parser result SHALL NOT include `822` solely from that bare section reference

#### Scenario: Soft section does not suppress phrase declarations

- **WHEN** text under a `## Related` heading contains `Depends on: #599`
- **THEN** the parser result SHALL include `599`

#### Scenario: Dependencies section bare references remain lexical candidates

- **WHEN** an issue body contains a `## Dependencies` section that references `#607`
- **THEN** the parser result SHALL include `607` as a lexical prerequisite candidate
