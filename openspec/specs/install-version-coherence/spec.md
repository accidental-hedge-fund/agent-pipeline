# install-version-coherence Specification

## Purpose
TBD - created by archiving change version-staleness-detection. Update Purpose after archive.

## Requirements

### Requirement: pipeline doctor SHALL include an install:version-coherence check

The `pipeline doctor` command SHALL include an `install:version-coherence` preflight check. The check SHALL read the `version` field from `core/package.json` at the install root (derived from the running module's `import.meta.url`) and compare it to the `VERSION` constant that `pipeline.ts` loaded at startup. If the two strings are identical the check SHALL pass; if they differ or `core/package.json` cannot be read the check SHALL fail.

#### Scenario: Versions match — check passes and reports install path

- **WHEN** `pipeline doctor` runs and the `version` field in `core/package.json` at the install root equals the `VERSION` constant loaded at startup
- **THEN** the `install:version-coherence` check SHALL have status `"pass"`
- **AND** the detail string SHALL include the version string (e.g., `v1.2.1`) and the install root path

#### Scenario: Versions differ — check fails with both versions named

- **WHEN** `pipeline doctor` runs and the `version` field in `core/package.json` at the install root does not equal the `VERSION` constant loaded at startup
- **THEN** the `install:version-coherence` check SHALL have status `"fail"`
- **AND** the detail string SHALL name both the loaded version and the on-disk version
- **AND** the detail string SHALL include the install root path

#### Scenario: core/package.json is unreadable — check fails with remediation

- **WHEN** `pipeline doctor` runs and `core/package.json` at the install root cannot be read (missing or malformed)
- **THEN** the `install:version-coherence` check SHALL have status `"fail"`
- **AND** the remediation text SHALL instruct the user to reinstall the pipeline skill

### Requirement: The launcher SHALL surface the install:version-coherence failure for a corrupt install, honoring doctor's machine-output contracts

When `core/package.json` at the install root is a **corrupt install config**, Node throws `ERR_INVALID_PACKAGE_CONFIG` while loading **any** TypeScript entry (`pipeline.ts` or the dependency-free `path-cli.ts`) — before that code can run. A corrupt install config is one that is missing, not valid JSON, OR valid JSON that nonetheless prevents the ESM-only `.ts` entries from loading: a non-object (e.g. a top-level array), a `version` that is not a string, or an explicit `type` other than `"module"` (e.g. `type: 123`, which trips `ERR_INVALID_PACKAGE_CONFIG`, or `type: "commonjs"`, under which the entries' ESM `import`s fail to load). An absent `type` is healthy — the `.ts` entries load as ESM. The pipeline launcher (`scripts/pipeline-launcher.mjs`) and the generated host shim (from `hosts/_shared/entry.template.mjs`) SHALL classify all of these as corrupt up front and emit the `install:version-coherence` failure with reinstall remediation themselves, exiting non-zero — they SHALL NOT treat a config as healthy merely because it parses as JSON. This guard SHALL run before any path that spawns a TypeScript entry — specifically ahead of the `path` discovery fast-path and ahead of the `core/node_modules` dependency check — so that every command (including `path --json` and a corrupt install that also lacks dependencies) reports a coherent diagnostic rather than a raw Node stack trace or a generic runtime-dependencies error. The only command exempt from this guard is `--version`, which has its own corrupt-install handling. For the `doctor` command the launcher SHALL honor doctor's machine-output contracts: `--json` emits the stable JSON envelope, `--is-ok` emits zero output, and plain `doctor` emits human-readable prose.

#### Scenario: Malformed core/package.json — plain `doctor` prose surfaces the failure

- **WHEN** the launcher runs `doctor` and `core/package.json` at the install root is malformed
- **THEN** it SHALL exit non-zero
- **AND** stdout SHALL contain a human-readable report naming `install:version-coherence` and a reinstall remediation

#### Scenario: Malformed core/package.json — `doctor --json` emits the stable envelope

- **WHEN** the launcher runs `doctor --json` and `core/package.json` at the install root is malformed
- **THEN** stdout SHALL be a single parseable JSON envelope with `schema_version` `"1"` and `status` `"error"`
- **AND** the envelope SHALL include an `install:version-coherence` check whose `ok` is `false` and whose `fix` is a non-empty reinstall remediation

#### Scenario: Malformed core/package.json — `doctor --is-ok` is a silent exit-code gate

- **WHEN** the launcher runs `doctor --is-ok` and `core/package.json` at the install root is malformed
- **THEN** it SHALL write zero bytes to stdout and stderr
- **AND** it SHALL exit non-zero

#### Scenario: Corrupt install also missing node_modules — version-coherence still reported

- **WHEN** the launcher runs `doctor`, `core/package.json` at the install root is malformed, and `core/node_modules` is absent
- **THEN** it SHALL report the `install:version-coherence` failure
- **AND** it SHALL NOT report a generic runtime-dependencies error

#### Scenario: Malformed core/package.json — `path` fast-path yields a coherent diagnostic

- **WHEN** the launcher runs `path --json` and `core/package.json` at the install root is malformed
- **THEN** it SHALL exit non-zero with the corrupt-install reinstall diagnostic
- **AND** it SHALL NOT leak a raw `ERR_INVALID_PACKAGE_CONFIG` Node error from spawning `path-cli.ts`

#### Scenario: Valid JSON but an ESM-incompatible package config — still classified as corrupt

- **WHEN** the launcher or host shim runs `path --json` or `doctor --json` and `core/package.json` at the install root is valid JSON that still prevents the `.ts` entries from loading (e.g. `{"version":"0.0.0","type":123}` or `{"version":"0.0.0","type":"commonjs"}`)
- **THEN** it SHALL classify the install as corrupt and surface the `install:version-coherence` diagnostic (a JSON envelope for `--json`, the reinstall hint otherwise)
- **AND** it SHALL NOT leak a raw `ERR_INVALID_PACKAGE_CONFIG` or `Cannot use import statement outside a module` Node error from spawning a TypeScript entry

### Requirement: The install:version-coherence check SHALL be unit-testable via injectable deps

The check implementation SHALL derive the install root path from a parameter (not from a module-level `import.meta.url` call inlined into the check body), and SHALL read `core/package.json` via the `DoctorDeps.readTextFile` primitive. This allows unit tests to supply a fake install root and a fake file reader without touching the real filesystem.

#### Scenario: Fake install root and fake file content — deterministic outcome

- **WHEN** a unit test calls `buildPreflightChecks` with an injected `installRoot` path and a `DoctorDeps` whose `readTextFile` returns a controlled JSON string
- **THEN** the `install:version-coherence` check SHALL produce the expected pass or fail result based solely on the injected inputs, with no real filesystem access

### Requirement: buildPreflightChecks SHALL accept the running version as an explicit argument

The `buildPreflightChecks` function SHALL accept the `version` string (the `VERSION` constant) as a second parameter so that unit tests can supply an arbitrary version without importing from `pipeline.ts`. The call site in `pipeline.ts` SHALL pass the `VERSION` constant.

#### Scenario: buildPreflightChecks called with a specific version string

- **WHEN** `buildPreflightChecks(config, "1.2.3")` is called
- **THEN** the resulting `install:version-coherence` check SHALL compare against `"1.2.3"` as the expected version

### Requirement: DoctorDeps SHALL expose readTextFile

The `DoctorDeps` interface SHALL include a `readTextFile(p: string): Promise<string | null>` method. The method SHALL return the file contents as a UTF-8 string on success, or `null` on any read error (missing file, permission error, etc.). The real implementation SHALL use `fs.promises.readFile(p, "utf8")` and catch all errors.

#### Scenario: readTextFile returns content for an existing file

- **WHEN** the real `DoctorDeps.readTextFile` is called with the path to an existing readable file
- **THEN** it SHALL return the file's UTF-8 contents as a string

#### Scenario: readTextFile returns null for a missing file

- **WHEN** the real `DoctorDeps.readTextFile` is called with a path that does not exist
- **THEN** it SHALL return `null` without throwing

### Requirement: `pipeline doctor` SHALL include a `loop:contract-coherence` check

The `pipeline doctor` command SHALL include a `loop:contract-coherence` preflight
check. The check SHALL discover an installed external goal-loop skill (when
present), read its ownership manifest (`.goal-loop-manifest.json`, which carries
`package` and `version`) and the contract/ledger schema ids it implements, and
compare those schema ids against Pipeline's supported-set constant.

The check SHALL **pass** when a goal-loop install is discovered whose schema ids
are all in the supported set. It SHALL **fail** when a goal-loop install is
discovered but the manifest cannot be read or parsed, or when any discovered
schema id is outside the supported set — including a schema id that is *newer*
than the supported set. A failure detail SHALL name both the discovered
version/schema ids and Pipeline's supported ids, and SHALL carry actionable
remediation.

When **no** goal-loop install is discovered, the check SHALL **not** fail. It
SHALL report status **`skip`** (preferred) or **`warn`**, with detail that an
external goal-loop skill is optional/legacy and is **not** required for
`pipeline loop` / the in-repo durable loop. Absence of goal-loop SHALL NOT cause
`pipeline doctor` to exit non-zero solely on this check.

#### Scenario: Supported goal-loop install — check passes

- **WHEN** `pipeline doctor` runs and the discovered goal-loop install reports a
  manifest version and contract/ledger schema ids that are all within Pipeline's
  supported set
- **THEN** the `loop:contract-coherence` check SHALL have status `"pass"`
- **AND** the detail string SHALL include the goal-loop version and the discovered
  contract schema id

#### Scenario: Unsupported contract schema — check fails naming both sides

- **WHEN** `pipeline doctor` runs and the discovered goal-loop implements a contract
  schema id outside Pipeline's supported set
- **THEN** the `loop:contract-coherence` check SHALL have status `"fail"`
- **AND** the detail string SHALL name both the discovered schema id and the supported
  schema id(s)
- **AND** the remediation SHALL instruct the user to align the goal-loop and Pipeline
  versions

#### Scenario: A newer-than-supported contract also fails

- **WHEN** the discovered goal-loop contract schema id is newer than any id in
  Pipeline's supported set
- **THEN** the check SHALL have status `"fail"` rather than passing optimistically

#### Scenario: goal-loop not installed — check does not fail

- **WHEN** `pipeline doctor` runs and no installed goal-loop skill or manifest can be
  discovered
- **THEN** the `loop:contract-coherence` check SHALL have status `"skip"` or `"warn"`
- **AND** the check SHALL NOT have status `"fail"`
- **AND** the detail SHALL indicate that external goal-loop is optional/legacy and not
  required for `pipeline loop`
- **AND** doctor overall exit status SHALL NOT be non-zero solely because of this check

---

### Requirement: The installer SHALL verify loop contract compatibility before external mutation

The installer SHALL run the same external-goal-loop `loop:contract-coherence` check
used by `pipeline doctor` when evaluating a *discovered* goal-loop install. The
verification SHALL run before the installer performs any external mutation. An
**incompatible** discovered pairing (schema ids outside the supported set, or an
unreadable manifest/schema at a discovered install) SHALL be surfaced as a failure
with remediation naming both versions rather than silently completing. The installer
SHALL NOT modify, overwrite, or migrate the goal-loop install or its runs.

When **no** goal-loop install is discovered, the installer SHALL complete
successfully with respect to this check (info-level or silent is allowed). The
installer SHALL NOT claim that `pipeline loop` is unavailable
until goal-loop is installed — durable loop is provided in-repo and does not require
the external skill.

#### Scenario: Incompatible pairing is reported at install time

- **WHEN** the installer runs against an environment whose installed goal-loop contract
  schema id is outside Pipeline's supported set
- **THEN** it SHALL surface the `loop:contract-coherence` failure naming both the
  Pipeline and goal-loop versions/schema ids
- **AND** it SHALL NOT report the install as coherent

#### Scenario: Verification precedes external mutation

- **WHEN** the installer detects an incompatible Pipeline/loop pairing
- **THEN** the incompatibility SHALL be detected before any external mutation is
  performed
- **AND** the goal-loop install and its existing runs SHALL be left untouched

#### Scenario: Missing goal-loop does not block install or misstate loop availability

- **WHEN** the installer runs and no goal-loop skill is discoverable
- **THEN** the installer SHALL NOT treat loop contract coherence as a hard failure
- **AND** install output SHALL NOT state that `pipeline loop`
  requires or is unavailable without goal-loop

---

### Requirement: The `loop:contract-coherence` check SHALL be unit-testable via injectable deps

The external-goal-loop `loop:contract-coherence` implementation SHALL take the
goal-loop discovery root and the file-reading primitive as injected dependencies
rather than resolving them from module-level filesystem state, so unit tests can
supply a fake install root, fake manifest contents, and fake schema ids with no real
filesystem, network, or subprocess access. The same check function SHALL be used by
`pipeline doctor` and by the installer so those two surfaces cannot diverge on
external goal-loop discovery semantics.

`pipeline loop` run-start preflight SHALL NOT require external goal-loop discovery
for success; it SHALL use the in-repo durable loop store schema-compatibility check
(and other in-repo loop preflight checks) instead. Unit tests for
`loop:contract-coherence` SHALL cover at least: supported install → pass; unsupported
schema → fail; absence → skip or warn (not fail).

#### Scenario: Fake manifest yields a deterministic outcome

- **WHEN** a unit test invokes the check with an injected discovery root and a reader
  returning controlled manifest and schema content
- **THEN** the result SHALL be determined solely by the injected inputs
- **AND** no real filesystem, network, or subprocess access SHALL occur

#### Scenario: Doctor and installer share external coherence semantics

- **WHEN** the external `loop:contract-coherence` outcome is computed for
  `pipeline doctor` and for the installer with identical discovery inputs
- **THEN** both SHALL produce the same status class for that input (pass, fail, or
  skip/warn on absence) and compatible remediation text on failure

#### Scenario: Absence is non-failing in unit tests

- **WHEN** a unit test invokes the check with no discoverable goal-loop install
- **THEN** the result status SHALL be `"skip"` or `"warn"`
- **AND** the result status SHALL NOT be `"fail"`

### Requirement: pipeline doctor SHALL surface engine track and production-pin coherence

The `pipeline doctor` command SHALL include a preflight check (named `install:engine-track` or
an equivalent stable id) that reports the **production pin** target version (when the pin
artifact is readable), the installed/running engine version, and the classified engine track
(`pinned` or `candidate`) or an explicit pin-match status. When production pinned-track intent
applies and the installed/running version does not match the production pin version (after
normalizing an optional leading `v`), the check SHALL fail with remediation that names both
versions and instructs the operator to reinstall from the pin tag (or to declare a candidate
soak path intentionally). When the pin artifact is missing or unreadable, the check SHALL fail
or warn with remediation to restore the pin artifact rather than silently omitting track
disclosure. When the install matches the pin under pinned intent, the check SHALL pass and the
detail string SHALL include the pin version and track.

This check is additive to `install:version-coherence` (loaded VERSION vs on-disk package) and
`install:version-freshness` (installed vs latest published release tag); it does not replace them.

#### Scenario: Install matches pin — track check passes

- **WHEN** `pipeline doctor` runs and the production pin version equals the installed/running
  version under pinned-track intent
- **THEN** the engine-track check SHALL have status `"pass"`
- **AND** the detail string SHALL include the pin version and indicate track `pinned` (or
  equivalent pin-match language)

#### Scenario: Install differs from pin under production intent — check fails

- **WHEN** `pipeline doctor` runs with production pinned-track intent
- **AND** the production pin version is `1.29.1` but the installed/running version is `1.30.0`
- **THEN** the engine-track check SHALL have status `"fail"`
- **AND** the detail string SHALL name both the pin version and the installed version
- **AND** the remediation SHALL instruct reinstall from the pin tag or intentional candidate use

#### Scenario: Missing pin artifact is not silent

- **WHEN** `pipeline doctor` runs and the production pin artifact cannot be read
- **THEN** the engine-track check SHALL have status `"fail"` or `"warn"`
- **AND** the remediation SHALL instruct restoring or initializing the production pin artifact
- **AND** the check SHALL NOT omit all track disclosure without status

#### Scenario: Candidate soak intent does not require pin match

- **WHEN** `pipeline doctor` or an equivalent preflight runs in an explicit candidate soak context
  (FRG Layer B / factory-gate / documented eval)
- **AND** the installed/running version differs from the production pin
- **THEN** the check SHALL NOT fail solely for pin mismatch
- **AND** SHALL still report the pin target and that the active track is `candidate`

#### Scenario: Non-factory doctor does not fail closed on missing pin

- **WHEN** `pipeline doctor` runs on a non-factory product repository host
- **AND** no explicit `--engine-track` / `engine_track` pinned intent is set
- **AND** the production pin artifact is missing
- **THEN** the engine-track check SHALL NOT fail solely for the missing pin
- **AND** MAY pass or skip with detail that two-track factory policy is inactive

---

### Requirement: The engine-track doctor check SHALL be unit-testable via injectable deps

The engine-track / production-pin coherence check SHALL obtain the pin artifact contents and
the running version through injected parameters or `DoctorDeps` file-read primitives (not
hard-coded module-level filesystem access inside the check body), so unit tests can supply a
fake pin JSON, fake running version, and fake intent without real filesystem, network, or
subprocess calls. Unit tests SHALL cover at least: pin match → pass; pin mismatch under
production intent → fail; missing pin → fail or warn; candidate intent with mismatch → non-fail
for mismatch alone.

#### Scenario: Fake pin and version yield deterministic pass

- **WHEN** a unit test injects pin version `1.29.1`, running version `1.29.1`, and pinned intent
- **THEN** the engine-track check SHALL produce status `"pass"` with no real I/O

#### Scenario: Fake pin mismatch yields deterministic fail

- **WHEN** a unit test injects pin version `1.29.1`, running version `1.30.0`, and production
  pinned intent
- **THEN** the engine-track check SHALL produce status `"fail"` with no real I/O

### Requirement: Factory doctor install:engine-track SHALL fail closed on a no-frg production pin

On the live factory control checkout, `pipeline doctor` check `install:engine-track` SHALL fail
when pinned-track intent applies and the live production pin is not production-quality: its
`frg_run_id` starts with `no-frg-`, or `frg_evidence_path` is null or empty. The check SHALL
fail even when the installed/running version matches the pin version and tag-install
provenance is otherwise coherent. Detail and remediation SHALL name the `no-frg-*` / null
evidence defect and SHALL instruct a non-skip promote from a real FRG pass (or an explicit
`--skip-frg` only when the operator intends a non-production-quality pin).

The check SHALL NOT fail solely for this marker when two-track factory policy is inactive
(ordinary non-factory product host, including a non-control clone of
`accidental-hedge-fund/agent-pipeline`). Under explicit candidate soak intent, the check SHALL
still report the marker in detail and SHALL NOT fail solely because the pin is `no-frg-*`.

This rule is fail-closed because default promote already requires FRG after the Tugboat
FRG ship path (#1039). A warn-only result is not sufficient on the factory pinned track.
GitHub owner/name SHALL NOT be what activates this fail-closed path.

#### Scenario: Factory pinned doctor fails a no-frg pin

- **WHEN** `pipeline doctor` runs on the live factory control checkout under pinned-track intent
- **AND** the live production pin has `frg_run_id` `no-frg-1.37.0` or `frg_evidence_path` null
- **THEN** `install:engine-track` SHALL have status `"fail"`
- **AND** the detail SHALL name the `no-frg-*` or null-evidence defect
- **AND** the remediation SHALL instruct promote from a real FRG pass

#### Scenario: Matching install does not hide a no-frg pin

- **WHEN** pinned-track intent applies on the live factory control checkout
- **AND** the installed/running version matches the pin version
- **AND** the pin `frg_run_id` starts with `no-frg-`
- **THEN** `install:engine-track` SHALL still have status `"fail"`
- **AND** SHALL NOT pass solely because version and tag-install provenance match

#### Scenario: Non-factory doctor does not fail solely for no-frg

- **WHEN** `pipeline doctor` runs on a non-factory product repository host
- **AND** two-track factory policy is inactive
- **AND** a readable pin has `frg_run_id` `no-frg-1.37.0`
- **THEN** `install:engine-track` SHALL NOT fail solely for that marker

#### Scenario: Non-control clone of this GitHub repo does not fail solely for no-frg

- **WHEN** `pipeline doctor` runs in a non-control clone of `accidental-hedge-fund/agent-pipeline`
- **AND** two-track factory policy is inactive
- **AND** a readable clone pin has `frg_run_id` `no-frg-1.39.1`
- **THEN** `install:engine-track` SHALL NOT fail solely for that marker
- **AND** SHALL NOT treat GitHub owner/name as factory-control identity

#### Scenario: Candidate soak reports the marker without failing for it

- **WHEN** `pipeline doctor` runs with explicit candidate soak intent
- **AND** the live pin has `frg_run_id` `no-frg-1.37.0`
- **THEN** the check SHALL report the `no-frg-*` marker in detail
- **AND** SHALL NOT fail solely because the pin is `no-frg-*`

#### Scenario: Production-quality pin still passes when install matches

- **WHEN** `pipeline doctor` runs on the live factory control checkout under pinned-track intent
- **AND** the live pin has a real FRG `frg_run_id` and a non-null `frg_evidence_path`
- **AND** the install matches the pin under existing track-coherence rules
- **THEN** `install:engine-track` SHALL have status `"pass"`

### Requirement: Factory doctor SHALL accept a shared-path production-quality pin after promote

Factory `pipeline doctor` check `install:engine-track` SHALL pass under pinned-track
intent after a non-skip promote of version `X.Y.Z` that wrote a production-quality pin
(`frg_run_id` does not start with `no-frg-`; `frg_evidence_path` is non-null) to the
shared factory pin path (`AGENT_PIPELINE_PRODUCTION_PIN` or the default factory pin
file), when the install matches that pin under existing track-coherence rules and the
factory control checkout is clean of unignored dirt.

The check SHALL load the shared / exported pin path. It SHALL NOT fail solely because a
promote worktree still holds a different pin file, or because committed `origin/main`
still names `no-frg-*` when that file is not the exported factory pin.

Version `X.Y.Z+1` train SHALL be allowed to start without a manual copy of the pin.

#### Scenario: Doctor accepts frg pin for N after promote

- **WHEN** a non-skip promote of `1.39.3` has written `frg_run_id` `frg-abc` to the
  exported factory pin
- **AND** `pipeline doctor` runs on the factory control checkout with that same pin
  path
- **AND** the install matches `1.39.3` under existing track-coherence rules
- **AND** the checkout has no unignored dirt
- **THEN** `install:engine-track` SHALL have status `"pass"`
- **AND** SHALL NOT require a human to copy the pin from a worktree

#### Scenario: Worktree pin is not the doctor authority when export is set

- **WHEN** `AGENT_PIPELINE_PRODUCTION_PIN` points at the factory pin with
  `frg_run_id` `frg-abc` for `1.39.3`
- **AND** a worktree `repoDir` still has `frg_run_id` `no-frg-1.39.1`
- **AND** `pipeline doctor` runs under pinned-track intent on the factory control
  checkout
- **THEN** `install:engine-track` SHALL evaluate the exported factory pin
- **AND** SHALL NOT fail solely because the worktree pin is `no-frg-*`

### Requirement: Factory-plane doctor SHALL fail when the env pin disagrees with the control pin

On the factory plane (`REPO_DIR` is the factory control checkout), `pipeline doctor` SHALL include an additive preflight check (stable id in the `install:` family) that compares the effective production-pin path to `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. The effective path SHALL be resolved in the same order as `engine-promote`: `production_engine_pin_path` override → `AGENT_PIPELINE_PRODUCTION_PIN` → `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. When the effective path is a different resolved file from the control-checkout pin and both files are readable and their `version` or `git_sha` disagree, the check SHALL have status `"fail"`. The check SHALL NOT use `"warn"` or `"pass"` for that disagreement. Remediation SHALL name both paths. When the winning source is the env, remediation SHALL instruct the operator to unset the env (so Tugboat binds the control pin) or to point the env at the control-checkout pin. When the winning source is `production_engine_pin_path`, remediation SHALL name that override. When both override and env are unset, when the effective path and the control-checkout pin resolve to the same file, or when `version` and `git_sha` agree, this check SHALL NOT fail for split-pin disagreement. Ordinary non-factory product repositories SHALL skip this check. A unit test SHALL fail if env pin and control pin disagree and the result is pass. A unit test SHALL fail if a divergent `production_engine_pin_path` disagrees with the control pin and the result is pass, both when `AGENT_PIPELINE_PRODUCTION_PIN` is unset and when that env points at the control-checkout pin. The check SHALL obtain pin contents through injected `DoctorDeps` file-read primitives so unit tests perform no real filesystem, network, git, or subprocess calls.

#### Scenario: Env pin version disagrees with control pin — fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is `/home/user/.local/state/hermes-factory/production-engine-pin.json`
- **AND** that file has `version` `1.39.6` and `git_sha` `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- **AND** `$REPO_DIR/.agent-pipeline/production-engine-pin.json` has `version` `1.39.7` and `git_sha` `e206cfdabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`
- **THEN** the pin-path check SHALL have status `"fail"`
- **AND** the status SHALL NOT be `"warn"` or `"pass"`
- **AND** remediation SHALL name both pin paths

#### Scenario: Env pin git_sha disagrees at the same version — fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is set to a different readable file from the control-checkout pin
- **AND** both files have `version` `1.39.7`
- **AND** their `git_sha` values differ
- **THEN** the pin-path check SHALL have status `"fail"`

#### Scenario: Matching env pin identity does not fail this check

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is set to a different readable file from the control-checkout pin
- **AND** both files have the same `version` and the same `git_sha`
- **THEN** the pin-path check SHALL NOT fail for split-pin disagreement

#### Scenario: Unset env skips split-pin fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** `production_engine_pin_path` is unset
- **THEN** the pin-path check SHALL NOT fail for split-pin disagreement
- **AND** pin resolution SHALL use `$REPO_DIR/.agent-pipeline/production-engine-pin.json`

#### Scenario: Configured pin override disagrees with control pin — unset env — fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `production_engine_pin_path` is a readable file other than `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** that override file's `version` or `git_sha` disagrees with the control-checkout pin
- **THEN** the pin-path check SHALL have status `"fail"`
- **AND** the status SHALL NOT be `"warn"` or `"pass"`
- **AND** remediation SHALL name the override path and the control-checkout pin

#### Scenario: Configured pin override disagrees with control pin — env points at control pin — fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `production_engine_pin_path` is a readable file other than `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is set to `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** that override file's `version` or `git_sha` disagrees with the control-checkout pin
- **THEN** the pin-path check SHALL have status `"fail"`
- **AND** the status SHALL NOT be `"warn"` or `"pass"`
- **AND** the check SHALL NOT skip as same-path because the env matches the control pin

#### Scenario: Non-factory doctor skips the split-pin check

- **WHEN** `pipeline doctor` runs on a non-factory product repository
- **AND** no factory-plane `REPO_DIR` applies
- **THEN** the pin-path check SHALL skip
- **AND** SHALL NOT fail solely because a Hermes-state pin file exists on the host

#### Scenario: Disagreement-pass regression is hermetic

- **WHEN** a unit test injects an env pin of version `1.39.6` and a control pin of version `1.39.7` under factory-plane doctor
- **THEN** the pin-path check SHALL have status `"fail"`
- **AND** the same suite SHALL fail if that result is `"pass"`
- **AND** no real network, git, or subprocess call SHALL occur

### Requirement: Doctor engine-track identity SHALL use checkout role not GitHub owner/name

`pipeline doctor` check `install:engine-track` SHALL obtain factory-control context from checkout role (live factory control checkout / control worktree), not from `config.repo` equal to `accidental-hedge-fund/agent-pipeline`. On a non-control clone of that GitHub repository, with two-track policy inactive, the check SHALL pass even when a leftover clone pin has `frg_run_id` `no-frg-1.39.1`. On the live factory control checkout, the check SHALL still fail closed under pinned intent when the live pin is `no-frg-*` or has null/empty `frg_evidence_path`.

A unit test SHALL fail if doctor identity treats a non-control clone of `accidental-hedge-fund/agent-pipeline` as pinned and `install:engine-track` / `evaluateEngineTrackCheck` fails on `no-frg-1.39.1`. A second unit test SHALL fail if factory-control checkout context accepts a `no-frg-*` pin as production-quality. Tests SHALL inject I/O and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Non-control clone leftover no-frg pin does not fail doctor

- **WHEN** `pipeline doctor` runs in a non-control clone of `accidental-hedge-fund/agent-pipeline`
- **AND** `config.repo` is `accidental-hedge-fund/agent-pipeline`
- **AND** no explicit `--engine-track` / `engine_track` is set
- **AND** factory-plane `REPO_DIR` and `AGENT_PIPELINE_FACTORY_CONTROL` are unset
- **AND** the clone has `.agent-pipeline/production-engine-pin.json` with `frg_run_id` `no-frg-1.39.1`
- **THEN** `install:engine-track` SHALL have status `"pass"`
- **AND** SHALL NOT fail solely for that leftover marker

#### Scenario: Clone GitHub-name plus leftover pin regression is hermetic

- **WHEN** a unit test injects `config.repo` `accidental-hedge-fund/agent-pipeline`, inactive two-track intent, and a readable pin with `frg_run_id` `no-frg-1.39.1` under a non-control checkout
- **THEN** `evaluateEngineTrackCheck` / `install:engine-track` SHALL have status `"pass"`
- **AND** the same suite SHALL fail if that result is `"fail"` solely because of GitHub owner/name plus the leftover marker
- **AND** no real network, git, or subprocess call SHALL occur

#### Scenario: Factory-control checkout still fails a no-frg pin

- **WHEN** a unit test injects factory-control checkout context and pinned intent
- **AND** the live pin has `frg_run_id` `no-frg-1.39.1` or null `frg_evidence_path`
- **THEN** `evaluateEngineTrackCheck` / `install:engine-track` SHALL have status `"fail"`
- **AND** the same suite SHALL fail if that result is `"pass"`
- **AND** no real network, git, or subprocess call SHALL occur
