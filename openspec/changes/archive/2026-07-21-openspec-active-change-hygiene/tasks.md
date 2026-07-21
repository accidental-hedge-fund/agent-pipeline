## 1. Adjudicate the 12 legacy changes

- [x] 1.1 For each of the 12 active change ids, record the merged PR (if any) that shipped it:
      `config-sync-command`, `fix-round-spec-delta-consistency`, `gh-wrapper-review-followup`,
      `implementing-model-slot`, `intake-sub-command`, `pipeline-throughput-remediation`,
      `planning-crash-recovery`, `queue-and-budget-mode`, `review-prompt-craft-gaps`,
      `roadmap-perf-observability`, `roadmap-release-model-config`, `sweep-sub-command`.
- [x] 1.2 For each change, diff its `specs/<capability>/spec.md` deltas against
      `openspec/specs/<capability>/spec.md` and classify: *already in living specs*,
      *shipped but missing from living specs*, or *never shipped / superseded*.
      Pay particular attention to deltas naming capabilities with no living spec directory
      (`gh-write-helpers`, `batch-queue-engine`, `queue-batch-safety`, `roadmap-run-stats`,
      `roadmap-release-model`, `openspec-fix-round-spec-revision`,
      `review-prompt-confidence-calibration`, `review-prompt-few-shot-anchoring`).
- [x] 1.3 Write the disposition table (id → classification → archive command → evidence) into
      the implementation PR body.

## 2. Build the guard (before the cleanup, so it proves itself on the mess)

- [x] 2.1 Add the active-change scan to `scripts/ci-openspec.mjs`: list `openspec/changes/*`
      excluding `archive`, run after `openspec validate --all`, report both failures.
- [x] 2.2 Add mode resolution: `OPENSPEC_HYGIENE_MODE` → GitHub Actions env
      (`push` + default-branch ref / `pull_request`) → local git branch → inert.
      Resolve the default branch name from `origin/HEAD`, falling back to `main`.
- [x] 2.3 Add allowlist parsing for `openspec/active-allowlist.txt` (one id per line, ignore
      blanks and `#` comments; missing/empty ⇒ strict); error on entries naming a
      non-existent change.
- [x] 2.4 Write the failure message: every offending id on its own line plus the cleanup path
      (pre-merge archiving, or `openspec archive <id>`).
- [x] 2.5 Create `openspec/active-allowlist.txt` containing only header comments (no entries).

## 3. Tests

- [x] 3.1 Extend `scripts/ci-openspec.test.mjs` with fixture repos under a temp dir, driven via
      `CI_OPENSPEC_ROOT` and `OPENSPEC_HYGIENE_MODE` — no network, git, or `gh` calls.
- [x] 3.2 Cases: unallowlisted active change in default-branch mode fails and names the id;
      multiple offenders all listed; clean default branch passes; pull-request mode with an
      active change passes; undetermined mode is inert; allowlisted id passes; comments and
      blank lines ignored; stale allowlist entry fails; missing allowlist file is strict;
      no `openspec/` directory is a no-op.
- [x] 3.3 Prove the guard tests bite — confirm they fail against the pre-change
      `ci-openspec.mjs`.

## 4. Cleanup

- [x] 4.1 Archive each *already in living specs* change with `openspec archive <id> --skip-specs`.
- [x] 4.2 Archive each *shipped but missing from living specs* change with
      `openspec archive <id> --yes`, then review the resulting `openspec/specs/` diff.
- [x] 4.3 Archive each *never shipped / superseded* change, adding
      `openspec/changes/archive/<id>/SUPERSEDED.md` with the reason and follow-up issue number;
      file the follow-up issues for any surviving intent.
      **Result: none of the 12 legacy changes fell into this bucket** — all 12 were confirmed
      shipped (merged PR and/or code present), so no `SUPERSEDED.md` files or follow-up issues
      were needed.
- [x] 4.4 Run `openspec validate --all` after **each** archive step so a bad spec merge is
      attributed to the change that caused it.
- [x] 4.5 Confirm `openspec list` reports zero active changes other than this change itself.

## 5. Verify

- [x] 5.1 `OPENSPEC_HYGIENE_MODE=default-branch npm run ci:openspec` fails against this
      worktree (this change is still active and unallowlisted) and names
      `openspec-active-change-hygiene`; `OPENSPEC_HYGIENE_MODE=pr npm run ci:openspec` passes.
      Do NOT allowlist this change — the PR path is the inert path, and pre-merge archiving
      is what clears it (5.4).
- [x] 5.2 `npm run ci` green from the repo root.
- [x] 5.3 Confirm no `core/` files changed, so no `plugin/` mirror regeneration is required
      (`node scripts/build.mjs --check` still clean).
- [ ] 5.4 Confirm the pipeline's own pre-merge archive of this change removes it from
      `openspec/changes/`, leaving the default branch at zero active changes.
      (Happens automatically at pre-merge; not yet reached.)
