## Why

Outer-host orchestration is still represented through host-name tables and inherited Claude-specific
behavior. Closed fixes for progress notify, reattach-after-wait-cancel, install paths, terminal
cleanup, and durable handoff solved individual hosts (#699/#725/#731/#742 and the post-#787 default
lifecycle) but did not define an extension boundary. A new outer host cannot integrate cleanly
without core edits, and outer-host identity is easily conflated with the stage adapter that executes
model work. #783 separated adapter/host vocabulary; this change defines the outer-host lifecycle
contract that consumes that separation.

## What Changes

- **Outer-host manifest.** Define a versioned outer-host manifest independent of stage adapter,
  provider/auth class, model, effort, and role. Each host declares: install/invocation profile,
  skill or command surface, early run handoff, event follow, reattach, wait/cancel behavior,
  material-progress notification mapping, terminal cleanup, and terminal summary capabilities.
- **Capability-driven shared orchestration.** Shared advance/loop skill orchestration and install
  surfaces consume declared capabilities and **never** branch on host name strings for lifecycle
  behavior. Built-in hosts re-declare through the same public surface as third-party ones.
- **Explicit unsupported/fallback behavior.** Every capability has a documented supported path and
  an explicit unsupported fallback. Portable baseline remains stdout JSON + `events.jsonl` follow
  (no host-specific tools required for correctness).
- **Conformance kit + synthetic third-party host.** A shared conformance kit asserts required
  declaration fields and capability semantics for every registered outer host. A synthetic
  third-party host fixture integrates install discovery, orchestration capability consumption, and
  long-running lifecycle fixtures **without** a core code change to host-name tables.
- **Cross-host regression fixtures.** Closed #699/#725/#731/#742 and post-#787 lifecycle behaviors
  (durable handoff, event follow, reattach/re-arm after cancelled wait, cancellation handling,
  monitor cleanup, terminal exit, final summary) are expressed as host-agnostic regression fixtures
  over the contract, not provider or host-name tables.
- **Identity in run evidence.** Run evidence records outer-host identity separately from
  implementer/reviewer treatment (adapter) identity.
- **Install lifecycle via manifest.** Host installation, update, uninstall, and discovery use
  manifest data and preserve user-owned content outside managed pipeline paths.

**Non-goals (explicit):**

