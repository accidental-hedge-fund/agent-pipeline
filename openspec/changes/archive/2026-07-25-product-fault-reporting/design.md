## Context

Issue #502 is **Blocked** pending an explicit product/privacy decision on the intake service owner,
retention policy, consent UX, and promotion thresholds. This design captures the intended
architecture so that, once those decisions land, implementation can proceed against a reviewed
threat model. It deliberately scopes the first shippable slice to **preview-and-submit only** and
holds background/automatic reporting behind a precision gate.

The guiding constraint: a public Agent Pipeline installation must be able to say "the pipeline
itself looks broken" **without** any autonomous network I/O, without granting the client upstream
issue-creation permission, and without any chance of leaking the operator's repository, prompts,
source, credentials, or environment. GitHub is the *maintainer-facing* destination, reached only
after a maintainer-side clustering step — never the client-side ingestion mechanism.

## Goals / Non-Goals

**Goals**
- A distinct, versioned `product_fault` evidence class with an explicit, auditable classifier.
- Allowlist-based redaction proven by tests, not assertion.
- An operator-driven `pipeline report` that is inert by default and shows the exact payload before submit.
- A maintainer intake + promotion contract that keeps client permissions minimal and issues deduplicated.

**Non-Goals (this change)**
- Capturing chain-of-thought, raw prompts/output, source code, repository identity, or arbitrary logs.
- Granting public installations permission to create upstream issues directly.
- Treating project-local failures or expert corrections as product defects.
- Enabling background telemetry by default (deferred, precision-gated).

## Key Decisions

### 1. `product_fault` is a new, separate evidence class — not an overload of existing events

`correction_event` records *operator corrections of the pipeline's decisions*; `papercut` records
*agent-reported minor friction*; target-repo test/build failures and environment/auth failures are
*the operator's project's problem*. None of these mean "Agent Pipeline is defective." We add a
distinct `product_fault` member to the `RunEvent` union (additive; existing events' `schema_version`
unchanged, following the papercut/correction precedent) so the classes never blur. The classifier
that emits it carries an explicit `rationale` string and a `confidence` level, and a signal that is
*only* a non-zero exit is classified as `low` and never emitted as a defect claim.

**Alternative rejected:** reusing `papercut` with a "severity: product" flag — it would let the
existing opt-in papercut auto-file path (which *does* create issues) promote a product fault into
the operator's own backlog, and would entangle two very different consent models.

### 2. Redaction is allowlist-based, not denylist-based

Denylists leak by omission. The payload is assembled field-by-field from a **fixed allowlist** of
bounded diagnostics: Pipeline version, host adapter, stage name, error *class*/fingerprint, exit
state, and relevant schema versions. Free-form strings that could carry identity (error messages,
stack frames) are reduced to a **fingerprint** (hash of a normalized, path-stripped, token-stripped
error signature) rather than carried verbatim. Every field that reaches the wire passes through the
existing injection screen + secret redaction (`artifact-sanitize.ts`) as a second line of defense,
but correctness rests on the allowlist: if a field is not on the list, it does not exist in the
payload. Tests seed each excluded category (repo name, absolute paths, issue/PR text, prompt/output,
source snippet, `AWS_SECRET…`, `ghp_…`, `KEY=value`) into the classifier inputs and assert the built
payload contains none of them.

### 3. `pipeline report` is default-inert and operator-driven

No config block, or `product_fault.enabled: false` → the command does nothing that touches the
network or `gh` writes. When invoked, the flow is: build payload → **render exact sanitized payload**
→ require explicit confirmation → submit → write a local consent/audit record (timestamp, payload
hash, destination, operator confirmation). The preview is byte-identical to what is sent. There is
no "submit without preview" path.

### 4. Intake keeps client permissions minimal

The client authenticates to the maintainer intake with a **submission-scoped credential** (e.g. a
capability token for the intake endpoint) — **not** a GitHub token and **not** any broad scope on the
operator's machine. The intake is the trust boundary: it validates the schema (rejecting malformed,
oversized, or unknown-version payloads), rate-limits per source, deduplicates by stable fingerprint,
and enforces retention/deletion. Because the client holds no issue-creation permission, a compromised
or malicious client cannot open upstream issues.

### 5. Promotion is maintainer-side and one-issue-per-fingerprint

Only a **high-confidence crash** or a **fingerprint repeated across installations** promotes a
cluster. A maintainer bot (running with the maintainer org's own permissions, outside the client)
opens or updates exactly **one** GitHub issue per stable fingerprint, carrying only sanitized
aggregate evidence: affected Pipeline versions and anonymous report counts. Client-submitted free
text is never copied into the issue. This mirrors the `papercut-auto-file` read-back-and-dedup
discipline (one issue per cluster, lowest-numbered open issue wins) but the authority lives with the
maintainer, not the client.

### 6. Background reporting is a later, gated phase

Automatic/opt-in background reporting multiplies both privacy risk and false-positive noise. It is
specified here only as a **deferred requirement gated on** (a) measured classifier precision above a
reviewed threshold and (b) a signed-off privacy/security threat model. Nothing in the first slice
enables it, and the phase gate is itself a normative requirement so the ordering can't be skipped.

## Reuse

- **Event append + redaction path** (`configurable-event-sink`, `artifact-sanitize`): `product_fault`
  flows through the same `appendEvent`/screening pipeline as every other event.
- **Fingerprint technique** (`stable-finding-identity`): the same "hash a normalized signature,
  truncate to a short stable key" approach yields the bounded cross-installation fingerprint.
- **Opt-in-and-inert config discipline** (`papercuts`, `corrections` blocks in `config.ts`): a strict,
  default-absent `product_fault` block with the same "absent → identical to pre-feature behavior" test.
- **One-issue-per-cluster dedup** (`papercut-auto-file`): promotion's read-back/dedup shape, applied
  maintainer-side.

Kept **separate** from the correction-to-control work (#499–#501): product faults are Pipeline
defects, corrections are operator overrides of Pipeline decisions — different consent, different destination.

## Risks / Open Questions (owned by the product/privacy decision that unblocks #502)

- Intake service owner and hosting (maintainer org vs. third party).
- Retention window and deletion-request mechanics.
- Consent UX wording and where audit records live.
- Exact promotion thresholds (crash confidence bar; cross-installation recurrence count).
- Classifier precision target that unblocks the background-reporting phase.
