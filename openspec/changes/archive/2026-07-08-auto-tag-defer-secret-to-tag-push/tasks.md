# Tasks — Defer the auto-tag secret to the tag-push step

## 1. Workflow

- [x] 1.1 In `.github/workflows/auto-tag-release.yml`, remove the
      `token: ${{ secrets.RELEASE_TAG_TOKEN }}` input from `actions/checkout` so checkout
      uses the default `GITHUB_TOKEN`. Keep `fetch-depth: 0`.
- [x] 1.2 On the "Create and push annotated tag" step, add
      `env: RELEASE_TAG_TOKEN: ${{ secrets.RELEASE_TAG_TOKEN }}` and, at the top of its
      `run:` script, guard on an empty secret — fail (`::error::` + `exit 1`) with a
      message naming `RELEASE_TAG_TOKEN` and the provisioning steps (fine-grained PAT,
      `contents: read` + `contents: write` on this repo, added as a repo Actions secret).
- [x] 1.3 Change the push to authenticate explicitly with the PAT via the remote URL
      (`git push "https://x-access-token:${RELEASE_TAG_TOKEN}@github.com/${{ github.repository }}.git" "refs/tags/v${version}"`),
      since checkout no longer stores the credential. Tag creation (`git tag -a`) is
      unchanged; never force-push, never delete.
- [x] 1.4 Update the workflow header comment: add a "Setup" note that
      `RELEASE_TAG_TOKEN` must be provisioned before the tag push can succeed, and that
      checkout uses the default token so non-release pushes are unaffected.

## 2. `pipeline release` PR body

- [x] 2.1 In `buildPRBody` (`core/scripts/stages/release.ts`), name `RELEASE_TAG_TOKEN`
      and its provisioning (fine-grained PAT, `contents: read`/`write`, repo Actions
      secret) in the fallback footer, so an adopting repo sees the requirement.

## 3. Drift-guard test

- [x] 3.1 Extend `core/test/auto-tag-release-workflow.test.ts` to assert from the
      workflow YAML that `actions/checkout` has no `token:` referencing
      `RELEASE_TAG_TOKEN`, and that `RELEASE_TAG_TOKEN` is referenced only within the
      tag-push step. Prove the test bites (reintroducing the token on checkout fails it).
- [x] 3.2 Add/adjust the `buildPRBody` test to assert the footer names
      `RELEASE_TAG_TOKEN` and its provisioning steps.

## 4. Gate

- [x] 4.1 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` in the same
      change.
- [x] 4.2 `npm run ci` green from repo root (includes `openspec validate --all`).
- [x] 4.3 Verify behavior deterministically: run the workflow's guard steps under `bash`
      against (a) a non-release subject → job would conclude without reaching the push
      step; (b) a release subject with `RELEASE_TAG_TOKEN` unset → the tag-push guard
      exits non-zero with the explicit `RELEASE_TAG_TOKEN` provisioning error. Document
      the outcomes.

      Outcomes:
      (a) The detection regex `^release: ([0-9]+\.[0-9]+\.[0-9]+) — .*$` does not match
      a non-release subject (e.g. `fix: something unrelated (#420)`), so `is_release`
      resolves to `false` and every subsequent step — including the tag-push step that
      references `RELEASE_TAG_TOKEN` — is skipped via its `if:` guard. The job concludes
      successfully without the secret ever being evaluated.
      (b) With `RELEASE_TAG_TOKEN` unset, the tag-push step's guard prints
      `::error::RELEASE_TAG_TOKEN is empty/absent — this release merge cannot be tagged.
      Provision a fine-grained PAT with 'contents: read' and 'contents: write' on this
      repository, and add it as a repository Actions secret named RELEASE_TAG_TOKEN.`
      and exits 1 before reaching `git tag`/`git push`.
