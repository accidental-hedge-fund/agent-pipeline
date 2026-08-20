## Context

See `proposal.md` for why. Current law and code at this worktree (inspected, not assumed):

- `#1127` gitignores `.agent-pipeline/frg/` (`engine-artifact-ignore-contract`, root `.gitignore` line `.agent-pipeline/frg/`). Pack writes stay local. Auto-tag and `release ensure-tag` already treat on-disk HMAC `latest.json` as the lookup.
- `runRelease` still does `if (frgEvidence) addPaths.push(releaseFrgDir)` (`core/scripts/stages/release.ts` ~2175–2185). `git add` of an ignored pathspec is a hard fail. That is the 1.39.5 `release-prepare.err`.
- FRG is required before bump (`requireFrgPassForRelease`). Skip is CLI `--skip-frg` or config `skip_frg: true` only. Issue non-goal: do not use `--skip-frg`.
- Rollback today restores `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, `.claude-plugin/` only **before** `git checkout -b`. After the branch exists, add/commit throw with no restore. Control checkout after 1.39.5: `release/v1.39.5` at `a949c581`, dirty version `1.39.5`, no commit.
- Living tests encode the old staging: `runRelease: release commit stages only the validated version FRG directory` asserts `add` includes `.agent-pipeline/frg/1.6.0`. `runRelease: a post-staging failure preserves the validated FRG input` asserts the same and that commit failure does not restore.

**Conflict (do not average):**

1. Code and two unit tests `git add` `.agent-pipeline/frg/<ver>` after a pass.
2. Ignore contract and #1127 forbid committing that tree. `git add` of an ignored pathspec fails.
3. Rollback comment calls branch creation the point of no return. Issue criterion 3 requires restore of `main` / configured base on add/commit failure.

This change **supersedes** (1). It **does not** reverse (2). It **moves** the point of no return in (3) to a successful release commit.

**Class vs site (engine-dogfood bar):**

| | |
| --- | --- |
| **Site** | Tugboat `pipeline release 1.39.5 --no-edit` after HMAC pack. `git add` `.agent-pipeline/frg`. Checkout left on `release/v1.39.5` with uncommitted 1.39.5 bumps. |
| **Class** | An engine command MUST NOT pass an artifact-ignore-contract path as an explicit `git add` pathspec. A failed release stage/commit after `checkout -b` MUST restore the configured base so the next identical prepare can retry. |
| **Shared surfaces** | `runRelease` staging and post-branch restore; `release-sub-command`; `factory-reliability-gate` (on-disk lookup, PR `run_id` attachment); `engine-artifact-ignore-contract` (no explicit add of ignored contract paths). |
| **Next identical fault** | The next HMAC-packed, gitignored-FRG `pipeline release` stages product files only, keeps `latest.json` on disk, and restores the base if add/commit fails. Tests fail if `addPaths` includes `.agent-pipeline/frg` while gitignored, or if a failed add leaves HEAD on `release/vX.Y.Z`. No new mole issue. |

A path-local `git add -f` on 1.39.5, or committing `latest.json` so add succeeds, is not the class fix.

## Goals / Non-Goals

**Goals:**

- Omit `.agent-pipeline/frg/` from release `git add` while still requiring on-disk HMAC `latest.json`.
- Restore configured base + release-managed files + delete the uncommitted local `release/vX.Y.Z` when add or commit fails after `checkout -b`.
- Flip tests that currently require staging FRG. Add a regression that failed add restores HEAD to the base.
- Keep PR-body FRG `run_id` / pass summary as the public attachment.

**Non-Goals:**

- Committing or `git add -f` of `latest.json`.
- `--skip-frg` as the ship path.
- Changing HMAC, pack-done, or `requireFrgPassForRelease` eligibility.
- Adding `CHANGELOG.md` to the prepare stage set (living prepare is not the post-tag CHANGELOG owner).
- Restoring or deleting after a successful release commit (push failure stays retryable on the branch).
- `git clean` of `.agent-pipeline/frg/`.
- Merge inside advance/loop.

## Decisions

### 1. Omit FRG from addPaths; do not force-add or un-ignore

`addPaths` stays the living product set: `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`. Drop `if (frgEvidence) addPaths.push(releaseFrgDir)`. Do not `git add -f`. Do not remove `.agent-pipeline/frg/` from `.gitignore`.

**Why not `git add -f`:** #1127 and the ignore contract exist so FRG stays local. Force-add would commit HMAC evidence onto the release PR and undo that class.

**Why not un-ignore:** that is the 1.39.4 `worktree-clean` failure class (#1127). Issue non-goal: do not commit `latest.json` so add succeeds.

**Why not `git add -A`:** release already uses an explicit allow-list. Keep that list. `git add -A` is the salvage path and already skips ignored files; it is not this command.

### 2. Point of no return is a successful release commit

Extend the rollback guard through `git add` and `git commit`. After `checkout -b` succeeds, those steps still have no unique commit. A failure there leaves the same uncommitted bumps the pre-branch guard already knows how to restore, plus HEAD on `release/vX.Y.Z`.

Restore order:

1. Restore release-managed files from HEAD (`git restore --source=HEAD --staged --worktree -- package.json core/package.json ROADMAP.md plugin .claude-plugin` and `git clean -fd plugin .claude-plugin`). `git checkout --` is not enough after a successful `git add`: it copies the index into the worktree and leaves staged version bumps.
2. Check out the configured base (`cfg.base_branch ?? "main"`).
3. Delete local `release/vX.Y.Z` only when it has no unique commit, so a retry can `git checkout -b` again.

Do not `git clean`, `git restore`, or `git checkout --` `.agent-pipeline/frg`. Evidence stays.

After a successful commit, this restore SHALL NOT run. A push failure leaves a real local commit for retry.

**Why delete the uncommitted local branch:** a leftover `release/v1.39.5` at the base SHA makes the next `checkout -b` fail with "branch already exists". That is a second mole on the same fault.

**Why not `git reset --hard` of the whole tree:** today's pre-branch restore is path-scoped so ignored FRG and other local files survive. Keep that scope.

### 3. Tests encode the class, not the 1.39.5 pathspec

Flip:

- `runRelease: release commit stages only the validated version FRG directory` → assert `git add` does **not** include `.agent-pipeline/frg`.
- `runRelease: a post-staging failure preserves the validated FRG input` → keep "do not clean/checkout FRG"; add restore of the configured base on commit failure.

Add:

- FRG pass + gitignored path: `add` argv has no `.agent-pipeline/frg`. Prove it fails on current `addPaths.push(releaseFrgDir)`.
- `git add` non-zero after `checkout -b`: HEAD is not `release/vX.Y.Z`; restore of version files ran; FRG path was not cleaned.

Inject `runCommand`. No live git, network, or GitHub.

### 4. Do not retune requireFrgPassForRelease

Keep the existing fail-closed lookup. Missing / fail / unparsable still throw before bump. This change only stops staging the file that lookup already read.

## Risks / Trade-offs

- **[Risk] leftover local `release/vX.Y.Z` blocks retry** → Mitigation: delete that local branch only when it has no unique commit.
- **[Risk] restore deletes on-disk HMAC `latest.json`** → Mitigation: restore pathspec stays the living release-managed files. Never pass `.agent-pipeline/frg` to `git restore`, `git checkout --`, or `git clean`.
- **[Risk] restore after successful commit destroys a real release commit** → Mitigation: restore duty ends at successful commit. Push failure is out of scope.
- **[Risk] consumers expected FRG in the release tree** → Mitigation: living #1127 / auto-tag / ensure-tag already treat disk as the lookup. PR body still carries `run_id`.

## Migration Plan

No data migration. The next `pipeline release` after this change is the fix. If a host is still on leftover `release/v1.39.5` with dirty 1.39.5 bumps from the 2026-08-19 fail, restore the control checkout to `main` by hand once (`git checkout --` the bumped files, `git checkout main`, delete the uncommitted local branch) before retrying. That one-time janitor is not the product path.

## Open Questions

None. HMAC / pack policy stays. CHANGELOG stays off the prepare stage set. Restore target is the configured base.
