## 1. Schema, taxonomy, and fingerprints

- [x] 1.1 Add a versioned Decisions artifact schema (`decisions.v1`; node fields: question, recommendation, class, resolution, provenance, input digests) plus render/parse helpers and the HTML-comment + `pipeline-decisions-v1` fence, and verify a unit test accepts a valid artifact, rejects render divergence, rejects an unknown schema version, and rejects delimiter collisions / duplicate fences
- [x] 1.2 Add the closed authority taxonomy `grill-taxonomy.v1` with operator-required members `scope`, `security`, `irreversible-operations`, `merge-release`, and `human-attestation` and non-authority members `interface-contract`, `test-evidence`, `docs-surface`, and `operational-default`, and verify unknown and disputed classes stay unresolved and cannot record `settled-by: reviewer-accept`
- [x] 1.3 Implement SHA-256 fingerprints (`sha256:` + 64 hex) over title, applied body, dependency closure, integration base, required context, provider configuration, and resolved planning treatment, and verify a unit test treats any bound-input change as stale
- [x] 1.4 Implement the `grill-proposal.v1` HMAC-SHA256 envelope (canonical JSON, 24h TTL, nonce, host-local key, 1 MiB bound), and verify tamper, forged verdicts, expiry, consumed-nonce replay, and unknown schema fail closed with no write

## 2. CLI dispatch, registry, and help

- [x] 2.1 Keep `refine-spec` `needsIssueNumber: false`, add `--issue` and `--proposal-file` to `allowedFlags`, accept positional `apply` only as a sub-verb (not a proposal blob), and verify `pipeline refine-spec --issue 42 --bogus` exits 2 before GitHub writes
- [x] 2.2 Keep `--title/--body` required as a pair when `--issue` is absent, reject mixing `--issue` with `--title` or `--body`, and verify the existing missing-title and missing-body tests still fail closed with no harness call
- [x] 2.3 Update `pipeline refine-spec --help` and top-level help to mention `--title`, `--body`, `--issue`, `apply`, `--proposal-file`, and `--json`, and verify `--help` exits 0 and still mentions `--title` and `--body` for Desk probing
- [x] 2.4 Dispatch `--issue` and `apply` without entering the advance loop or writing stage labels, and verify a fake-driven test records zero stage-label mutations on both paths

## 3. Title/body compatibility

- [x] 3.1 Keep `--title/--body` as one Implementer call, gh-free, canonical-section validation, stdout JSON exactly `{ title, body, milestone }`, and no writes, and verify the existing refine-spec unit tests still pass including mixed-input and unknown-flag paths before config or harness resolution
- [x] 3.2 Keep preview `RefineSpecDeps` without write-capable slots for the `--title/--body` path, and verify a type/test seam still has no `createIssue` / `writeFile` / label helpers

## 4. Issue preview

- [x] 4.1 Fetch current title and body immediately before `--issue` preview, read facts from the trusted integration-base revision, and verify a stale-fixture test is not used as the evaluated text
- [x] 4.2 Walk declared dependencies through the existing grammar and a bounded closure, and verify cycle, missing/inaccessible issue, malformed declaration, and closure-limit exhaustion become typed unresolved facts with no silent truncate
- [x] 4.3 Invoke the resolved Implementer once with `harnesses.implementer`, `models.planning`, and `effort.planning` (including `auto`), then the resolved Reviewer once with the Decisions artifact plus fingerprint only, and verify invoke counts and Reviewer prompt contents with injected harness fakes
- [x] 4.4 Reject Implementer output that marks its own nodes `accept` / `settled-by: reviewer-accept` before the Reviewer call, and verify no GitHub mutation and no Reviewer invoke
- [x] 4.5 Map harness failure, timeout, malformed output, capability refusal, unavailable facts, and input drift to a non-zero exit with no body or label mutation, and verify fake call logs are empty for writes
- [x] 4.6 Emit one bounded signed envelope to stdout (refined body, artifact, reviewer verdicts, fingerprint, advisory title/milestone, mac) and fail closed on size-bound overflow rather than dropping authority nodes, and verify JSON.parse of stdout succeeds on the happy path with exactly one JSON object
- [x] 4.7 Produce a canonical Decisions artifact for a thin issue with unresolved operator-required nodes, and verify `--stage ready` against that applied body exits 2

## 5. Reviewer verdicts and apply

