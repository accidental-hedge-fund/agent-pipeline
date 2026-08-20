## ADDED Requirements

### Requirement: Annotated v-star tag push SHALL be sufficient to publish the GitHub Release

The release workflow SHALL trigger on `push` of tags matching `v*` and SHALL publish a non-draft GitHub Release for that tag. After candidate `release ensure-tag` pushes the annotated tag, Tugboat wait-release SHALL succeed by polling `gh release view` without an operator `gh release create`. Tugboat SHALL NOT invoke `gh release create` or `git tag`.

#### Scenario: Tag push publishes Release for wait-release

- **WHEN** candidate `release ensure-tag` pushes annotated tag `v1.39.6`
- **AND** `.github/workflows/release.yml` is triggered by that tag push
- **THEN** a published non-draft GitHub Release `v1.39.6` SHALL appear
- **AND** Tugboat wait-release SHALL observe it via `gh release view`

#### Scenario: Tugboat does not create the Release

- **WHEN** an automated check inspects Tugboat ship-end
- **THEN** the composer SHALL NOT contain `gh release create`
- **AND** the composer SHALL NOT contain `git tag` as the ship path
