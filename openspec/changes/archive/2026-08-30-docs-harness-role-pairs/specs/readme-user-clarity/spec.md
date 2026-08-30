## MODIFIED Requirements

### Requirement: README opens with a purpose-first summary

The README SHALL communicate — within the first visible screenful, before any configuration detail or repository layout — what the tool does, who it is for, the implementer/reviewer pair declared in `.github/pipeline.yml`, and the core prerequisites (Node ≥ 24, git, gh, and the configured harness CLIs authenticated). It SHALL NOT state that both the Claude CLI and the Codex CLI are required as the product, regardless of which host is installed. Deeper pair examples and the `steps.adversarial_review` matrix SHALL live in `docs/concepts.md`, linked from the README.

#### Scenario: First screenful is informative

- **WHEN** a developer opens the README cold on GitHub
- **THEN** the first screen SHALL contain the tool's purpose, the implementer/reviewer pair model, and the prerequisite summary before any configuration block or repository layout
- **AND** it SHALL NOT say both Claude and Codex CLIs are required as the product

#### Scenario: Cross-harness prerequisite is visible before install

- **WHEN** a reader reaches the install section
- **THEN** the implementer/reviewer pair from repository config SHALL have been stated earlier in the document, not only inside install sub-sections
- **AND** that earlier text SHALL NOT require both `claude` and `codex` CLIs as the product

---

### Requirement: README contains a quickstart section

The README SHALL include a dedicated quickstart (or "Getting Started") section that provides one clearly recommended install path and a minimal first-run example that takes a reader from install to advancing a single issue — without requiring the reader to parse optional or advanced sections first.

#### Scenario: Single recommended install command is present

- **WHEN** a reader wants to install the tool for the first time
- **THEN** there SHALL be exactly one visually highlighted recommended command (the `npx github:...` one-liner) before alternatives are listed

#### Scenario: First-run example is present

- **WHEN** a reader completes the recommended install path
- **THEN** the quickstart SHALL show at minimum: how to add the first `pipeline:ready` label to an issue and the command to invoke the pipeline on it (`pipeline N`)
- **AND** that first-run example SHALL NOT require `/pipeline N` or `$pipeline N`
