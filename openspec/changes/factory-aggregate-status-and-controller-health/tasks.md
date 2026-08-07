## 1. Allowlisted factory status read model

- [ ] 1.1 Define `FactoryStatusEnvelope` (`schema_version`, `status` ok|degraded|error,
      `generated_at`, health dimensions, identity/run/items/cost/source-attribution blocks) and
      an explicit public field allowlist module.
- [ ] 1.2 Implement pure `assembleFactoryStatus(sources, clock, probes)` that maps injected
      controller/service, loop status, process-identity, pin, provider/cooldown, write-health,
      and cost readers into the allowlisted envelope only.
- [ ] 1.3 Sanitize free text: drop or coarse-code issue titles, comments, hold reasons,
      next-action prose; never copy lock tokens, bearer tokens, credentials, secret refs, env
      maps, prompts, or tool transcripts.
- [ ] 1.4 Structured `error` / `degraded` paths always return valid envelope JSON with sanitized
      messages.
- [ ] 1.5 Unit tests: full snapshot field categories; unknown/legacy for missing optional
      sources; zero mutation calls on injected seams; frozen `generated_at` from injected clock.

## 2. Canary and secret non-leakage guards

- [ ] 2.1 Build a canary fixture that injects unique `CANARY_SECRET_*` values and prompt-like
      strings into **every** registered status source object shape.
- [ ] 2.2 Assert canaries and raw prompt-like text are absent from JSON.stringify(envelope),
      human rendering, and error-path strings.
- [ ] 2.3 Guard: adding a source key without canary coverage fails the suite.

## 3. Independent controller health and classification

- [ ] 3.1 Define health dimensions (process liveness, durable progress, expected waiting) and
      coarse classes (`healthy`/`waiting`, `suspected_stuck`, `dead`, `unknown`).
- [ ] 3.2 Implement classification pure functions with injected clock and process/service probes.
- [ ] 3.3 Enforce rules: `suspected_stuck` requires fresh liveness + started operation past
      deadline + no durable progress; `dead` requires stale heartbeat + same-host absence proof;
      cross-host / insufficient evidence → `unknown`.
- [ ] 3.4 Expected CI/provider/backoff/dependency/capacity/human waits before deadline classify
      as healthy waiting, not stuck.
- [ ] 3.5 Cost/telemetry honesty: actual|estimated|unknown only; no remaining-quota %; no
      zero-cost invention from absence.
- [ ] 3.6 Unit tests matrix for waiting, stuck, same-host dead, cross-host unknown,
      insufficient-evidence unknown, and cost-unknown.

## 4. Controller-owned independent heartbeat

- [ ] 4.1 Add bounded independent heartbeat refresh on the live controller path (loop
      supervisor now; #890 macro-controller seam when present) during dispatch, expected wait,
      and recovery backoff without requiring model/worker messages.
- [ ] 4.2 Stop refresh after lock loss or terminal exit; surface failed heartbeat persistence as
      non-healthy (not silent healthy).
- [ ] 4.3 Compose with existing cycle-bound process-identity heartbeat; do not replace lock or
      action-evidence contracts.
- [ ] 4.4 Optional operation id/deadline and wait kind/deadline fields on process/controller
      evidence; legacy records without them remain loadable.
- [ ] 4.5 Unit tests with injected interval, clock, and store seam (no real subprocess/network).

## 5. CLI command and registry

- [ ] 5.1 Register factory status in `COMMAND_REGISTRY` (`mutatesGitHub: false`, tight
      `allowedFlags` including `--json`, non-mutating handler).
- [ ] 5.2 Wire `pipeline factory status` human output and `--json` single-object stdout (exact
      nesting matches existing factory-gate/pin command style).
- [ ] 5.3 CLI handler maps real readers into assembler seams; default path remains pure
      observation.
- [ ] 5.4 Registry/flag tests: accepted `--json`, rejected unknown flags (exit 2), handler not
      advance/merge/deploy.

## 6. #890 and legacy source attribution

- [ ] 6.1 When macro-controller/service records exist, fill controller identity, mode/revision,
      active contract, and coarse phase from them.
- [ ] 6.2 When absent/disabled, emit explicit unknown/legacy/not_applicable; still assemble from
      loop supervisor + durable store + pin/provider sources.
- [ ] 6.3 Never invent a running macro-controller or cross-host death.

## 7. Documentation, mirror, and gates

- [ ] 7.1 Ensure factory status is documented in generator inventory so `docs/cli.md` and host
      SKILL tables include it after regenerate.
- [ ] 7.2 After any `core/` change: `node scripts/build.mjs` and commit regenerated `plugin/`.
- [ ] 7.3 `npm run ci` green (`ci:core`, mirror check, install smoke, openspec validate, docs
      check when present, scripts).
- [ ] 7.4 Confirm no dashboard/HTTP raw-status exposure, no auto-merge path, and no
      cross-host death claim was introduced.
