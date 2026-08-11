## Context

See proposal.md for the production failure mode (stale tag-derived `CHANGELOG.md` after release).

Relevant current shapes:

1. **`pipeline release` (prepare)** — bumps versions, regenerates `plugin/` mirror, scaffolds forward-looking ROADMAP sites, opens a release PR. Explicitly does **not** merge, tag, or publish (`release-sub-command`). Comments in `scaffoldRoadmap` note that free-form ROADMAP history was retired in favor of generator-owned `CHANGELOG.md`, but prepare never runs the generator for the new version.
2. **`pipeline release finish`** — operator-authorized merge of the release PR only. Logs that tag/publish remain auto-tag + `release.yml`.
3. **`auto-tag-release.yml`** — on default-branch push, detects a release merge subject + matching `core/package.json` version, creates and pushes annotated `vX.Y.Z`, which then triggers `release.yml` for GitHub Release publish.
4. **Docs generator** — `CHANGELOG.md` is fully regenerated from git tags (`listReleases` / `parseGitTagListLines` → `renderChangelogMarkdown`). Check mode fails when committed content differs from a fresh generation. CI checkout already fetches full history + tags (`ci-checkout-generator-parity`).

**Ordering constraint:** Squash-merge means the annotated tag must point at the post-merge default-branch commit. The tag therefore does not exist while the release PR is open. Any prepare-time CHANGELOG that invents the new version section will **diverge** from generator check mode on the release PR (check reads only real tags) unless the generator gains dual-mode "pending release" injection. After the real tag lands with richer notes, a prepare-time placeholder also tends to go stale again.

## Goals / Non-Goals

**Goals:**

- After `vX.Y.Z` exists, leave the default branch with committed generator output that includes that version and passes `generate-docs --check` on a full-tag checkout.
- Keep tags as the CHANGELOG source of truth (no parallel hand-edited history path).
- Keep release prepare free of merge/tag/publish authority.
- Make the regenerate+commit path unit-testable via deps injection (fake tag list / fake write+commit).

**Non-Goals:**

- Changing Keep-a-Changelog-ish heading format or tag-parse rules.
- Reintroducing ROADMAP Shipped prose or revive `prependShippedBlock` as the history surface.
- Giving `pipeline release` prepare the power to push tags or publish GitHub Releases.
- Solving unrelated docs drift (README landing contract, CLI/config reference staleness) except as incidental co-regeneration when the shared generator runs.
- Cross-host distributed locking for the post-tag commit (single default-branch writer after tag is enough).

## Decisions

### D1 — Regenerate after the version tag exists (not only at prepare)

**Decision:** The normative refresh happens **after** the annotated `vX.Y.Z` tag is created and visible to the generator, then commits the generator write outputs to the default branch.

**Why not prepare-only regen without a real tag?**  
On the open release PR, `git tag -l` does not include `vX.Y.Z`. Committing a synthetic `## [X.Y.Z]` section makes `docs:check` fail on that PR unless check mode also injects a pending release. After auto-tag, tag subject/body/date may still differ from the synthetic section, causing a second staleness. Post-tag regen uses the same inputs CI and operators use.

**Why not change tag timing to before the release commit?**  
Squash merge retargets history; a pre-merge tag would not point at the merge commit that `release.yml` and install pins expect. Auto-tag-on-merge remains correct for tag placement.

**Alternatives considered:**

| Approach | Reject reason / defer |
| --- | --- |
| Prepare-time synthetic pending release + dual-mode check | Possible later optimization for "entry in version-bump commit"; higher coupling and note-alignment risk |
| Manual operator `generate-docs` after every release | Status quo; fails under automation (this bug) |
| Soft-fail docs:check when latest package version lacks a CHANGELOG section | Hides real staleness; violates docs-freshness-gate |

### D2 — Primary live invoker: auto-tag success path; shared TypeScript helper

**Decision:**

1. Extract a small **shared post-tag docs refresh** helper under `core/scripts/` (name left to implementer; e.g. release-docs-refresh) with injectable deps:
   - observe version / tag presence (or accept version already validated by caller)
   - run docs generator write mode (or pure `buildGeneratedArtifacts` + write files)
   - detect dirt limited to generator-owned paths
   - create a conventional commit on the default branch and push when dirt exists
   - no-op success when generation produces no diff
2. **Primary live call site:** after a successful annotated tag create/push in `auto-tag-release.yml` (same job, checkout already has history/tags; generator can see the new tag). Prefer invoking a repo script entry that loads the helper rather than reimplementing generation in shell.
3. **Secondary / operator path (optional but desirable):** `release finish` MAY wait for tag observation and invoke the same helper when the operator environment can write the default branch — useful for local recovery when the workflow step failed. It MUST NOT become a second competing writer on the happy path if the workflow already committed identical content (idempotent no-op when clean).

