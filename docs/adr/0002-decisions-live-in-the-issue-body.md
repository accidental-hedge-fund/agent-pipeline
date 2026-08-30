# Decisions live in the issue body; comments are not the spec

Agents, train, and `triage --stage ready` read the **issue body**. `pipeline refine-spec --issue` / `apply` is the grill writer: it embeds a versioned Decisions artifact and a derived `## Decisions` section. `pipeline triage --stage` never edits the body. `--stage ready` is a model-free gate (exit 2, no label flip) that validates that artifact.

A comment does not settle an authority node. Reviewer `accept` on a taxonomy-validated non-authority node is provenance of an automatic default (`settled-by: reviewer-accept`), not operator authority. Scope, security, irreversible operations, merge/release, and human-attestation stay unresolved until an authenticated hash-bound `pipeline handoff answer`.

#1238 owned comments are verdict evidence for the pickup-time issue-implementation-readiness gate. They are not the specification. A successful `--stage ready` label write is not a pickup bypass.

**Considered options:** store the frontier in issue comments (rejected: comments are invisible to train/body readers); interview during planning (rejected: factory must not grill mid-run); put a harness inside every `--stage ready` (rejected: complete bodies stay one deterministic call); overload bare `pipeline triage N` as the grill (rejected: living triage spec requires `--stage`; mixing grill and labels hides mutations).
