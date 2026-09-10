## Decisions

- Git, GitHub forge/CI/review/Tester observations, workflow runs, and Releases are authoritative. Local state may checkpoint and bind an FRG epoch identity or provide same-host exclusion, but ignored files never prove completion.
- Metadata merges before C is frozen. An unpublished bump on main is an accepted retry state.
- Every metadata reuse state (open, observed transition to merged, or already merged, including a deleted `release/vVERSION` head) passes one common validator: exact PR/base/head identity; title `release: VERSION — THEME` with one nonempty single-line theme; exact final nonempty provenance line (current helper marker or legacy `_Prepared by `pipeline release`_`); author login equal to the freshly observed authenticated actor (case-insensitive; another operator cannot resume); release-managed nonempty diff only; VERSION in root and core package files at that head; nonempty green checks bound to that head; exact merge identity and containment in C. A version string on main without that PR proof fails closed. `finishMetadata` reapplies that same `pr view` validator on every CI-wait observation and immediately before merge.
- Milestone membership and merged-PR containment are re-resolved against frozen C after metadata exact-head CI/merge and before fixtures, then revalidated after FRG immediately before tag creation. A change in membership, proof, or C blocks the next mutation.
- Completed retry identity is tag C, both package versions at C, exact annotation, an authoritative reconstruction of the passed exact pair, successful exact `release.yml` run at C, and a matching non-draft publication. Reconstruction discovers exactly one pair by its external provenance and re-observes its issues, PRs, exact-head checks, reviews, Tester evidence, current-head readiness, and absence of fixture merges. A clean checkout with no local record performs the same read-only reconstruction; it never creates a replacement pair for a tagged candidate.
- `release.yml` is the sole publisher and recovery implementation. Recovery uses a remote-evidence state machine keyed by workflow `release.yml` + tag + C. Release can rerun one observed exact-C workflow run or issue one bounded exact-C recovery dispatch to that workflow when the run is authoritatively absent. Before that dispatch, the CLI persists a recovery episode for the same key and reloads it on re-entry. An unobserved dispatch is a durable wait, not a second dispatch. Before `gh run rerun`, the CLI persists a recovery episode for the same key plus the exact workflow run ID and reloads it on re-entry. An unobserved rerun of a still-visible failed first attempt is a durable wait, not a second rerun. The workflow re-verifies the annotated remote tag at C before create/edit. Only a status-aware exact-tag 404 that is not auth-shaped proves Release absence; all other observer failures are unknown and block mutation.
- Existing prepare is retained only behind the explicit `release prepare`, `factory-release prepare`, and merge-queue `--release-when-complete` surfaces and runs in a dedicated worktree. `release prepare --packed-candidate` is rejected during argument validation before any Git command. `release finish` remains a metadata-PR merge helper and does not tag or publish.
- Publisher order is tag checkout/fetch, annotated-tag and root/core version verification, publication, then checkout of current main before dependency installation and tag-derived docs generation. `release.yml` remains the sole publisher and post-tag docs owner; the obsolete main-push auto-tagger is disabled pending #1560 deletion.

## Publisher recovery state machine

Key: `(workflow = release.yml, tag = vVERSION, candidate = C)`.

Exact-identity run: `event` is `push` or `workflow_dispatch`, `headBranch` equals the tag, and `headSha` equals C. Observation uses `gh api --paginate --slurp` on `repos/<repo>/actions/workflows/release.yml/runs?per_page=100&head_sha=C` and maps `id,event,head_branch,head_sha,status,conclusion,run_attempt`. `id`/`databaseId` and `run_attempt`/`attempt` MUST be JSON numbers in safe-integer bounds; numeric strings fail closed. Absence is concluded only when `total_count` matches the flattened set. Unknown, truncated, or malformed lists fail closed.

| Remote class | Predicate | Action |
| --- | --- | --- |
| successful | at least one exact run completed with `conclusion=success` | wait only for the matching non-draft Release; never dispatch or rerun |
| pending | at least one exact run is queued, waiting, or in progress | wait; never dispatch or rerun |
| failed | every exact run completed unsuccessfully | persist a recovery episode for `(release.yml, tag, C, run_id)` then `gh run rerun` the newest exact `databaseId` only when its `attempt` is 1 and that episode does not already record a rerun of that run; if the episode records an unobserved rerun, wait and re-observe; if `attempt > 1`, fail closed |
| absent | zero exact runs | persist a recovery episode for `(release.yml, tag, C)` then one `gh workflow run release.yml --ref vVERSION -f tag=vVERSION -f candidate=C` after re-verifying the remote annotated tag and `origin/main = C`. If that episode already records a dispatch, wait and reconcile remote runs; do not dispatch again. |

Bounds come from that remote set across reinvocations. A local `recoveryAttempted` flag is not the bound. The recovery episode is a persist-before-dispatch checkpoint of the one missing-run dispatch and a persist-before-rerun checkpoint of the one in-place rerun so a later process does not treat GitHub lag as a new absence or a fresh rerun permission. Dispatch is only for absence with no episode. A failed push or dispatch run is rerun in place at most once; it never authorizes a second dispatch or a second `gh run rerun` while the new attempt is still unlisted. CLI never creates or edits a GitHub Release.

## workflow_dispatch contract

`release.yml` keeps the existing `push: tags: ["v*"]` publisher and adds:

```yaml
workflow_dispatch:
  inputs:
    tag:
      description: Exact annotated tag (vX.Y.Z)
      required: true
      type: string
    candidate:
      description: Exact 40-hex candidate SHA C
      required: true
      type: string
```

