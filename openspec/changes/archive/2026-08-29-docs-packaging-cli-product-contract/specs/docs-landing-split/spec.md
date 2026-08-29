## ADDED Requirements

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
