## Context

See proposal.md for motivation (#691). Today verifier-related identity is partial and split:

| Surface | What is pinned today | Gap |
|---|---|---|
| Engine prompts | Process-start template snapshot + `templates_fingerprint` (#450) | Mid-run drift is disclosed fail-soft; does not rebind or block readiness |
| Engine install | `engine-identity` version/root/fingerprint; factory production pin (#762 track) | Dogfood candidate engine can still be the judge of its own PR |
| Review policy | Effective `review_policy` in config / severity policy digests | Candidate can change `.github/pipeline.yml` policy used for the same PR |
| Tester gates | `config_digest`, command identity | Candidate can rewrite gate scripts/commands judged against itself |
| `evidence_subject` (#692) | `verifier_fingerprint` reserved | No single module defines path classes or trusted revision sources |
| Eval / visual / shipcheck | Family-local rubrics/config | No cross-family “candidate cannot weaken its rubric” invariant |
| Ownership / authority | Merge authority is structural (not config); other ownership maps scattered | No unified sensitive-class for authority mappings |

Related but distinct: #646 Tester SHA pin, #692 subject identity, #618 isolation (non-goal), #575 human authority (policy-bound humans — not this change).

Product boundary: **Agent Pipeline computes** the trusted-surface decision. Project Warrant may display and refuse dossiers that lack or mismatch it; Warrant MUST NOT invent or repair the decision.

## Goals / Non-Goals

**Goals:**

- One versioned path-class registry and resolution algorithm shared by dogfood and target repos.
- Deterministic decision enum: `passthrough` | `rebound` | `blocked`.
- Effective verifier identity (content hash + source metadata) that feeds `verifier_fingerprint` and run evidence.
- Fail closed when a required trusted revision cannot be resolved.
- Mid-run effective-surface change invalidates affected readiness evidence.
- Explicit non-regression for untouched product PRs.

**Non-Goals:**

- Sandboxing every harness command or OS tamper-proofing (#618).
- Warrant UI or decision recomputation.
- Treating all repository files as sensitive.
- Replacing engine template snapshot isolation or factory production pin — compose with them.
- Allowing repository config to shrink built-in sensitive classes.

## Decisions

### 1. Path classes are engine-versioned, not candidate-authored

**Decision:** Define a versioned integer `path_class_schema_version` (start at `1`) and a fixed set of built-in classes:

| Class id | Examples (illustrative globs / roots) | Trusted source priority |
|---|---|---|
| `engine_core` | Installed engine root: `core/scripts/**`, packaged prompts, review schema, policy modules shipped with the skill | **Installed engine** process pin (running skill / package), never the candidate worktree for dogfood judging of that same candidate |
| `engine_prompts` | Prompt templates under the engine prompts snapshot | Same as engine process pin / template snapshot |
| `repo_policy` | `.github/pipeline.yml` and documented pipeline config includes | Integration **base ref** blob for that path (or last known good policy pin); candidate may propose changes but judging of the candidate uses trusted revision unless rebound is explicit |
| `gate_commands` | Configured test/build/shipcheck command scripts and gate command identity material referenced by config | Base ref (or installed defaults) for script paths; command identity from trusted config resolution |
| `evidence_schemas` | Evidence JSON schemas / producer contracts that define pass shape | Engine-shipped schemas + base-ref repo schemas when repo-owned |
| `eval_rubrics` | Eval grader rubrics, visual/shipcheck rubric files declared by config | Base ref for repo-owned; engine pin for engine-shipped |
| `ownership_authority` | Ownership maps, CODEOWNERS-like pipeline maps, authority mapping files the engine consults for who may override / own stages (not merge grants in repo config — those remain rejected) | Base ref or engine defaults |

Built-in classes and default globs live in engine code (typed constants + tests). Repository config MAY **add** globs under an optional `trusted_surface.extra_paths` (or equivalent) block that only **extends** coverage. Repository config MUST NOT delete or disable a built-in class.

**Why:** The candidate must not author the rules for which of its own files are sensitive.

**Alternatives:** Fully config-driven classes — rejected (self-weakening). Every file sensitive — rejected (non-goal; too broad).

### 2. Decision taxonomy

**Decision:** Exactly one top-level outcome per evaluation:

- **`passthrough`** — candidate changed-path set intersects no sensitive class; effective verifier identity equals the pre-existing trusted resolution (installed engine + base policy). Ordinary product PRs.
- **`rebound`** — candidate touches one or more sensitive paths, but a trusted revision for each touched class was resolved and the run **explicitly** binds judging to that trusted surface (not the candidate’s weakened copy). Triggering paths and hashes are recorded. Use when the change can still be judged safely against the prior/trusted surface (e.g. policy edit judged under base policy; engine dogfood judged under installed pin / base).
- **`blocked`** — cannot resolve trusted revision for a required touched class; resolution conflict; integrity failure; or policy that forbids rebound for that class/context (e.g. certain authority maps). Fail closed; do not invent a surface from candidate-only content.

When multiple classes are touched, the aggregate outcome is `blocked` if any required class is blocked; else `rebound` if any class rebounds; else `passthrough`.

**Why:** Matches the issue contract and makes silent self-judging impossible.

**Alternatives:** Auto-approve rebound always — rejected (some cases must block). Soft-warn only — rejected (not fail-safe).

### 3. Trusted revision resolution algorithm

**Decision:** Pure function over injectable inputs:

```
inputs: candidate_paths, candidate_sha, base_sha, base_tree_reader,
        installed_engine_identity, path_class_registry, optional_extra_globs
for each class C:
  trusted_rev[C] = resolve_source(C)  // engine pin | base blob | engine-default
  candidate_rev[C] = if any path in C ∩ candidate_paths then candidate blob set else null
decision = classify(intersections, trusted_rev completeness)
effective_hash = hash(sorted class_id → trusted content digest)
```

- **Engine classes:** trusted content = running process pin (engine-identity + template snapshot), not the worktree under test when that worktree is the dogfood candidate.
- **Repo classes:** trusted content = blobs at `base_sha` (integration base) for intersecting paths; if path is newly added on candidate, trusted side may be “absent at base” with documented rebound rules (judge under absence/defaults, not under candidate-only new policy that weakens gates).
- **Missing base blob / unreadable engine pin for a required class** → class resolution failure → contribute to `blocked`.

No harness prose or model JSON may supply trusted revisions.

**Why:** Deterministic, testable, aligns with base-ref and installed-engine authorities already used elsewhere.

### 4. Effective verifier identity and evidence_subject

**Decision:** The decision record includes:

- `schema_version`
- `outcome` (`passthrough` | `rebound` | `blocked`)
- `path_class_schema_version`
- `candidate_sha`, `base_sha`
- `triggering_paths[]` (empty on passthrough)
- `classes[]`: `{ class_id, trusted_source, trusted_content_hash, candidate_content_hash | null, status }`
- `effective_verifier_hash` — stable digest over the trusted content map used for judging
- `reason` — short machine-oriented reason code + human summary

`evidence_subject.verifier_fingerprint` for readiness producers on this run SHALL equal or be a documented pure derivation of `effective_verifier_hash` (plus family-local surface material when a family has an extra verifier slice). When outcome is `blocked`, readiness producers MUST NOT claim a successful subject match that implies a trustworthy verifier pin.

**Why:** #692 reserved the field; this change fills the authoritative source.

### 5. When to evaluate

**Decision:**

1. **Run start / first readiness-relevant gate:** compute and durable-persist the decision for `(candidate_sha, base_sha, path_class_schema_version, engine pin)`.
2. **Head advance:** recompute when product `candidate_sha` changes; prior decision for old SHA is non-authoritative for the new head.
3. **Stage boundaries (mid-run):** re-probe installed engine identity / template fingerprint as today; if effective engine-class trusted material drifts relative to the pinned decision, mark engine-class surface changed, emit diagnostic, and **invalidate** readiness evidence bound to the prior `effective_verifier_hash` (stronger than today’s fail-soft-only drift disclosure for evidence currency — the run may continue only after regeneration under the new pin or block per policy).
4. **Do not** re-read candidate worktree files as trusted mid-stage for classes already bound.

**Why:** Issue requires mid-run invalidation; composes with existing engine drift detection without reloading untrusted candidate as judge.

### 6. Dogfood vs target repository

**Decision:** Same algorithm; different dominant classes:

- **Target product repo:** typically `repo_policy`, `gate_commands`, rubrics, ownership; engine classes usually passthrough (installed skill unchanged).
- **Agent Pipeline dogfood:** `engine_core` / `engine_prompts` frequently rebound to the **installed/pinned** engine while the candidate worktree implements the change; unit/integration tests still run against the candidate tree for product correctness, but **judging rules** (prompts, review schema, severity policy defaults shipped in engine) come from the trusted pin unless an explicit operator-authorized evaluation mode is documented later (out of scope for v1 — v1 dogfood = rebound to pin or blocked).

**Why:** Prevents “PR that deletes the review gate is judged by the deleted gate.”

### 7. Evidence bundle and Warrant

**Decision:** Persist the full decision object under a stable key (e.g. `trusted_surface` on `summary.json` / run evidence). Bundle diagnostics MAY reference `effective_verifier_hash` alongside subject diagnostics. Warrant reads only; no recompute.

### 8. Configuration surface

**Decision:** Optional additive config only:

```yaml
# illustrative — exact keys fixed at implement time within schema tests
trusted_surface:
  extra_paths:
    - class: eval_rubrics
      globs: ["qa/rubrics/**"]
```

Unknown keys fail strict schema validation. No `disable_classes`, no `use_candidate_as_trusted`.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| False `rebound` noise on unrelated path globs | Tight built-in globs; unit tests for path classification; passthrough baseline suite |
| Dogfood cannot land engine changes because always blocked | Rebound to installed pin for judging; candidate still builds/tests itself; promotion/install remains separate (#762) |
| Base ref unavailable offline | Fail closed `blocked` with clear reason; inject base reader in tests |
| Over-invalidation on cosmetic template edits mid-run | Invalidation keyed to `effective_verifier_hash` / engine fingerprint change only when content hash changes |
| Config attempts to shrink classes | Schema rejects disable keys; tests for reject |
| Scope creep into full isolation | Spec non-goals; no command sandbox in this change |
| Dual authority between old fingerprints and new decision | Producers must keep `verifier_fingerprint` consistent; tests assert equality/derivation |

## Migration Plan

1. Ship path-class registry + pure resolve/decide helpers + unit tests (no behavior change if not wired).
2. Wire decision at run start; record on bundle; `passthrough` path preserves prior judging sources.
3. Bind `verifier_fingerprint` derivation; enforce rebound/block at readiness-relevant gates.
4. Mid-run invalidation for effective hash drift.
5. Dogfood + target-repo regression matrices.
6. Rollback: stop wiring enforcement; keep helpers inert — or feature-gate only if needed (prefer always-on passthrough-safe default).

## Open Questions

None that block specs or tasks. Exact YAML key names, glob lists, and reason-code enum strings may be fixed at implementation time if deterministic, schema-validated, and covered by tests matching the decisions above.
