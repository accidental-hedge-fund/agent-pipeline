## ADDED Requirements

### Requirement: Candidate tugboat.sh SHALL own ship-end compose after train

A ship-end composer SHALL exec the packed-candidate tree’s `examples/supervisor/shell/tugboat.sh` after train-complete when process-start compose is not already that file. After that exec, FRG pack, release prepare, release finish, ensure-tag, wait-release, and the remaining ship-end sequence SHALL run from the candidate composer. Process-start tugboat from a stale checkout SHALL NOT keep composing those verbs.

#### Scenario: Next identical pin-behind-candidate composer fix needs no new mole

- **WHEN** train merges a tugboat wait or ensure-tag fix into candidate SHA `C`
- **AND** process-start tugboat is the previous pin tree
- **THEN** ship-end SHALL exec `tugboat.sh` from the tree at `C`
- **AND** FRG pack SHALL use that candidate composer
