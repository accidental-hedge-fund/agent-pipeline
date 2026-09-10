## Decisions

- GitHub milestone/issues/PRs and origin refs are authoritative. Local state is only a same-host exclusion aid.
- Metadata merges before C is frozen. An unpublished bump on main is an accepted retry state.
- Completed retry identity is tag C, package versions at C, exact annotation, successful `release.yml` run at C, and a non-draft publication. Later main or milestone movement cannot invalidate it.
- Existing prepare is retained only behind the explicit `release prepare`/factory/merge-queue surfaces and runs in a dedicated worktree.
- `release.yml` is the sole publisher and post-tag docs owner. The obsolete main-push auto-tagger is disabled pending #1560 deletion.
