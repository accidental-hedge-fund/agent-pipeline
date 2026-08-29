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

### Requirement: README landing-page contract SHALL be enforced by an executable docs check

The repository docs check surface used by contributors and CI (`npm run docs:check` and/or `node scripts/generate-docs.mjs --check`, and the conditional `ci:docs` path) SHALL enforce the lean landing-page contract on root `README.md`, not only generator-owned artifacts. Enforcement SHALL fail closed with diagnostics that name the failed contract dimension (at minimum: line budget; missing companion link; and, when implemented, full hand-maintained inventory shape). A README that only satisfies the contract in prose or in OpenSpec living text without passing this check SHALL NOT be treated as compliant.

#### Scenario: Over-budget README fails the docs check

- **WHEN** root `README.md` contains 400 or more lines
- **AND** the docs check surface is run against that worktree
- **THEN** the check SHALL exit non-zero
- **AND** the diagnostics SHALL indicate the line-budget failure (including measured size when practical)

#### Scenario: Missing companion link fails the docs check

- **WHEN** root `README.md` lacks a working relative link to any of `docs/cli.md`, `docs/config.md`, or `docs/concepts.md`
- **AND** the docs check surface is run
- **THEN** the check SHALL exit non-zero
- **AND** the diagnostics SHALL name the missing companion path class

#### Scenario: Compliant lean README passes the landing-page portion of the check

- **WHEN** root `README.md` has fewer than 400 lines
- **AND** it contains relative links to `docs/cli.md`, `docs/config.md`, and `docs/concepts.md`
- **AND** it does not reintroduce a full hand-maintained CLI/config inventory body
- **AND** other generator-owned artifacts are fresh
- **THEN** the docs check surface SHALL NOT fail solely due to the landing-page contract

---

### Requirement: A #793-shaped monolithic README append SHALL fail before PR readiness

The test suite and/or docs-check fixture surface SHALL include a regression fixture whose content shape matches the #793 failure mode: a lean landing-page prefix with a large unrelated monolithic README body appended (order-of-magnitude hundreds to thousands of extra lines and/or a full hand-maintained command inventory). Running the landing-page contract check (or the full docs check surface) against that fixture SHALL fail. The regression SHALL bite: if the landing-page enforcement is removed or bypassed, the test SHALL fail.

#### Scenario: Fixture shaped like the #793 append fails the guard

- **WHEN** a test supplies README content that embeds a large monolithic append after a lean prefix (the #793 shape)
- **THEN** the landing-page contract check SHALL report failure
- **AND** the test SHALL assert a non-zero / failing outcome

#### Scenario: Regression bites without the guard

- **WHEN** the README landing-page enforcement is deleted or always-skipped
- **THEN** the #793-shaped regression test SHALL fail (proving it would have caught the escape)

---

### Requirement: Restored README SHALL preserve legitimate post-#790 landing-page edits

When the repository restores `README.md` from the #793 monolith regression, the restored file SHALL satisfy the lean landing-page contract and SHALL retain intentional post-#790 landing-page content that is not the monolith append — including stage-inventory accuracy required by `stage-inventory-ssot` and install/packaging accuracy required by living install/readme specs — rather than blindly reverting to the #790 blob alone when that would drop those edits.

#### Scenario: Restored README is lean and linked

- **WHEN** the change head's `README.md` is measured after restoration
- **THEN** it SHALL contain fewer than 400 lines
- **AND** SHALL contain relative links to `docs/cli.md`, `docs/config.md`, and `docs/concepts.md`

#### Scenario: Restored README is not a pure #790 checkout when later legit edits exist

- **WHEN** legitimate post-#790 landing-page edits exist on the integration history (for example stage-count or install packaging language)
- **THEN** the restored README SHALL include those classes of content when they still belong on the landing page
- **AND** SHALL NOT reintroduce the #793 monolithic append

### Requirement: docs/concepts.md SHALL link the ship-path autonomy living doctrine

`docs/concepts.md` SHALL include a working relative link to the ship-path autonomy living doctrine document (`docs/ship-path-autonomy.md` or the equivalent path established by the ship-path-autonomy-doctrine capability). The link SHALL appear in the concepts contents and/or an advanced section so operators and agents reach the doctrine from the advanced-topics entry point without hunting the epic issue thread. This requirement SHALL NOT force the lean README to embed the full doctrine, and SHALL NOT reintroduce a monolithic README.

#### Scenario: Concepts links ship-path autonomy doc

- **WHEN** a reader opens `docs/concepts.md`
- **THEN** the document SHALL contain a working relative link to `docs/ship-path-autonomy.md` (or the equivalent doctrine path)

#### Scenario: Doctrine remains outside the lean README body

- **WHEN** the README landing page is measured after the doctrine is published
- **THEN** the README SHALL still satisfy the lean landing-page size and companion-link contract
- **AND** the full ship-path autonomy doctrine SHALL live under `docs/`, not as a full copy in the README body

### Requirement: README and concepts SHALL link the packaging contract companion

Root `README.md` and `docs/concepts.md` SHALL each contain a working relative markdown link to `docs/packaging.md`. This packaging companion SHALL NOT replace `docs/cli.md`, `docs/config.md`, or `docs/concepts.md` in the lean landing-page contract. The executable README companion-link check for those three files SHALL remain in force. This requirement SHALL NOT require the executable checker to add `docs/packaging.md` in this slice (no engine behavior change).

#### Scenario: Landing page links packaging.md

- **WHEN** a reader opens root `README.md`
- **THEN** the document SHALL contain a relative link to `docs/packaging.md`
- **AND** the document SHALL still contain relative links to `docs/cli.md`, `docs/config.md`, and `docs/concepts.md`

#### Scenario: Concepts links packaging.md

- **WHEN** a reader opens `docs/concepts.md`
- **THEN** the document SHALL contain a relative link to `docs/packaging.md`

#### Scenario: README stays under the landing-page size budget

- **WHEN** the README is measured after adding the packaging link and pair-language edit
- **THEN** `README.md` SHALL contain fewer than 400 lines

---

### Requirement: README SHALL describe the implementer/reviewer pair instead of both CLIs required

The lean README purpose and prerequisites text SHALL describe a runnable repository as declaring an implementer/reviewer pair in `.github/pipeline.yml`. That text SHALL NOT state that both the Claude CLI and the Codex CLI are required as the product. This requirement SHALL NOT expand the README into a full harness-matrix reference (that remains issue #976).

#### Scenario: Prerequisites use pair language

- **WHEN** a first-time reader follows only the README prerequisites
- **THEN** they SHALL see an implementer/reviewer pair as repository policy
- **AND** they SHALL NOT be told that both Claude and Codex CLIs are required as the product
