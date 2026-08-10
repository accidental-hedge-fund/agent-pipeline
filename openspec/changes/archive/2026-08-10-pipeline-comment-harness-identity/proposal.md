## Why

GitHub stage-transition comments still hardcode the Claude skill footer and render `Harness: unassigned` when the primary harness is `grok` (or any non-claude/codex harness). That misattributes the run and bypasses the profile-driven `marker_footer` already used by every other comment builder. Issue #954 needs a correctness fix so labels and footers match the harness the pipeline actually stamped.

## What Changes

- Parse any `harness:<name>` issue label as the harness identity (not only `claude` / `codex`), so transition and related surfaces show `grok`, `opencode`, `pi`, etc. instead of `unassigned`.
- Bootstrap `harness:*` labels for every registered harness-adapter name (not only claude/codex), so stamping `harness:grok` during planning cannot fail because the label is missing.
- Build stage-transition (and the sibling blocked-comment path that shares the same hardcoded constant) footers from `cfg.marker_footer`, matching planning / review / deploy_ready comment builders. Remove the Claude-only `COMMENT_FOOTER` hardcode.
- Update unit tests and add regressions for `harness:grok` parsing and configured footer on transition comments.
- **Out of scope for this change:** a separate Grok skill profile / identity string when the outer host is grok but `profileDefault` remains `claude` (install intentionally shares the Claude skill tree). Footer *content* continues to follow the active profile's `markerFooter`; only the hardcode bypass is removed. A future change may add `core/profiles/grok.json` if operators want a Grok-specific footer string.

## Capabilities

### New Capabilities
- `pipeline-comment-harness-identity`: requirements for harness-label parsing on comments, multi-harness label bootstrap, and config-sourced footers on transition/blocked pipeline comments.

### Modified Capabilities
- `init-command`: broaden the init label-bootstrap scenario so expected `harness:*` labels include all registered harness names, not only `harness:claude` and `harness:codex`.
- `worktree-lifecycle`: tighten `ensurePipelineLabels` so the harness label set is defined as every registered harness-adapter name (not an implicit claude/codex pair).

## Acceptance criteria

- [ ] Given issue labels including `harness:grok`, `getHarnessLabel` returns `"grok"` (not `null`), and a stage-transition comment body renders `**Harness**: grok` rather than `unassigned`.
- [ ] Given issue labels including `harness:opencode` or `harness:pi`, the same parser returns that harness name; labels without any `harness:` prefix still yield the existing `unassigned` fallback on transition.
- [ ] `ensurePipelineLabels` (and therefore `pipeline init`) creates `harness:<name>` for every registered harness-adapter name at least including `claude`, `codex`, `grok`, `opencode`, and `pi`, without erroring when those labels already exist.
- [ ] A stage-transition comment body ends with the active config's `marker_footer` (for example `*Automated by Codex Pipeline Skill*` under the codex profile), not a hardcoded Claude-only string, while still carrying attestation / audit sentinel structure.
- [ ] The blocked-comment builder that currently shares the hardcoded Claude footer also uses `cfg.marker_footer` (or an equivalent config-sourced footer) instead of the Claude hardcode.
- [ ] Unit tests cover: `harness:grok` → `"grok"`; unknown non-`harness:` labels → null/`unassigned` fallback; transition comment contains configured `marker_footer`; existing claude/codex cases remain green.
- [ ] `npm run ci` passes from the repo root (including mirror check when `core/` is edited at implementation time).

## Impact

- `core/scripts/gh.ts` — `getHarnessLabel`, `ensurePipelineLabels`, `buildTransitionComment` / `transition`, blocked-comment footer.
- `core/test/gh-parsers.test.ts`, `core/test/pipeline-comment-attestation.test.ts`, and any tests pinned to the old `getHarnessLabel` union or Claude-only transition footer.
- `init` / advance bootstrap paths that call `ensurePipelineLabels` (behavior only: more labels created).
- No state-machine stage edges, review policy, merge authority, or profile resolution changes in this change.
- `plugin/` mirror regeneration only when implementation edits `core/`.
