## ADDED Requirements

### Requirement: Ship coordinator post-train phases SHALL execute the candidate engine

After `train --merge` is complete or resumed complete, in-engine `pipeline ship` SHALL run Factory Reliability Gate (FRG) pack (`factory-release prepare` and `factory-gate`), `pipeline release`, `release finish`, and any coordinator-invoked tag on the candidate engine bound to the SHA being released. The candidate engine SHALL be the control checkout at that SHA, or an explicit candidate install of that SHA.

When the operator started `pipeline ship` from the previous production-pin CLI, the coordinator SHALL re-exec or spawn the candidate engine for those post-train phases. It SHALL NOT keep executing ship-end verbs inside the production-pin process when that process version or source SHA differs from the candidate. Train SHALL remain on the production pin.

The coordinator SHALL fail closed before those ship-end verbs if it cannot resolve a matching candidate engine. This requirement does not authorize `--skip-frg` as the default. It does not authorize promote before GitHub Release publication.

#### Scenario: Production-pin ship switches to candidate after train

- **WHEN** an operator runs production-pin `pipeline ship --milestone v1.39.5`
- **AND** train completes with FRG-bound candidate SHA `C` whose version is `1.39.5`
- **THEN** the coordinator SHALL invoke `factory-release prepare` and `pipeline release` on the candidate engine at `C`
- **AND** it SHALL NOT open the release PR using the `1.39.4` production-pin `release.ts`

#### Scenario: Unresolvable candidate stops ship before release

- **WHEN** train is complete
- **AND** the coordinator cannot resolve a candidate engine matching the FRG-bound SHA
- **THEN** ship SHALL stop before `pipeline release`
- **AND** status SHALL name the candidate-engine identity defect
