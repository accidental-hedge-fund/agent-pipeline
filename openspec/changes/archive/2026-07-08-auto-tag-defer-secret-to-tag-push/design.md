# Design — Defer the auto-tag secret to the tag-push step

## Context

`auto-tag-release.yml` (#411/#412) triggers on every push to `main`. Its job is to
no-op unless HEAD is a `pipeline release` merge, in which case it creates and pushes an
annotated `vX.Y.Z` tag. The tag must be pushed with a credential whose events trigger
other workflows (a PAT / App token / deploy key), because the default `GITHUB_TOKEN`
does not re-trigger `release.yml`.

The bug: the credential is consumed at `actions/checkout`, which **requires** a non-empty
`token`. So when `RELEASE_TAG_TOKEN` is unprovisioned, the job dies at checkout on every
push — including non-release pushes the guard was designed to skip.

## Goal

Make the secret a lazily-evaluated, release-only dependency:

1. Checkout must not depend on it → checkout uses the default `GITHUB_TOKEN`.
2. Non-release pushes (and any push while the secret is absent) must conclude green.
3. A release merge with the secret absent must fail with an actionable error, not a
   generic checkout error.
4. The pushed `v*` tag must still trigger `release.yml` unchanged when the secret exists.

## Decisions

### 1. Checkout uses the default `GITHUB_TOKEN`

Drop the `token:` input from `actions/checkout` (its default is `github.token`).
`fetch-depth: 0` still gives full history + tags for detection, version cross-check, and
`git ls-remote`. None of those read/write operations need elevated scope; they run under
the default token that every workflow gets for free.

**Consequence:** checkout no longer configures the PAT as the git `extraheader`
credential, so the push step can no longer rely on an ambient credential. The push must
authenticate explicitly (Decision 3).

### 2. The secret is referenced only by the tag-push step

`RELEASE_TAG_TOKEN` is exposed via `env:` on the "Create and push annotated tag" step
only. That step already runs conditionally (`if: steps.exists.outputs.exists == 'false'`),
i.e. only after the subject + version + not-already-tagged guards pass. A non-release push
never reaches it, so the secret is never evaluated on the common path. GitHub does not
fail a job merely because a referenced secret is empty — only `actions/checkout`'s
explicit "token required" validation did — so exposing an empty secret to a step that
never runs is harmless.

### 3. Explicit empty-secret precondition + explicit push authentication

At the top of the tag-push step, guard on the secret and fail loudly when it is empty:

```bash
if [ -z "${RELEASE_TAG_TOKEN:-}" ]; then
  echo "::error::RELEASE_TAG_TOKEN is not set. This repository secret is required to push the release tag so that release.yml re-triggers. Provision a fine-grained PAT with 'contents: read' and 'contents: write' on this repository and add it as a repository Actions secret named RELEASE_TAG_TOKEN."
  exit 1
fi
```

Then push with the token in the remote URL rather than relying on the checkout-configured
credential:

```bash
git push "https://x-access-token:${RELEASE_TAG_TOKEN}@github.com/${{ github.repository }}.git" "refs/tags/v${version}"
```

This keeps the tag *creation* (`git tag -a`) unchanged and scopes the credential to the
single push invocation. The error message names the secret and the exact provisioning
steps so an operator hitting it on a real release merge knows precisely what to do.

**Why fail rather than fall back to `GITHUB_TOKEN`:** pushing the tag with
`GITHUB_TOKEN` would succeed but silently *not* trigger `release.yml` — reproducing the
original latent bug #411 set out to kill (a tag with no Release). A loud failure on the
release merge is strictly better than a silent half-success; the PR-body fallback command
(`git tag -a … && git push`, run by a human with their own credentials) remains the
manual recovery path.

### 4. Documentation surfaces

- **Workflow header comment**: add a short "Setup" note stating `RELEASE_TAG_TOKEN` must
  be provisioned (fine-grained PAT, `contents: read` + `contents: write` on this repo,
  added as a repo Actions secret) before the tag push can succeed, and that checkout uses
  the default token so non-release pushes are unaffected.
- **`pipeline release` PR-body footer** (`buildPRBody`): the existing "_Fallback only_"
  line already mentions "a missing/misconfigured tag-push credential"; name it
  `RELEASE_TAG_TOKEN` and its provisioning so the next repo adopting the flow sees the
  requirement at merge time.

### 5. Drift guard pins the single point of use

Extend `core/test/auto-tag-release-workflow.test.ts` to assert, from the workflow YAML:

- `actions/checkout` has **no** `token:` input referencing `RELEASE_TAG_TOKEN` (it uses
  the default token).
- `RELEASE_TAG_TOKEN` appears **only** within the tag-push step.

The test must bite: reintroducing `token: ${{ secrets.RELEASE_TAG_TOKEN }}` on checkout
fails it. This is a structural assertion over the YAML, consistent with the existing
pattern/extraction helpers in that test file (no network, git, or subprocess in the
assertion itself beyond the already-present notes-script harness).

## Risks / trade-offs

- **Explicit URL auth vs. checkout `persist-credentials`**: putting the token in the push
  URL is a common, well-understood pattern; it avoids leaving a PAT in `.git/config`. The
  token is masked in logs (it is a registered secret). Acceptable.
- **The guard adds one branch to a step that only runs on real releases**: negligible;
  the payoff is an actionable error instead of a mysterious one.