- A Grok-only host profile or any privileged vendor path.
- Replacing stage adapter invocation or model capability negotiation (#783 owns that surface).
- Campaign monitoring (#654) — later consumer of this protocol, not a prerequisite.
- Changing review policy, auto-merge stop, or stage state-machine semantics.

## Capabilities

### New Capabilities

- `outer-host-lifecycle-contract`: Versioned outer-host manifest and runtime host registry;
  capability declarations for install/invocation, skill/command surface, early handoff, event
  follow, reattach, wait/cancel, material-progress notify mapping, terminal cleanup, and terminal
  summary; shared orchestration that consumes capabilities without host-name branching; explicit
  unsupported fallbacks with stdout/`events.jsonl` as portable baseline; shared conformance kit;
  synthetic third-party host fixture; cross-host lifecycle regression fixtures; separate outer-host
  identity in run evidence.

### Modified Capabilities

- `host-install-discovery`: Discovery, coverage reporting, and install-location probes SHALL
  enumerate and describe hosts from the outer-host registry/manifest rather than a closed
  host-name table hardcoded as the completeness criterion for "all installable hosts."
- `host-neutral-progress-notify`: Material-progress notify mapping SHALL be declared on the
  outer-host manifest (or equivalent capability field) and consumed by shared orchestration via
  that declaration, not by host-name conditionals in shared prose or core.
- `cross-host-profiles`: Outer-host lifecycle identity remains independent of the profile's
  implementer/reviewer role assignment; profile loading MUST NOT be the sole extension path for
  outer-host lifecycle capabilities, and outer-host identity MUST NOT collapse into profile
  harness role names.
- `advance-skill-orchestration`: Default single-issue advance orchestration SHALL consume
  outer-host lifecycle capabilities (handoff, follow, reattach, notify, terminal summary/cleanup)
  and express closed reattach/follow behaviors as contract fixtures rather than host-name branches.
- `loop-skill-orchestration`: Default multi-item loop orchestration SHALL likewise consume
  outer-host lifecycle capabilities for dual-follow, handoff, reattach, notify, and terminal
  summary without host-name branching in shared steps.
- `installer-command-lifecycle`: Install/update/uninstall of host skill and command surfaces SHALL
  be driven by outer-host manifest install profile data (paths, managed artifacts, user-owned
  exclusion) rather than only host-name-specific install functions as the extension model.
- `adapter-extension-registry`: Cross-link only — reinforce that outer-host identity stays
  independent of stage adapter identity when outer-host lifecycle evidence is recorded (no new
  adapter contract members required beyond existing identity-separation requirements).

## Impact

- **New surface:** outer-host manifest schema, runtime host registry API, conformance kit, synthetic
  third-party host fixture, and host-agnostic lifecycle regression fixtures.
- **Install / discovery:** `scripts/install.mjs`, `core/scripts/discovery.ts`, and related tests
  migrate enumeration and install actions onto manifest-declared hosts while preserving existing
  built-in install paths and user-owned content rules.
- **Host packaging:** `hosts/*` and generated `plugin/` overlays declare or load manifests; shared
  skill orchestration text becomes capability-parameterized.
- **Evidence / identity:** run-start / treatment / accounting paths record outer-host id separately
  from implementer/reviewer adapter treatment.
- **Docs / schema / mirror:** config schema, generated docs, host skills, and `plugin/` stay
  synchronized; `npm run ci` passes.
- **Out of scope code:** stage handlers, review policy, auto-merge, adapter model negotiation, and
  #654 campaign automation.

## Acceptance criteria

Observable, falsifiable outcomes that make #784 done:

- [ ] A versioned outer-host manifest schema exists and is independent of stage adapter ID,
      provider/auth class, model, effort, and role fields.
- [ ] Every capability on the manifest (install/invocation profile, skill/command surface, early
      run handoff, event follow, reattach, wait/cancel, material-progress notify mapping, terminal
      cleanup, terminal summary) has an explicit supported path **and** an explicit unsupported
      fallback; portable baseline is stdout JSON + `events.jsonl`.
- [ ] Shared advance and loop orchestration consume declared capabilities and do **not** branch on
      host name strings for lifecycle behavior (no `if (host === "claude")` style lifecycle
      dispatch in shared orchestration).
- [ ] Built-in hosts (at least claude, codex, and any other currently installable host) register
      through the same public outer-host surface used by extensions.
- [ ] A synthetic third-party outer-host fixture integrates (discovery and/or install + capability
      consumption + conformance) **without** modifying core host-name tables or built-in host
      implementation modules as the registration path.
- [ ] A shared conformance kit fails incomplete host declarations and passes complete built-ins
      plus the synthetic fixture.
- [ ] Closed #699/#725/#731/#742 and post-#787 lifecycle behaviors (durable handoff, event follow,
      reattach/re-arm after cancelled wait, cancellation handling, monitor cleanup, terminal exit,
      final summary) are expressed as cross-host regression fixtures over the contract, not as
      host-name or provider tables.
- [ ] Long-running execution evidence (fixture or documented supervised path) proves handoff →
      progress → reattach after cancel → terminal exit → monitor cleanup → final summary under the
      contract.
- [ ] Run evidence records outer-host identity as a field separate from implementer and reviewer
      treatment (adapter) identity.
- [ ] Host installation, update, uninstall, and discovery use manifest data and preserve
      user-owned content outside managed pipeline artifact paths.
- [ ] Config/schema/docs and the generated `plugin/` mirror remain synchronized; `npm run ci`
      passes.
- [ ] No Grok-only privileged host path and no replacement of stage adapter invocation or model
      capability negotiation are introduced.
