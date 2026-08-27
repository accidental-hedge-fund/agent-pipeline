## ADDED Requirements

### Requirement: Train merge-wave linked PR SHALL include non-closing pipeline mentions

Train merge-mode reconciliation SHALL treat a ready-to-deploy item as already integrated when any-state resolution links a same-repo merged pull request via `ConnectedEvent`, closing `willCloseTarget`, head `pipeline/<N>-*`, or title parenthetical `(#N)`, and the merge commit OID is contained in the fetched configured base. It SHALL NOT STOP with `ready-to-deploy but has no linked open PR` for that item. It SHALL NOT require an open pull request and SHALL NOT invoke a merge mutation for that item.

#### Scenario: Merged (#N) pipeline PR is already-integrated

- **WHEN** `pipeline train --merge` processes an issue labeled `pipeline:ready-to-deploy`
- **AND** the issue has no open pull request
- **AND** the issue timeline has a `CrossReferencedEvent` with `willCloseTarget: false` to a merged same-repo pull request whose head is `pipeline/<N>-*` or whose title contains `(#N)`
- **AND** that merge commit OID is contained in the fetched base
- **THEN** the train SHALL record the item as already integrated
- **AND** it SHALL NOT stop with `ready-to-deploy but has no linked open PR`
- **AND** it SHALL NOT invoke a merge mutation for that item

#### Scenario: Resume after ship train merge does not re-STOP

- **WHEN** a ship resume re-enters `train --merge` for planned issues whose squash merges already landed on `origin/<base>` as `(#N)` mentions
- **THEN** the train SHALL classify those items already-integrated
- **AND** it SHALL NOT STOP with `ready-to-deploy but has no linked open PR`
