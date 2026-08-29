## ADDED Requirements

### Requirement: The shared planning phase runner SHALL recompute planning facts immediately before each planning model invocation

`runPlanningPhases` SHALL invoke planning-facts observation immediately before plan authoring, immediately before plan-review, and immediately before plan-revision. Freeform and OpenSpec hooks SHALL share that observation. The runner SHALL pass the resulting current bundle into the prompt builder for that invocation. The runner SHALL NOT invoke the corresponding harness when a required provider failed that observation.

#### Scenario: Freeform planning observes before authoring

- **WHEN** `runPlanningPhases` reaches plan authoring on a repository that declares providers
- **THEN** it SHALL complete a fresh observation before `hooks.authorArtifact`
- **AND** the authoring prompt SHALL receive that observation's bundle

#### Scenario: OpenSpec planning uses the same observation seam

- **WHEN** `runPlanningPhases` reaches plan authoring on an OpenSpec repository that declares providers
- **THEN** it SHALL use the same observation function as the freeform path
- **AND** the OpenSpec planning prompt SHALL receive that observation's bundle

#### Scenario: Plan-review and plan-revision recompute

- **WHEN** the runner reaches plan-review or plan-revision
- **THEN** it SHALL recompute facts immediately before that harness invoke
- **AND** SHALL NOT reuse the authoring-time bundle as current

### Requirement: Planning-facts provider-contract failure SHALL be equivalent across freeform and OpenSpec paths

When planning-facts observation fails the provider contract, both freeform and OpenSpec paths SHALL record the same blocker tag `planning-facts-provider-contract` and the same reason prefix when routed through `runPlanningPhases`.

#### Scenario: Required provider failure is equivalent across paths

- **WHEN** a required provider times out or mutates the worktree
- **THEN** both freeform and OpenSpec hooks SHALL result in blocker tag `planning-facts-provider-contract`
- **AND** SHALL share the same reason prefix
- **AND** SHALL NOT invoke the model that observation was meant to feed
