# Pinned deployment sources

These receipts bind the first `agent-box` deployment. Do not replace a commit,
tag, or checksum without a reviewed deployment change.

Copy `deployment-receipt.json.example` to the factory state directory. Complete
it with observed host values. Do not complete or commit the example in this
repository.

## Hermes Agent

- Project: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- Release tag: `v2026.8.3`
- Package version: `0.20.0`
- Annotated tag object: `7de39e700d2c329e15d32eb0b96e2f7cdd9fbdb2`
- Peeled commit: `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`
- Exact installer SHA-256:
  `45f589461248c7a6ec3aecd7522a69dd49c5c8dbf4798ba1296af5c0c5e7ccd3`
- Exact source archive SHA-256 observed on 2026-08-08:
  `a68e96f385768ec6c466122bf21fcb697680a5f349c9a673badfbe27752b6928`
- `uv.lock` Git object:
  `592d5db2612fc0e306a42e8eccabf9b7856cd3c4`

The exact installer URL is:

```text
https://raw.githubusercontent.com/NousResearch/hermes-agent/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/scripts/install.sh
```

The deployment uses the native Buzz platform in this commit. It uses the
`xai-oauth` provider and `grok-4.5` only. The service calls the Python
interpreter in the versioned install. It does not use a floating `hermes`
launcher.

## Buzz CLI

- Project: [block/buzz](https://github.com/block/buzz)
- Release tag: `v0.5.2`
- Tag commit: `3e48f1b2365d326ee1c9582448d86a99b44ecd5d`
- Exact source archive SHA-256 observed on 2026-08-08:
  `520fb7d6bc9f705bf01ad72eb8fa101888a0a1082e18bb0e137f87eebdaaf395`
- `Cargo.lock` Git object:
  `3b60dc4579f00f082e08055ca2d3814056bff6f8`
- `rust-toolchain.toml` Git object:
  `f92020c65377147728672908fb7a901c0e848771`
- Rust toolchain in that file: `1.95.0`

Buzz v0.5.2 does not publish a Linux `buzz` CLI asset. Build
`cargo build --locked --release -p buzz-cli` from the exact commit. Record the
SHA-256 of the installed binary on the host. The workspace package version is
not the desktop release tag, so `buzz --version` alone does not prove this pin.

## Receipt checks

For each source checkout, require a clean detached checkout and compare the
exact commit:

```bash
git -C "$HERMES_INSTALL_DIR" diff --quiet
git -C "$HERMES_INSTALL_DIR" diff --cached --quiet
test "$(git -C "$HERMES_INSTALL_DIR" rev-parse HEAD)" = \
  3c27eb6234bf91b8ceee9e9071591b31e9b148cb

git -C "$BUZZ_SOURCE_DIR" diff --quiet
git -C "$BUZZ_SOURCE_DIR" diff --cached --quiet
test "$(git -C "$BUZZ_SOURCE_DIR" rev-parse HEAD)" = \
  3e48f1b2365d326ee1c9582448d86a99b44ecd5d
```

The generated GitHub archive checksum is a second receipt. The commit is the
primary source identity. Stop if either the expected commit or the reviewed
archive checksum does not match.

## Pipeline and bootstrap wrapper

The first run has two Pipeline identities:

- Production issue-wave launcher: the installed Codex Pipeline skill at
  version `1.31.1`.
- Candidate FRG and release launcher: the clean detached final `main` commit
  that the wrapper binds after the issue train.

The #898 commit is a separate wrapper identity. Do not copy the wrapper from a
released checkout. The wrapper is a bootstrap
artifact. It creates release `v1.33.0`. Copy it only from the exact reviewed
and merged #898 commit. Record that 40-character commit as `wrapper_git_sha`.
The wrapper manifest records its own file digests.

Do not reuse `wrapper_git_sha` as the candidate identity. Record the clean
starting `main` commit as `bootstrap_base_git_sha`. After the issue train
merges, the wrapper fetches final `main`, detaches the clean control checkout,
and records that observed commit as the integrated candidate in its journal.
FRG and release preparation use only that exact checkout. Keep these identities
separate from the production pin.

Before release preparation, the candidate launcher must report `1.32.0`. The
release command prepares `v1.33.0`. This candidate version is not the installed
production pin.

Production stays at `v1.31.1` until `v1.33.0` has a verified annotated tag and
a non-draft GitHub Release. Only then can the factory promote the external pin
and install the published tag. The next run uses the new installed launcher.
