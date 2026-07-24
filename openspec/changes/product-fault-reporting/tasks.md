# Tasks — product-fault-reporting (#502)

> Blocked on the product/privacy decision (intake owner, retention, consent UX, promotion
> thresholds). Implementation begins with the preview-and-submit slice (sections 1–5); background
> reporting (gated) is not implemented in this change.

## 1. `product_fault` event + classifier

- [ ] 1.1 Add a `ProductFaultEvent` member to the `RunEvent` union in `core/scripts/run-store.ts`
  (fields: `schema_version`, `payload_schema_version`, `at`, `confidence`, `rationale`,
  `fingerprint`, plus allowlisted diagnostics). Keep other events' `schema_version` unchanged.
- [ ] 1.2 Add a classifier module (`core/scripts/product-fault.ts`) with a `Deps` seam that decides
  `low`/`medium`/`high` confidence and produces a `rationale`. A bare non-zero exit → `low`, no emit.
- [ ] 1.3 Compute the stable bounded `fingerprint` (reuse the stable-finding-identity hash-and-truncate
  technique over a normalized, path-/token-/digit-stripped signature + version + host + stage).
- [ ] 1.4 Tests: record shape + `schema_version` invariants; separation from `correction_event`,
  `papercut`, target-repo, and env/auth failures; bare-non-zero-exit produces no event;
  same-defect-across-installations shares a fingerprint. Prove each bites.

## 2. Allowlist redaction

- [ ] 2.1 Add an allowlist payload-builder (in `product-fault.ts` or a helper) that copies only
  allowlisted fields; reduce raw messages/stacks to the fingerprint; pass every field through the
  existing `artifact-sanitize` injection + secret screen as defense in depth.
- [ ] 2.2 Tests: seed each excluded category (repo name, absolute paths, issue/PR text,
  prompt/output, source snippet, `ghp_`/`AWS_SECRET` tokens, private key, `KEY=value`) into the
  classifier inputs — including inside an error message that feeds the fingerprint — and assert the
  built payload contains none of them. Prove they bite.

## 3. `pipeline report` command (default-inert, preview + consent)

- [ ] 3.1 Add a strict, default-absent `product_fault` config block to `core/scripts/config.ts`
  (enable flag, intake endpoint/auth reference) with the "absent → identical to pre-feature" test.
- [ ] 3.2 Add the `pipeline report` subcommand (`pipeline.ts` + `command-registry`): build payload →
  render exact sanitized preview → require explicit confirmation → submit → write local consent/audit record.
- [ ] 3.3 Manual fallback: when no intake configured, prepare a prefilled GitHub issue draft
  (browser URL / CLI) the operator must submit; the client creates no issue itself.
- [ ] 3.4 Tests: inert when disabled/absent (no network, no `gh` write); preview byte-identical to
  submission; no-confirmation → no transmit; audit record written; manual fallback prepares a draft
  without creating an issue. Prove each bites.

## 4. Intake + promotion contract (maintainer-side; documented, not client-embedded)

- [ ] 4.1 Document the intake contract: submission-scoped auth (no client GitHub scope), schema
  rejection, per-source rate-limit, fingerprint dedup, retention/deletion enforcement.
- [ ] 4.2 Document the promotion contract: threshold gating (high-confidence crash OR
  cross-installation recurrence), one GitHub issue per stable fingerprint, sanitized aggregate
  evidence only, update-not-duplicate on repeat. (Bot runs outside the client engine.)

## 5. Docs, mirror, CI

- [ ] 5.1 Docs: consent, collected/excluded field lists, retention, how to disable, how to inspect a
  submitted report.
- [ ] 5.2 `node scripts/build.mjs` — regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 5.3 `npm run ci` green from repo root (includes `openspec validate --all`).

## 6. Deferred (NOT in this change — later, gated phase)

- [ ] 6.1 Background/automatic opt-in reporting — implement only after measured classifier precision
  meets the reviewed threshold and a signed-off privacy/security threat model exists.
