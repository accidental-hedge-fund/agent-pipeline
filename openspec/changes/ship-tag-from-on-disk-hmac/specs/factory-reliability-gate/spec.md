## MODIFIED Requirements

### Requirement: Ship-path skip-frg default restore SHALL stay blocked until one post-1.33 honest FRG pass exists

The pipeline SHALL treat a ship-path change that drops the default `--skip-frg` flag on Tugboat, `pipeline release`, or `engine-promote` as blocked until at least one release version after `1.33.0` has a `.agent-pipeline/frg/<version>/latest.json` that an honest-pass check accepts. After that check accepts, the factory Option 1 composer default SHALL omit `--skip-frg` and SHALL run the FRG pack phase before release. A `1.33.0`-only artifact, a `pass: false` artifact, a product-milestone loop, a caller-authored observations file, or a hand-edited `pass: true` SHALL NOT satisfy this precondition and SHALL NOT restore skip-as-default. The next identical skip-frg restore request SHALL reuse this same check and SHALL NOT require a new mole issue. Auto-tag fail-closed restore is the child of this unblock and SHALL require a release-eligible `latest.json` for the version being tagged **on the local tag path**. When `.agent-pipeline/frg/` is gitignored, auto-tag SHALL NOT fail the ship for a missing tree-file copy of that artifact. Pin default changes remain a sibling child.

#### Scenario: Missing post-1.33 honest pass blocks skip-frg restore

- **WHEN** no `.agent-pipeline/frg/<version>/latest.json` after `1.33.0` passes the honest-pass check
- **THEN** the skip-frg default restore SHALL remain blocked
- **AND** Tugboat, release, and engine-promote default argv SHALL keep `--skip-frg`

#### Scenario: Accepted honest pass unblocks Tugboat default no-skip

- **WHEN** at least one `.agent-pipeline/frg/<version>/latest.json` after `1.33.0` passes the honest-pass check
- **THEN** Tugboat default release and promote argv SHALL omit `--skip-frg`
- **AND** Tugboat SHALL run the FRG pack phase before release
- **AND** the restore SHALL reuse `isHonestPost133FrgPass` (or the same check) and SHALL NOT invent a second pass definition

#### Scenario: Historical 1.33.0 pass does not satisfy the precondition

- **WHEN** `.agent-pipeline/frg/1.33.0/latest.json` exists with `pass: true`
- **AND** no later version has an accepted honest-pass artifact
- **THEN** the skip-frg default restore SHALL remain blocked

#### Scenario: Fail latest.json does not unlock skip-frg restore

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` exists with `pass: false`
- **THEN** the skip-frg default restore SHALL remain blocked
- **AND** the artifact SHALL NOT be rewritten to `pass: true`

#### Scenario: Unblocked ship path fail-closes auto-tag without latest.json

- **WHEN** the post-1.33 honest-pass check has already accepted and Tugboat default no-skip is in force
- **AND** a detected release merge for version `X.Y.Z` has no release-eligible `.agent-pipeline/frg/<X.Y.Z>/latest.json` in the tree
- **AND** `.agent-pipeline/frg/` is not gitignored
- **THEN** auto-tag SHALL fail closed
- **AND** SHALL NOT create or push `vX.Y.Z`

#### Scenario: Gitignored missing tree latest.json does not fail auto-tag

- **WHEN** the post-1.33 honest-pass check has already accepted and Tugboat default no-skip is in force
- **AND** a detected release merge for version `X.Y.Z` has no tree-file `.agent-pipeline/frg/<X.Y.Z>/latest.json`
- **AND** `.agent-pipeline/frg/` is gitignored
- **THEN** auto-tag SHALL NOT fail the job for that missing tree file
- **AND** local `release ensure-tag` SHALL remain the fail-closed tag path for on-disk HMAC evidence

### Requirement: Shared tag-path FRG validation SHALL name the latest.json path and pack remediation

The shared release-eligible tag validator SHALL fail closed when
`.agent-pipeline/frg/<X.Y.Z>/latest.json` is missing, unparsable, `pass: false`,
or otherwise not release-eligible for version `X.Y.Z` on the **local on-disk** tag
path (`pipeline release ensure-tag` / `ensureAnnotatedReleaseTag`). The fail-closed
message SHALL name that `latest.json` path and SHALL name `factory-release prepare` or
the Tugboat FRG pack phase as the remediation. The validator SHALL NOT say FRG
is optional or advisory on the tag path. The local tag helper SHALL reuse this
validator. Auto-tag SHALL reuse this validator when FRG is not gitignored. Auto-tag
SHALL NOT use this validator to fail the job when FRG is gitignored and the tree
file is absent. Callers SHALL NOT invent a second tag eligibility checker.
The validator SHALL return the parsed HMAC-validated snapshot from that same
file read so `release ensure-tag` can bind `--packed-candidate` without
reopening `latest.json`. HMAC `candidate_git_sha` SHALL be an attested field:
the canonical attestation payload SHALL include `factory_release_binding` when
that field is present on the snapshot. An unauthenticated top-level
`factory_release_binding` overlay SHALL fail HMAC verification. The validator
SHALL NOT fall back from a present but invalid binding to another carrier.

#### Scenario: Missing latest.json names path and remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` is absent
- **THEN** validation SHALL fail closed
- **AND** the message SHALL name `.agent-pipeline/frg/1.39.0/latest.json`
- **AND** the message SHALL name `factory-release prepare` or the Tugboat FRG pack phase

