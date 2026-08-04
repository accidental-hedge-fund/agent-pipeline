## Context

Production harness invoke (`core/scripts/harness.ts`) already:

1. Dispatches through the public adapter registry (#431 / #783).
2. Calls `adapter.parseTelemetry(stdout)` and threads recovered `resolvedModel` / `throttled` into `describeTreatment` and stage accounting.
3. For claude/codex only, enables machine-readable modes (`telemetry: "jsonl"`) with verified parsers.

Gaps that motivate this change:

| Surface | Today | Problem |
| --- | --- | --- |
| grok / pi / opencode | `telemetry: "none"`, plain/text output, `EMPTY_TELEMETRY` | Primary implementer (often grok after 2026-07-28 switch) is cost/model-blind; promotion ceilings uncomputable |
| `AdapterProbe.cliVersion` | Hard-coded `null` at invoke (comment: avoid per-call subprocess) | CLI drift invisible; treatment provenance incomplete |
| Machine-readable flags | grok `--output-format json|streaming-json`, pi `--mode json`, opencode `--format json` documented but **schemas never fixture-verified** | Golden rule 5 forbids flipping telemetry until fixtures exist |
| Treatment identity | Partial: adapter, models, efforts, throttle, origin | Missing absolute CLI path, capability hash, role, contract versions, coverage class, fail-soft verified-against drift |
| Provider paths | No vendor-specific architecture yet | Recommendation upsert: keep it that way — one contract for every registered adapter |

Related issues (boundaries):

- **#636** — owns once-per-run exact-treatment preflight including binary/version probe **production**. This change **consumes** that probe result; it does not invent a second probe path.
- **#653** — evals-side per-stage usage/cost/provenance; **shares** fingerprint shape and adapter parsers; does not own production invoke.
- **#763** — engine SHA / discovery attribution; orthogonal to harness CLI version.
- **#602** — eval campaign version freezes; production counterpart is this issue's verified-against + probe warning.

## Goals / Non-Goals

**Goals:**

1. Fixture-verify machine-readable envelopes for every built-in that can honestly declare them; flip `telemetry` only when verified.
2. Thread recovered cost/usage/`resolvedModel`/`throttled` and once-per-run `cliVersion` into treatment + stage accounting for all adapters (including extension/compatibility via the same contract).
3. Define a provider-neutral **immutable production treatment fingerprint** recorded per invocation (or once per resolved treatment within a run, as long as identity is complete and stable).
4. Expose telemetry coverage / cost_source / usage classes / throttle without zero-filling unknowns.
5. Fail-soft compat warning on verified-against vs probed version divergence.
6. Structure fingerprint + parsers so #653 can import them without a second production parser.

**Non-Goals:**

- Live CLI schema discovery as the CI source of truth (fixtures are the truth; live probes may inform fixture updates offline).
- Evals capture pipelines, cell grades, or eval-only fixtures (#653).
- Engine/discovery version stamping (#763).
- Full #636 preflight (model/effort/sandbox/prompt-size exact preflight) beyond consuming its version/binary probe.
- Price tables that invent `cost_source: "actual"` from tokens alone (existing stage-cost-accounting rule stands).
- Blocking stages solely on version drift or missing telemetry.

## Decisions

### Decision 1 — Fixture-first telemetry flip (no live-schema guessing)

**Chosen:** For each candidate adapter (`grok`, `pi`, `opencode`, and any extension that claims jsonl), land **recorded fixtures** under a shared harness-adapter fixture root (exact path chosen at implementation; e.g. `core/scripts/harness-adapters/fixtures/<adapter>/…` or shared with #653 under a neutral path). Unit tests drive `parseTelemetry` against those fixtures. Only after fixtures + parser + golden-argv (or flag-shape) tests pass may `capabilities.telemetry` / `declaration.telemetry` become `"jsonl"` and the adapter enable the verified output-mode flags.

**Rejected:** Enabling `--output-format json` / `--mode json` / `--format json` and “seeing what comes back” in production. **Rejected:** Declaring jsonl while `parseTelemetry` still returns `EMPTY_TELEMETRY`.

**Why.** Golden rule 5 and the original grok adapter comment are explicit: flag existence ≠ schema verification. Fixtures make CI deterministic without network or installed CLIs.

**Per-adapter disposition (intent; implementation records the verified outcome):**

| Adapter | Candidate mode | Disposition rule |
| --- | --- | --- |
| claude | already jsonl | Keep; ensure fingerprint/coverage fields attach |
| codex | already jsonl | Keep; ensure fingerprint/coverage fields attach |
| grok | `--output-format json` and/or `streaming-json` | Flip only if fixtures cover cost/usage/model/throttle fields that the parser claims |
| pi | `--mode json` | Same |
| opencode | `--format json` | Same |
| extension / compatibility | declaration-driven | Same contract; no special vendor path |

If offline capture cannot produce a reliable fixture for a field class, that field stays null and coverage metadata marks it unavailable — do not block the flip of fields that *are* verified, and do not flip the whole adapter to jsonl if the envelope cannot even recover assistant text safely (stdout consumer contract from stage-cost-accounting must hold).

### Decision 2 — One provider-neutral fingerprint, not per-vendor telemetry stacks

**Chosen:** A single fingerprint type/record shape used for every registered adapter. Fields (normative intent; names may snake_case in accounting JSON):

- `adapterId`, `adapterContractVersion` (or declaration/contract version stamp)
- `cliPath` (absolute when resolved), `cliVersion` (probed)
- `capabilityHash` (stable hash of declared capabilities / declaration surface relevant to treatment)
- `role` (implementer / reviewer / other declared role for this invocation)
- `requestedModel`, `resolvedModel`, `requestedEffort`, `resolvedEffort`
- `sandboxToolPolicy` (resolved sandbox/tool policy identity for the invocation)
- `promptContractVersion`, `outputContractVersion` (or equivalent prompt-delivery + output-envelope contract stamps)
- `fallback` (`true`/`false`/`null` — null = unknown, never fabricated false)
- `failureReason` (null on success; typed reason class on failure when known)
- `providerAuthClass` only when actually reported (else unknown/omitted)
- `telemetryCoverage` (e.g. which of cost/usage/model/throttle channels are available vs unavailable vs unknown)
- `costSource` alignment with existing `actual` | `estimated` | `unknown`

**Rejected:** Parallel “Grok telemetry” / “Pi telemetry” modules with different record shapes. **Rejected:** Inferring provider from model name.

**Why.** Recommendation upsert: unknown stays unknown; no named provider receives a separate architecture. #783 already forced one extension contract — fingerprint is the production evidence face of that contract.

### Decision 3 — Consume #636 once-per-run probe; do not probe per call

**Chosen:** Version/binary resolution is **once per run** (or once per distinct adapter CLI identity within a run), cached, and injected into `AdapterProbe.cliVersion` at `describeTreatment` / accounting time. Prefer the probe produced or owned by #636's preflight-on-invoke surface. If #636 is not yet landed when this implements, land a minimal shared probe helper that #636 will own/absorb — **one** implementation, not two diverging paths.

**Rejected:** `exec(cli, ["--version"])` inside every `invoke()` accounting block (current comment correctly rejects this overhead). **Rejected:** Fabricating version from package.json or npm.

**Why.** Issue text: “naturally lands on #636's preflight-on-invoke surface.” Per-call probes add latency and can race CLI upgrades mid-run without improving identity.

**Verified-against metadata:** Each built-in adapter records the CLI version (and optionally commit/build id) against which its argv and telemetry schema were verified (header comment today; promote to structured declaration or adjacent metadata so tests and warnings can read it). When `probedVersion` is present and not compatible with `verifiedAgainst` under a documented comparison rule (exact string or documented semver/prefix rule chosen at implementation and tested), emit a **fail-soft** warning (run log / event); **do not** block the stage solely for drift.

### Decision 4 — Share parsers and fingerprint with #653; boundary with #763

**Chosen:**

- `parseTelemetry` implementations and fixture corpus live under the harness-adapter (or neutral shared) tree so production invoke and eval executor import the **same** functions.
- Fingerprint builder is a pure function of (adapter declaration, probe, request, invocation, telemetry, role, policy) so evals can call it without GitHub/run-store coupling.
- Engine SHA, discovery channel, scoreboard escape-recurrence (#763) stay out of this fingerprint.

**Rejected:** Copy-paste eval-only parsers. **Rejected:** Putting engine version into harness treatment fingerprint.

### Decision 5 — Coverage honesty and no zero-fill (extends existing accounting rules)

**Chosen:** Extend stage accounting / fingerprint consumers so:

- Missing cost → `cost_source: "unknown"`, `cost_usd: null` (existing).
- Missing token counters → omit or null, never `0` unless the provider envelope explicitly reports zero (existing stage-cost-accounting rule).
- Missing throttle → `throttled: null` (not `false`).
- Missing resolved model → `null` (not copy of requested model).
- New coverage metadata states which channels were available for this adapter declaration vs recovered for this call.

**Rejected:** Defaulting unknowns to zeros for “prettier” scoreboards. **Rejected:** Copying requested model into resolved model to “fill the column.”

### Decision 6 — Conformance and kill-switch continuity

**Chosen:** Shared conformance kit continues to require non-throwing `parseTelemetry`, required keys, and no invented `resolvedModel` from unparseable input. Jsonl-declared adapters MUST demonstrate fixture-backed recovery of assistant text (stdout contract) and of any field class they claim. Existing telemetry kill-switch for built-ins (plain-text restore) remains for adapters that support opt-out; adapters flipped to jsonl SHALL honor the same kill-switch pattern where already established for claude/codex, or document if a given CLI has no plain-text twin.

**Why.** Unparseable telemetry must never fail the stage (stage-cost-accounting). Kill-switch preserves operator recovery when a CLI schema drifts mid-fleet.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Fixture capture is incomplete or stale vs current CLI | Version probe + verified-against warning surfaces drift; fixtures versioned beside parser; fail-soft keeps pipeline running |
| #636 not landed yet when implementation starts | Ship shared once-per-run probe helper as the single owner; #636 absorbs/consumes it — document seam in both issues |
| Jsonl mode breaks stdout consumers (verdict JSON, etc.) | Same as claude: parseTelemetry reconstructs assistant text; golden tests for text recovery; kill-switch |
| Over-wide fingerprint bloats every accounting event | Keep fields additive/optional; omit unknowns; no raw prompts/secrets (existing allowlist) |
| Pi/OpenCode json modes are event streams without cost | Leave cost unknown; still recover text/model/throttle if present; coverage marks cost unavailable |
| Double-probe if #636 and #778 both implement | Design decision 3: one helper; conformance/docs forbid a second path |
| Scope creep into #653 eval fixtures | Explicit non-goal; only share shapes/parsers; evals own cell wiring |

## Migration Plan

1. Land fixtures + parser tests for candidates **before** flipping capability flags (safe additive).
2. Thread once-per-run probe into `AdapterProbe` (still null when probe unavailable — additive).
3. Flip telemetry capability + argv only for adapters whose fixtures+parser are green.
4. Emit fingerprint / coverage fields additively on stage accounting (schema remains backward compatible; readers treat absent as unknown).
5. Regenerate `plugin/`; `npm run ci`.
6. Rollback: re-declare `telemetry: "none"` and plain argv for a broken adapter; probe can remain (null-safe). No data migration of historical accounting records.

## Open Questions

1. **Exact fixture path** vs #653 shared corpus directory — resolve at implementation with a single tree both issues import.
2. **`capabilityHash` algorithm** — which declaration fields enter the hash (recommend: stable JSON of capabilities + prompt delivery + telemetry + output envelope + roles; exclude volatile path).
3. **Version comparison rule** — exact string vs documented prefix/semver; pick one tested rule per adapter family if CLIs format versions differently.
4. **Whether fingerprint is a nested object on `stage_accounting` vs flattened fields** — prefer nested or prefixed additive fields without breaking schema_version readers; implementation chooses one and tests round-trip.
5. **#636 landing order** — if #636 lands first, consume its API; if this lands first, export the probe helper #636 will call.
