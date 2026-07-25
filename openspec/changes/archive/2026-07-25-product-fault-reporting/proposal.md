## Why

When Agent Pipeline itself breaks inside a public installation, maintainers get no signal —
the failure is buried in an operator's private repo, and there is no privacy-safe path for that
operator to report "the *pipeline* looks broken" without leaking their repository, prompts,
source, credentials, or environment. Existing evidence classes (`correction_event`, papercuts,
target-repo failures, environment/auth failures) deliberately do **not** claim "Agent Pipeline is
at fault," so recurring product defects across installations stay invisible. We need a distinct,
consent-gated, allowlist-redacted product-fault reporting path — never autonomous, never
issue-creating from the client — that lets an operator explicitly submit a sanitized diagnostic to
a maintainer-controlled intake, and lets maintainers cluster those into a single upstream issue.

Issue #502 is **Blocked** pending a product/privacy decision on intake ownership, retention,
consent UX, and promotion thresholds. This change captures **intent only** (requirements /
behavior). It specifies the preview-and-submit client path, the classifier, the redaction
guarantees, and the maintainer intake + promotion contract as the approved starting scope, and
explicitly gates **background opt-in reporting** as a later, precision-gated phase.

## What Changes

- **New `product_fault` run event** with a versioned schema, a stable bounded fingerprint, and an
  explicit classifier rationale — recorded only for *probable Agent Pipeline defects*, cleanly
  separated from `correction_event`, papercuts, target-repo failures, and environment/auth
  failures. A non-zero command exit alone SHALL NOT produce a product-fault claim.
- **Allowlist-based redaction**: the payload is built from a fixed field allowlist; repository
  identity, filesystem paths, issue/PR text, prompts/model output, source snippets, environment
  values, tokens, and common secret forms cannot enter it. Redaction is proven by tests, not asserted.
- **New `pipeline report` command**: disabled by default, performs **no** network I/O and creates
  **no** GitHub issue unless explicitly invoked. It renders the exact sanitized payload for operator
  inspection, requires explicit submit confirmation, and records local consent/audit evidence.
- **Manual GitHub fallback**: when no intake service is configured, `pipeline report` prepares a
  prefilled issue draft (browser/CLI) that the operator must review and submit themselves.
- **Maintainer-controlled intake contract** (server-side capability spec): authenticates client
  submissions without requiring broad GitHub permissions on client machines, rejects malformed
  schemas, rate-limits, deduplicates by fingerprint, and enforces a retention/deletion policy.
- **Cluster→issue promotion contract**: only a high-confidence crash or a fingerprint repeated
  across installations promotes a cluster; a maintainer bot opens or updates exactly **one** GitHub
  issue per stable fingerprint carrying only sanitized aggregate evidence (affected versions,
  anonymous counts) — never client-submitted raw text.
- **Phase gate**: background/automatic reporting is explicitly deferred to a later phase, gated on
  measured classifier precision and a reviewed privacy/security threat model.

This change adds **no** `auto_merge`-style autonomy: public installations are never granted
permission to create upstream issues, and reporting is inert unless the operator opts in per-run.

## Capabilities

### New Capabilities

- `product-fault-classification`: define the versioned `product_fault` event, its stable bounded
  fingerprint, confidence level, and explicit classifier rationale; require clean separation from
  other evidence classes and forbid non-zero-exit-alone product-fault claims.
- `product-fault-redaction`: allowlist-based payload construction with proven exclusion of
  repository identity, paths, issue/PR content, prompts/output, source, environment values, and
  common secret forms.
- `product-fault-report-command`: the `pipeline report` command — default-inert, exact sanitized
  preview, explicit submit confirmation, local consent/audit record, manual prefilled fallback, and
  the background-reporting phase gate.
- `product-fault-intake`: maintainer-controlled intake service contract — client auth without broad
  GitHub scopes, schema rejection, rate-limiting, fingerprint dedup, retention/deletion enforcement.
- `product-fault-issue-promotion`: promote a stable-fingerprint cluster to exactly one GitHub issue
  carrying only sanitized aggregate evidence, gated on high-confidence crash or cross-installation
  recurrence.

### Modified Capabilities

_None._ This is additive. `configurable-event-sink`, `papercut-capture`, and `stable-finding-identity`
supply reusable foundations (event-append + redaction path, capture shape, fingerprint technique)
but their existing requirements are unchanged.

## Impact

- `core/scripts/run-store.ts` — new `product_fault` member of the `RunEvent` union (additive;
  `schema_version` of existing events unchanged).
- `core/scripts/artifact-sanitize.ts` — reused injection/secret screening; new allowlist-build helper.
- New client module for classification + payload build + preview; new `pipeline report` CLI
  subcommand in `core/scripts/pipeline.ts` and `command-registry`.
- `core/scripts/config.ts` — new optional, default-off `product_fault` config block (strict schema)
  naming the intake endpoint/auth and enabling reporting.
- Maintainer-side intake service and promotion bot — specified as a contract here; implemented
  outside the client engine (separate deployable), so no client GitHub-write scope is added.
- Docs: consent, collected/excluded fields, retention, disablement, and how to inspect submitted reports.
- **No changes** to the merge surface, review layer, or any autonomous issue-creation path.

## Acceptance Criteria

- [ ] `product_fault` has a versioned schema (`schema_version`), a stable bounded fingerprint, an
  explicit classifier rationale string, and a confidence level; a test proves its record shape and
  its separation from `correction_event`, `papercut`, target-repo failures, and environment/auth
  failures.
- [ ] Default behavior performs **no** network reporting and creates **no** GitHub issue; a test
  proves `pipeline report` is inert (no network, no `gh` write) when the `product_fault` config is
  absent or disabled.
- [ ] `pipeline report` renders the exact sanitized payload byte-for-byte before any submission,
  requires an explicit operator confirmation to submit, and writes a local consent/audit record of
  what was shown and what was sent.
- [ ] Redaction is allowlist-based; tests prove repository names, filesystem paths, issue/PR
  content, prompts/model output, source snippets, environment values, and common secret forms
  (tokens, keys, `KEY=value` pairs) cannot enter the payload — including when they appear inside an
  error message or fingerprint input.
- [ ] The intake contract authenticates submissions without requiring broad GitHub permissions on
  client machines, rejects malformed/oversized/unknown-schema payloads, rate-limits per source,
  deduplicates by stable fingerprint, and supports retention/deletion policy enforcement.
- [ ] Issue promotion creates or updates exactly **one** GitHub issue per stable fingerprint and
  includes only sanitized aggregate evidence (affected versions, anonymous report counts) — never
  client-submitted free text.
- [ ] Low-confidence classifications stay local/manual; the client never asserts a Pipeline defect
  solely because a command exited non-zero — a test proves a non-zero exit with no defect signal
  produces no `product_fault`.
- [ ] The manual fallback opens a prefilled browser/CLI issue draft but requires the operator to
  review and submit it; the client itself performs no upstream issue creation.
- [ ] Background/opt-in automatic reporting is specified as a later phase, explicitly gated on
  measured classifier precision and a reviewed privacy/security threat model; no requirement in this
  change enables it by default.
- [ ] Documentation explains consent, the collected/excluded field lists, retention, how to disable
  reporting, and how to inspect a submitted report.
