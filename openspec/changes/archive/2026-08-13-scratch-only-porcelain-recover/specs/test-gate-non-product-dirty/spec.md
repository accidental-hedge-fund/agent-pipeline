## ADDED Requirements

### Requirement: Scratch-only dirt SHALL NOT escalate as needs-human at format or test dirt gates

When format-gate or test-gate dirty-trust checks classify porcelain as engine-known non-product scratch only (shared classifier / engine-known set including `artifacts/challenge-response-*.json`, planning scratch under `tasks/**`, and `.pipeline-prompt-*`), the gate SHALL NOT set `pipeline:blocked` and SHALL NOT call `setBlocked` with kind `needs-human` or `human-decision-required` solely for that scratch. The gate SHALL proceed (or restore/unlink scratch then proceed) consistent with existing non-product dirty trust rules. Product dirt remains fail-closed with path disclosure under the established dirty-trust block path.

#### Scenario: Challenge-response-only does not needs-human at the test gate

- **WHEN** porcelain lists only `?? artifacts/challenge-response-N.json`
- **AND** the test gate evaluates pre-run dirty trust
- **THEN** the gate SHALL NOT set `pipeline:blocked` solely for that path
- **AND** SHALL NOT call `setBlocked` with kind `needs-human` or `human-decision-required` solely for that path
- **AND** SHALL proceed to invoke the test/build command (or restore scratch first and then proceed)

#### Scenario: Challenge-response-only does not needs-human at the format gate

- **WHEN** porcelain lists only engine-known scratch including a challenge-response dump
- **AND** the format gate evaluates pre-flight dirty trust on the implement certification path
- **THEN** the format gate SHALL NOT refuse solely for that scratch with `needs-human` or `human-decision-required`
- **AND** SHALL treat the worktree as clean enough for trust

#### Scenario: Product dirt at format or test gate still blocks

- **WHEN** porcelain includes an uncommitted product path under `core/` or dirty product `openspec/`
- **AND** the format or test gate evaluates dirty trust
- **THEN** the gate SHALL still hard-block with product-path disclosure
- **AND** SHALL NOT waive the product block because engine scratch is also present
