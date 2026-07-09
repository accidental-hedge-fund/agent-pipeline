# Defer the auto-tag secret to the tag-push step

## Why

The auto-tag workflow added in #411/#412 (`.github/workflows/auto-tag-release.yml`)
passes `secrets.RELEASE_TAG_TOKEN` to `actions/checkout`:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
    token: ${{ secrets.RELEASE_TAG_TOKEN }}
```

`actions/checkout` requires a non-empty `token`. When the secret is unprovisioned,
the run fails at **checkout** — `Input required and not supplied: token` — on **every**
push to `main`, before the release-detection guard can no-op a non-release commit. The
very first live run (the #412 merge commit itself) failed this way:
https://github.com/accidental-hedge-fund/agent-pipeline/actions/runs/28971129345.

The PAT is only needed for the tag *push* (so `release.yml` re-triggers off the `v*`
tag). Checkout works with the default `GITHUB_TOKEN`. Consuming the secret at checkout
turns an optional, release-only credential into a hard dependency of every main push,
and — when it is missing — surfaces a generic checkout error that gives the operator no
hint about what to provision.

## What Changes

- **Move** the `RELEASE_TAG_TOKEN` reference off `actions/checkout` and onto the
  tag-push step only. `actions/checkout` uses the default `GITHUB_TOKEN` (its default),
  so every non-release push — and any push while the secret is absent — checks out and
  concludes successfully without the secret being evaluated at all.
- **Add an explicit precondition** to the tag-push step: on a detected release merge, if
  `RELEASE_TAG_TOKEN` is empty, fail with an error that names the secret and states the
  provisioning steps (a fine-grained PAT with `contents: read` + `contents: write` on
  this repository, added as a repository Actions secret named `RELEASE_TAG_TOKEN`) —
  never a generic `actions/checkout` token error.
- **Authenticate the push with the PAT explicitly** (the checkout no longer stores it in
  git config), so the pushed `v*` tag still triggers `release.yml` unchanged.
- **Document provisioning as setup** in the workflow header comment, and **surface it in
  the `pipeline release` PR-body footer** so the next repo adopting the flow can't miss
  the requirement.
- **Update the drift-guard test** to pin the secret's single point of use — asserting
  `RELEASE_TAG_TOKEN` is referenced only by the tag-push step and never by
  `actions/checkout`.

## Acceptance Criteria

- [ ] `actions/checkout` uses the default `GITHUB_TOKEN`; `RELEASE_TAG_TOKEN` is
      referenced only by the tag-push step (verifiable by inspecting the workflow YAML).
- [ ] Non-release pushes to `main` conclude successfully without evaluating the secret at
      all (checkout succeeds under `GITHUB_TOKEN`; the detection guard no-ops before the
      tag-push step).
- [ ] A release merge commit with the secret absent fails with an explicit error naming
      `RELEASE_TAG_TOKEN` and the provisioning steps (fine-grained PAT, `contents: read` +
      `contents: write` on this repo, added as a repo Actions secret) — not a generic
      checkout error.
- [ ] On a release merge with the secret present, the annotated tag is pushed with the
      PAT and `release.yml` still triggers off the `v*` tag push (behavior of #411/#412
      preserved).
- [ ] The workflow header comment documents the provisioning requirement as setup, and
      the `pipeline release` PR-body footer names `RELEASE_TAG_TOKEN` and its provisioning
      steps.
- [ ] A drift-guard test asserts `RELEASE_TAG_TOKEN` is referenced only by the tag-push
      step and never by `actions/checkout`; it fails if the secret is reintroduced at
      checkout.

## Impact

- **Modified workflow**: `.github/workflows/auto-tag-release.yml` — checkout uses the
  default token; the secret moves to the tag-push step with an explicit empty-secret
  precondition; header comment documents provisioning.
- **Modified capability**: `release-auto-tag-on-merge` — the credential/trigger
  requirement now pins where the secret is consumed and how absence is reported;
  a new requirement pins the single-point-of-use drift guard.
- **Modified capability**: `release-sub-command` — the PR-body requirement now names the
  `RELEASE_TAG_TOKEN` provisioning requirement in the footer.
- **Changed code**: `core/scripts/stages/release.ts` (`buildPRBody`) and
  `core/test/auto-tag-release-workflow.test.ts`; regenerated `plugin/` mirror.
- **Out of scope**: the detection pattern, tag format, and `release.yml` (all working as
  designed); provisioning the secret itself (an operator/repo-admin action — the workflow
  functions fully once it exists).
