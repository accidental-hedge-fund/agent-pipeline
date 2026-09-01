## ADDED Requirements

### Requirement: Recovery SHALL observe typed production-preflight refusal and SHALL NOT select inapplicable worktree recipes

The recovery controller SHALL observe a typed production-preflight refusal through the existing stage-diagnostic fields (`preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, bounded message). The controller SHALL NOT select `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, force-push, or worktree-removal when the harness never started and the worktree is clean. Inapplicable recipes SHALL NOT count as recovery exhaustion. The controller SHALL NOT invent a harness session or switch adapters. Mechanical routing failure SHALL remain engine-owned recover and SHALL NOT become human authority. A true unavailable capability that requires supplied input SHALL become a typed `CapabilityRequest`. An external condition that is currently false SHALL become an external-condition wait. Product failure classification SHALL NOT grant merge, release, destructive, security, or implicit adapter-fallback authority.

#### Scenario: Never-started harness does not select scratch or dirt recipes

- **WHEN** recovery observes `preflight_failed: true` and the worktree is clean
- **THEN** the controller SHALL NOT claim `unlink_engine_scratch`
- **AND** SHALL NOT claim `checkpoint_owned_harness_dirt`
- **AND** SHALL NOT force-push
- **AND** SHALL NOT remove the worktree

#### Scenario: Inapplicable recipes are not exhaustion

- **WHEN** every remaining recovery recipe is inapplicable because the harness never started
- **THEN** the controller SHALL NOT record recovery exhaustion for those skipped recipes
- **AND** the Logical Operation SHALL remain owned as typed wait or supervised recover

#### Scenario: Mechanical omitted or malformed routing stays engine-owned

- **WHEN** the refusal is an omitted or malformed required lifecycle declaration
- **THEN** the diagnostic SHALL be `capability-refusal` with disposition recover
- **AND** SHALL NOT project to human authority
- **AND** SHALL NOT create a `CapabilityRequest` solely for that mechanical routing failure

#### Scenario: True unavailable capability that needs input becomes CapabilityRequest

- **WHEN** progress requires an unavailable external capability or information that the operator must supply
- **THEN** the pipeline SHALL emit a typed `CapabilityRequest`
- **AND** SHALL NOT treat that request as merge, release, or destructive authority

#### Scenario: External condition wait is not human authority

- **WHEN** the refusal is an external condition that is currently false (including environment-auth)
- **THEN** recovery SHALL use the existing wait or `verify_authentication` path
- **AND** SHALL NOT park the item as human authority solely because the condition is false
