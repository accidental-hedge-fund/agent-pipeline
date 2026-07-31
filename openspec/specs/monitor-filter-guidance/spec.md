# monitor-filter-guidance Specification

## Purpose
TBD - created by archiving change tighten-skillmd-monitor-filter. Update Purpose after archive.
## Requirements
### Requirement: Issue-scoped Monitor grep filter
The operator orchestration guidance in SKILL.md SHALL recommend a grep filter anchored to the specific issue number being monitored: `^\[pipeline\] #<N>: ` (where `<N>` is the issue number passed to `/pipeline N`). The guidance MUST NOT recommend the broad alternation pattern `"^\[pipeline\]|^\[exit code|FAILED|timed out|blocked label|approved|needs-attention|→ "` as the primary filter.

#### Scenario: Tight filter used in Monitor command
- **WHEN** the operator arms a Monitor to tail the pipeline log
- **THEN** the SKILL.md guidance provides the filter `^\[pipeline\] #<N>: ` with `<N>` explicitly substituted to the issue number

#### Scenario: Concrete substitution example provided
- **WHEN** the SKILL.md shows a filter example
- **THEN** the example uses a real issue number (e.g., `^\[pipeline\] #64: `) or a placeholder making the substitution unambiguous

### Requirement: Rationale for tight filter documented
The SKILL.md guidance SHALL include an explanation of why the issue-scoped filter is preferred, covering: (a) the test-gate stage dumps the full unit-test suite output — including eval-gate and state-machine fixtures that reproduce `[pipeline] #<other-N>:` and `→ ready-to-deploy` substrings — to the same log file; and (b) the broad alternation matches these fixture lines, causing a burst of false-positive Monitor events that can trigger the Monitor's auto-stop threshold.

#### Scenario: Test-gate fixture spam explained
- **WHEN** an operator reads section 4c of SKILL.md
- **THEN** the text explains that running `npm test` (test gate) outputs fixture lines matching `[pipeline] #N:` patterns for arbitrary issue numbers, which flood the Monitor

#### Scenario: Auto-stop risk explained
- **WHEN** an operator reads the filter guidance
- **THEN** the text explains that too many rapid Monitor events trigger the Monitor tool's auto-stop threshold, silencing the rest of the run

### Requirement: No real signal lost by tight filter
The SKILL.md guidance SHALL confirm that the tight `^\[pipeline\] #<N>: ` filter captures all real stage transitions, including terminal states. Specifically, the guidance MUST state that every transition line — including `done`, `at <stage> — blocked: …`, and `→ ready-to-deploy` — begins with `[pipeline] #N:`, and that process exit (background task completion) independently signals run-end regardless of log content.

#### Scenario: Terminal transitions confirmed captured
- **WHEN** an operator reads the filter guidance
- **THEN** the text confirms that `[pipeline] #N: → ready-to-deploy`, `[pipeline] #N: done`, and `[pipeline] #N: at <stage> — blocked: …` all match the tight filter

#### Scenario: Process-exit signal described
- **WHEN** an operator reads section 4e (Stop the Monitor)
- **THEN** the guidance explains that the background bash task completion event signals run-end independently, so the log filter does not need to catch a final exit line

### Requirement: Consistent filter across all host variants
All three SKILL.md files (`plugin/pipeline/skills/pipeline/SKILL.md`, `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`) SHALL use the same tight `^\[pipeline\] #<N>: ` filter and carry equivalent rationale prose. No host variant SHALL retain the broad alternation pattern.

#### Scenario: Claude host filter matches spec
- **WHEN** `hosts/claude/SKILL.md` section 4c is read
- **THEN** the Monitor filter pattern is `^\[pipeline\] #<N>: ` (not the broad alternation)

#### Scenario: Codex host filter matches spec
- **WHEN** `hosts/codex/SKILL.md` section 4c is read
- **THEN** the log-poll filter pattern is `^\[pipeline\] #<N>: ` (not the broad alternation)

#### Scenario: Plugin SKILL.md filter matches spec
- **WHEN** `plugin/pipeline/skills/pipeline/SKILL.md` section 4c is read
- **THEN** the Monitor filter pattern is `^\[pipeline\] #<N>: ` (not the broad alternation)

### Requirement: Host skill guidance SHALL document the events.jsonl material filter for progress notify

Host skill orchestration guidance for long-running advance and loop runs SHALL document the shared **events.jsonl material filter** used for progress notify, in addition to any issue-scoped terminal-log Monitor filters. The guidance SHALL recommend composing host follow/monitor with that filter (or an engine `--material` path that implements the same rules) so material stage/loop kinds are surfaced and polling spam is suppressed. The guidance SHALL state that unfiltered `events.jsonl` remains the complete evidence stream and that the material filter is for human-visible progress only.

#### Scenario: Material filter is named in host skill monitoring guidance

- **WHEN** an operator reads host skill §4 / §4b follow or notify guidance
- **THEN** the text SHALL name the shared material filter (script, documented
  composition, or `logs … --material` equivalent)
- **AND** SHALL list or point to the material advance and loop event kinds

#### Scenario: Unfiltered evidence path remains available

- **WHEN** an operator needs full lifecycle detail rather than bubbles only
- **THEN** the guidance SHALL still allow unfiltered `logs … --events --follow`
  (or raw `events.jsonl`) as a diagnostic fallback
- **AND** SHALL NOT claim the material filter replaces the run store

---

### Requirement: Material filter guidance SHALL be consistent across host variants

All host skill variants that document long-running progress notify (at least `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and the Grok-consumed path / `hosts/grok/SKILL.md` when present, plus generated plugin mirrors of those files) SHALL describe the **same** material kind set and spam-suppression rules for the events.jsonl material filter. Host variants SHALL differ only in the host notify map tool names used to surface filter output, not in which event kinds are material.

#### Scenario: Claude and Codex share material kinds

- **WHEN** material kind lists in `hosts/claude/SKILL.md` and
  `hosts/codex/SKILL.md` are compared for advance and loop notify
- **THEN** the required material kinds and suppression rules SHALL match
- **AND** only the notify tool/surface names MAY differ

#### Scenario: Grok path matches the shared material set

- **WHEN** the Grok-consumed skill path documents material progress notify
- **THEN** its material kind set SHALL match the shared filter contract
- **AND** its surface SHALL be Grok `monitor` (or equivalent), not a divergent
  kind list

