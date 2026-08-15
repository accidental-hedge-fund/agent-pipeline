# declared-dependency-grammar Specification

## Purpose
TBD - created by archiving change complete-declared-dependency-discovery. Update Purpose after archive.

## Requirements

### Requirement: One exported deterministic lexical dependency grammar SHALL own phrase and section parsing

Pipeline SHALL provide exactly one exported deterministic pure function (or tightly
coupled pure API surface under one module) that owns the lexical dependency grammar for
free text. That API SHALL accept issue title/body text (or equivalent prose) and return
stable, normalized, deduplicated prerequisite issue identifiers in first-seen order. Loop
work-list declared-dependency discovery and roadmap textual dependency candidate discovery
SHALL both call this API for lexical extraction. They SHALL NOT maintain separate private
regular expressions, alias tables, or divergent phrase lists for the same grammar. The
grammar module SHALL perform no network, git, or subprocess IO.

#### Scenario: Loop and roadmap call the same parser export

- **WHEN** work-list lexical discovery and roadmap textual candidate discovery extract
  declared prerequisites from free text
- **THEN** both consumers SHALL invoke the same exported grammar API
- **AND** neither consumer SHALL apply a private phrase regular expression that can
  diverge from that API

#### Scenario: Parser is pure under unit test

- **WHEN** unit tests exercise the lexical grammar
- **THEN** those tests SHALL require no network, git, or subprocess calls

### Requirement: The lexical grammar SHALL accept multi-reference punctuated and unpunctuated declaration forms

The grammar SHALL recognize case-insensitive dependency phrases `depends on`, `requires`,
`blocked by`, and `needs`, with an optional colon after the phrase, followed by a
reference list of one or more `#N` issue references. References in the list MAY be
separated by commas, whitespace, and/or the word `and`. The grammar SHALL preserve
**every** canonical referenced prerequisite in that list, not only the first. Equivalent
roadmap writeback forms such as `_(blocked by #N, #M)_` SHALL contribute every listed
prerequisite when scanned as dependency prose.

#### Scenario: Colon and comma multi-reference form

- **WHEN** text contains `Depends on: #12, #13`
- **THEN** the parser result SHALL include both `12` and `13`

#### Scenario: Unpunctuated and-joined multi-reference form

- **WHEN** text contains `Depends on #12 and #13`
- **THEN** the parser result SHALL include both `12` and `13`

#### Scenario: Oxford-comma multi-reference form

- **WHEN** text contains `Depends on: #12, #13, and #14`
- **THEN** the parser result SHALL include `12`, `13`, and `14`

#### Scenario: Equivalent phrase forms preserve every reference

- **WHEN** text contains `requires #1, #2` or `blocked by #3 and #4` or `needs #5, #6 and #7`
  (case-insensitive)
- **THEN** the parser result SHALL include every listed prerequisite identifier

### Requirement: Dependency sections SHALL remain supported and bare references outside declarations SHALL NOT become dependencies

The grammar SHALL continue to treat `#N` references under a dedicated ATX heading whose
title matches `Dependency` or `Dependencies` (any heading level) as declared prerequisites
until the next ATX heading. Bare `#N` references that appear only in unrelated prose
outside a phrase declaration and outside a dependency section SHALL NOT become
dependencies.

#### Scenario: Dependency section captures bare references

- **WHEN** an issue body contains a `## Dependency` or `## Dependencies` section that
  references `#607` and `#100`
- **THEN** the parser result SHALL include `607` and `100`

#### Scenario: Unrelated prose does not invent edges

- **WHEN** text mentions `See #42 in the design doc` outside a dependency phrase or
  dependency section
- **THEN** the parser result SHALL NOT include `42` solely from that bare reference

### Requirement: Parser output SHALL be stable, normalized, and deduplicated

The grammar SHALL return prerequisite identifiers as canonical decimal issue id strings
(no leading zeros; positive integers only under the same canonical gate already used for
declared dependency ids). When a self-id is provided, self-references SHALL be ignored.
Duplicate references SHALL appear once, preserving first-seen order. Consumers SHALL
perform only their own shape conversion (for example number vs string, edge pair
orientation) and in-snapshot filtering after parsing; they SHALL NOT re-implement the
lexical grammar.

#### Scenario: Self-reference and duplicates are normalized

- **WHEN** text for issue `608` contains `Depends on #608, #607, #607`
- **AND** the parser is invoked with self-id `608`
- **THEN** the result SHALL be exactly `["607"]`

#### Scenario: First-seen order is stable

- **WHEN** the same multi-reference text is parsed repeatedly
- **THEN** every invocation SHALL return the same ordered identifier list

### Requirement: Shared table-driven fixtures SHALL prove loop and roadmap lexical parity

Pipeline SHALL maintain table-driven fixtures that exercise punctuation, multiple
references, case, self-references, duplicate references, dependency sections, and
unrelated prose. The same fixture inputs SHALL run through the loop lexical consumer path
and the roadmap textual candidate path and SHALL produce identical lexical prerequisite
sets for each input (modulo documented consumer-side in-snapshot filtering). A captured
fixture covering issues #890 through #903 SHALL produce the exact declared graph for that
pack, including #900's in-set reference to #899 and external reference to #662 when those
declarations are present in the fixture text.

#### Scenario: Shared fixtures yield identical lexical edges

- **WHEN** a multi-reference fixture row is evaluated by both the loop lexical path and the
  roadmap textual candidate path without in-snapshot filtering differences
- **THEN** both paths SHALL report the same prerequisite identifier set for that row

#### Scenario: Captured #890–#903 fixture matches the declared graph

- **WHEN** the captured fixture for issues #890 through #903 is parsed
- **THEN** the resulting declared edges SHALL match the fixture's expected graph
- **AND** that graph SHALL include #900's dependency on #899 and #900's dependency on #662
  when those declarations are part of the fixture

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
