## ADDED Requirements

### Requirement: Review paths SHALL receive SHA-matched Tester evidence as shared input

The pipeline SHALL load Tester evidence for the candidate under review and
inject it into the prompt material when assembling the review prompt for
`review-1`, `review-2`, and delta re-review (and any other code-review path
that evaluates a product candidate SHA). Acquisition SHALL require a SHA match
between the artifact and the candidate HEAD, or SHALL inject an explicit
stale/unavailable/missing classification per `tester-evidence`. The prompt
SHALL distinguish authoritative engine suite evidence from any supplemental
reviewer-targeted checks. Reviewers MAY run targeted checks, but those results
SHALL NOT overwrite the authoritative Tester record used for the round.

#### Scenario: review-1 prompt includes current Tester evidence

- **WHEN** `review-1` runs against candidate SHA `S`
- **AND** trustworthy Tester evidence exists with `candidate_sha` equal to `S`
- **THEN** the review prompt SHALL include the authoritative Tester evidence
  section for that artifact
- **AND** the section SHALL report the structured overall status and command
  summary for `S`

#### Scenario: review-2 and delta re-review use the same acquisition rules

- **WHEN** `review-2` or a delta re-review runs against candidate SHA `S`
- **THEN** acquisition SHALL apply the same SHA-match and missing/stale rules
  as `review-1`
- **AND** the prompt SHALL include current evidence or an explicit
  non-current classification

#### Scenario: stale evidence cannot support suite-pass framing

- **WHEN** only Tester evidence for a different SHA is available
- **THEN** the review prompt SHALL NOT present that evidence as a suite pass
  for the current candidate
- **AND** SHALL mark the suite evidence as stale or unavailable for the
  candidate under review

#### Scenario: missing evidence follows configured disposition without implying pass

- **WHEN** no trustworthy SHA-matched Tester evidence exists at review time
- **THEN** the prompt or stage disposition SHALL follow the configured
  fail-open/fail-closed policy from `tester-evidence`
- **AND** SHALL NOT imply that tests passed

#### Scenario: targeted checks remain supplemental in the review path

- **WHEN** a reviewer performs a targeted check during a review round
- **THEN** any recorded targeted-check result SHALL be labeled supplemental
- **AND** SHALL NOT replace the authoritative Tester evidence for the candidate
