## ADDED Requirements

### Requirement: Harness roles SHALL come from repository config when declared, otherwise the active profile

The `harnesses` (`implementer`/`reviewer`) roles SHALL be resolved per role: from the repository's
optional strict `harnesses:` block in `.github/pipeline.yml` when that role is declared there, and from
the active profile (`profile.harnesses`) when it is not. `PartialConfigSchema` SHALL accept the
`harnesses` block with exactly the optional keys `implementer` and `reviewer`; any other key inside it
SHALL be a strict-schema parse error. The reviewer role MAY additionally be supplied by the optional
`review_harness` key (see `configurable-harness-roles` and `configurable-review-harness` for the
precedence rules between the two). See the `configurable-harness-roles` capability for the full role
resolution, routing, validation, and evidence requirements.

#### Scenario: harnesses block accepted and applied

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with `implementer: grok` and `reviewer: codex`
- **THEN** `resolveConfig()` SHALL set `cfg.harnesses.implementer` to `"grok"` and
  `cfg.harnesses.reviewer` to `"codex"` regardless of the active profile

#### Scenario: unknown key inside harnesses rejected

- **WHEN** `.github/pipeline.yml` sets a `harnesses:` block containing a key other than `implementer` or
  `reviewer`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying that key

#### Scenario: absent block falls back to the profile

- **WHEN** `.github/pipeline.yml` sets no `harnesses:` block and no `review_harness` key
- **THEN** `cfg.harnesses.implementer` and `cfg.harnesses.reviewer` SHALL equal the active profile's
  roles, unchanged from the pre-change behavior

#### Scenario: implementer declared, reviewer omitted

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `implementer: grok`
- **THEN** `cfg.harnesses.implementer` SHALL be `"grok"` and `cfg.harnesses.reviewer` SHALL equal the
  active profile's reviewer

## MODIFIED Requirements

### Requirement: Inert models.* aliases produce a diagnostic warning at config-resolve time
`resolveConfig()` SHALL detect and warn about `models.*` aliases that are explicitly set in `.github/pipeline.yml` but will be silently ignored because the harness backing that role cannot honor a model selection. Whether a role's harness can honor a model selection SHALL be determined from that harness adapter's declared capabilities, not from a hard-coded harness name. A role whose harness adapter declares a model capability SHALL NOT produce the warning. This requirement augments the existing config-loading contract without changing validation, precedence, or the never-auto-merge safety floor. See the `config-inert-models-warn` capability for full requirements and scenarios.

#### Scenario: explicit inert alias detected and warned
- **WHEN** `.github/pipeline.yml` explicitly sets one or more `models.*` keys and the harness backing that role declares no model capability
- **THEN** `resolveConfig()` SHALL emit a non-blocking `console.warn` for each affected key before returning the resolved config

#### Scenario: capable harness produces no warning
- **WHEN** `.github/pipeline.yml` explicitly sets an implementer-role `models.*` key and the resolved implementer's adapter declares a model capability
- **THEN** `resolveConfig()` SHALL NOT emit an inert-alias warning for that key

## REMOVED Requirements

### Requirement: Harness roles come from the active profile, not file config

**Reason**: Reversed by this change. The primary (implementer) role was a property of the invoking host
rather than of the repository, which prevented a repository from declaring its intended primary/secondary
pairing. The replacement requirement — "Harness roles SHALL come from repository config when declared,
otherwise the active profile" — is added in this same delta.

**Migration**: No action is required for existing repositories. A config with no `harnesses:` block
resolves both roles from the active profile exactly as before. A repository that wants to pin its roles
adds `harnesses: { implementer: <name>, reviewer: <name> }` to `.github/pipeline.yml`; a config that
previously relied on `harnesses:` being a parse error will now parse, so any such intentional-failure
fixture must be updated to assert the new strict-key behavior instead.
