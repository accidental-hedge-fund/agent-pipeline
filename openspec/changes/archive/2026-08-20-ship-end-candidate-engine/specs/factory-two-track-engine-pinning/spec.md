## ADDED Requirements

### Requirement: Ship-end publishing SHALL execute the candidate track without reclassifying pinned production

Ship-end verbs that score or publish the candidate (`factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, and in-engine `ensureAnnotatedReleaseTag`) SHALL execute the candidate engine track after train-complete. Tugboat SHALL NOT invoke `git tag` or `gh release create`. That execution SHALL be labeled track `candidate` in run or ship evidence when those runs record engine identity. It SHALL NOT be recorded as track `pinned` solely because a production pin exists.

Ordinary factory production and dogfood loops SHALL continue to execute the production pin. Train `--merge` and implementer / review harnesses for train items SHALL stay on the pinned track. Running the candidate for ship-end SHALL NOT silently reclassify a pinned-track dogfood loop as the candidate, and SHALL NOT update the production pin (promote still requires GitHub Release publication and the existing FRG-gated promote path).

#### Scenario: Ship-end release is candidate track

- **WHEN** Tugboat or `pipeline ship` invokes `pipeline release` after train-complete
- **AND** the production pin version is `1.39.4` and the candidate SHA is `1.39.5`
- **THEN** the executing engine for that release SHALL be the candidate
- **AND** evidence SHALL NOT record that invocation as track `pinned`

#### Scenario: Pinned dogfood is unchanged

- **WHEN** a factory production/dogfood loop is intended as pinned-track
- **THEN** it SHALL still execute the production pin
- **AND** the ship-end candidate rule SHALL NOT cause that loop to run the unpromoted candidate as if it were production
