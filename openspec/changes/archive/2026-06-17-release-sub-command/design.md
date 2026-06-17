## Context

The post-merge release half is already automated by `.github/workflows/release.yml` (PR #169): pushing a `v*` tag causes it to publish a GitHub Release automatically. This design covers only the pre-merge half — preparing the release commit and PR.

The existing no-issue-number sub-commands (`init`, `doctor`, `cleanup`) each dispatch from `pipeline.ts` via a keyword check on the positional argument. The `release` keyword follows that same pattern. The implementation goes in a new `core/scripts/stages/release.ts` module so the CLI dispatch file stays thin.

Key constraints from the repo's golden rules:
- `core/package.json` is the canonical version source (read by `pipeline --version`); root `package.json` mirrors it.
- `plugin/` must be regenerated with `node scripts/build.mjs` after any version bump, otherwise `build.mjs --check` (run inside `npm run ci`) will fail.
- ROADMAP.md is hand-curated. The command scaffolds changes (i.e., writes machine-derivable rows and opens the diff for human confirmation) rather than fully auto-generating final prose.

## Goals / Non-Goals

**Goals:**
- Automate the four deterministic steps: version bump, mirror regen, ROADMAP scaffolding, CI gate.
- Open the release PR with a machine-generated but human-editable body.
- Support `--dry-run` so the maintainer can preview before committing.
- Support semver alias expansion (`major`, `minor`, `patch`) as shorthand.
- Keep the human in the loop for ROADMAP prose and the version decision.

**Non-Goals:**
- Auto-deciding the version number (aliases require the maintainer to choose; explicit `X.Y.Z` requires even less guessing).
- Tagging, merging, or publishing the GitHub Release — those are the post-merge workflow's domain.
- Full auto-generation of ROADMAP prose — the maintainer finalizes the Shipped block narrative.
- Any interaction with the pipeline state machine, issue labels, or stage handlers.
- Reusing the ROADMAP-editing machinery from #158 (intake) at this point; #158 is not yet merged and its ROADMAP mutation surface may differ. If #158 ships first, the implementation can refactor to share helpers — but the spec should not block on it. Track as a possible follow-up consolidation.

## Decisions

**Decision: `release` dispatches as a positional keyword, not a `--release` flag.**
Consistent with `doctor`, `init`, and `config` — they are all positional keywords. `--release` as a flag would be inconsistent and harder to extend with sub-arguments like `release minor`. Positional dispatch is already well-supported by the `commander` argument pattern in `pipeline.ts`.

**Decision: Version alias expansion reads `core/package.json`, not root `package.json`.**
`core/package.json` is the canonical version source (the one read by `--version`). Root `package.json` is bumped in parallel. Alternative (reading root) would diverge from the runtime version source.

**Decision: ROADMAP.md is scaffolded (not fully auto-generated), then opened in `$EDITOR`.**
The ROADMAP is explicitly hand-curated (CLAUDE.md). Fully auto-generating it risks wrong prose surviving into the PR. Instead, the command:
1. Derives machine-computable data (issue/PR numbers and titles from `git log <last-tag>..HEAD`, the release-plan row date).
2. Writes those into the four ROADMAP locations as scaffolded text (placeholders where judgment is needed).
3. Opens the result in `$EDITOR` for the maintainer to complete.
4. Only proceeds to PR creation after the maintainer saves and closes the editor (or under `--dry-run`, skips the editor and prints the diff).

Under `--no-edit` (CI / automated context), the scaffold is committed as-is without opening the editor.

**Decision: CI gate runs `npm run ci` before opening the PR, not as a pre-condition.**
Running CI inside the command (in the current worktree, after the bump) catches mirror staleness or a package.json parse error before the PR is opened. Alternative (asserting CI is already green) would require the maintainer to have already run CI manually, which defeats part of the automation. The command: bump → regen mirror → run `npm run ci` → open editor → open PR.

**Decision: Discovering "what shipped" uses `git log <last-tag>..HEAD --merges`.**
This gives the canonical set of merge commits since the last tag. Each is parsed for the PR number from the merge message (GitHub's standard `Merge pull request #N` format). From those PR numbers, issue references are extracted from PR bodies via `gh pr view N --json body`. Alternative (reading `release:` labels) is less reliable because label history is mutable; git log is the ground truth.

**Decision: The ROADMAP has four mutation sites, all patched atomically.**
1. Intro paragraph — the shipped-chain sentence appended with the new version.
2. Release-plan table — the matching row's type cell updated to `✅ shipped`.
3. Shipped section — a new subsection prepended below the existing most-recent shipped block.
4. Per-issue semver table — rows for issues in this release stamped with the resolved version.

All four writes happen on the same in-memory string before it is written to disk, so the on-disk ROADMAP is always self-consistent (no partial update possible).

## Risks / Trade-offs

- *ROADMAP text layout changes break the patch logic* — the four mutation sites are identified by regex anchors (e.g., the `## Shipped` header, the release-plan table delimiter). If the ROADMAP's structure drifts, the patching may mis-apply. Mitigation: the command fails explicitly if any anchor is not found, rather than silently writing a malformed file.
- *`git log --merges` misses squash-merged PRs* — GitHub's squash-merge messages don't start with "Merge pull request #N". Mitigation: fall back to scanning all commits for `(#N)` parenthetical references, which GitHub injects for squash merges. If neither pattern matches, emit a warning and leave the PR list as `(no merged PRs detected — fill manually)`.
- *`$EDITOR` is not set in CI* — under `--no-edit` or `--dry-run`, no editor is launched; this is the safe CI path. If `$EDITOR` is unset and `--no-edit` is not passed, warn and proceed as `--no-edit`.
- *Concurrent release runs* — no special lock beyond the normal git worktree. The command is interactive/human-driven and is not expected to run concurrently.

## Open Questions (from issue #170)

The following open questions from the issue are resolved by this design:

1. **"What shipped since the last release"** → `git log <last-tag>..HEAD --merges` + squash-merge fallback on `(#N)` commit message references.
2. **"Scaffold vs. fully auto-generate ROADMAP"** → Scaffold (machine-derivable rows filled in; narrative prose left for human to finalize in `$EDITOR`).
3. **"Reuse #158 ROADMAP-editing machinery"** → Not at this time; track as follow-up consolidation if #158 ships first.
