## Why

A candidate change can edit the same configuration, prompts, policy, schemas, gate commands, rubrics, or ownership mappings used to judge that change. Agent Pipeline already pins or fingerprints parts of the engine (template snapshot, engine identity, Tester `config_digest`, `evidence_subject.verifier_fingerprint`), but it does not define one explicit invariant covering every verifier-sensitive surface. Without that boundary, a dogfood PR to the engine or a target-repo edit to `.github/pipeline.yml` and related assets can weaken the rules or evidence requirements applied to itself. Issue #691 adopts the Trusted-Surface Rebind invariant (inspired by Cerebe’s pattern, not its product architecture): judge the candidate against a resolved trusted surface, or make any rebind explicit and recorded.

## What Changes

- Define **versioned verifier-sensitive path classes** for: engine and prompt templates; repository policy/configuration; evidence schemas and gate commands; eval/visual/shipcheck rubrics; ownership and authority mappings.
- Resolve a **trusted revision** for each class from the installed engine, integration base ref, or repository-owned policy authority — never solely from untrusted candidate content when that content is under evaluation.
- Emit a structured **trusted-surface decision** for every run: `passthrough`, `rebound`, or `blocked`, with triggering paths, candidate/base revisions, trusted source, effective content hash, and reason.
- **Fail closed** when the trusted surface cannot be resolved or verified for a class that the run’s judging path depends on.
- Bind downstream assurance artifacts (including `evidence_subject.verifier_fingerprint` and evidence-bundle records) to the **effective verifier identity** from that decision.
- Invalidate affected evidence when the effective verifier surface changes mid-run.
- Add dogfood and target-repository regression coverage proving a candidate cannot silently weaken judging rules.
- **Not changing:** sandboxing every command (#618 roadmap), Project Warrant decision logic (Warrant consumes evidence only), merge authority, or treating every repository file as verifier-sensitive. Existing repositories keep current judging behavior when no sensitive path is touched (`passthrough`).

## Acceptance criteria

- [ ] Versioned path-class definitions exist for engine/prompts, repo policy/config, evidence schemas and gate commands, eval/visual/shipcheck rubrics, and ownership/authority mappings; classes are documented and schema-validated where configuration is allowed.
- [ ] For each class, trusted-revision resolution is deterministic given the same installed engine, base ref, and repository-owned policy inputs (injectable deps in unit tests).
- [ ] Every advance/eval run that performs readiness-relevant verification emits exactly one structured trusted-surface decision of `passthrough`, `rebound`, or `blocked`, including triggering paths (if any), candidate and base revisions, trusted source per class, effective content hash(es), and reason.
- [ ] When the candidate does not touch any verifier-sensitive path, decision is `passthrough` and judging uses the same effective surface as before this change (no behavioral regression for ordinary product PRs).
- [ ] When the candidate touches a verifier-sensitive path, decision is `rebound` or `blocked` — never silent use of the candidate-weakened surface as the sole judge for that candidate without recording the rebind.
- [ ] Unresolvable or unverifiable trusted surface for a required class yields `blocked` (or equivalent fail-closed refusal) rather than inventing a trusted revision from the candidate alone.
- [ ] Downstream readiness artifacts and evidence bundles carry the trusted-surface decision and effective verifier identity; `evidence_subject.verifier_fingerprint` (when present) is consistent with that effective identity.
- [ ] Mid-run change to the effective verifier surface invalidates affected evidence families for readiness until regeneration under the new effective identity.
- [ ] Dogfood regression tests prove an Agent Pipeline engine/PR change that weakens judging rules cannot pass readiness while judged only by the weakened candidate surface.
- [ ] Target-repository tests cover candidate edits to `.github/pipeline.yml`, gate scripts, rubrics, schemas, and ownership mappings with expected `rebound` or `blocked` outcomes.
- [ ] Unit tests use dependency seams only (no real network/git/subprocess). `npm run ci` green after implementation; `plugin/` regenerated in the same change if `core/` is edited.

## Capabilities

### New Capabilities

- `trusted-surface-rebind`: Versioned verifier-sensitive path classes; trusted-revision resolution; structured `passthrough` / `rebound` / `blocked` decisions; fail-closed unresolved surfaces; mid-run invalidation; run evidence of effective verifier identity; dogfood and target-repo regression invariants.

### Modified Capabilities

- `evidence-subject`: `verifier_fingerprint` SHALL be derived from (or explicitly bound to) the effective trusted-surface verifier identity when a trusted-surface decision is present for the run.
- `evidence-bundle`: Run summary / diagnostics SHALL record the trusted-surface decision and effective verifier identity so external consumers (including Project Warrant) can see which surface judged the run without recomputing it.
- `pipeline-configuration`: Document and validate any optional repository-owned extensions to path-class coverage; repository config MUST NOT remove built-in verifier-sensitive classes or authorize self-judging under a weakened surface.

## Impact

- **New pure module (expected):** `core/scripts/trusted-surface.ts` (or equivalent) for path classification, trusted resolution, decision emission, and hash construction — injectable in unit tests.
- **Orchestration:** run start / readiness-relevant gate entry records the decision; stage boundaries re-check effective surface when required.
- **Producers/consumers:** evidence-subject builders, Tester/review/readiness composition, evidence-bundle finalize.
- **Config:** optional typed extension points under `.github/pipeline.yml` only for additive class coverage; built-in classes remain engine-defined.
- **Tests:** dogfood weaken-surface fixtures; target-repo sensitive-path matrices; passthrough baseline.
- **Dependents / consumers:** #692 `evidence_subject` field reservation; Project Warrant reads decision evidence and MUST NOT recompute the trusted-surface decision.
- **Out of scope:** OS isolation (#618); moving verification into Warrant; auto-merge; marking all repo files sensitive.
