## ADDED Requirements

### Requirement: The `release` sub-command SHALL refuse to run when `release_model` is `continuous`

When the resolved `config.roadmap.release_model` is `'continuous'`, the `pipeline release` sub-command SHALL exit non-zero before bumping the version, regenerating the mirror, or creating any git object or GitHub resource. It SHALL print a message stating that release bundling is unavailable under the `continuous` release model and naming the `roadmap.release_model` config key.

#### Scenario: Continuous model causes immediate refusal before any mutation

- **WHEN** the user runs `pipeline release minor` and the resolved config has `roadmap.release_model === 'continuous'`
- **THEN** the command SHALL exit non-zero
- **AND** SHALL print a message naming `roadmap.release_model` and explaining that versioned release bundling is not available under the `continuous` model
- **AND** no version bump SHALL be written to any `package.json`
- **AND** no release branch, commit, or PR SHALL be created

#### Scenario: Semver model proceeds normally

- **WHEN** the user runs `pipeline release minor` and `config.roadmap.release_model` is `'semver'` or `release_model` is absent
- **THEN** the command SHALL proceed with the normal release flow without triggering the refusal gate
