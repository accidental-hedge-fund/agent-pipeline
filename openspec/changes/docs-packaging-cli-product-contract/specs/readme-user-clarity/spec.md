## MODIFIED Requirements

### Requirement: README opens with a purpose-first summary

The README SHALL communicate — within the first visible screenful, before any configuration detail or repository layout — what the tool does, who it is for, the implementer/reviewer pair declared in `.github/pipeline.yml`, and the core prerequisites (Node ≥ 24, git, gh, and the configured harness CLIs authenticated). It SHALL NOT state that both the Claude CLI and the Codex CLI are required as the product, regardless of which host is installed. Deeper harness-pair documentation remains issue #976.

#### Scenario: First screenful is informative

- **WHEN** a developer opens the README cold on GitHub
- **THEN** the first screen SHALL contain the tool's purpose, the implementer/reviewer pair model, and the prerequisite summary before any configuration block or repository layout
- **AND** it SHALL NOT say both Claude and Codex CLIs are required as the product

#### Scenario: Cross-harness prerequisite is visible before install

- **WHEN** a reader reaches the install section
- **THEN** the implementer/reviewer pair from repository config SHALL have been stated earlier in the document, not only inside install sub-sections
- **AND** that earlier text SHALL NOT require both `claude` and `codex` CLIs as the product
