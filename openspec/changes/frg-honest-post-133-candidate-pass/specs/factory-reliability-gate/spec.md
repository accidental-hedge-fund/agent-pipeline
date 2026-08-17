## ADDED Requirements

### Requirement: Ship-path skip-frg default restore SHALL stay blocked until one post-1.33 honest FRG pass exists

The pipeline SHALL treat a ship-path change that drops the default
`--skip-frg` flag on Tugboat, `pipeline release`, or `engine-promote` as
blocked until at least one release version after `1.33.0` has a
`.agent-pipeline/frg/<version>/latest.json` that an honest-pass check
accepts. A `1.33.0`-only artifact, a `pass: false` artifact, a
product-milestone loop, a caller-authored observations file, or a
hand-edited `pass: true` SHALL NOT satisfy this precondition. The next
identical skip-frg restore request SHALL reuse this same check and SHALL
NOT require a new mole issue.

#### Scenario: Missing post-1.33 honest pass blocks skip-frg restore

- **WHEN** no `.agent-pipeline/frg/<version>/latest.json` after `1.33.0`
  passes the honest-pass check
- **THEN** the skip-frg default restore SHALL remain blocked
- **AND** Tugboat, release, and engine-promote default argv SHALL keep
  `--skip-frg`

#### Scenario: Historical 1.33.0 pass does not satisfy the precondition

- **WHEN** `.agent-pipeline/frg/1.33.0/latest.json` exists with
  `pass: true`
- **AND** no later version has an accepted honest-pass artifact
- **THEN** the skip-frg default restore SHALL remain blocked