**Why auto-tag first?**  
Tag creation and CHANGELOG refresh share the same success condition ("release merge detected and tagged"). Putting regen in the same job minimizes the window where `main` has the tag but stale CHANGELOG. `release finish` today exits at merge and must not invent tag authority; waiting for workflows is optional hardening, not a replacement for the workflow step.

**Alternatives considered:**

- Only extend `release finish` — leaves automated merges that never call finish (or finish before tag is ready) exposed.
- Only a later cron/heal bot — larger window of red next-PR CI.

### D3 — Commit scope and message

**Decision:**

- Stage **only** paths the docs generator owns (at minimum `CHANGELOG.md`; also other generator outputs dirty in the same write, e.g. `docs/cli.md` / SKILL regions if the same generate run rewrites them). Do not fold unrelated worktree dirt.
- Use a conventional commit subject such as `docs: regenerate CHANGELOG for vX.Y.Z` (exact text implementer-chosen but stable and greppable). Include issue trailers only when the operator/workflow context has an issue number; auto-tag may omit issue trailers if none apply.
- If the generator write produces **no** diff, do not create an empty commit; exit success.
- If generate or commit/push fails after the tag was already pushed, **fail the job loudly** (tag remains; CHANGELOG heal is required). Do not delete the tag as rollback.

### D4 — Credentials and workflow trigger hygiene

**Decision:** Reuse the existing post-tag credential model carefully:

- Tag push already requires `RELEASE_TAG_TOKEN` (or equivalent trigger-capable credential) so `release.yml` fires.
- The follow-up docs commit push also needs a credential that can push to the default branch. Prefer the same secret **only if** its scopes already allow contents write for commits; do not broaden scopes beyond contents write already required for tag push.
- Pushing a docs commit to `main` will re-enter `auto-tag-release.yml`. Detection MUST remain a successful no-op (subject will not match `release: X.Y.Z — …`), so no tag loop. Add an explicit regression note/test that a `docs:` subject does not re-tag.

### D5 — Testing strategy

**Decision:**

- Unit-test the helper with fake deps:
  - **Given** a release list that includes the new version (simulating post-tag `listReleases`)
  - **When** refresh runs against a committed CHANGELOG missing that section (or a stub write that reports dirt)
  - **Then** generate write is invoked and a commit of generator-owned paths is requested
- Negative cases: no dirt → no commit; generate failure → error, no commit; non-release / missing tag precondition → no-op or fail closed per helper contract.
- Workflow drift-guard: if YAML gains a generate-docs / refresh step, extend `auto-tag-release-workflow.test.ts` (or sibling) to assert the step exists after tag push — mirror existing subject-pattern drift guards.
- No real `gh`, network, or git as the sole pass path for unit tests.

### D6 — Prepare path remains free of false "CHANGELOG fixed" claims

**Decision:** Do **not** claim prepare regenerated the shipped tag entry. Prepare may continue to avoid CHANGELOG mutation, or may only regenerate non-tag docs if needed for other reasons — but the **shipped version entry** obligation is post-tag. Update comments near retired `patchIntroLine` / `prependShippedBlock` call sites to point at the post-tag refresh helper so future readers do not assume prepare writes CHANGELOG.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Window between tag push and docs commit where next PR can still fail docs:check | Keep regen in the same auto-tag job immediately after tag push; fail job if regen fails so operators notice before starting the next train |
| Docs commit re-triggers auto-tag workflow | Existing subject+version detection no-ops; add test/comment |
| Generate rewrites extra artifacts (SKILL regions) and expands the commit | Accept co-regeneration of generator-owned set; still better than stale CHANGELOG; do not stage non-generator paths |
| `RELEASE_TAG_TOKEN` cannot push ordinary commits | Verify during implement; if not, document required scope or use a dedicated contents-write secret already used for maintainer automation — fail closed with explicit error |
| Two writers (finish + workflow) race | Helper is idempotent when tree already matches generation; prefer workflow as primary |
| Operator runs finish before tag exists | Finish remains merge-only on the critical path; optional wait/heal is best-effort and must not fail merge success already recorded without a clear retry message |

## Migration Plan

1. Land helper + unit tests + workflow (or finish) invoker on a normal PR through the pipeline.
2. No data migration: next real release exercises the path; if a past tag already left CHANGELOG stale on `main`, one manual or one-shot `node scripts/generate-docs.mjs` + commit heals history (optional chore, not required for acceptance if current main is already green).
3. Rollback: revert the workflow step / helper; worst case returns to status quo (manual CHANGELOG regen). Tags already pushed are unaffected.

## Open Questions

None that block specs or tasks. Implementer may choose exact helper module name and whether optional `release finish` wait is in the first PR or a fast follow, as long as the auto-tag (or other default-branch post-tag) path satisfies the acceptance criteria.
