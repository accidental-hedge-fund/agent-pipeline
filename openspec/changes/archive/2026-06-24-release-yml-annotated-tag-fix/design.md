## Context

`actions/checkout@v4` fetches the triggering tag via `refs/tags/<name>` but dereferences (peels) it to the underlying commit SHA on the local clone. This is standard git behavior when a remote advertises a peeled ref — but it means the local `refs/tags/<name>` ref points to a commit object, not the tag object. All tag-inspection commands (`git cat-file -t`, `git tag -l --format='%(contents)'`) operate on the local ref and therefore see only the commit.

The existing release workflow added `fetch-depth: 0` expecting full history and tags to be available — this brings down the commit history but does not force the annotated tag object to be stored locally as a `tag`-type object.

## Goals / Non-Goals

**Goals:**

- Ensure `refs/tags/${GITHUB_REF_NAME}` on the runner resolves to the annotated tag object before any guard or extraction step.
- Keep the fix surgical: touch only the step(s) needed, leave all existing guards and logic intact.

**Non-Goals:**

- Changing how tags are created by maintainers.
- Modifying `core/` TypeScript code or the pipeline state machine.
- Using `actions/checkout` options (`fetch-tags: true`) as a replacement — this option still peels refs in many configurations and is less predictable than an explicit targeted fetch.

## Decisions

### Decision: explicit single-tag force-fetch before guards

**Chosen approach:** Add one step immediately after `actions/checkout`:

```yaml
- name: Fetch the annotated tag object (checkout peels it to a commit)
  run: git fetch origin --force "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"
```

**Why not `fetch-tags: true` on the checkout action?**  
`fetch-tags: true` tells checkout to fetch all tags, but the behavior depends on the git version and whether the remote advertises peeled refs. On GitHub-hosted runners the peeling still occurs for the triggering tag. The targeted `--force` refspec unambiguously overwrites the local ref with the remote object, regardless of runner git version.

**Why `--force`?**  
Without `--force`, git refuses to overwrite a ref that already exists locally (checkout has already materialized it). The flag is safe here because we are only overwriting a ref that checkout just wrote — we cannot be losing anything the workflow needs.

**Why a dedicated step before the guards?**  
Placing it first makes the prerequisite explicit in the YAML; the guards and extraction steps remain unchanged and continue to work correctly on any runner where the annotated object is already available.

## Risks / Trade-offs

- **Rate / network cost:** A single `git fetch` of one refspec is negligible; no meaningful latency risk.
- **Runner git version:** `--force` with a full refspec (`src:dst`) is supported by all git versions available on GitHub-hosted runners (≥ 2.36). No compatibility concern.
- **Unintended scope:** The fetch is scoped to a single tag by name; it cannot overwrite unrelated refs.

## Migration Plan

1. Author the workflow YAML change (add one step).
2. Verify by pushing a test annotated tag to a branch (or by manually re-running a workflow via `workflow_dispatch` if the workflow is extended to support it).
3. Merge. Next annotated `v*` tag push auto-publishes the Release without manual intervention.

**Rollback:** Remove the added step; revert to manual `gh release create` (current workaround).

## Open Questions

_(none — approach is well-understood and reversible)_
