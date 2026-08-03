## ADDED Requirements

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
