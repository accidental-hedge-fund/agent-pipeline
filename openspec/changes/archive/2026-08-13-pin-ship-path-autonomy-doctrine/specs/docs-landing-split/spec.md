## ADDED Requirements

### Requirement: docs/concepts.md SHALL link the ship-path autonomy living doctrine

`docs/concepts.md` SHALL include a working relative link to the ship-path autonomy living doctrine document (`docs/ship-path-autonomy.md` or the equivalent path established by the ship-path-autonomy-doctrine capability). The link SHALL appear in the concepts contents and/or an advanced section so operators and agents reach the doctrine from the advanced-topics entry point without hunting the epic issue thread. This requirement SHALL NOT force the lean README to embed the full doctrine, and SHALL NOT reintroduce a monolithic README.

#### Scenario: Concepts links ship-path autonomy doc

- **WHEN** a reader opens `docs/concepts.md`
- **THEN** the document SHALL contain a working relative link to `docs/ship-path-autonomy.md` (or the equivalent doctrine path)

#### Scenario: Doctrine remains outside the lean README body

- **WHEN** the README landing page is measured after the doctrine is published
- **THEN** the README SHALL still satisfy the lean landing-page size and companion-link contract
- **AND** the full ship-path autonomy doctrine SHALL live under `docs/`, not as a full copy in the README body
