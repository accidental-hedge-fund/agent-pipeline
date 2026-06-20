## Context

`release.yml` publishes a GitHub Release when a `v*` tag is pushed. The workflow runs:

```
gh release create "${GITHUB_REF_NAME}" --verify-tag --notes-from-tag --title "${GITHUB_REF_NAME}" $flag
```

The intent is that the Release body comes from the annotated tag message. In practice:

- **Lightweight tags** silently produce GitHub auto-generated "What's Changed" notes because there is no annotation object to read.
- **Annotated tags** still produce the squash-commit message, not the annotation, because `actions/checkout@v4` with `fetch-depth: 0` fetches the peeled tag ref but `gh release create --notes-from-tag` on the Actions runner resolves the annotation unreliably (confirmed across v1.7.0 and v1.8.0).

The workaround used after every release — `gh release edit vX.Y.Z --notes "<annotation>"` — proves the annotation content is correct; the problem is solely in how the workflow passes it to `gh`.

## Goals / Non-Goals

**Goals:**
- The Release body SHALL equal the annotated tag message, without any manual post-publish edits.
- Lightweight tags SHALL be detected and rejected before publishing, so notes behavior can never silently change based on tag type.
- The fix SHALL be contained to `release.yml`; no application code or CI configuration changes.

**Non-Goals:**
- Changing how the maintainer authors or pushes tags (annotated tags via `git tag -a` remain the contract).
- Changing the `pipeline release` CLI sub-command (it stops at PR creation; tagging and publishing are the maintainer's domain).
- Supporting lightweight tags as a valid release path.

## Decisions

### Decision 1 — Explicit `--notes-file` over `--notes-from-tag`

**Chosen:** Read the annotation explicitly with `git tag -l "$GITHUB_REF_NAME" --format='%(contents)'`, write it to a temp file, and pass `--notes-file /tmp/notes.md` to `gh release create`.

**Rejected:**
- **Keep `--notes-from-tag` + `git fetch --force --tags`** — We tried `fetch-depth: 0` which already fetches all tags; the failure is in how `gh` resolves the annotation on the runner, not in which refs are available. An additional fetch is unlikely to help, and we'd have no deterministic way to verify the behavior changed.
- **`--generate-notes`** — Produces GitHub's auto-generated "What's Changed" PR list, which is not hand-curated. This contradicts the stated intent.

`git tag --format='%(contents)'` reads the annotation object directly from the local git store; it is deterministic regardless of how `gh` resolves tag references internally.

### Decision 2 — Fail fast on lightweight tags

**Chosen:** Before publishing, check `git cat-file -t "$GITHUB_REF_NAME"`. If the type is `commit` (lightweight tag) rather than `tag` (annotated), exit non-zero with a descriptive error.

**Rationale:** A lightweight tag cannot carry notes, so `%(contents)` would produce an empty string and the Release body would be blank. Failing fast with a clear error is better than silently publishing a Release with no notes and requiring manual correction.

**Rejected:** Silently allowing lightweight tags and falling back to `--generate-notes` — this would mask the incorrect tagging procedure and produce inconsistent Release bodies.

## Risks / Trade-offs

- **`git tag --format='%(contents)'` strips trailing newlines on some git versions** — Mitigate: write to a file rather than substituting inline; the file contents are passed as-is to `gh`.
- **Empty annotation body** — If the maintainer creates an annotated tag with an empty message, `%(contents)` is empty and the Release body is blank. This is a user error (annotated tags MUST have a non-empty message per this workflow's contract); the lightweight-tag guard does not catch it. Mitigation: add a non-empty check and fail fast if the extracted notes are blank.
- **Scope limited to `release.yml`** — We cannot retroactively fix already-published Releases; those require `gh release edit`.
