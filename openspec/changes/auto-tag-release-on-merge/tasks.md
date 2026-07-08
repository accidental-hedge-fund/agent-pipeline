# Tasks — Auto-tag releases when a release PR merges

## 1. Provisioning (credential)

- [ ] 1.1 Provision a credential whose pushes trigger workflows (fine-grained PAT or
      GitHub App token with `contents: write`, or an SSH deploy key). Store it as a
      repo secret (e.g. `RELEASE_TAG_TOKEN`). Document that `GITHUB_TOKEN` alone will
      not trigger `release.yml`.

## 2. Workflow

- [ ] 2.1 Add `.github/workflows/auto-tag-release.yml` triggered on `push:
      branches: [main]` with `permissions: contents: write`.
- [ ] 2.2 Check out with `fetch-depth: 0` (full history + tags) using the trigger-capable
      credential.
- [ ] 2.3 Detect the release merge: match the HEAD commit subject against the
      `release: X.Y.Z — …` pattern; if no match, exit 0 as a no-op.
- [ ] 2.4 Cross-check: read `version` from `core/package.json` at HEAD; if it does not
      equal the `X.Y.Z` captured from the subject, exit 0 as a no-op (log why).
- [ ] 2.5 Idempotency: `git ls-remote --tags origin refs/tags/vX.Y.Z`; if it exists,
      exit 0 without creating/pushing/force-updating.
- [ ] 2.6 Resolve release notes: merge-commit body (`git log -1 --format=%b`), falling
      back to the release PR body via `gh` when the body is empty/whitespace; fail
      loudly if no non-empty notes can be found.
- [ ] 2.7 Create the **annotated** tag (`git tag -a vX.Y.Z -m "<notes>" <sha>`) and push
      it with the trigger-capable credential. Never force-push, never delete.

## 3. `pipeline release` PR body

- [ ] 3.1 Update `buildPRBody` in `core/scripts/stages/release.ts`: state that merging
      the PR is the final step and auto-publishes the Release; keep the manual
      `git tag … && git push` command labelled as a fallback only.

## 4. Drift-guard test

- [ ] 4.1 Add a test in `core/test/` that reads the detection pattern from the workflow
      file and asserts it matches a subject built the same way `release.ts` builds the
      title (`release: X.Y.Z — <theme>` and squash form `… (#N)`), and does NOT match a
      plausible non-release subject. Prove the test bites (fails if the pattern and the
      title format diverge).
- [ ] 4.2 Add/adjust a `buildPRBody` test asserting the merge-is-final wording and the
      fallback-labelled tag command.

## 5. Gate

- [ ] 5.1 Regenerate the mirror: `node scripts/build.mjs`, commit `plugin/` in the same
      change.
- [ ] 5.2 `npm run ci` green from repo root (includes `openspec validate --all`).
- [ ] 5.3 Manual/dry verification of detection on a real `release:` subject vs. a
      non-release subject (documented outcome, not local-only).
