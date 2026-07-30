## 1. Mint the credential (human-only)

- [ ] 1.1 Open https://github.com/settings/personal-access-tokens/new as a trusted maintainer
- [ ] 1.2 Set resource owner to `accidental-hedge-fund`, only select repository `agent-pipeline`
- [ ] 1.3 Grant repository permission **Contents: Read and write** (no other permissions)
- [ ] 1.4 Generate the fine-grained PAT and copy the token value once (it is not shown again)

## 2. Store the repository Actions secret

- [ ] 2.1 Set the secret on the repo:
      `gh secret set RELEASE_TAG_TOKEN -R accidental-hedge-fund/agent-pipeline`
      (paste the PAT when prompted; do not commit or log the value)
- [ ] 2.2 Confirm presence:
      `gh secret list -R accidental-hedge-fund/agent-pipeline`
      shows `RELEASE_TAG_TOKEN`
- [ ] 2.3 Optionally re-check via API that secrets are no longer empty:
      `gh api repos/accidental-hedge-fund/agent-pipeline/actions/secrets --jq .total_count`
      is ≥ 1 and names include `RELEASE_TAG_TOKEN`

## 3. End-to-end verification on the next release

- [ ] 3.1 On the next `pipeline release` PR merge, do **not** hand-push a `vX.Y.Z` tag; let `auto-tag-release` run
- [ ] 3.2 Confirm the `auto-tag-release` workflow run for that merge succeeds and pushes annotated tag `vX.Y.Z`
- [ ] 3.3 Confirm `release.yml` triggers off that tag and completes green (GitHub Release published)
- [ ] 3.4 If auto-tag fails for a reason other than a missing secret (e.g. empty notes resolution), file or update a separate issue — do not expand this change into workflow code fixes

## 4. Close-out

- [ ] 4.1 Record verification evidence (secret list output name-only, auto-tag run URL, release.yml run URL) on issue #449
- [ ] 4.2 Confirm no application code, workflow YAML, or `GITHUB_TOKEN` fallback was introduced under this change