- [x] 5.1 Record per-node `accept` or `challenge` with a reason; on `challenge` keep the node unresolved and copy the challenge text into the proposal, and verify apply of that proposal exits 2 with no body write
- [x] 5.2 On reviewer `accept` of a taxonomy-validated non-authority node, write `settled-by: reviewer-accept` and skip handoff, and verify apply persists that provenance
- [x] 5.3 On reviewer `accept` of an operator-required node, keep the node unresolved, and verify `--stage ready` still exits 2
- [x] 5.4 Implement apply as signed-envelope replay (stdin XOR `--proposal-file`), no model call, MAC/TTL/nonce/issue checks then re-fetch title/body identity, drift/MAC/expiry/replay exit 2, body-only write, and verify title/milestone/labels/comments/files are unchanged
- [x] 5.5 Honor the kill-switch on `apply` writes and not on `--issue` preview, and verify a kill-switch fake blocks apply and still allows preview with zero writes
- [x] 5.6 Reject empty stdin, dual stdin+`--proposal-file`, oversize input, and a positional proposal token with exit 2 and no mutation

## 6. Handoff materialize

- [x] 6.1 Extend handoff create for pre-admission operator-required nodes with a policy-bound grill-authority gate bound to repository, issue, node ID, frontier fingerprint, and source body hash, omit `candidate_sha` when no tip exists, and verify mid-flight HDR create without reviewed SHA still fails closed
- [x] 6.2 Materialize `pipeline handoff answer` as a deterministic patch of that node plus provenance and derived render, refuse bound-hash drift with exit 2 while leaving the ledger `pending` and the body unchanged, persist `answered` only after a successful body write, and verify other nodes are unchanged
- [x] 6.5 Create pending grill-authority handoffs on apply after envelope verification and before the body write, idempotent on `declaration_identity`, and verify preview created none
- [x] 6.6 Verify concurrent different-payload answers refuse, same payload/`--client-request-id` is idempotent, and a persist-after-write failure heals on retry without a second body write
- [x] 6.3 Ignore GitHub comments and review comments as settlement, and verify a comment-only fixture leaves the node unresolved and `--stage ready` exits 2
- [x] 6.4 Do not add `pipeline:ready` as a side effect of answer, and verify labels are unchanged after a successful materialize
- [x] 6.7 Require exact live-body SHA-256 match on grill-authority answer (no spec-core fallback), rebind pending sibling handoffs after a successful body write, and verify an artifact-only body edit exits 2 with no write and the handoff still pending

## 7. CONTEXT proposals and ready gate

- [x] 7.1 Include typed CONTEXT proposals in the envelope, never write repository files, classify required vs advisory from the integration-base blob and operator-required `term_id`s (ignore model necessity prose), block `--stage ready` until Pipeline-recorded base/blob hashes match, and verify advisory proposals do not block
- [x] 7.2 Make `--stage ready` re-fetch and validate the artifact with no model: unresolved authority, typed dependency facts, provenance, render identity, required-context hashes, and current fingerprints; exit 2 with no label change on failure; and verify a complete current artifact changes only the stage label
- [x] 7.6 On ready label success, re-fetch and retry one remove pass; persistent extras exit `label_reconciliation_failed` without dropping `pipeline:ready`; validation failure still records zero label-write calls
- [x] 7.3 Keep `--stage backlog` as a label write with no artifact requirement, and verify existing backlog triage tests still pass
- [x] 7.4 Re-validate `--stage ready` even when `pipeline:ready` is already the only stage label, and verify a stale already-ready issue exits 2 without label writes
- [x] 7.5 Keep pickup on the shared #1238 gate after a successful ready label write, and verify a fake pickup still evaluates the fresh body and does not skip because a Decisions artifact is present

## 8. Docs, glossary, packaging, and CI

- [x] 8.1 Rewrite `docs/adr/0002-decisions-live-in-the-issue-body.md` so `refine-spec` is the grill writer, triage never edits the body, reviewer-accept is provenance, and #1238 comments are verdict evidence, and verify the ADR no longer says bare `pipeline triage N` rewrites the body
- [x] 8.2 Update root `CONTEXT.md` glossary for Grill, Decisions, Authority node, and reviewer-accept without turning the file into implementation steps, and verify those terms match the locked taxonomy
- [x] 8.3 After any `core/` edit run `node scripts/build.mjs` and commit regenerated SKILL overlay/catalog in the same change, and verify `node scripts/build.mjs --check` passes
- [x] 8.4 Run `openspec validate grill-then-ready` and `npm run ci` from the repo root, and verify both exit 0
