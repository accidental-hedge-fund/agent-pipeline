## Why

The local-CLI adapter registry and role selection are closed over adapter names compiled into
core (`claude`, `codex`, `grok`, `opencode`, `pi`). Open-source users cannot add an implementer or
reviewer adapter without editing the engine, profile unions, discovery, doctor, and evaluation
code. The custom-reviewer CLI escape hatch (#40) is a second-class path with weaker contracts than
registered adapters. Host, adapter, provider, role, model, and effort are also not consistently
treated as independent identities — blocking third-party extension and honest multi-harness
comparison.

## What Changes

- **Public extension contract.** A documented, versioned declarative manifest (and/or package
  hook) lets arbitrary adapter IDs register with the engine without modifying core source. The
  contract declares executable resolution, prompt delivery and size limits, model/effort discovery
  and validation, sandbox/tool policy, cwd/worktree behavior, output envelope, telemetry,
  authentication, version probe, and a runtime smoke hook.
- **Runtime registry as the single source of truth.** Config validation, doctor, evals, discovery,
  help text, and tests iterate the runtime registry rather than hardcoded adapter-name lists or
  provider unions. Built-in adapters register through the same public surface as third-party ones.
- **Either-role eligibility by capability.** Any registered adapter may serve as implementer or
  reviewer when its declared capabilities allow that role; role assignment is configuration plus
  capability checks, not a compile-time name allowlist.
- **Identity separation.** Outer-host identity (the CLI/session that invoked the pipeline) stays
  independent of stage adapter identity, provider/auth class, model, and effort. Unknown
  model/provider metadata remains unknown — core never invents a vendor-global model catalog or
  silent default.
- **Custom-reviewer migration.** The `#40` custom-reviewer CLI escape hatch migrates onto the
  extension contract with compatible defaults (existing configs keep working) while gaining the
  same preflight, prompt-delivery, and failure-classification surface as first-class adapters.
- **Shared conformance kit.** A test kit verifies declared capabilities, exact invocation
  treatment, unsupported-capability refusal, output normalization, telemetry coverage, and failure
  classification for every registered adapter (built-in and extension).
- **Docs / schema / mirror sync.** Config schema, generated docs, host skill docs, and the
  `plugin/` mirror stay synchronized; `npm run ci` passes.

**Non-goals (explicit):**

- No privileged path for Grok, Claude, Codex, Pi, OpenCode, or any other vendor.
- No central catalog of every vendor model.
- No outer-host lifecycle/supervision contract (tracked separately — e.g. #784); this change only
  keeps host and adapter identities separate so that work can compose later.
- No production preflight expansion (#636), fingerprint/prompt-byte vocabulary (#778–#780), or
  verification-policy negotiation (#738) — those consume this registry after it lands.

## Capabilities

### New Capabilities

- `adapter-extension-registry`: Public end-user adapter extension contract, runtime registry,
  declarative registration (manifest and/or package hook), either-role capability eligibility,
  independent host/adapter/provider/model/effort identities, shared conformance kit, and
  compatible migration of the custom-reviewer CLI escape hatch onto the extension surface.

### Modified Capabilities

- `cli-harness-adapters`: Built-in adapters SHALL register through the same public contract as
  extensions; closed compile-time name unions and hardcoded name lists in production paths SHALL
  yield to the runtime registry; golden-fixture and treatment surfaces stay aligned with the
  extension identity namespace.
- `configurable-harness-roles`: Implementer and reviewer role values SHALL resolve against the
  runtime registry (and declared role capabilities) rather than a fixed built-in name set; an
  extension adapter with the required capabilities SHALL be assignable to either role without core
  edits.
- `configurable-review-harness`: The custom-reviewer CLI path SHALL migrate onto the extension
  contract with backward-compatible resolution for existing `review_harness` / unregistered-name
  configs, while gaining the documented extension surface rather than a permanent second-class
  spawn path.
- `doctor-preflight`: Doctor readiness checks for harness adapters SHALL iterate adapters present
  in the runtime registry (and assigned by config) rather than a hardcoded harness-name list.

## Impact

- `core/scripts/harness-adapters/` — public contract expansion, runtime registration API, built-in
  re-registration through the public surface, custom-reviewer compatibility adapter or equivalent
- Config / types / profile surfaces that currently hardcode or document a closed adapter-name set
- Doctor, discovery, help, eval stage-adapters, and tests that enumerate adapters by name
- Host skill docs and config schema / generated docs describing how to register a third-party
  adapter
- `plugin/` mirror regeneration when `core/` changes
- No change to stage semantics, review-verdict policy, never-auto-merge stop, or outer-host install
  packaging beyond documenting identity separation

## Acceptance criteria

Observable, falsifiable outcomes that make #783 done:

- [ ] A synthetic third-party adapter package (fixture or documented minimal package) can be
      registered for **both** implementer and reviewer roles **without** modifying any file under
      `core/` source that hardcodes adapter implementations; config can assign that adapter ID to
      either role and the runtime resolves it.
- [ ] A documented declarative manifest and/or package-hook registration path exists and is the
      supported end-user extension mechanism (not "edit `index.ts`").
- [ ] The public contract requires adapters to declare: executable resolution, prompt delivery and
      limits, model/effort discovery and validation, sandbox/tool policy, cwd/worktree behavior,
      output envelope, telemetry, authentication, version probe, and runtime smoke hook — and the
      shared conformance kit fails an incomplete declaration.
- [ ] The shared conformance kit verifies, for every registered adapter (built-in + extension
      fixture): declared capabilities match behavior, exact invocation treatment for supported
      settings, explicit refusal for unsupported capabilities (no silent drop), output
      normalization into the pipeline result shape, telemetry coverage when declared, and
      distinguishable failure classification.
- [ ] Config validation, doctor, evals, discovery, help, and adapter-enumerating tests obtain the
      set of adapter IDs from the runtime registry (or a test double of it) rather than a
      hardcoded closed list of built-in names; adding a synthetic registry entry surfaces in those
      consumers without core name-list edits.
- [ ] Outer-host identity is recorded and documented as separate from stage adapter, provider/auth
      class, model, and effort; a stage run never collapses host identity into adapter identity.
- [ ] Unknown model or provider metadata remains `unknown` / omitted — core never invents a
      vendor-global model registry entry or silently substitutes a default model for an extension
      adapter.
- [ ] Built-in adapters (`claude`, `codex`, `grok`, `opencode`, `pi`) migrate through the same
      public contract with golden-argv / behavior regression coverage showing no intentional
      invocation regression for established shapes.
- [ ] Existing custom-reviewer CLI configurations (`review_harness` string/object and unregistered
      harness names) continue to resolve with compatible behavior, now via the extension contract
      (or an explicit compatibility registration path documented in design).
- [ ] Config schema, docs, and the generated `plugin/` mirror remain synchronized; `npm run ci`
      passes.
