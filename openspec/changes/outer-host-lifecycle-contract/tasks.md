## 1. Outer-host manifest schema and runtime registry

- [ ] 1.1 Define the versioned outer-host lifecycle manifest types (id, displayName, version, install/invocation, skill/command surface, early handoff, event follow, reattach, wait/cancel, material-progress notify, terminal cleanup, terminal summary, optional profile_default) with explicit support levels and fallback fields
- [ ] 1.2 Implement outer-host runtime registry API: register, resolve, list ids, all hosts; idempotent same-identity registration; fail-closed id collision; test-only reset/inject seam
- [ ] 1.3 Co-locate single-source install-time manifests (prefer `hosts/<id>/outer-host.manifest.json` or equivalent) so installer can load without full engine deps
- [ ] 1.4 Add unit tests for registration, collision, resolution, enumeration, and version rejection

## 2. Built-in host registration encoding current behavior

- [ ] 2.1 Register built-in outer hosts (`claude`, `codex`, `grok`, `opencode`, and any other currently installable host) solely through the public registry using manifests that encode today's install modes and lifecycle support
- [ ] 2.2 Map existing notify surfaces (Claude Monitor/PushNotification, Grok monitor material lines, Codex chat/status) into material-progress capability declarations
- [ ] 2.3 Map post-#787 / #725 reattach, follow, handoff, cleanup, and terminal summary behaviors into capability declarations (supported + how-to, not host-name tables)
- [ ] 2.4 Add golden tests that built-in install destinations and lifecycle support levels match pre-change behavior for established hosts

## 3. Installer and discovery consume the registry

- [ ] 3.1 Migrate `scripts/install.mjs` host validation, install/update/uninstall path selection, and managed-artifact rules to read outer-host install profiles from manifests/registry rather than a closed name table as the extension model
- [ ] 3.2 Preserve user-owned content rules (only managed pipeline artifacts removed) and dry-run no-write behavior under profile-driven paths
- [ ] 3.3 Migrate discovery completeness listing to registry enumeration while preserving legacy Claude/Codex `hostCoverage` enum semantics as a compat view
- [ ] 3.4 Update install and discovery tests for registry-driven hosts; prove a registered synthetic host appears without editing built-in host modules

## 4. Shared orchestration capability consumption

- [ ] 4.1 Refactor shared advance orchestration guidance/helpers to select handoff, follow, reattach, notify, cleanup, and summary steps from outer-host capabilities (no shared host-name lifecycle switches as the extension path)
- [ ] 4.2 Refactor shared loop orchestration guidance/helpers the same way (including dual-follow material notify via declared mapping/fallback)
- [ ] 4.3 Ensure host overlays only supply host-local mapping details already declared on the manifest; remove Claude-only tool hard-requires from shared prose consumed by other hosts
- [ ] 4.4 Add drift guards so shared orchestration cannot reintroduce host-name lifecycle branching or drop reattach / cancelled-wait-is-not-terminal language

## 5. Run evidence identity separation

- [ ] 5.1 Record outer-host id as its own field in run-start / evidence paths owned by this change, separate from implementer and reviewer treatment (adapter) identity
- [ ] 5.2 When outer host is unknown, omit or set explicit unknown — never invent from implementer adapter id
- [ ] 5.3 Add regression tests for distinct host vs adapter evidence fields (including extension adapter case)

## 6. Conformance kit and synthetic third-party host

- [ ] 6.1 Implement shared outer-host conformance kit: required fields, support-or-fallback completeness, install profile managed paths + user-owned exclusion when install supported, identity independence from stage adapters
- [ ] 6.2 Run all built-in outer hosts through the kit in CI
- [ ] 6.3 Add a complete synthetic third-party outer-host fixture that registers without modifying built-in host implementation modules; kit passes
- [ ] 6.4 Add an intentionally incomplete synthetic host; kit fails naming the missing field
- [ ] 6.5 Add host-agnostic lifecycle regression fixtures for: durable handoff, event follow, reattach after cancelled wait, cancellation non-terminal, material progress (notify or portable baseline), terminal exit, monitor/follow cleanup, final summary

## 7. Docs, schema, mirror, and CI gate

- [ ] 7.1 Document outer-host manifest, registration path, capability fallbacks, and identity separation in host skills / config or install docs
- [ ] 7.2 Update generated config schema/docs if any operator-facing registration keys are introduced
- [ ] 7.3 Regenerate `plugin/` via `node scripts/build.mjs` when `core/` or Claude host packaging changes; commit mirror with source
- [ ] 7.4 Run `npm run ci` and fix all failures until green
