## Context

#431 shipped a typed local-CLI adapter contract (`HarnessAdapter`) and a **closed** in-process
registry (`core/scripts/harness-adapters/index.ts`) that freezes five built-in names. Invocation,
preflight, telemetry, and treatment identity already dispatch through that registry for registered
names. Unregistered names fall through to the custom-reviewer CLI path (#40): spawn by string, thin
prompt delivery, no capability declaration, no conformance kit.

#629 extracted a shared implementer-round skeleton so stage orchestration no longer embeds
adapter-specific logic. Stage-output contracts (#770-class work) already expose an
extension-aligned golden-fixture hook that references #783 as the capability/identity namespace.

What remains closed:

| Surface | Today's coupling |
| --- | --- |
| Registry population | Static imports + `Object.freeze({ claude, codex, … })` in core |
| Config / help | Description strings and error lists from `registeredAdapterNames()`, but implementer docs still name the five; tests assert exact five-name sets |
| Role eligibility | Implementer must resolve to a registered adapter; reviewer may be arbitrary string (custom CLI) |
| Identity | Outer host/profile vs stage adapter vs provider are related in docs but not enforced as independent dimensions for extension adapters |
| Conformance | Runtime member-kind tests exist; no end-user-facing kit that an extension package can run against the public contract |

Consumers (#636 preflight, #778–#780 fingerprint/smoke, #784 host lifecycle, #738 verification
negotiation) need a stable public registry + capability declaration surface. This change is that
surface; it does not implement those consumers.

## Goals / Non-Goals

**Goals:**

1. End users can register an arbitrary adapter ID via a documented declarative manifest and/or
   package hook **without editing core**.
2. Any registered adapter can be assigned implementer or reviewer when its declared role
   capabilities allow it.
3. Config, doctor, evals, discovery, help, and tests treat the runtime registry as the only
   authoritative adapter ID set.
4. Host, adapter, provider, role, model, and effort stay independent identity dimensions.
5. Built-ins re-register through the public contract with no intentional argv/behavior regression.
6. Custom-reviewer CLI configs keep working via a compatible migration onto the extension contract.
7. A shared conformance kit is the gate for "this adapter is complete."

**Non-Goals:**

- Privileged vendor path or central model catalog.
- Outer-host install/lifecycle supervision (#784).
- Production preflight expansion (#636), fingerprint/prompt-byte vocabulary (#778–#780), or
  verification-policy product negotiation (#738).
- Changing review policy, auto-merge policy, or stage state machine.

## Decisions

### Decision 1 — Extend the existing `HarnessAdapter` contract; do not invent a parallel type tree

**Chosen:** Grow the public contract in `harness-adapters/types.ts` (and any new declaration
module co-located with it) so built-ins and extensions implement one interface. Add explicit
declaration fields the issue requires (role capabilities, prompt-limit policy, model/effort
discovery hooks, smoke hook, etc.) as additive members with clear defaults for built-ins.

**Rejected:** A separate `ExtensionAdapter` type that wraps or forks `HarnessAdapter`.

**Why.** #431 already owns invocation/preflight/telemetry. A second tree would force every
dispatcher (`invoke`, doctor, evals) to branch dual paths and would re-open the custom-CLI
second-class problem. Additive members + conformance kit keep one dispatch path.

### Decision 2 — Declarative registration: manifest discovery + programmatic package hook

**Chosen:** Support both:

1. **Declarative manifest** — a documented file/shape (exact path and schema recorded at
   implementation time; candidates: package.json `"agent-pipeline.adapters"` / a
   `pipeline-adapter.json` next to a package entry, and/or repo-local config key listing package
   entry points) that names adapter module entry points and stable IDs.
2. **Programmatic hook** — `registerAdapter(adapter)` (or equivalent) callable from a loaded
   package entry, used by built-ins at engine boot and by extension packages after load.

Registration SHALL be idempotent per adapter ID for the same implementation identity, and SHALL
fail closed on ID collision between distinct implementations.

**Rejected:** Only "drop a file under `core/scripts/harness-adapters/`" (requires core edits).
**Rejected:** Only remote HTTP registry (out of scope; local-CLI focus).

**Why.** Open-source packages need a package-manager-friendly path; built-ins need the same
`registerAdapter` call so the registry is not a special case. Manifest + hook covers both.

**Load order (normative intent):**

1. Engine boot registers built-ins through the public API.
2. Configured extension packages/manifests load and register.
3. Custom-reviewer compatibility registration (decision 5) applies only for unresolved names at
   role-resolution time, not as permanent anonymous registry pollution unless the operator opts in.

### Decision 3 — Runtime registry is the sole enumeration source

**Chosen:** Replace frozen compile-time maps and hardcoded five-name assertions in production
paths with:

- `registerAdapter` / `resolveAdapter` / `registeredAdapterNames` / `allAdapters` (mutable at
  load time, freeze-after-boot optional for safety)
- Consumers (config error strings, doctor, discovery, help, evals) call these APIs
- Unit tests inject a registry double or register a synthetic adapter rather than hardcoding the
  built-in set as the completeness criterion (built-in golden coverage remains separate)

**Rejected:** Keep the frozen map and "plugin" overlays that only patch config docs.

**Why.** The issue's falsifiable outcome is that adding a synthetic entry surfaces in consumers
without editing name lists in core.

### Decision 4 — Role eligibility is capability-declared, not name-allowlisted

**Chosen:** Adapters declare which roles they support (at minimum `implementer` and/or
`reviewer`). Config resolution:

- For `harnesses.implementer` / `harnesses.reviewer` / `review_harness.command` / `local-cli`
  adapter fields: the ID must resolve in the runtime registry **and** declare the requested role
  (or an explicit "either role" capability).
- A registered adapter missing the role capability is rejected at config-resolve or preflight with
  a message naming the adapter, role, and missing capability — never silently used.

**Rejected:** Keep implementer = registered only, reviewer = any string forever.
**Rejected:** Infer role support from presence of model/effort flags alone.

**Why.** The issue requires either role when capabilities allow. Explicit role flags avoid
accidental assignment of a reviewer-only CLI as implementer.

### Decision 5 — Migrate custom-reviewer CLI onto a compatibility extension registration

**Chosen:** When role resolution yields a name that is not yet registered, the engine constructs a
**compatibility adapter** for that command string using the documented extension contract defaults
(`prompt_delivery` from config, thin capabilities, declared role `reviewer` unless configured
otherwise, preflight = PATH + spawnability, no invented model catalog). Existing
`review_harness: my-reviewer` configs keep working without a manifest.

That compatibility adapter is still subject to the public interface (buildInvocation, preflight,
describeTreatment, failure classes) so doctor/evals see one shape.

**Rejected:** Leave the permanent raw-spawn branch in `invoke()` forever.
**Rejected:** Require every custom CLI to publish a package before use (breaks #40 compat).

**Why.** Compat without a forever-forked code path. Operators can later replace the compatibility
adapter with a full third-party package of the same ID.

### Decision 6 — Identity dimensions stay independent

**Chosen:** Evidence and types continue (and enforce for extensions) these distinct fields:

| Dimension | Owner | Must not be inferred from |
| --- | --- | --- |
| Outer host / profile | Host packaging + profile | Stage adapter name |
| Adapter ID | Registry | Model alias or host |
| Provider / auth class | Adapter probe (or `unknown`) | Model name alone |
| Role | Config resolution | Adapter marketing name |
| Model (requested / resolved) | Request + telemetry | Host default when unknown |
| Effort (requested / resolved) | Request + telemetry | Cross-adapter mapping tables |

Core SHALL NOT maintain a vendor-global model registry. Model validation is adapter-declared
(open set, closed enum if the CLI documents one, or "unknown / unsupported") — never a silent
default model invent for an extension adapter.

### Decision 7 — Conformance kit is shared and registry-driven

**Chosen:** A test module (and documented entry for external packages) that, given a registered
adapter (or a fixture adapter), asserts:

1. Required contract members and declaration fields present
2. Supported settings produce exact expected invocation treatment (table-driven)
3. Unsupported settings refuse with the documented failure class (no silent drop)
4. Output normalization into `HarnessResult` / stage-output envelope
5. Telemetry parse never throws; nulls when absent
6. Failure classification vocabulary matches the public enum

Built-ins run through the kit in CI; the synthetic third-party fixture proves extension
registration without core edits.

### Decision 8 — Scope of "discovery / help / evals"

**Chosen:** Any code path that lists "supported adapters" or validates adapter IDs for local-CLI
use SHALL call the runtime registry. This includes at least: config validation messages, doctor
assigned-adapter checks, `local-cli` executor validation, help/docs generation that enumerates
adapters, and eval treatment/stage-adapter selection that names local adapters.

Outer-host discovery (`host-install-discovery`, OpenCode host install, loop engine
claude|codex) remains **host** identity and is **not** merged into the adapter registry in this
change (decision 6 / non-goal #784).

## Risks / Trade-offs

- **[Risk] Dynamic registration complicates unit-test isolation** → Mitigation: registry reset /
  inject seam for tests; freeze-after-boot in production after config load.
- **[Risk] Manifest path / package-entry security (arbitrary code load)** → Mitigation: only load
  packages explicitly listed in repo config or trusted install location; never auto-scan global
  node_modules by default; document trust boundary.
- **[Risk] Custom-reviewer compatibility looks like a first-class adapter with weaker guarantees**
  → Mitigation: treatment identity marks compatibility origin; docs encourage full packages for
  implementer use; implementer role on a bare command string remains capability-gated.
- **[Risk] Built-in argv drift during re-registration** → Mitigation: existing golden-argv tests
  remain the regression bar; no intentional argv change in this issue.
- **[Risk] Follow-on issues (#636, #778–#780, #738, #784) over-scope into this PR** → Mitigation:
  non-goals are explicit; capability schema leaves extension points but does not implement those
  products.
- **[Trade-off] Mutable registry vs pure frozen map** → Accept load-time mutation for extensibility;
  optional freeze after resolution for runtime safety.

## Migration Plan

1. Land public contract fields + `registerAdapter` API; re-register built-ins through it (behavior
   identical).
2. Point config/doctor/evals/help enumeration at runtime registry; update tests that assert exact
   five-name completeness to registry-driven assertions + separate built-in golden suite.
3. Add synthetic extension fixture package/path and conformance kit coverage.
4. Route unregistered custom-reviewer names through compatibility adapter registration; delete or
   narrow the raw-spawn special case once golden tests pass.
5. Document end-user registration in host skills / config reference; regenerate plugin mirror.
6. Rollback: revert change; closed registry and raw custom path remain the pre-change behavior.

## Open Questions

1. **Exact manifest file name and schema location** (package.json key vs standalone file vs
   `.github/pipeline.yml` `adapters:` list) — implementer chooses one primary documented path and
   records it in tasks; secondary aliases only if needed for DX.
2. **Whether implementer may use the bare compatibility adapter** for an unregistered command —
   default proposal: reviewer yes (compat); implementer requires a registered adapter that
   declares implementer role (safer), unless design review finds a strong need for parity.
3. **Freeze-after-boot vs mutable-for-test-only** — prefer freeze after config-driven loads in
   production; tests use an explicit reset hook.
