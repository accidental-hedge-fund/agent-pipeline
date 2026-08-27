## MODIFIED Requirements

### Requirement: Harness roles are harness-relative
Each profile SHALL still record `implementer` and `reviewer` as bootstrap/presentation metadata so `claude` documents implementer `claude` / reviewer `codex` and `codex` documents implementer `codex` / reviewer `claude`. Those profile fields SHALL NOT select live stage workers for a runnable repository. Live implementer and reviewer SHALL come from `.github/pipeline.yml` as specified by `required-repository-harness-roles`. `pipeline init` MAY copy the active profile pair into a newly created file as starter repository policy.

#### Scenario: Claude-invoked run
- **WHEN** the run uses the `claude` profile
- **AND** `.github/pipeline.yml` declares `harnesses.implementer` and `harnesses.reviewer`
- **THEN** planning/implementation/fix SHALL run on the repository implementer
- **AND** review SHALL run on the repository reviewer

#### Scenario: Codex-invoked run
- **WHEN** the run uses the `codex` profile
- **AND** `.github/pipeline.yml` declares the same `harnesses` pair
- **THEN** planning/implementation/fix and review SHALL target that same repository pair
- **AND** the live workers SHALL NOT switch to the `codex` profile's documented pairing

## REMOVED Requirements

### Requirement: The profile, not file config, selects the per-role harness

**Reason**: Reversed. An outer host must not select live implementer or reviewer workers. Repository `.github/pipeline.yml` is the execution-policy boundary. This also repairs the contradiction with `configurable-harness-roles`, which already allowed a repository `harnesses` block to override the profile.

**Migration**: Declare both `harnesses.implementer` and `harnesses.reviewer` in `.github/pipeline.yml`. Profile JSON keeps invocation, review mode, and presentation defaults. Live workers no longer come from the profile at stage execution. Replacement behavior is specified in `required-repository-harness-roles` and the modified "Harness roles are harness-relative" requirement.
