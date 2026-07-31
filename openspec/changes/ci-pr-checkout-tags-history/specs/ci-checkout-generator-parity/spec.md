## ADDED Requirements

### Requirement: PR and main CI checkout fetches full history and tags

The repository's GitHub Actions workflow that runs the full CI gate on pull requests and pushes to `main` (`.github/workflows/ci.yml`) SHALL configure `actions/checkout` so the job receives full git history and version tags — not the action default shallow, tag-limited checkout. The checkout step SHALL set `fetch-depth: 0` and SHALL ensure tags are available to subsequent steps (via the checkout action's documented tag-fetch input when required, and/or an equivalent explicit `git fetch` of tags). After checkout, listing version tags with `git tag -l 'v*'` SHALL be able to observe tags that exist on the remote for that repository when those tags are present upstream. The workflow SHALL include a brief comment stating that full history and tags are required for local/CI parity of tag-dependent generators (for example CHANGELOG generation).

#### Scenario: ci.yml is not the default shallow checkout

- **WHEN** `.github/workflows/ci.yml` is inspected for the job that runs `npm run ci`
- **THEN** its checkout step SHALL set `fetch-depth: 0`
- **AND** SHALL NOT rely on the action default shallow depth alone

#### Scenario: Tags are available to the CI job after checkout

- **WHEN** the CI job has completed the checkout step on a repository that has one or more remote tags matching `v*`
- **THEN** a subsequent step in that job SHALL be able to list those tags via `git tag -l 'v*'` (non-empty when such tags exist upstream)
- **AND** SHALL NOT run the full CI gate against a checkout where tag-dependent generators necessarily see zero tags solely because of checkout configuration

#### Scenario: Workflow comment documents the reason

- **WHEN** a contributor reads the checkout step in `.github/workflows/ci.yml`
- **THEN** they SHALL find a comment explaining that full history and/or tags are required for generator / local CI parity
- **AND** SHALL NOT be left without guidance that default shallow checkout is intentional

### Requirement: CI checkout shape is drift-guarded

The repository test suite (scripts or core unit tests, using structural file parse — no live network required) SHALL assert that `.github/workflows/ci.yml`'s full-gate job checkout retains full-history configuration (`fetch-depth: 0`) and the tag-availability contract expressed in this capability. Removing `fetch-depth: 0` (or reverting to bare `actions/checkout` without depth/tags) SHALL cause that test to fail.

#### Scenario: Structural test fails if checkout reverts to default shallow

- **WHEN** a unit/fixture test parses `.github/workflows/ci.yml`
- **AND** the full-gate job's checkout step lacks `fetch-depth: 0` (or equivalent full-history configuration required by this capability)
- **THEN** the test SHALL fail
- **AND** the test SHALL fail if that assertion is deleted while the capability remains in force

#### Scenario: Structural test passes on the required checkout shape

- **WHEN** the checkout step configures full history (and tag availability as specified)
- **AND** the structural test runs
- **THEN** the test SHALL pass for that configuration

### Requirement: Tag-dependent generator check matches full local clone under the CI checkout contract

When a docs (or other) generator in this repository derives committed artifacts from git tags and/or full history, the full CI gate run under the CI checkout contract defined above SHALL produce the same docs-freshness (or generator `--check`) pass/fail verdict for a given commit SHA as a full local clone of that SHA with the same working tree content. The supported fix for environment divergence is the CI checkout contract — generators that intentionally use tags as source of truth SHALL NOT be required to become checkout-independent solely to paper over default shallow Actions checkouts.

#### Scenario: Same SHA green locally remains green in Actions for tag-sourced CHANGELOG

- **WHEN** a head includes a tag-dependent docs generator and a committed `CHANGELOG.md` that is green under `docs:check` on a full local clone of that SHA
- **AND** GitHub Actions runs `npm run ci` (including the docs freshness step) on that head with the CI checkout contract
- **THEN** the docs freshness / generator check SHALL NOT fail solely because the Actions checkout lacked tags or full history
- **AND** SHALL pass or fail for the same content reasons as the local full clone

#### Scenario: Checkout-independence is not the required mitigation

- **WHEN** an implementer or reviewer evaluates how to keep local and Actions generator checks aligned
- **THEN** the repository contract SHALL treat full CI history+tags checkout as the supported approach for tag-sourced generators
- **AND** SHALL NOT require those generators to ignore git tags or fabricate release history to work under default shallow checkout

### Requirement: Release workflows retain full-history checkout independently

Existing release and auto-tag workflows that already use `fetch-depth: 0` for tag annotation access SHALL remain compatible with this capability. This change SHALL NOT weaken those workflows' history/tag fetch requirements.

#### Scenario: release.yml still fetches full history

- **WHEN** `.github/workflows/release.yml` (and auto-tag release workflow, if present) are inspected
- **THEN** they SHALL continue to use full-history checkout (`fetch-depth: 0` or stronger)
- **AND** this capability's CI job change SHALL NOT remove full history from those workflows
