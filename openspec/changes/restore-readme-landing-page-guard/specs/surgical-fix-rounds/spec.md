## ADDED Requirements

### Requirement: Pre-merge or surgical repair SHALL fail closed on large unrelated landing-page documentation deltas

A pre-merge repair, fix-round repair, restack, or conflict-resolution path that applies surgical-fix discipline SHALL treat a large unrelated root `README.md` landing-page contract breach (including a #793-class monolithic append unrelated to the findings or conflict under repair) as out of surgical scope for silent success. When such a delta is present on the head that would advance, the control path SHALL fail closed or return the item to scoped repair/review with diagnostics naming the documentation contract breach. The path SHALL NOT advertise gate-passed implement/fix success or ready-to-deploy eligibility while the landing-page contract enforced by the docs check surface is red. This requirement does not change review severity thresholds, finding disposition policy, or merge authority; it is a deterministic documentation-contract control.

#### Scenario: Fix/pre-merge head with monolithic README does not silently advance

- **WHEN** a surgical fix or pre-merge repair commits a head whose `README.md` violates the landing-page line budget or companion-link contract
- **AND** that documentation delta is unrelated to the findings or conflict being repaired
- **THEN** the pipeline control path SHALL NOT treat the item as successfully advanced past the docs/test gate
- **AND** SHALL surface a failure or scoped-review return that names the README / landing-page contract breach class

#### Scenario: Finding-scoped code fix with compliant README still advances subject to other gates

- **WHEN** a surgical fix changes only finding-scoped code paths
- **AND** root `README.md` remains within the landing-page contract
- **THEN** this requirement SHALL NOT by itself block advance
- **AND** other existing gates (tests, review-SHA, CI) continue to apply unchanged

#### Scenario: Regression coverage for the #793 repair escape class

- **WHEN** a unit or fixture test injects a post-repair head with a #793-shaped monolithic README append on a path that claims surgical or conflict repair success
- **THEN** the test SHALL assert fail-closed or non-success (no silent ready-to-deploy / gate-pass outcome)
- **AND** the test SHALL fail if that assertion path is removed
