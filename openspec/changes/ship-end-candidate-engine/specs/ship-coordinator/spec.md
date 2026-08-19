## ADDED Requirements

### Requirement: Ship coordinator post-train phases SHALL execute the candidate engine

After `train --merge` is complete or resumed complete, in-engine `pipeline ship` SHALL run Factory Reliability Gate (FRG) pack (`factory-release prepare` and `factory-gate`), `pipeline release`, `release finish`, and any coordinator-invoked tag on the candidate engine bound to the SHA being released. The candidate engine SHALL be the control checkout at that SHA, or an explicit candidate install of that SHA.

When the operator started `pipeline ship` from the previous production-pin CLI, the coordinator SHALL keep that pin process as the durable coordinator and SHALL spawn the candidate engine for leaf post-train verbs (`factory-release prepare`, `factory-gate`, `release`, `release finish`, and `ensureAnnotatedReleaseTag`). It SHALL NOT re-exec `pipeline ship`. It SHALL NOT rerun train. It SHALL NOT keep executing those leaf verbs inside the production-pin process when that process source SHA differs from the candidate. Train and `engine-promote` SHALL remain on the production pin.

The coordinator SHALL fail closed before those ship-end verbs if it cannot resolve a matching candidate engine. A failed resolution SHALL persist the train checkpoint and SHALL NOT start FRG pack or release mutation. This requirement does not authorize `--skip-frg` as the default. It does not authorize promote before GitHub Release publication.

#### Scenario: Production-pin ship switches to candidate after train

- **WHEN** an operator runs production-pin `pipeline ship --milestone v1.39.5`
- **AND** train completes with FRG-bound candidate SHA `C` whose version is `1.39.5`
- **THEN** the coordinator SHALL spawn `factory-release prepare` and `pipeline release` on the candidate engine at `C`
- **AND** it SHALL NOT open the release PR using the `1.39.4` production-pin `release.ts`

#### Scenario: Unresolvable candidate stops ship before release

- **WHEN** train is complete
- **AND** the coordinator cannot resolve a candidate engine matching the FRG-bound SHA
- **THEN** ship SHALL stop before `pipeline factory-release prepare` and before `pipeline release`
- **AND** status SHALL name the candidate-engine identity defect
- **AND** persisted train evidence SHALL remain so a retry does not retrain

#### Scenario: Handoff does not re-enter ship or train

- **WHEN** the pin coordinator spawns the candidate for a post-train verb
- **THEN** the spawned argv SHALL be a leaf CLI verb
- **AND** it SHALL NOT be `pipeline ship --milestone`
- **AND** it SHALL NOT be `pipeline train`
