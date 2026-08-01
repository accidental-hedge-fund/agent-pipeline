# docs-landing-split Specification

## Purpose
TBD - created by archiving change docs-generate-cli-config-reference. Update Purpose after archive.
## Requirements
### Requirement: README SHALL be a lean landing page that links to docs companions

The repository root `README.md` SHALL serve as a lean landing page whose primary jobs are purpose, prerequisites, quickstart, and install. It SHALL link to deeper companions under `docs/` — at minimum `docs/cli.md`, `docs/config.md`, and `docs/concepts.md` — rather than embedding the full CLI inventory or full config key reference in the README body. The README itself SHALL remain well under 400 lines.

#### Scenario: Landing page stays under the size budget

- **WHEN** the README is measured after the split
- **THEN** `README.md` SHALL contain fewer than 400 lines

#### Scenario: Companion links are present

- **WHEN** a reader opens the README
- **THEN** the document SHALL contain working relative links to `docs/cli.md`, `docs/config.md`, and `docs/concepts.md`

#### Scenario: Full CLI inventory is not hand-maintained in the README

- **WHEN** a reader needs the complete command reference
- **THEN** the README SHALL direct them to `docs/cli.md` (or an equivalent generated companion) rather than maintaining a second full hand-authored command list in the README body

---

### Requirement: docs/concepts.md SHALL hold advanced and conceptual material extracted from the former monolithic README

The repository SHALL provide `docs/concepts.md` containing the advanced, optional, lifecycle, and conceptual material that no longer lives in the lean README. `docs/concepts.md` SHALL NOT re-hand-author the full CLI command inventory or the full config key reference; those remain the job of the generated `docs/cli.md` and `docs/config.md` pages. Optional/advanced sections in concepts SHALL remain labeled as optional where they describe optional features.

#### Scenario: Concepts companion exists and is linked

- **WHEN** a reader follows the README link to concepts
- **THEN** `docs/concepts.md` SHALL exist and contain advanced or conceptual material that was removed from the monolithic README body

#### Scenario: Concepts does not fork the CLI/config inventory

- **WHEN** `docs/concepts.md` is inspected for operator reference material
- **THEN** it SHALL NOT maintain a complete parallel hand-authored list of every CLI command and every config key that duplicates the generated references

---

### Requirement: Operator docs layout SHALL preserve first-run completeness without the monolithic README

A first-time reader who follows only the README prerequisites, install, and quickstart sections SHALL still reach a working setup without reading `docs/cli.md`, `docs/config.md`, or `docs/concepts.md`. Returning users who need configuration or CLI detail SHALL reach those topics via the README links to the generated companions.

#### Scenario: Newcomer path does not require deep docs

- **WHEN** a first-time reader follows only the README prerequisite, install, and quickstart sections
- **THEN** they SHALL reach a working setup without requiring information that exists only in `docs/cli.md`, `docs/config.md`, or `docs/concepts.md`

#### Scenario: Returning user reaches config via the landing page

- **WHEN** a returning user needs the `.github/pipeline.yml` configuration reference
- **THEN** the README SHALL provide a clear path (heading and/or link) to `docs/config.md` without requiring a full read of the README body

