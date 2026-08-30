## RENAMED Requirements

- FROM: ### Requirement: Host SKILLs SHALL document the operator-owned native `/goal` bootstrap sequence
- TO: ### Requirement: Durable operator docs SHALL document the operator-owned native `/goal` bootstrap sequence
- FROM: ### Requirement: A drift guard SHALL keep the bootstrap documentation correct and host-symmetric
- TO: ### Requirement: A drift guard SHALL keep native-goal bootstrap docs and one-pager pointers correct

## MODIFIED Requirements

### Requirement: Durable operator docs SHALL document the operator-owned native `/goal` bootstrap sequence

`docs/cli.md` and/or `docs/packaging.md` SHALL describe the canonical operator-owned bootstrap for a durable `pipeline loop` run as an ordered two-step: enter the active engine's native goal mode, then invoke `pipeline loop` through the Pipeline SKILL. The generated Claude, Codex, Grok, and OpenCode SKILLs SHALL remain byte-identical one-pagers that list `pipeline loop` in the shared verb table and link to those durable docs; they SHALL NOT be required to repeat a host-specific native-goal essay or emit a generated per-verb command file.

#### Scenario: Claude host documents native goal mode then pipeline loop

- **WHEN** an operator reaches the durable bootstrap docs from the Claude one-pager
- **THEN** it SHALL instruct the operator to enter the host's native goal mode and then invoke `pipeline loop`
- **AND** it SHALL present those two steps in that order

#### Scenario: Codex host documents native goal mode then pipeline loop

- **WHEN** an operator reaches the durable bootstrap docs from the Codex one-pager
- **THEN** the docs SHALL instruct entering native goal mode and then invoking `pipeline loop`
- **AND** the Codex one-pager SHALL retain the shared loop row and doc pointer without a bootstrap essay

#### Scenario: The two host surfaces stay symmetric

- **WHEN** the generated Claude, Codex, Grok, and OpenCode SKILLs are compared
- **THEN** they SHALL carry the same `pipeline loop` row and durable doc pointers
- **AND** they SHALL NOT require `/pipeline:loop`, `$pipeline:loop`, a generated yaml-agent surface, or divergent bootstrap essays

---

### Requirement: The bootstrap documentation SHALL disclaim host-state detection, recursive invocation, and lifecycle control

The durable native-goal bootstrap docs SHALL state that the Pipeline skill does not detect whether a host's native goal mode is active, does not invoke or re-enter that mode, and does not control the native goal session's lifecycle. The docs SHALL frame the host's native goal mode as the outer autonomous driver and `pipeline loop` as its durable workload. Generated host SKILLs SHALL point to those docs and SHALL NOT be required to repeat the three disclaimers as an essay.

#### Scenario: Docs deny host `/goal` state detection

- **WHEN** the bootstrap docs are read
- **THEN** they SHALL state that the Pipeline skill does not detect whether native goal mode is active

#### Scenario: Docs deny recursive `/goal` invocation

- **WHEN** the bootstrap docs describe startup
- **THEN** they SHALL state that the skill does not invoke or re-enter native goal mode
- **AND** they SHALL place responsibility for entering it on the operator

#### Scenario: Docs deny native lifecycle control

- **WHEN** the bootstrap docs describe session ownership
- **THEN** they SHALL state that the skill does not control the native goal session's lifecycle

#### Scenario: The one-pager delegates the essay

- **WHEN** a generated host SKILL is read
- **THEN** it SHALL provide a durable link to the bootstrap docs
- **AND** it SHALL NOT be required to repeat the state-detection, recursion, and lifecycle disclaimers

---

### Requirement: The bootstrap documentation SHALL place native completion with the host or operator

The durable native-goal bootstrap docs SHALL state that ending the native goal session is a host or operator action taken after `pipeline loop` reports its own terminal and reconciliation conditions. They SHALL make the boundary explicit: the loop observer reports done and stops its run-scoped follows; it neither ends the outer native-goal session nor invokes a merge-capable command. The generated one-pager SHALL preserve the compact observer no-merge rule and SHALL NOT be required to restate the full native-session completion essay.

#### Scenario: Completion is described as a host/user action after reported done

- **WHEN** the durable loop reports terminal and reconciliation conditions
- **THEN** the bootstrap docs SHALL place ending the native goal session with the host or operator
- **AND** they SHALL NOT claim that the Pipeline skill ends that session

#### Scenario: The skill does not merge or end the session at the boundary

- **WHEN** the durable run reports done
- **THEN** the bootstrap docs SHALL state that the skill neither ends the native goal session nor merges
- **AND** any merge-capable next step SHALL remain an explicitly operator-authorized action

#### Scenario: Generated one-pager keeps only the compact boundary

- **WHEN** a generated host SKILL is read
- **THEN** it SHALL forbid the follower from invoking merge-capable commands
- **AND** it SHALL point to durable docs for native-session ownership detail

---

### Requirement: A drift guard SHALL keep native-goal bootstrap docs and one-pager pointers correct

A co-located offline test SHALL assert that the durable native-goal bootstrap docs contain the ordered native-goal-then-`pipeline loop` sequence, the three required non-claims, and host/operator completion ownership. Generation freshness SHALL separately ensure that all four committed one-pagers contain the same `pipeline loop` verb-table row and durable doc links. The guard SHALL fail if packaging advertises `/pipeline:loop`, `$pipeline:loop`, or a generated per-verb yaml agent as the bootstrap. It SHALL read checked-in files directly and SHALL make no network, git, or subprocess call.

#### Scenario: Missing or generated-command bootstrap fails the guard

- **WHEN** the checked-in durable docs omit native-goal entry followed by `pipeline loop`, or packaging advertises a generated per-verb bootstrap
- **THEN** the bootstrap guard SHALL fail and identify the offending checked-in surface

#### Scenario: Dropped non-claim fails the guard

- **WHEN** the durable docs omit state-detection, recursive-invocation, lifecycle-control, or host/operator-completion ownership
- **THEN** the bootstrap guard SHALL fail

#### Scenario: Stale one-pager link or loop verb fails generation freshness

- **WHEN** a committed generated SKILL lacks the shared `pipeline loop` row or durable doc pointers emitted by `renderHostSkill()`
- **THEN** the generation-freshness guard SHALL fail without requiring the bootstrap essay in that SKILL

#### Scenario: The guard runs offline through checked-in files

- **WHEN** the bootstrap guard executes
- **THEN** it SHALL read checked-in docs and generated output without network, git, or subprocess calls
- **AND** it SHALL reject `/pipeline:loop`, `$pipeline:loop`, and generated per-verb yaml-agent bootstrap files
