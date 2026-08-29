## MODIFIED Requirements

### Requirement: Issue-scoped Monitor grep filter

The shared follow/notify contract SHALL recommend `pipeline logs` / `pipeline loop logs --events --follow` (optionally through the shared material filter) as the primary follow path. The generated SKILL SHALL NOT recommend the broad alternation pattern `"^\[pipeline\]|^\[exit code|FAILED|timed out|blocked label|approved|needs-attention|→ "` as the primary filter. The generated SKILL SHALL NOT be required to document the legacy issue-scoped stdout grep `^\[pipeline\] #<N>: ` as the follow contract.

#### Scenario: Tight filter used in Monitor command

- **WHEN** an operator arms follow for a durable run
- **THEN** the generated SKILL or shared contract SHALL name `pipeline loop logs --events --follow` or `pipeline logs <run-id> --events --follow`
- **AND** SHALL NOT recommend the broad stdout alternation as the primary filter

#### Scenario: Concrete substitution example provided

- **WHEN** the generated SKILL or shared contract shows a follow example
- **THEN** the example SHALL use a real `run_id` placeholder or an explicit `<run-id>` substitution
- **AND** SHALL NOT require `^\[pipeline\] #<N>: ` as the follow contract

---

### Requirement: Rationale for tight filter documented

The shared follow/notify contract SHALL state that the material filter (or unfiltered events follow) is for progress notify, and that unfiltered `events.jsonl` remains the evidence stream. Generated SKILLs SHALL NOT be required to restate the test-gate fixture-spam essay that justified the legacy stdout grep.

#### Scenario: Test-gate fixture spam explained

- **WHEN** an operator reads the follow/notify contract
- **THEN** the text SHALL name `events.jsonl` as the complete evidence stream
- **AND** SHALL treat the material filter as notify-only
- **AND** SHALL NOT be required to restate the test-gate fixture-spam stdout-grep essay

#### Scenario: Auto-stop risk explained

- **WHEN** an operator reads the filter guidance
- **THEN** the text SHALL treat the material filter as the way to avoid notify spam
- **AND** SHALL NOT be required to explain Monitor auto-stop in terms of stdout grep

---

### Requirement: No real signal lost by tight filter

The shared follow/notify contract SHALL confirm that follow-until-terminal captures stage progress and terminal outcomes via `events.jsonl`. The contract SHALL NOT require a SKILL essay that every stdout transition line begins with `[pipeline] #N:`.

#### Scenario: Terminal transitions confirmed captured

- **WHEN** an operator reads the follow/notify contract
- **THEN** the text SHALL require stop on a terminal run or loop event
- **AND** SHALL NOT require a stdout grep essay to prove terminal capture

#### Scenario: Process-exit signal described

- **WHEN** an operator reads the stop-follow guidance
- **THEN** the contract SHALL treat supervisor/process exit as a stop condition alongside terminal events
- **AND** SHALL NOT require a SKILL essay that every stdout line begins with `[pipeline] #N:`

---

### Requirement: Consistent filter across all host variants

All generated SKILL hosts (`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, `hosts/opencode/SKILL.md`, plus the generated plugin SKILL overlay) SHALL use the same events-follow plus material-filter contract. No host variant SHALL retain the broad stdout alternation pattern as the primary filter.

#### Scenario: Claude host filter matches spec

- **WHEN** `hosts/claude/SKILL.md` is read
- **THEN** the follow path SHALL be events follow, not the broad stdout alternation

#### Scenario: Codex host filter matches spec

- **WHEN** `hosts/codex/SKILL.md` is read
- **THEN** the follow path SHALL be events follow, not the broad stdout alternation

#### Scenario: Plugin SKILL.md filter matches spec

- **WHEN** `plugin/pipeline/skills/pipeline/SKILL.md` is read
- **THEN** the follow path SHALL match the generated Claude short SKILL

---

### Requirement: Host skill guidance SHALL document the events.jsonl material filter for progress notify

The shared orchestration-contract source SHALL document the shared **events.jsonl material filter** used for progress notify. Generated SKILLs SHALL name that filter or point at the shared contract. The guidance SHALL state that unfiltered `events.jsonl` remains the complete evidence stream and that the material filter is for human-visible progress only.

#### Scenario: Material filter is named in host skill monitoring guidance

- **WHEN** an operator reads the generated SKILL or the shared contract
- **THEN** the text SHALL name the shared material filter or `logs … --events --follow` composed with it
- **AND** SHALL list or point to the material event kinds

#### Scenario: Unfiltered evidence path remains available

- **WHEN** an operator needs full lifecycle detail rather than bubbles only
- **THEN** the guidance SHALL still allow unfiltered `logs … --events --follow` as a diagnostic fallback
- **AND** SHALL NOT claim the material filter replaces the run store

---

### Requirement: Material filter guidance SHALL be consistent across host variants

All generated SKILL hosts that document long-running progress notify (`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, `hosts/opencode/SKILL.md`, plus the generated plugin SKILL overlay) SHALL describe the **same** material kind set and spam-suppression rules. Host variants SHALL differ only in the host notify map tool names used to surface filter output, not in which event kinds are material.

#### Scenario: Claude and Codex share material kinds

- **WHEN** material kind lists in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` are compared for notify
- **THEN** the required material kinds and suppression rules SHALL match
- **AND** only the notify tool/surface names MAY differ

#### Scenario: Grok path matches the shared material set

- **WHEN** the generated Grok SKILL documents material progress notify
- **THEN** its material kind set SHALL match the shared filter contract
- **AND** its surface SHALL be Grok `monitor` (or equivalent), not a divergent kind list
