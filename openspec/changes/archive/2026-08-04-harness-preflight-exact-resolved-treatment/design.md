## Context

Production harness invoke (`core/scripts/harness.ts` `invoke`) already:

1. Dispatches through the public adapter registry (#431 / #783), including compatibility adapters
   for unregistered custom reviewer CLIs.
2. Runs **#779** `checkMaterializedPromptBytes` before `buildInvocation` / spawn.
3. Threads **#778** once-per-run CLI version probe into `AdapterProbe` / treatment fingerprint on
   the accounting path (shared helper in `cli-version-probe.ts`).

What it does **not** do today:

| Surface | Today | Residual gap (#636) |
| --- | --- | --- |
| `adapter.preflight(deps, req)` | Implemented per adapter; exercised by doctor + evals + unit tests | **Not** called from production `invoke` with the exact resolved `{model, effort, sandbox}` |
| Role | Config/profile resolve implementer vs reviewer | Preflight request does not prove role-eligibility at the invoke gate |
| Unsupported settings | Adapter preflight would refuse if called | Silent drop risk if invoke builds argv without preflight |
| Executable absolute path | Fingerprint wants `cliPath`; PATH lookup is ambient | Detached launch may see a different PATH; absolute path not systematically resolved before detach |
| Failure typing | Adapter failure classes exist (`missing-cli`, `unauthenticated`, …) | Production path may surface spawn-adjacent errors without #760 intervention/reason projection |
| Doctor | Registry-driven `adapter.preflight()` / smoke (#608) | Coarse / assigned-adapter readiness — **not** a substitute for per-invocation exact treatment |

Dependencies (landed): #783 extension registry, #760 typed remediation taxonomy (consume projection),
#778 fingerprint + version probe helper, #779 prompt-size capability. Follow-on #780 dynamic
authenticated smoke is **out of scope**.

## Goals / Non-Goals

**Goals:**

1. One production **preflight-on-invoke** surface that receives the exact resolved treatment for
   the call about to run and refuses closed before spawn on capability / readiness failure.
2. Same path for built-in, extension, and compatibility adapters.
3. Absolute executable resolution recorded when possible; foreground and detached harness CLI
   discovery equivalent under the same environment treatment.
4. Map preflight failures into #760-compatible typed reason / `HumanInterventionKind` (and related
   blocker surfaces) with bounded, operator-actionable diagnostics.
5. Consume existing #778 probe helper and #779 prompt check — do not fork second versions.
6. Prove with injected-deps tests for implementer and reviewer roles.

**Non-Goals:**

- Re-doing doctor registry enumeration or `allAdapters()` conformance (#608).
- Live authenticated multi-turn smoke (#780).
- Owning evals cell preflight (#601 / #653 may share helpers).
- Ambient model catalogs or silent harness substitution.
- Blocking solely on version drift (fail-soft remains #778).
- Autonomous merge or review-policy changes.

## Decisions

### Decision 1 — Single production preflight-before-invoke helper; `invoke` is the choke point

**Chosen:** Centralize production exact-treatment preflight in a helper used by `harness.invoke`
(and any other production spawn path that must not bypass it). Stages resolve role, model, effort,
and sandbox/tool policy **before** call; the helper assembles `AdapterRequest` + role + materialized
prompt length check and calls `adapter.preflight` with injectable deps.

**Rejected:** Relying only on `doctor.runOnStart` (too coarse, not per-treatment, optional).
**Rejected:** Per-stage ad-hoc preflight copies (drift and missed stages).

**Why.** Issue acceptance requires exact resolved request at preflight for implementer and
reviewer. The invoke entry point is already the single registry dispatch for local CLIs.

**Ordering (normative intent):**

1. Resolve adapter from registry (or compatibility materialization).
2. Measure prompt vs `maxPromptBytes` (#779 — already present; keep first-class).
3. Resolve absolute executable when declaration allows (PATH → absolute once).
4. Run `adapter.preflight` with exact `{model, effort, sandbox}` (and role eligibility check).
5. Consume once-per-run version probe (#778) for probe fields / fingerprint; version **drift**
   remains fail-soft (warn, do not block solely for drift). Missing executable / failed readiness
   **does** block.
6. Only then `buildInvocation` + spawn.

### Decision 2 — Exact resolved treatment is explicit; never ambient default

**Chosen:** The preflight request carries the **resolved** model/effort/sandbox/tool policy the
stage will use. Empty/undefined means “caller requested none,” not “substitute a core-owned
ambient model.” Unsupported capability → `unsupported-setting` (or equivalent) refusal. Preflight
failure **never** switches harness to profile default.

**Rejected:** Silent omission of unsupported flags in `buildInvocation` after a skipped preflight.
**Rejected:** Core-wide default model table for extension adapters (#783 already forbids this).

**Why.** Issue text: “Never use an ambient model default or silent treatment fallback.”

### Decision 3 — Absolute executable + PATH parity for detach

**Chosen:** Before detached launch (and on the production preflight path), resolve PATH-declared
commands to an absolute path using the **same** environment PATH the production process uses for
foreground invoke. Record that absolute path for fingerprint / diagnostics. Detached wrapper env
SHALL preserve the harness-discovery PATH (or the resolved absolute command) so the child finds
the same binary.

**Rejected:** Re-looking up the command only inside the detached child with a stripped PATH.
**Rejected:** Hard-coding vendor install paths.

**Why.** Detached jobs historically lose shell-augmented PATH; absolute resolution at launch time
is the durable fix when resolution succeeds.

### Decision 4 — Typed remediation via existing #760 projection, not a fourth taxonomy

**Chosen:** Map `AdapterPreflightFailure` (and prompt-limit / missing-executable classes) into the
existing escalation / `HumanInterventionKind` projection (`auth-tooling-preflight-failure` and
adjacent kinds as applicable). Messages name stage, adapter, setting, and remediation. Do **not**
invent a parallel free-form-only error type.

**Rejected:** Parking only with prose comments and no typed kind.
**Rejected:** Expanding #760’s full site inventory inside this issue (consume; do not re-audit).

**Why.** Issue requires “#760 typed remediation”; taxonomy already exists.

### Decision 5 — Diagnostic parity for registered adapters and custom executors

**Chosen:** Registered-adapter preflight/spawn failures produce the same bounded shape as other
executor/harness failures: classifiable failure class, non-secret message, no unbounded stack dump
as the sole operator surface. Reuse harness result flags / structured failure fields where they
already exist.

**Rejected:** Special-casing extension adapters with thinner errors.

### Decision 6 — Doctor remains complementary, not replaced

**Chosen:** Doctor continues to validate assigned adapters at operator/run-start time. Production
preflight-on-invoke remains mandatory even when doctor was skipped. No requirement that
`doctor.runOnStart` be true for correctness of this gate.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Double preflight cost (doctor + every invoke) | Keep adapter preflight cheap (no model tokens); cache version probe once-per-run; smoke ≠ full invoke |
| Stages forget to pass model/effort into invoke opts | Choke point tests assert preflight saw resolved values; stage wiring tasks call out both roles |
| Absolute path resolution differs on Windows / exotic PATH | Document Unix-first parity with existing engine support; fail closed with remediation when unresolved |
| Over-blocking on auth probe flakiness | Preserve existing adapter auth-probe semantics (`unknown` ≠ fail for CLIs without documented probe); only declared failure classes block |
| #780 scope creep into authenticated smoke | Explicit non-goal; only cheap readiness + setting validation here |
| Dual version probe if implementer reimplements #778 | Spec + design: import `cli-version-probe` only |

## Migration Plan

1. Land helper + `invoke` wiring behind existing tests; no config flag required (correctness gate).
2. Detach env / absolute path packing as additive; existing foreground runs gain preflight only.
3. Map failures into intervention/blocker emitters at existing call sites that already handle
   harness failure — no new unattended merge path.
4. Rollback: revert change; behavior returns to post-#779 prompt-check-only pre-spawn gate (weaker).

## Open Questions

1. **Role on `AdapterRequest` vs separate argument** — prefer extending preflight input with role
   without breaking doctor’s existing `AdapterRequest` calls; implementation chooses additive
   field or wrapper options object.
2. **Sandbox/tool policy identity** — use existing `sandbox?: boolean` + `sandboxMode` on invoke
   context; preflight must see the same resolved policy the invocation will apply.
3. **Whether external stage executors (# model-endpoint)** share this local-CLI gate — out of
   scope unless they already go through `harness.invoke`; API executors keep their own preflight.
