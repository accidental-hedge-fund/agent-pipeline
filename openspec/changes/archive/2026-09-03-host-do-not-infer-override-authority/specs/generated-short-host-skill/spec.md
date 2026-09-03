## ADDED Requirements

### Requirement: Generated host SKILLs SHALL label override as operator-supplied authority

Each generated host SKILL (Claude, Codex, Grok, OpenCode) SHALL describe `pipeline override` as an operator-supplied or explicitly approved disposition. The verb-table description SHALL NOT present override as an ordinary autonomous host next action. The shared Authority section SHALL list `pipeline override` with the same operator-authorized class as merge and ship: the host MUST NOT invent a finding key or reason and MUST NOT invoke override from its own factual judgment. Compact policy text SHALL remain launch documentation. It SHALL NOT encode a recovery recipe catalog, fault classifier, retry controller, or second ledger. The four generated SKILL bodies SHALL remain byte-identical. Claude's permission classifier SHALL NOT be required and SHALL NOT be treated as authorization.

#### Scenario: Verb table names operator-supplied override

- **WHEN** a reader inspects the Operations verb table in any generated host SKILL
- **THEN** the `pipeline override` row SHALL state that the exact disposition is operator-supplied or explicitly approved
- **AND** it SHALL NOT describe override only as “disposition a review finding and auto-resume” without that authority qualifier

#### Scenario: Authority section forbids inferred override

- **WHEN** a reader inspects the Authority section of any generated host SKILL
- **THEN** the section SHALL state that `pipeline override` requires an operator-supplied or explicitly approved exact key and reason
- **AND** it SHALL state that the host must not invent that disposition
- **AND** it SHALL still name merge, merge-queue apply, train merge, and ship as operator-authorized non-advance surfaces

#### Scenario: All four hosts carry the same override boundary

- **WHEN** the four generated SKILL bodies are compared
- **THEN** they SHALL be byte-identical
- **AND** each SHALL contain the operator-supplied override wording
- **AND** none SHALL contain a host-specific override permission or classifier rule

---

### Requirement: Generated host SKILL follow and terminal guidance SHALL recover parked once then STOP

The shared follow/notify contract in each generated host SKILL SHALL state the residual-park rule: for a residual review park at current HEAD, the host MAY run `pipeline recover-parked <N>` at most once for the current park fingerprint; if the issue remains parked, the host MUST stop in the same turn, notify a human, and MUST NOT invent `pipeline override` or remove `blocked` / `pipeline:needs-human`. Train's in-wave RecoverySupervisor recovery remains authoritative; the SKILL SHALL NOT tell the host to auto-invoke `recover-parked` from inside `pipeline train`. This compact STOP rule SHALL live in the existing follow or Authority section. It SHALL NOT add a host-specific state machine or a second recoverer.

#### Scenario: Follow contract names recover-parked once then STOP

- **WHEN** a reader inspects the follow/notify or Authority text in any generated host SKILL
- **THEN** the text SHALL name `pipeline recover-parked` once per park fingerprint as the residual-park recovery-first action
- **AND** it SHALL state that a remaining park requires STOP and human notify
- **AND** it SHALL forbid inventing `pipeline override` and dropping `blocked`

#### Scenario: Train path is not a second recoverer

- **WHEN** generated SKILL text mentions `recover-parked` and `train`
- **THEN** it SHALL NOT instruct the host to invoke `recover-parked` from inside `pipeline train`
- **AND** it SHALL NOT invent merge authority from recover-parked

#### Scenario: Compact park rule is not a recovery essay

- **WHEN** the four generated SKILL bodies are inspected for host-owned behavior
- **THEN** they SHALL NOT contain a per-kind recovery recipe catalog or fault-classification procedure
- **AND** they SHALL still contain the compact recover-parked-once-then-STOP authority rule

---

### Requirement: Tests SHALL fail if any generated host SKILL makes inferred override the autonomous next action

A co-located unit test SHALL fail when any of the four generated host SKILLs, or a fresh `renderHostSkill` result, (1) describes `pipeline override` without the operator-supplied or explicitly-approved qualifier, (2) omits the recover-parked-once-then-STOP residual-park rule, or (3) instructs the host to invent an override key/reason or to remove `blocked` as the next action for a residual park. The same test SHALL assert all four committed SKILL files remain byte-identical to that render. The test SHALL perform no network, git, or subprocess calls beyond in-process rendering.

#### Scenario: Missing operator qualifier fails

- **WHEN** a generated SKILL override row matches the pre-change autonomous summary and lacks operator-supplied wording
- **THEN** the host-skill authority test SHALL fail

#### Scenario: Missing STOP rule fails

- **WHEN** a generated SKILL omits recover-parked-once-then-STOP for a residual park
- **THEN** the host-skill authority test SHALL fail

#### Scenario: Inferred-override next action fails on every host

- **WHEN** the test inspects Claude, Codex, Grok, and OpenCode generated SKILLs
- **THEN** each file SHALL fail the same assertions if inferred override is again the autonomous next action
- **AND** a single-host-only assertion SHALL NOT be sufficient
