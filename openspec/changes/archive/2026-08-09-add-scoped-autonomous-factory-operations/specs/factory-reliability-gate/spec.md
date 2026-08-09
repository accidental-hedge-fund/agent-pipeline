## ADDED Requirements

### Requirement: Resolved fixed-pack selector provenance SHALL survive native loop compilation

When a fresh native loop resolves a supported label or milestone selector to a fixed issue list, the immutable loop contract SHALL retain the normalized source selector as `contract.selector`. It SHALL NOT replace that selector with `work-list` only because the compiler receives resolved issue numbers. Direct explicit issue lists and ranges SHALL retain `work-list` selector semantics. Resume SHALL preserve the accepted selector without recompilation.

#### Scenario: Label selector remains eligible for FRG validation

- **WHEN** `pipeline loop --label factory-gate` resolves issue numbers and creates a fresh contract
- **THEN** the contract selector SHALL remain `{ type: "label", value: "factory-gate" }`
- **AND** `validateFrgPackContract` SHALL evaluate that label selector instead of rejecting it as an ad-hoc work list

#### Scenario: Supported milestone selector remains identifiable

- **WHEN** a supported fixed-pack milestone selector resolves issue numbers and creates a fresh contract
- **THEN** the contract selector SHALL retain that normalized milestone identity
- **AND** run identity, issue order, and dependency compilation SHALL otherwise remain unchanged

#### Scenario: Explicit issue list is not promoted to a fixed pack

- **WHEN** a caller creates a loop from an explicit issue list or range
- **THEN** the contract selector SHALL remain `work-list`
- **AND** FRG fixed-pack validation SHALL reject it unless a future policy explicitly supports that selector

### Requirement: Every release SHALL instantiate the representative pack from a versioned manifest

The repository SHALL contain a versioned representative FRG pack manifest with deterministic issue templates, template identifiers and hashes, required clean-path items, scenario and fault recipes, evidence requirements, and expected composition. A release run SHALL create fresh synthetic issues from that manifest and bind each issue and observation to the exact release version, manifest version, template identity, and run. It SHALL NOT reuse prior release issues such as #749 or #750.

#### Scenario: Fresh release creates fresh pack instances

- **WHEN** the factory starts FRG for version `X.Y.Z`
- **THEN** it SHALL instantiate new synthetic pack issues from the checked-in manifest
- **AND** every issue SHALL carry the fixed selector label plus machine-readable manifest and template provenance

#### Scenario: Old pack item cannot satisfy a new release

- **WHEN** an issue or observation is bound to an earlier version, manifest hash, template, or run
- **THEN** the FRG collector and scorer SHALL refuse it for the current release

### Requirement: FRG observations SHALL be derived from concrete run and fault evidence

The representative pack SHALL provide a collector that creates the documented observation input from concrete Pipeline run events, action evidence, pull-request and check identities, and documented fault injection results. The collector SHALL refuse a required scenario when its evidence is absent or inconsistent. Production collection SHALL NOT import or expose test-only required-observation or required-composition overrides.

#### Scenario: Complete evidence produces an observation input

- **WHEN** every required scenario and fault recipe has concrete evidence bound to the current pack run
- **THEN** the collector SHALL emit a deterministic observation file that names those evidence identities
- **AND** the normal `pipeline factory-gate` scorer SHALL determine pass or fail

#### Scenario: Missing fault evidence fails closed

- **WHEN** one required injection or recovery outcome has no matching concrete evidence
- **THEN** the collector SHALL exit non-zero and name the missing scenario
- **AND** it SHALL NOT synthesize a passing observation

#### Scenario: Test-only overrides are absent from production pack code

- **WHEN** production pack scripts and their imports are inspected
- **THEN** they SHALL NOT import `frgRequiredObservationOverrides`, `frgRequiredCompositionOverrides`, or an equivalent all-pass override

### Requirement: The v1.33.0 pilot MAY use candidate-bound Layer A proof for unsafe fault classes

For release v1.33.0 only, pack `factory-gate-v1` MAY prove fault classes that have no safe production injection seam with a closed manifest list of exact Layer A probes. Live proof remains mandatory for fresh manifest issues, the exact loop item set, two clean ready items, blocker taxonomy, one real OpenSpec-bearing item, pull-request heads, and final checks. The runner SHALL execute every Layer A probe from the same clean candidate commit. It SHALL construct each command from the manifest and SHALL NOT accept a caller-supplied status, metric, receipt, or pass result. This temporary rule SHALL expire after v1.33.0. Issue #908 SHALL replace it in v1.34.0 after #890 and #891 through the idempotent two-call `pipeline factory-release prepare --request <absolute-request.json> --json` interface.

#### Scenario: Candidate-bound hybrid evidence may pass for v1.33.0

