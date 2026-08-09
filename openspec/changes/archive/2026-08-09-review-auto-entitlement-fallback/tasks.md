## 1. Detection and classification primitives

- [x] 1.1 Add a pure, tested helper that recognizes Claude Fable/usage-credit entitlement failures from harness stdout/stderr (closed phrase set + optional exit/429 signals); distinguish from ordinary rate-limit throttle without entitlement text
- [x] 1.2 Add stage-diagnostic reason code(s) for model entitlement (e.g. `model-entitlement-required` or reuse `capability-refusal`) projecting to `environment-auth`; keep ordinary throttle on `transient-infra` → `transient-rate-limit`
- [x] 1.3 Regression: zero-token entitlement message and ordinary throttle never project solely to `workflow-engine-defect` when the typed reason is present

## 2. Auto entitlement allowlisted retry

- [x] 2.1 Implement shared reviewer helper: when model source was `auto`, reviewer harness is `claude`, and the preferred attempt is entitlement failure, retry once with `sonnet` (same prompt/effort); never rewrite explicit models
- [x] 2.2 Wire the helper into plan-review and standard review invoke paths that already share the model chain
- [x] 2.3 Populate stage accounting `requested_model` / `resolved_model` / `fallback` on preferred and retry attempts (including zero-token failures)
- [x] 2.4 Unit tests: successful sonnet recovery after Fable entitlement; explicit `claude-fable-5` fails closed; ordinary throttle does not rewrite model; Codex reviewer + auto unchanged

## 3. Design-gate model chain and recovery

- [x] 3.1 Initialize design-gate `reviewerIdentity.model` / effort via shared chain (`reviewerModel ?? models.review`, auto expansion, `resolveReviewerModelForHarness`); re-resolve empty prior identity under auto
- [x] 3.2 Pass concrete model/effort on both interrogation and bounded re-ask; apply shared entitlement fallback helper
- [x] 3.3 Preserve existing validated decision record across reviewer entitlement/throttle recovery (no implementer re-extract solely for reviewer start failure)
- [x] 3.4 Unit tests: unstructured `models.review: auto` emits `--model`; entitlement text is not a verdict; decision record reuse; both profile reviewer harnesses

## 4. Durable recovery scope (plan preservation)

- [x] 4.1 Ensure plan-review throttle/entitlement diagnostics redispatch plan-review only when a completed plan already exists (do not re-run planning harness work)
- [x] 4.2 Unit/integration-style test with injected deps: planning completes once; repeated plan-review entitlement failures do not re-invoke planning
- [x] 4.3 Confirm recovery budgets for `transient-rate-limit` and `environment-auth` apply without forcing `run_fatal` on first entitlement failure

## 5. Docs, mirror, and full gate

- [x] 5.1 Document `auto` preferred Fable + single subscription fallback behavior in operator-facing model routing docs (README and/or host SKILL as appropriate)
- [x] 5.2 After any `core/` edits: run `node scripts/build.mjs` and commit regenerated `plugin/` with the same change
- [x] 5.3 Run `npm run ci` from repo root and fix failures until green
- [x] 5.4 Run `openspec validate review-auto-entitlement-fallback` (and `openspec validate --all` as part of ci)