#### Scenario: Fail latest.json does not unlock skip-frg restore

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` exists with
  `pass: false`
- **THEN** the skip-frg default restore SHALL remain blocked
- **AND** the artifact SHALL NOT be rewritten to `pass: true`

### Requirement: Honest post-1.33 FRG pass SHALL come from the bound candidate pack scored without observations

The first post-1.33 honest FRG pass SHALL be produced by the durable
generator path: a request-bound `factory-gate` pack on the **candidate**
engine track, scored with `pipeline factory-gate --for <version>
--from-run <loop_run_id>` or the in-process equivalent. That score
invocation SHALL NOT pass `--observations` or any caller-authored
observations file. The scored work-list SHALL be the request-bound
candidate pack. It SHALL NOT be the product v1.39 milestone work-list.
The written `.agent-pipeline/frg/<version>/latest.json` SHALL include
`pass: true`, a non-empty `run_id`, a non-empty bound `loop_run_id`,
pack identity `factory-gate-v1`, and `pack_provenance.candidate_git_sha`
for that candidate. The evidence object SHALL record runner-stamped
`score_source` `from-run` and `work_list` `factory-gate-pack`. Free-text
notes and caller options SHALL NOT establish those fields. Persist SHALL
require those fields already present on the scored object and SHALL NOT
stamp them from caller options.

#### Scenario: Bound pack from-run writes honest pass latest.json

- **WHEN** the request-bound candidate pack loop `L` is terminal for a
  version after `1.33.0`
- **AND** factory-gate scores `L` with `--from-run L` and no
  `--observations`
- **AND** hybrid v2 scoring yields a genuine `pass: true`
- **THEN** `.agent-pipeline/frg/<version>/latest.json` SHALL record
  `pass: true`, `run_id`, `loop_run_id` `L`, `pack_id` `factory-gate-v1`,
  and the candidate git SHA

#### Scenario: Product milestone work-list is refused as FRG evidence

- **WHEN** a loop's work-list is the product v1.39 milestone rather than
  the request-bound `factory-gate` pack
- **THEN** the honest-pass check SHALL reject that loop as evidence
- **AND** the skip-frg default restore SHALL remain blocked

#### Scenario: Missing or other work-list is refused as FRG evidence

- **WHEN** the evidence object has no `work_list`, or `work_list` is
  `other`, or a caller option names `other`
- **THEN** the honest-pass check SHALL reject that evidence
- **AND** free-text notes SHALL NOT establish `factory-gate-pack`
  identity

#### Scenario: Observations file cannot create an honest pass

- **WHEN** a caller or work directory supplies an observations file to
  the score path
- **THEN** that file SHALL NOT be used as authority for `pass: true`
- **AND** only runner-derived hybrid v2 evidence MAY contribute to an
  honest pass

#### Scenario: Note-only or caller-opt from-run does not establish honest pass

- **WHEN** the evidence object has no `score_source` of `from-run`
- **AND** notes begin with a from-run prefix or a caller option claims
  `from-run`
- **THEN** the honest-pass check SHALL reject that evidence
- **AND** lookup of a hand-edited `latest.json` that only adds that note
  SHALL NOT accept the artifact

#### Scenario: Persist caller options cannot stamp missing provenance

- **WHEN** the scored object has no `score_source` or no `work_list`
- **AND** persist is called with caller options that name `from-run` and
  `factory-gate-pack`
- **THEN** persist SHALL NOT add those fields to the scored object
- **AND** persist SHALL NOT return `pass: true`

### Requirement: Honest-pass required-live ids SHALL not be not_observed

An honest post-1.33 FRG pass SHALL record required-live scenario ids
`clean-item-throughput`, `blocker-taxonomy`, and
`empty-depends-on-stack-honesty`, plus the required OpenSpec-bearing
composition item, with a status other than `not_observed`. Those ids
SHALL use proof source `live`, `ledger`, or `derived` as appropriate.
They SHALL NOT use source `layer_a`.

#### Scenario: Required-live not_observed fails the honest-pass check

- **WHEN** a post-1.33 `latest.json` has `pass: true`
- **AND** any required-live id or the required OpenSpec-bearing
  composition item has status `not_observed`
- **THEN** the honest-pass check SHALL reject the artifact
- **AND** the skip-frg default restore SHALL remain blocked

#### Scenario: Required-live observed on the candidate pack can pass

- **WHEN** required-live ids are observed on the request-bound candidate
  pack loop (`clean-item-throughput` and `blocker-taxonomy` from the
  ledger, `empty-depends-on-stack-honesty` derived, OpenSpec-bearing
  composition from the live pack item)
- **AND** remaining honest-pass criteria hold
- **THEN** the honest-pass check MAY accept the artifact

### Requirement: Honest-pass Layer A-allowed ids SHALL cite candidate-SHA TAP hashes

An honest post-1.33 Layer A-allowed outcome SHALL cite a named TAP hash
bound to the same `pack_provenance.candidate_git_sha` when source is
`layer_a`. Hybrid Layer A provenance SHALL remain refused for ids that
are not on the closed Layer A-allowed set. A missing, skipped,
mismatched, or other-commit TAP SHALL fail that probe and SHALL fail the
honest-pass check.

#### Scenario: Layer A-allowed TAP on the candidate SHA can pass

- **WHEN** every Layer A-allowed id used in the report cites a TAP hash
  bound to the same candidate git SHA
- **AND** required-live ids are not `not_observed`
- **AND** remaining honest-pass criteria hold
- **THEN** the honest-pass check MAY accept the artifact

#### Scenario: Unknown layer_a id is refused

- **WHEN** a scenario or composition id that is not on the closed Layer
  A-allowed set claims source `layer_a`
- **THEN** the honest-pass check SHALL reject the artifact
- **AND** SHALL NOT treat the claim as proof of that id

#### Scenario: Missing or other-commit TAP fails the Layer A probe

- **WHEN** a Layer A-allowed probe is missing, skipped, fails, or binds
  its TAP hash to a different git SHA than `pack_provenance.candidate_git_sha`
- **THEN** the honest-pass check SHALL reject the artifact

### Requirement: Honest-pass evidence SHALL be cited on the tracking issue

When an honest post-1.33 `latest.json` exists, the implementer SHALL post
a comment on the tracking issue for this proof (issue #1038) that names
the evidence path and the `frg_run_id` (`run_id`). A chat paste or
hand-edited observations file SHALL NOT substitute for that citation.

#### Scenario: Comment names evidence path and frg_run_id

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` is an accepted
  honest pass with `run_id` `frg-1`
