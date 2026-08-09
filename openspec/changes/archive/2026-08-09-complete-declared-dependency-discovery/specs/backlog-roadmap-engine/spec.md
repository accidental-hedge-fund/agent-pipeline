## ADDED Requirements

### Requirement: Roadmap textual dependency candidates SHALL use the shared declared-dependency grammar

The roadmap engine SHALL obtain textual dependency candidate prerequisite references from
issue title and body text only through the shared `declared-dependency-grammar` export
before source-verification. It SHALL NOT maintain a private phrase regular expression or
alias table for `depends on` / `requires` / `blocked by` / `needs`. Multi-reference
punctuated and unpunctuated declarations SHALL produce a candidate for every listed
in-inventory prerequisite, not only the first reference after a phrase. Bare issue
references outside a declaration or dependency section SHALL NOT become textual candidates
solely from prose. Self-references and out-of-inventory ids SHALL be filtered after parse
as consumer-side shape rules, without re-implementing the lexical grammar. Shared table-
driven fixtures with the loop lexical consumer SHALL prove identical lexical edges.

#### Scenario: Multi-reference body produces multiple textual candidates

- **WHEN** inventory issue `10` has body text `Depends on: #5, #6` and issues `5` and `6`
  are also in the inventory
- **THEN** textual candidate extraction SHALL include edges that make both `5` and `6`
  prerequisites of `10` (candidate orientation as required by the depgraph phase)

#### Scenario: Private phrase regex is not used

- **WHEN** roadmap textual candidate discovery runs
- **THEN** it SHALL call the shared grammar API
- **AND** it SHALL NOT apply a separate module-local phrase regular expression for the
  same dependency phrases

#### Scenario: Unrelated prose does not create textual candidates

- **WHEN** an issue body mentions `See #42 in the design doc` without a dependency phrase
  or dependency section
- **AND** `#42` is in the inventory
- **THEN** textual candidate extraction SHALL NOT emit a dependency candidate solely from
  that bare reference

#### Scenario: Parity fixtures match the loop lexical path

- **WHEN** shared multi-reference and section fixtures are evaluated by roadmap textual
  extraction and by the loop lexical parser on the same text
- **THEN** the sets of lexical prerequisite ids (before consumer-specific inventory
  filtering differences that are held constant) SHALL be identical
