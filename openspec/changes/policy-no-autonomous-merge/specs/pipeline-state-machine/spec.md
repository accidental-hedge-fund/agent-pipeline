## MODIFIED Requirements

### Requirement: Never auto-merge (structural guarantee)
The pipeline SHALL NOT merge pull requests from the autonomous `advance` loop (any path reachable from `pipeline advance` / the stage dispatch table that advances an issue). There SHALL be no merge stage in `STAGES`; the terminal stage remains `ready-to-deploy`. Merge capability MAY exist only behind explicit operator-invoked CLI surfaces that the advance loop never calls. The `auto_merge` config key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error identifying `auto_merge` as an unknown key (see `pipeline-configuration`). The never-autonomous-merge guarantee is structural — enforced by stage-table isolation, config parse rejection of `auto_merge`, and loop-isolation tests — not by a runtime "merge disabled" flag that an unattended path could flip.

Explicit operator-invoked merge surfaces exist and do not weaken this guarantee when they are never called from advance:

- `pipeline merge <pr>` (per-PR squash merge after `pipeline:ready-to-deploy`)
- `pipeline merge-queue … --apply` (batch sequential merge under explicit operator apply; dry-run remains the default for merge-queue)

These surfaces are session-bound operator authority for a given invocation. Unattended or config-driven merge without an explicit operator merge command remains out of scope for this product surface and MUST NOT be introduced via an `auto_merge` config key (see issue #662 for any future unattended-merge evidence standard). See `merge-sub-command` and `merge-queue-command` for surface-specific requirements.

#### Scenario: auto_merge key is rejected at config parse time
- **WHEN** a repo sets `auto_merge: true` in `.github/pipeline.yml`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `auto_merge` as an unknown key
- **AND** the pipeline SHALL NOT run

#### Scenario: advance loop never invokes the merge handler
- **WHEN** the advance loop dispatches any stage transition (from `ready` through `ready-to-deploy`)
- **THEN** no call to the `pipeline merge` handler, `mergePr`, the merge-queue apply/drive handler, or any merge primitive used by those surfaces is made
- **AND** the loop terminates at `ready-to-deploy` without merging the PR

#### Scenario: operator-invoked merge surfaces remain outside advance
- **WHEN** an operator runs `pipeline merge <pr>` or `pipeline merge-queue … --apply` in an explicit invocation
- **THEN** those commands MAY merge under their own gates
- **AND** their execution SHALL NOT be reachable from `pipeline advance` stage dispatch