The dispatch path is the same job as tag-push, not a second publisher. The job resolves `TAG`/`C` from `inputs` on dispatch and from `github.ref_name`/`github.sha` on push, then independently fetches `refs/tags/${TAG}`, verifies it is annotated, peels to C, matches both package versions, and confirms `origin/main = C` before publication. Invalid inputs, tag/C mismatch, or main movement fail closed without creating or editing a Release. `core/test/release-yml-tag-push.test.ts` currently forbids `workflow_dispatch`; replace that assertion with a contract that the dispatch inputs exist and share the push job.

## Metadata validator retrieval

One validator covers open, observed merge, already merged, and already merged with deleted `release/vVERSION`.

Do not use `gh pr list --head release/vVERSION` as the only lookup. Discover by release title/`gh pr view` identity. After branch deletion:

- `gh pr view N --json number,state,baseRefName,headRefOid,mergeCommit` still returns head and merge identity
- `git fetch origin pull/N/head:refs/pipeline/release-metadata/vVERSION` or fetch of the merge OID retrieves the exact head
- `git show <head_oid>:package.json` and `git show <head_oid>:core/package.json` prove both versions
- `gh api repos/.../pulls/N/files` proves release-managed paths after merge-commit, squash, or rebase, including when GitHub deleted the source branch. Do not compare a merged PR head to the current base tip (`origin/<base>...<head_oid>` is empty when that head is already an ancestor of main). Open retained worktrees may still use `git diff --name-only origin/<base>...<head>` before merge.
- `gh pr checks N --json name,bucket` or commit check-runs at `headRefOid` prove nonempty exact-head CI
- `git merge-base --is-ancestor <merge_oid> <C>` proves containment

A version already on main without that PR proof fails closed. `observeMetadata` returning null is not permission to treat current package versions as provenance.

## Prepare-only caller map

| Surface | Authority |
| --- | --- |
| `pipeline release VERSION` | complete: metadata, merge, FRG, tag, publication |
| `pipeline ship --milestone` (SemVer) | train, then exactly one complete-release call |
| `pipeline ship --milestone` (continuous) | train/integration only |
| `pipeline release prepare VERSION` | metadata PR only |
| `pipeline factory-release prepare --request` | FRG pack plus shared prepare-only `runRelease` |
| `pipeline merge-queue --release-when-complete` | shared prepare-only `runRelease` |
| `pipeline release finish <pr>` | merge the metadata PR; no tag or publish |
| `advance` / `single` / `loop` | no merge, no tag, no publish |

`release prepare --packed-candidate` is rejected at argv validation before any Git command. Remove the current `alignReleaseCheckoutToCandidate` call from the `release prepare` path in `core/scripts/pipeline.ts`. Legacy `release ensure-tag --packed-candidate` is unchanged and is not a complete-release caller.

## Tagged-stale-C versus completed docs refresh

- Completed: annotated `vVERSION` at C, matching notes and package versions, reconstructed exact-pair FRG pass, successful exact `release.yml` run, matching non-draft Release. Later docs refresh may advance main. Repeat invocation returns complete without milestone, fixtures, retag, or republish.
- Tagged-stale-C: annotated `vVERSION` at C exists, publication is not a verified success, and origin/main no longer equals C. Report durable incomplete/stale-C. Never retag, delete, recreate FRG, or rebind to later main. This is the observable half of the documented non-atomic tag-boundary race.
- Docs-push window: matching non-draft published Release plus exact publisher still `pending` is not completion and is not tagged-stale-C. Wait/observe without dispatch or rerun while that pending run is live, even after main moves C→D. Re-observe publication before throwing tagged-stale-C when head ≠ C. Absent/draft/unpublished state does not excuse that movement. Unknown or failed publication stays fail-closed.

## Status-aware Release lookup and workflow order

Replace `gh release view … &>/dev/null` and CLI `/release not found/i` matching. Both owners classify observer errors with the existing `isHttp404Signal` and `isGithubAuthOrPermissionError` helpers in `core/scripts/gh.ts`. Absence is only an HTTP-404-class, not-auth-shaped response for that exact tag. Auth, rate-limit, network, malformed JSON, and 5xx remain unknown.

Required `release.yml` order:

1. Fetch and check out the intended tag object
2. Guard annotated tag plus root and `core/package.json` versions
3. Independently verify remote tag identity and `origin/main = C`
4. Publish or edit the GitHub Release using status-aware lookup
5. Check out current `origin/main`
6. Install dependencies
7. Generate tag-derived docs without retargeting the tag

## Tag-boundary proof and limitation

Local Git documentation confirms that `--force-with-lease=<ref>:<expect>` protects a ref that is being updated and `--atomic` only groups the requested ref updates. The existing GitHub ref creation surface likewise has no precondition on a different ref. Updating protected main merely to obtain a lease is not an acceptable release primitive.

The strongest supported boundary is therefore: observe origin/main=C immediately after final milestone validation; non-force create/push the exact annotated tag object; re-fetch and verify that one remote tag snapshot and re-observe main; then have `release.yml` independently verify the tag object/C/notes and main=C immediately before publication. Observable movement fails closed and tags are never deleted or moved. There remains a narrow unavoidable race between the last main observation and tag ref creation, and another between the workflow's main observation and publication. This limitation requires explicit plan-review acceptance; the design does not claim impossible distributed compare-and-swap semantics. Absolute exclusion would require a server-side cross-ref precondition or a repository-wide merge/release lock obeyed by every writer, neither of which exists in the current approved scope.
