## MODIFIED Requirements

### Requirement: Repository SHALL keep one shared orchestration-contract source

The repository SHALL keep `core/scripts/host-skill.ts` as the single committed one-pager renderer. Its single deep interface SHALL include `renderHostSkill(options?)`, which returns the complete host-neutral SKILL bytes and MAY receive `operationSurface` and `manifests` for deterministic in-process tests. When omitted, those inputs SHALL default to `OPERATION_SURFACE` and `loadOuterHostManifestsPreferHosts()`. The module SHALL export one issue-locked `SKILL_HOST_IDS` tuple containing exactly `claude`, `codex`, `grok`, and `opencode`; that tuple SHALL be the sole generated-host membership source and SHALL NOT contain notify values or lifecycle behavior. The renderer SHALL select those IDs in tuple order, require exactly one manifest for each selected ID, fail closed on missing or duplicate selected IDs, and exclude non-selected manifests such as OMP. It SHALL derive the displayed notify values only from each selected manifest's `material_progress_notify.mapping`; it SHALL NOT own or hardcode a parallel host/surface/tool map. The module SHALL state the follow/notify contract: capture `run_id` from the durable loop handoff as `loop_run_id` for mutating `pipeline <N>`, `pipeline single`, and `pipeline loop`; use `pipeline loop logs <loop-run-id> --events --follow` as the primary follow; after linkage use `pipeline logs <advance-run-id> --events --follow` for the linked child advance; reattach after an interrupted follow; stop only the matching advance follow on advance `run_complete`; stop the loop-scoped set on `loop_run_complete`, `loop_run_stopped`, or supervisor exit; surface the terminal reason and final summary; and forbid the follower or observer from invoking a merge-capable command. Generated SKILLs SHALL retain `pipeline <N>` as the default numeric issue/PR drive syntax and SHALL NOT recommend a raw-advance bypass. Issue #971 SHALL be able to call that same interface without copying a host SKILL essay. This change SHALL NOT add Hermes or OpenClaw install logic.

#### Scenario: Shared contract names follow-until-terminal

- **WHEN** a reader opens the shared orchestration-contract source
- **THEN** the source SHALL name `run_id`
- **AND** it SHALL name `pipeline logs <advance-run-id> --events --follow`
- **AND** it SHALL name `pipeline loop logs <loop-run-id> --events --follow`
- **AND** it SHALL require reattach after interruption, stop on a terminal run event or supervisor exit, and a terminal reason plus final summary

#### Scenario: Shared contract forbids follower merge

- **WHEN** a reader opens the shared orchestration-contract source
- **THEN** the source SHALL state that the follower or observer never invokes a merge-capable command
- **AND** it SHALL name at least `merge`, `merge-queue --apply`, `train --merge`, and `ship` as merge-capable

#### Scenario: Supervisor pack can reuse the source

- **WHEN** issue #971 needs a host-neutral one-pager
- **THEN** it SHALL be able to import or render the same committed source
- **AND** this change SHALL NOT add Hermes or OpenClaw install paths

#### Scenario: Notify rows come from outer-host manifests

- **WHEN** the renderer builds the compact notify table
- **THEN** each Claude, Codex, Grok, and OpenCode row SHALL equal that manifest's declared notify `surface`, `tools`, and `filter`
- **AND** `host-skill.ts` SHALL NOT select notify behavior with a second hardcoded host-name map

#### Scenario: Injected manifest fixtures change rendered rows

- **WHEN** a test passes a complete selected-host manifest fixture to `renderHostSkill` and changes one fixture mapping
- **THEN** the corresponding rendered row SHALL change without editing `host-skill.ts`
- **AND** a missing or duplicate selected manifest ID SHALL fail generation

#### Scenario: Issue-locked host membership excludes OMP

- **WHEN** the default outer-host loader returns the repository manifest registry
- **THEN** rendered row membership SHALL equal `SKILL_HOST_IDS` in tuple order
- **AND** OMP or another non-selected manifest SHALL NOT add a row or generated target

#### Scenario: Shared contract treats numeric drive as the durable loop path

- **WHEN** a reader opens the shared orchestration-contract source
- **THEN** mutating `pipeline <N>` SHALL be described as the durable one-item drive
- **AND** the source SHALL NOT recommend a raw-advance bypass for issue drive
- **AND** the source SHALL still retain `pipeline <N>` as the default numeric syntax

---

### Requirement: Generated host SKILLs SHALL own only launch, follow, reattach, answer, cancel, and notification behavior

Each generated host SKILL SHALL tell the session host to exec `pipeline <verb>` to launch, follow events with `pipeline logs` / `pipeline loop logs`, reattach through the shared liveness restore or portable follow, answer typed requests through CLI (`pipeline unblock` or the documented answer surface), cancel only through authenticated cancel surfaces, and notify from the active outer-host manifest row. Generated SKILLs SHALL NOT encode recovery recipes, fault classification, retry controllers, merge-from-follow, or a second ledger. Compact policy that names operator-authorized merge and ship surfaces SHALL remain launch documentation only. The follower SHALL still never invoke a merge-capable command. Generated SKILLs SHALL NOT instruct the host to bypass durable supervision by calling raw stage advancement for default numeric issue drive.

#### Scenario: SKILL reattach points at shared restore

- **WHEN** a reader opens a generated host SKILL
- **THEN** interrupted follow and dead-worker restore SHALL be described as non-terminal
- **AND** the SKILL SHALL name the shared liveness restore or portable follow CLI
- **AND** it SHALL NOT tell the host to retry `pipeline single` or classify a recipe

#### Scenario: Recovery and retry language is absent from host-owned behavior

- **WHEN** the four generated SKILL bodies are inspected for host-owned behavior
- **THEN** they SHALL NOT instruct the host to classify faults, park as needs-human, or merge because follow stopped
- **AND** they SHALL still list operator-authorized merge and ship as explicit launch surfaces outside follow

#### Scenario: Generated SKILL does not recommend a bypassing issue path

- **WHEN** a reader inspects the default numeric drive guidance in any generated host SKILL
- **THEN** it SHALL present `pipeline <N>` as the durable one-item drive
- **AND** it SHALL NOT instruct the host to follow a top-level `advance_run_handoff` as the canonical numeric identity
- **AND** it SHALL NOT present raw stage advancement as the public issue-drive path