- **THEN** issue #1038 SHALL receive a comment that cites that path and
  `frg-1`

#### Scenario: Missing citation leaves the issue incomplete

- **WHEN** an honest `latest.json` exists
- **AND** issue #1038 has no comment naming the path and `frg_run_id`
- **THEN** this issue's acceptance SHALL remain unsatisfied
- **AND** the on-disk artifact MAY still satisfy the skip-frg restore
  precondition

### Requirement: Failed honest-pass attempt SHALL not waive into the Tugboat skip-frg child

The pipeline SHALL keep the tracking issue open and SHALL NOT start the
Tugboat `--skip-frg` default flip when the bound candidate pack cannot
produce an accepted honest pass. A fail score, a missing artifact, or an
operator waiver SHALL NOT grant that permission. The written
`latest.json`, if any, SHALL keep `pass: false`. Persist SHALL NOT
rewrite a scorer `pass: false` to `pass: true`.

#### Scenario: Pack fail keeps the issue open

- **WHEN** factory-gate scoring of the bound terminal loop yields
  `pass: false`
- **THEN** any written `latest.json` SHALL keep `pass: false`
- **AND** persist SHALL NOT validate `{ ...scored, pass: true }` and
  rewrite the scorer result
- **AND** issue #1038 SHALL remain open
- **AND** the Tugboat skip-frg child SHALL stay blocked

### Requirement: Honest-pass check SHALL be machine-checkable and reusable

The pipeline SHALL expose one deterministic honest-pass check over a
`latest.json` (or equivalent evidence object). That check SHALL accept
only evidence that meets the post-1.33, from-run, required-live,
Layer A TAP, pack-identity, and no-observations rules in this change.
The check SHALL require a runner-issued `integrity.score_receipt` that
binds the computed `pass` to the evidence run. That receipt SHALL be an
HMAC-SHA256 under `PIPELINE_FRG_ATTESTATION_KEY` (or an explicit injected
test key). A public hash of evidence fields SHALL NOT satisfy the check.
A hand-edited `pass: true` on an unsigned or failed score SHALL NOT match
that receipt, including when the editor also remints `score_receipt`
without the producer key. Full HMAC attestation (`integrity.attestation`)
remains optional for this check. Later skip-frg restore, auto-tag, and
pin work SHALL reuse this check. They SHALL NOT invent a second pass
definition.

#### Scenario: Checker accepts a conforming post-1.33 from-run pass

- **WHEN** a `latest.json` for version `1.39.0` has `pass: true`, a
  bound `loop_run_id`, pack `factory-gate-v1`, observed required-live
  ids, and candidate-SHA TAP hashes for any Layer A-allowed ids
- **AND** provenance records `--from-run` scoring with no observations
  file
- **THEN** the honest-pass check SHALL return accept

#### Scenario: Checker rejects fabricated or pre-1.33 evidence

- **WHEN** the evidence is only version `1.33.0`, or has required-live
  `not_observed`, or lacks a candidate-SHA TAP for a used Layer A id,
  or was scored from an observations file, or used the product
  milestone work-list
- **THEN** the honest-pass check SHALL return reject

#### Scenario: Checker rejects a hand-edited pass on an unsigned fail

- **WHEN** the runner writes a structurally eligible unsigned score with
  `pass: false`
- **AND** a caller clones the object with `pass: true`
- **THEN** the honest-pass check SHALL return reject

#### Scenario: Checker rejects a reminted public receipt on an unsigned fail

- **WHEN** the runner writes a structurally eligible unsigned score with
  `pass: false`
- **AND** a caller clones the object with `pass: true` and a recomputed
  public `score_receipt` hash, or a MAC under a different key
- **THEN** the honest-pass check SHALL return reject
