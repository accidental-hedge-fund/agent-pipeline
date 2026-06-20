## 1. Update release.yml — lightweight-tag guard

- [ ] 1.1 In `.github/workflows/release.yml`, add a step before the publish step that runs `git cat-file -t "$GITHUB_REF_NAME"` and exits non-zero with a descriptive error if the result is not `tag`

## 2. Update release.yml — explicit annotation extraction

- [ ] 2.1 Replace the `gh release create --notes-from-tag` call with: extract the annotation via `git tag -l "$GITHUB_REF_NAME" --format='%(contents)' > /tmp/notes.md`, verify `/tmp/notes.md` is non-empty, then call `gh release create --notes-file /tmp/notes.md`
- [ ] 2.2 Update the workflow comment to accurately describe the new notes extraction mechanism (remove the stale `--notes-from-tag` reference)

## 3. Verify correctness

- [ ] 3.1 Confirm the updated steps would produce the correct body for v1.8.0 by running the extraction commands locally against the existing annotated tag and comparing the output to the manually-corrected Release notes
- [ ] 3.2 Confirm a lightweight tag (created with `git tag` without `-a`) is correctly rejected by the guard step
- [ ] 3.3 Confirm an annotated tag with an empty message is correctly rejected by the non-empty check

## 4. Acceptance check

- [ ] 4.1 Push an annotated pre-release tag (e.g. `vX.Y.Z-rc.1`) to a test repo or verify on the next real release that the published Release body equals the tag annotation message without any manual `gh release edit`