- **WHEN** the two fresh pack issues complete in the exact live candidate loop
- **AND** the live evidence proves the exact item set, throughput, taxonomy, OpenSpec content, pull-request heads, and green checks
- **AND** every manifest Layer A probe reports the exact named test as passed and not skipped on the unchanged clean candidate commit
- **THEN** the collector MAY project the mapped fault outcomes with source `layer_a`
- **AND** the scorer MAY produce release-eligible v1.33.0 evidence only when the producer attestation binds the release, candidate commit, manifest, loop, issue set, and proof digests

#### Scenario: Layer A proof is not reported as a live injection

- **WHEN** a fault outcome comes from a candidate-bound hermetic probe
- **THEN** its proof source SHALL be `layer_a`
- **AND** no report, journal, or release evidence SHALL describe it as a live production fault injection

#### Scenario: Hybrid proof is not reusable after v1.33.0

- **WHEN** the target release is not exactly `1.33.0`
- **THEN** the hybrid rule SHALL fail closed
- **AND** the wrapper SHALL NOT reinterpret static bootstrap or candidate-version config as current proof
- **AND** the full current FRG policy or the #908 candidate-native replacement SHALL apply

#### Scenario: Unverified probe output fails closed

- **WHEN** a probe is missing, skipped, fails, lacks the exact named TAP pass, runs on another commit, moves or dirties the checkout, or has an unreadable output digest
- **THEN** the collector SHALL refuse the mapped outcomes
- **AND** it SHALL NOT produce a passing observation for those outcomes

### Requirement: FRG attestation SHALL remain production-owned and candidate-uncredentialed

The factory SHALL NOT place the FRG attestation key or its path in the candidate environment, inherited file descriptors, the candidate-action cgroup's credential mount, request, result, error, log, or notice. The existing scorer unit SHALL load the credential and run only a fixed wrapper-local trusted attestor. That attestor SHALL NOT start a child process, use the network, import or execute candidate code, or import a module selected by candidate output or the attestation request.

The pilot explicitly accepts the broad local authority of the `mcomardo` account and passwordless sudo. A malicious same-user process can read or control local resources. This requirement prevents automatic propagation and candidate-selected attestor behavior; it does not claim filesystem, process-control, or service-manager isolation from that account. Issues #618, #899, or later hardening own that privilege-separation boundary.

For v1.33.0, the attestor SHALL use the policy snapshot pinned with the reviewed #898 wrapper. For every later release, it SHALL use only the signer from the verified current production engine through a closed wrapper-owned selection rule. It SHALL stop on an unsupported request schema, evidence schema, signer identity, or policy. It SHALL NOT use candidate code as the signer.

The attestation request SHALL contain only versioned identity fields, wrapper-approved closed data paths, and expected digests. It SHALL contain no executable path, module name, command, network target, caller-authored pass claim, or signing result. The trusted attestor SHALL resolve each data path within its fixed allowed roots, reject traversal and unexpected file types, verify every digest, recompute the policy result, and emit only the bounded attestation result.

#### Scenario: Candidate action receives no automatic FRG credential

- **WHEN** the wrapper starts a candidate action and processes its attestation handoff
- **THEN** the candidate environment SHALL contain no FRG key or key path
- **AND** the candidate SHALL inherit no FRG key file descriptor
- **AND** the candidate-action cgroup SHALL have no FRG credential mount
- **AND** the request, result, error, journal record, log, and notice SHALL contain no key and SHALL redact its path

#### Scenario: Candidate cannot select trusted attestor behavior

- **WHEN** candidate output names a credential, executable, module, command, network target, traversal path, or symlink escape in an attestation request
- **THEN** the trusted attestor SHALL reject the request without importing or executing candidate code, starting a child process, using the network, reading the selected target, or returning secret data

#### Scenario: Same-user authority remains explicit

- **WHEN** a malicious process runs as `mcomardo` or uses the pilot's passwordless sudo outside the wrapper handoff
- **THEN** #898 SHALL make no claim that it prevents that process from reading or controlling local resources
- **AND** #618, #899, or later hardening SHALL own any required privilege separation

#### Scenario: Current production policy owns later signing

- **WHEN** a release after v1.33.0 requests attestation
- **THEN** the wrapper SHALL select the signer from the verified installed production engine without using a candidate-selected import or path
- **AND** the attestor SHALL stop if that signer does not support the request schema, evidence schema, or policy

#### Scenario: Candidate cannot claim a passing attestation

- **WHEN** candidate output includes a pass claim, MAC, signer identity, or other field outside the unsigned artifact contract
- **THEN** the wrapper and trusted attestor SHALL ignore or reject that field according to the closed schema
- **AND** only a policy result recomputed by the trusted attestor MAY be signed
