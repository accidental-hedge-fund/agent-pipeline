## Decisions

- GitHub milestone/issues/PRs and origin refs are authoritative. Local state is only a same-host exclusion aid.
- Metadata merges before C is frozen. An unpublished bump on main is an accepted retry state.
- Milestone membership and merged-PR containment are re-resolved against frozen C after metadata exact-head CI/merge and before fixtures, then revalidated after FRG immediately before tag creation. A change in membership, proof, or C blocks the next mutation.
- Completed retry identity is tag C, package versions at C, exact annotation, a durable passed exact-pair FRG record for C, successful exact `release.yml` run at C, and a matching non-draft publication. An incomplete publication retry remains anchored to this C and never reruns fixtures or rebinds to later main; unknown proof fails closed.
- Existing prepare is retained only behind the explicit `release prepare`/factory/merge-queue surfaces and runs in a dedicated worktree. Packed-candidate preparation must preserve the same caller-checkout isolation or reject before Git mutation.
- `release.yml` is the sole publisher and post-tag docs owner. The obsolete main-push auto-tagger is disabled pending #1560 deletion.
