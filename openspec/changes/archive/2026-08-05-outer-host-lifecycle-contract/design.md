## Context

Today the outer-host seam is a closed map:

| Surface | Today's coupling |
| --- | --- |
| Installer | `VALID_HOSTS` + `HOSTS` object in `scripts/install.mjs` (`claude` / `codex` / `grok` / `opencode`) with per-host install modes and post-install prose |
| Discovery | `pipeline path` reports a Claude/Codex-centric `hostCoverage` enum; OpenCode is additive only |
| Skill orchestration | Host skill §4 / §4b document detach, follow, reattach, notify, terminal summary — largely by naming hosts and copying Claude patterns |
| Progress notify | Host notify map is documented per host name (#742-class / host-neutral-progress-notify) |
| Profiles | `core/profiles/*.json` bind implementer/reviewer harness roles; outer host and profile are related but not a lifecycle capability surface |
| Stage adapters | #783 (`adapter-extension-registry`) owns model/CLI adapter extension; deliberately deferred outer-host lifecycle to this issue |

Post-#787 default behavior already expects durable handoff, event follow, reattach/re-arm, cancellation handling, and terminal summaries for one-item and milestone host invocations. Those behaviors exist as skill text and scattered engine contracts (loop early handoff, logs until-terminal, material filter) rather than as a **host-extensible capability contract**. Adding a fifth host still means editing installer tables, discovery, and orchestration prose.

#783 established independent outer-host vs stage-adapter identity. #784 must define the outer-host **lifecycle** contract that shared orchestration and install consume without host-name branching.

## Goals / Non-Goals

**Goals:**

1. A versioned outer-host manifest declares lifecycle capabilities independent of stage adapter, provider, model, effort, and role.
2. A runtime outer-host registry is the sole enumeration source for installable/orchestrable hosts (built-ins register through the same API as extensions).
3. Shared orchestration and install consumers branch on **declared capabilities**, never on host name string equality.
4. Every capability has an explicit unsupported fallback; portable baseline is stdout JSON + `events.jsonl`.
5. Conformance kit + synthetic third-party host fixture prove extension without core host-table edits.
6. Closed #699/#725/#731/#742 and post-#787 lifecycle behaviors become cross-host regression fixtures.
7. Run evidence records outer-host identity separately from implementer/reviewer treatment identity.
8. Install/update/uninstall/discovery use manifest data and preserve user-owned content.

**Non-Goals:**

- Grok-only privileged profile or vendor-special path beyond declaring Grok's existing symlink-claude install mode as one capability profile.
- Replacing stage adapter invocation, model capability negotiation, or the #783 registry.
- #654 campaign monitoring automation (consumer later).
- Changing review policy, auto-merge, or stage state machines.
- Requiring every host to support every rich capability (fallbacks are first-class).

## Decisions

### Decision 1 — Separate outer-host lifecycle from profiles and stage adapters

**Chosen:** Introduce an **outer-host** identity and registry distinct from:

- `core/profiles/<name>.json` (implementer/reviewer role assignment, reviewMode, presentation defaults)
- stage `HarnessAdapter` registry (#783)

An outer host **may** default-associate a profile name (e.g. Claude host → `claude` profile) but lifecycle capabilities live on the outer-host manifest, not inside profile JSON or adapter declarations.

**Rejected:** Stuffing lifecycle into profiles (conflates role assignment with install/follow/notify).  
**Rejected:** Stuffing lifecycle into stage adapters (adapters execute model work; outer host supervises the operator session).

**Why.** Issue and #783 both require independent identities. Lifecycle (install, handoff, follow, reattach, notify, cleanup) is about the **session host** that launches and supervises the pipeline, not the CLI used for a stage.

### Decision 2 — Manifest schema: declarative capabilities with explicit support level

**Chosen:** Each outer host declares a versioned manifest with at least:

| Field / capability area | Intent |
| --- | --- |
| `id`, `displayName`, `manifestVersion` | Stable host identity |
| `install` | Install mode (tree / symlink / commands-only / none), base-path resolution hooks, managed artifact globs, user-owned exclusion, post-install operator hint |
| `invocation` | Skill path, command surface names (e.g. `/pipeline`, `$pipeline`), discovery probe |
| `early_run_handoff` | supported / unsupported + how handoff is observed (stdout JSON kinds) |
| `event_follow` | supported / unsupported + follow command or portable `events.jsonl` path |
| `reattach` | supported / unsupported + re-arm obligations after cancelled wait |
| `wait_cancel` | How cancelled wait is classified (never terminal) + required recovery |
| `material_progress_notify` | Notify surface mapping (or `stdout_only` / `none`) |
| `terminal_cleanup` | Stop monitors/follows on terminal; what is cleaned |
| `terminal_summary` | How final summary is obtained (`pipeline summary`, stdout, etc.) |
| `profile_default` (optional) | Default pipeline profile name when this host launches |
| `unsupported_fallback` per capability | Required when support ≠ full |

Exact TypeScript field names are implementation detail; the capability **areas** above are normative intent.

**Rejected:** Boolean-only "features" without fallbacks.  
**Rejected:** Free-form prose-only host docs as the sole contract (undrift-guardable).

**Why.** Issue requires every capability to have explicit unsupported/fallback behavior and a portable baseline.

### Decision 3 — Runtime registry as sole enumeration source (mirror #783 pattern)

**Chosen:**

- `registerOuterHost(manifest | hostModule)` / `resolveOuterHost(id)` / `registeredOuterHostIds()` / `allOuterHosts()`
- Built-ins register at boot through the public API
- Extension hosts load only from operator-configured or built-in entry points (no ambient auto-load of random packages)
- Installer `--host` validation, discovery host keys, and tests that assert "all hosts" iterate the registry
- Unit tests inject a registry double or synthetic host rather than hardcoding `{claude,codex,grok,opencode}` as the completeness criterion (built-in golden install coverage remains separate)

**Rejected:** Keep forever-closed `VALID_HOSTS` arrays as the source of truth.  
**Rejected:** Remote HTTP host marketplace.

**Why.** Matches the proven adapter-extension pattern; falsifiable outcome is synthetic host without core table edits.

### Decision 4 — Shared orchestration consumes capabilities, not host names

**Chosen:** Skill packaging and any shared orchestration helpers resolve the active outer host once, then:

1. Read capability support levels from the manifest.
2. Emit or select host-parameterized steps (notify via declared map; reattach when `reattach` supported; else document portable CLI reattach).
3. Never use `if (hostId === "claude")` (or equivalent) in **shared** orchestration modules for lifecycle dispatch.

Host-specific **implementation** of a capability (e.g. Claude `PushNotification` vs Grok `monitor`) lives **inside** the host's declared notify mapping or host overlay, not in shared branch tables.

**Rejected:** Keep expanding host-name switch statements in shared skill templates.  
**Rejected:** Require every host to implement Claude tools.

**Why.** Extension boundary fails if shared code re-encodes host names.

### Decision 5 — Portable baseline is stdout + events.jsonl

**Chosen:** Minimum viable outer host needs only:

1. Ability to invoke the engine (or document install that provides skill/command entry).
2. Observation of durable run handoff / run-store ids via machine-readable stdout or status commands.
3. Follow of `events.jsonl` until terminal (`pipeline logs … --events --follow` or equivalent).
4. Terminal summary via `pipeline summary` / terminal stdout.

Rich capabilities (push notifications, host-native monitors, dual-follow helpers) are optional with documented fallbacks to the baseline.

**Why.** Issue states stdout/events remain the portable baseline; #725/#787 already proved this path.

### Decision 6 — Conformance kit + synthetic third-party fixture

**Chosen:** A shared kit (unit/integration tests under `core/test/` and/or `scripts/` with injected I/O) that:

- Asserts every required declaration field is present and well-typed at runtime
- Asserts each capability either declares full support with a non-empty how-to, or declares unsupported + fallback
- Runs built-ins through the kit in CI
- Runs a **synthetic third-party host** fixture (in-repo package or fixture directory) that:
  - Registers without editing built-in host modules or closed name tables
  - Appears in registry enumeration used by discovery/install test doubles
  - Passes lifecycle fixture scenarios (handoff, follow, reattach-after-cancel, terminal cleanup, summary) via declared capabilities
- Fails an intentionally incomplete fixture

Lifecycle fixtures restate closed #699/#725/#731/#742 / post-#787 behaviors as host-agnostic scenarios driven by capability declarations.

**Rejected:** Docs-only "how to add a host" without an executable kit.  
**Rejected:** Live multi-vendor E2E as the only proof (too flaky for unit gate; optional manual path may be documented).

### Decision 7 — Install/update/uninstall driven by install profile data

**Chosen:** Migrate installer actions to read:

- base path resolution (env overrides, default homes)
- install mode (`tree`, `symlink-to-host`, `commands-surface`, …)
- managed artifact paths (skill tree, `pipeline:*.md` commands, etc.)
- user-owned exclusion (never delete non-pipeline files)
- post-install operator message

from the registered host's install profile. Built-in hosts keep current behavior via manifest data that encodes today's modes (including Grok `symlink-claude` and OpenCode tree+commands). Discovery reports hosts from the registry; legacy Claude/Codex `hostCoverage` enum semantics are preserved as a **compat view** unless a separate additive field enumerates all registered hosts (preferred: keep enum, add registry-driven `hosts` map keys).

**Rejected:** Require a breaking change to `hostCoverage` enum values in the same PR if avoidable.  
**Rejected:** Uninstall that deletes user-owned non-pipeline content.

**Why.** Issue requires manifest-driven install lifecycle and user-owned preservation; compatibility for desktop integrators matters.

### Decision 8 — Evidence records outer-host identity separately

**Chosen:** Run evidence (run-start metadata, treatment/accounting envelopes, and any host-supervised summary artifacts this change owns) includes an explicit **outer-host id** field that:

- Is not rewritten to equal stage adapter id
- Is not inferred from model name or provider
- May coexist with profile name and engine/treatment fields already recorded

When the launching host is unknown, record `unknown` / omit rather than inventing a host id from the implementer adapter.

**Why.** Acceptance criterion and #783 identity separation; #654 later needs a stable host id for campaign follow.

### Decision 9 — Where code lives

**Chosen (intent):**

| Concern | Likely home |
| --- | --- |
| Manifest types + registry | `core/scripts/outer-hosts/` (or equivalent) — new module, not inside `harness-adapters/` |
| Conformance kit | `core/test/outer-host-conformance*.test.ts` + fixture under `core/test/fixtures/outer-hosts/` or `hosts/_fixtures/` |
| Installer consumption | `scripts/install.mjs` loads registry or shared manifest JSON generated/shipped for install-time (Node without full core deps if needed — design may dual-source a JSON manifest list for the installer) |
| Skill orchestration | Shared prose parameterized by capability; host overlays only supply host-local notify/install presentation |
| Discovery | `core/scripts/discovery.ts` iterates registry |

**Installer dual-source note:** `install.mjs` historically avoids full engine deps. Acceptable approaches: (a) ship static `hosts/*/outer-host.manifest.json` files the installer reads, with core registry loading the same files; or (b) small shared ESM module both import. Prefer single-source JSON/manifest files next to host overlays so install remains dependency-light.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Scope creep into rewriting all skill prose | Parameterize lifecycle steps and drift-guard critical phrases; do not rewrite unrelated skill sections |
| Breaking `hostCoverage` for desktop integrators | Preserve enum semantics; add registry-driven fields additively |
| Installer cannot import TypeScript core | Manifest JSON co-located with hosts; shared pure-JS loader if needed |
| Conflating outer host with profile again | Design + tests assert independent fields; conformance kit checks identity separation |
| Synthetic host still requires core PR | Registration path must be config/manifest-only; tests prove no edit to built-in host modules |
| Over-fitting to Claude notify tools | Portable baseline + explicit unsupported for push surfaces |

## Migration Plan

1. Land manifest schema + registry + built-in registrations encoding current behavior (no intentional install/orchestration regression).
2. Wire installer and discovery to registry/manifest while keeping golden install tests green.
3. Land conformance kit + synthetic fixture.
4. Refactor shared orchestration language to capability consumption; host overlays declare notify maps on manifests.
5. Add lifecycle regression fixtures covering handoff/follow/reattach/cancel/cleanup/summary.
6. Record outer-host id in run evidence; document for operators.
7. `node scripts/build.mjs` for mirror; `npm run ci` green.
8. Archive OpenSpec change at pre-merge as usual.

Rollback: revert the change branch; manifests are additive until consumers require them. Prefer feature-flag-free land with built-ins always registered.

## Open Questions

1. **Exact install-time load path** — static JSON next to `hosts/<id>/` vs small shared JS module. Prefer static JSON unless implementation finds duplication intolerable.
2. **Whether `hostCoverage` gains a multi-host generic mode** in this issue or stays Claude/Codex-compat with additive `hosts` map only. Prefer additive-only unless tests force a broader enum.
3. **How much of Grok's symlink-claude mode is re-expressed as a reusable install capability** vs a one-off install mode string. Prefer a named install mode in the schema so future symlink hosts need no new core branch.
4. **Depth of long-running proof in CI** — fully simulated fixture stream vs optional live supervised path. Prefer deterministic fixture-driven kit in CI; document optional live path.
