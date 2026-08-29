## REMOVED Requirements

### Requirement: Both host surfaces SHALL document the operator-owned native `/goal` bootstrap sequence

**Reason:** #1048 retires generated per-host `pipeline:loop` command files, so the old host-token-specific requirement identity no longer describes the product surface.

**Migration:** Every host SKILL documents native goal mode followed by the shared `pipeline loop` CLI invocation.

## ADDED Requirements

### Requirement: Host SKILLs SHALL document the operator-owned native `/goal` bootstrap sequence

Each host's operator-facing SKILL documentation SHALL describe the canonical,
operator-owned bootstrap for starting a durable `pipeline loop` run as an
explicit, ordered two-step performed by the operator inside the engine's
built-in autonomous `/goal` mode. On every host, the documented sequence SHALL
be to enter the host's native goal mode first and then invoke `pipeline loop`
through the Pipeline SKILL. The documents SHALL present the same ordering and
meaning without requiring generated per-verb command files.

#### Scenario: Claude host documents native goal mode then pipeline loop

- **WHEN** the Claude host SKILL documentation is read
- **THEN** it SHALL contain a bootstrap description that instructs the operator to
  enter the native `/goal` mode and then invoke `pipeline loop` for a durable run
- **AND** it SHALL present those two steps in that order

#### Scenario: Codex host documents native goal mode then pipeline loop

- **WHEN** the Codex host SKILL documentation is read
- **THEN** it SHALL contain a bootstrap description that instructs the operator to
  enter the native goal mode and then invoke `pipeline loop` for a durable run
- **AND** it SHALL present those two steps in that order

#### Scenario: The two host surfaces stay symmetric

- **WHEN** the Claude and Codex bootstrap descriptions are compared
- **THEN** they SHALL describe the same ordered two-step bootstrap
- **AND** both SHALL name the same `pipeline loop` CLI invocation

---

## MODIFIED Requirements

### Requirement: The bootstrap documentation SHALL disclaim host-state detection, recursive invocation, and lifecycle control

The bootstrap documentation on both host surfaces SHALL state explicitly that
the skill does **not** detect whether the host's native `/goal` mode is active,
does **not** invoke or re-enter `/goal` itself, and does **not** control the
native `/goal` session's lifecycle. The documentation SHALL frame the engine's
`/goal` mode as the outer autonomous driver and `pipeline loop` as the durable
workload it runs, so no reader concludes the skill manages the session it runs
inside. The documentation SHALL NOT claim any of those three capabilities in
any other passage.

#### Scenario: Docs deny host `/goal` state detection

- **WHEN** either host's bootstrap documentation is read
- **THEN** it SHALL state that the skill does not detect the host's native
  `/goal` session state

#### Scenario: Docs deny recursive `/goal` invocation

- **WHEN** either host's bootstrap documentation is read
- **THEN** it SHALL state that the skill does not itself invoke or re-enter the
  native `/goal` mode
- **AND** it SHALL place responsibility for entering `/goal` on the operator

#### Scenario: Docs deny native lifecycle control

- **WHEN** either host's bootstrap documentation is read
- **THEN** it SHALL state that the skill does not control the native `/goal`
  session's lifecycle

---

### Requirement: The bootstrap documentation SHALL place native completion with the host or operator

The bootstrap documentation SHALL state that native completion of the `/goal`
session is a host or operator action, taken **after** `pipeline loop` reports
its own terminal done and reconciliation conditions from the durable loop
engine. It SHALL make clear that reporting done is the skill's boundary: the
skill neither ends the native `/goal` session nor merges, consistent with the
pipeline stopping at `pipeline:ready-to-deploy` and a human owning the merge.

#### Scenario: Completion is described as a host/user action after reported done

- **WHEN** either host's bootstrap documentation is read
- **THEN** it SHALL state that the durable run reports its own done and
  reconciliation conditions
- **AND** it SHALL state that ending the native `/goal` session afterward is a
  host or operator action, not something the skill performs

#### Scenario: The skill does not merge or end the session at the boundary

- **WHEN** either host's bootstrap documentation is read
- **THEN** it SHALL state that the skill neither ends the native `/goal` session
  nor merges once the durable run reports done

---

### Requirement: A drift guard SHALL keep the bootstrap documentation correct and host-symmetric

A co-located test SHALL assert that both host SKILL documents carry the
bootstrap sequence with the shared `pipeline loop` CLI token and every required
non-claim and completion-ownership statement. The test SHALL fail if either
document drops the bootstrap sequence, advertises a generated per-verb command token, or
omits any required non-claim, so the two operator surfaces cannot silently
diverge or regress into an over-claim. The test SHALL read the checked-in host
documentation directly and SHALL NOT perform any network, git, or subprocess
call.

#### Scenario: Missing or generated-command bootstrap fails the guard

- **WHEN** a host document lacks its bootstrap sequence or advertises `/pipeline:loop`
  or `$pipeline:loop` instead of `pipeline loop`
- **THEN** the drift-guard test SHALL fail identifying the offending host surface

#### Scenario: Dropped non-claim fails the guard

- **WHEN** a host document omits the host-state-detection, recursive-invocation,
  lifecycle-control, or host-owned-completion statement
- **THEN** the drift-guard test SHALL fail

#### Scenario: The guard runs offline through checked-in files

- **WHEN** the drift-guard test executes
- **THEN** it SHALL read the checked-in host SKILL documents directly
- **AND** it SHALL make no network, git, or subprocess call