#### Scenario: Failed latest.json names path and remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` exists with `pass: false`
- **THEN** validation SHALL fail closed
- **AND** the message SHALL name `.agent-pipeline/frg/1.39.0/latest.json`
- **AND** the message SHALL name `factory-release prepare` or the Tugboat FRG pack phase

#### Scenario: Release-eligible pass does not emit the fail-closed remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` is release-eligible with `pass: true`
- **THEN** validation SHALL succeed
- **AND** SHALL NOT treat the artifact as a hard block

#### Scenario: Tag binding uses the HMAC-validated snapshot

- **WHEN** the shared tag validator reads `.agent-pipeline/frg/1.39.0/latest.json`
- **AND** HMAC validation succeeds
- **THEN** it SHALL return the parsed snapshot from that same read
- **AND** a later replacement of the on-disk file SHALL NOT change the returned snapshot

#### Scenario: Unauthenticated factory_release_binding overlay fails HMAC

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` is HMAC-valid for packed candidate `A`
- **AND** a writer adds or changes `factory_release_binding.candidate_git_sha` to `B` after signing
- **THEN** tag-path validation SHALL fail closed
- **AND** SHALL NOT treat `B` as HMAC `candidate_git_sha`
- **AND** SHALL NOT fall back to `pack_provenance.candidate_git_sha`

### Requirement: FRG runtime files SHALL NOT dirty the factory control checkout

`.agent-pipeline/frg/` (including `<X.Y.Z>/latest.json` and the rest of that tree) SHALL
be treated as an engine-written runtime artifact on the factory control checkout. A pack
or promote write of `latest.json` SHALL NOT fail the next train's `worktree-clean` check.
The FRG runbook SHALL NOT require that directory to stay unignored on the protected
checkout. Host-only `skip-worktree` SHALL NOT be the product fix.

Local `latest.json` SHALL remain the ship-host lookup for `pipeline release`,
`pipeline engine-promote`, and `pipeline release ensure-tag` on the host that just packed.
Release-eligible evidence SHALL NOT need to be committed, comment-attached, or
`git add -f`'d so auto-tag can see it. Auto-tag SHALL NOT block the ship when that
path is gitignored. Local `release ensure-tag` SHALL create `vX.Y.Z` from on-disk HMAC
evidence. That posture SHALL NOT require leaving `.agent-pipeline/frg/` unignored on the
factory control checkout.

#### Scenario: Pack write does not fail the next train worktree-clean

- **WHEN** Tugboat or `pipeline factory-release prepare` writes
  `.agent-pipeline/frg/1.39.3/latest.json` on the factory control checkout
- **AND** that file is not committed
- **THEN** the next `pipeline train` / `pipeline doctor` `worktree-clean` check SHALL
  pass
- **AND** SHALL NOT fail solely because `latest.json` exists as an untracked file

#### Scenario: Runbook no longer requires unignored FRG on the protected checkout

- **WHEN** an operator reads the FRG runbook evidence-path section after this change
- **THEN** it SHALL state that `.agent-pipeline/frg/` is gitignored on the factory
  control checkout
- **AND** SHALL NOT require operators to commit leftover `latest.json` onto the
  protected checkout to keep the next train clean

#### Scenario: Auto-tag evidence remains attachable

- **WHEN** a release PR for version `1.39.3` is prepared after an FRG pack
- **THEN** release-eligible evidence for `1.39.3` MAY still be attachable
- **AND** that attachment SHALL NOT be required for auto-tag or for local `release ensure-tag`
- **AND** SHALL NOT require the factory control checkout to keep `.agent-pipeline/frg/`
  unignored

#### Scenario: Auto-tag does not require attached tree evidence when FRG is gitignored

- **WHEN** a release PR for version `1.39.5` is merged after an FRG pack
- **AND** `.agent-pipeline/frg/` is gitignored
- **AND** on-disk HMAC `latest.json` is release-eligible
- **THEN** ship-end SHALL create `v1.39.5` via `release ensure-tag` from disk
- **AND** auto-tag SHALL NOT fail the job because the merged tree has no `latest.json`
- **AND** the factory control checkout SHALL keep `.agent-pipeline/frg/` gitignored
