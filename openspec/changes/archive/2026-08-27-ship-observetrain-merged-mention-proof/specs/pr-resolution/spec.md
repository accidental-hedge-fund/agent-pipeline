## ADDED Requirements

### Requirement: Any-state PR resolution SHALL accept merged pipeline mentions

Any-state issue-to-PR resolution SHALL treat a same-repo pull request as linked to issue N when the issue timeline records any of:

1. a `ConnectedEvent` whose subject is that pull request, or
2. a `CrossReferencedEvent` with `willCloseTarget: true` whose source is that pull request, or
3. a `CrossReferencedEvent` whose source is a same-repo pull request whose head ref starts with `pipeline/<N>-`, or
4. a `CrossReferencedEvent` whose source is a same-repo pull request whose title contains the parenthetical `(#N)`.

It SHALL ignore fork pull requests (`isCrossRepository: true`) under every identity. It SHALL NOT treat a non-pipeline mention (`willCloseTarget: false`, head not `pipeline/<N>-*`, title without `(#N)`) as a link. It SHALL keep scanning newest-first and SHALL return the newest matching same-repo pull request. Open-PR resolution SHALL remain branch-prefix plus `closingIssuesReferences` only and SHALL NOT search titles or body text.

#### Scenario: Non-closing pipeline-head CrossReferencedEvent resolves

- **WHEN** the issue timeline has a `CrossReferencedEvent` with `willCloseTarget: false`
- **AND** the source pull request is same-repo with head `pipeline/1258-resume-after-run-fatal`
- **AND** any-state resolution runs for issue 1258
- **THEN** it SHALL return that pull request's number
- **AND** it SHALL NOT return null solely because `willCloseTarget` is false

#### Scenario: Non-closing parenthetical title CrossReferencedEvent resolves

- **WHEN** the issue timeline has a `CrossReferencedEvent` with `willCloseTarget: false`
- **AND** the source pull request is same-repo with title containing `(#1258)`
- **AND** the head ref is not `pipeline/1258-*`
- **AND** any-state resolution runs for issue 1258
- **THEN** it SHALL return that pull request's number

#### Scenario: ConnectedEvent and closing CrossReferencedEvent still resolve

- **WHEN** the issue timeline has a `ConnectedEvent` to a same-repo pull request
- **OR** a `CrossReferencedEvent` with `willCloseTarget: true` to a same-repo pull request
- **THEN** any-state resolution SHALL return that pull request's number

#### Scenario: Mere non-pipeline mention does not resolve

- **WHEN** the issue timeline has only a `CrossReferencedEvent` with `willCloseTarget: false`
- **AND** the source pull request head is not `pipeline/<N>-*`
- **AND** the source pull request title does not contain `(#N)`
- **THEN** any-state resolution for issue N SHALL return null

#### Scenario: Fork PR cannot spoof any-state pipeline identity

- **WHEN** a `CrossReferencedEvent` or `ConnectedEvent` points at a pull request with `isCrossRepository: true`
- **AND** that pull request head is `pipeline/1258-spoofed` or its title contains `(#1258)`
- **THEN** any-state resolution for issue 1258 SHALL NOT return that pull request

#### Scenario: Open-PR resolution does not gain title search

- **WHEN** an open pull request title contains `(#42)` or `Fixes #42`
- **AND** its head is not `pipeline/42-*`
- **AND** its `closingIssuesReferences` does not include issue 42
- **THEN** open-PR resolution for issue 42 SHALL return null
