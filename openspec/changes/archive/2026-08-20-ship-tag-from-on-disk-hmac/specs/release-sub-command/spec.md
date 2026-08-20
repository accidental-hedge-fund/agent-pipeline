## MODIFIED Requirements

### Requirement: Release finish MAY heal docs after tag observation without owning tag creation

The operator-authorized `pipeline release finish <pr>` command SHALL continue to merge the release PR without itself creating tags or GitHub Releases. After a successful merge, finish SHALL return `mergeCommitOid` in JSON so a ship-end composer can invoke `pipeline release ensure-tag`. Finish MAY observe that annotated tag `vX.Y.Z` exists and invoke the same post-tag docs-refresh helper used by the auto-tag path when the local environment can write the default branch. When the auto-tag path has already committed an identical generator tree, finish's refresh SHALL be an idempotent no-op (no empty commit). Finish SHALL NOT delete tags, SHALL NOT publish releases, and SHALL NOT treat docs heal failure as a reason to unmerge the PR.

When `.agent-pipeline/frg/` is gitignored, ship-end tag creation SHALL be `pipeline release ensure-tag` (or in-process `ensureAnnotatedReleaseTag`) from on-disk HMAC `latest.json`, not auto-tag-release reading the merged tree. Finish SHALL NOT become that tag owner.

#### Scenario: Finish remains merge-authorized and tag-free

- **WHEN** `pipeline release finish <pr>` merges a valid release PR
- **THEN** the command SHALL NOT create or push the version tag
- **AND** tag creation SHALL be `pipeline release ensure-tag` on the ship-end composer, not finish itself

#### Scenario: Finish JSON includes mergeCommitOid

- **WHEN** `pipeline release finish <pr> --json` merges a valid release PR
- **AND** GitHub reports a merge commit OID
- **THEN** the JSON result SHALL include that OID as `mergeCommitOid`

#### Scenario: Optional post-tag heal is idempotent

- **WHEN** finish observes tag `vX.Y.Z` after merge
- **AND** it invokes post-tag docs refresh
- **AND** committed generator-owned docs already match a fresh generation from current tags
- **THEN** finish SHALL succeed without creating an empty commit

## ADDED Requirements

### Requirement: Ship-end composers SHALL invoke candidate release ensure-tag after finish

Ship-end composers (Tugboat, the installed `pipeline-ship-playbook` launcher, and in-engine `pipeline ship`) SHALL invoke `pipeline release ensure-tag` from the candidate engine after a merged release PR and before publication wait. They SHALL NOT invoke `git tag` or `gh release create`. They SHALL NOT treat auto-tag-release as a substitute when `.agent-pipeline/frg/` is gitignored. `pipeline release finish` SHALL NOT itself tag.

#### Scenario: Tugboat calls ensure-tag not git tag

- **WHEN** Tugboat has merged the `1.39.5` release PR via `release finish`
- **THEN** it SHALL invoke candidate `pipeline release ensure-tag 1.39.5 <mergeCommitOid>`
- **AND** it SHALL NOT invoke `git tag`
