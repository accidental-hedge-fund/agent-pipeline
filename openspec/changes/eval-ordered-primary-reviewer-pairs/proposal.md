## Why

The stage eval runner expands treatments as a Cartesian product of single-role axes
(`harness` × `model` × `effort`). That form cannot truthfully represent the production
question that parent epic #600 must answer: which ordered **primary → reviewer** pair
should own implementation and review. A Cartesian cell has one harness; it cannot hand a
real primary diff to a distinct review harness, cannot attach harness-specific model
names to separate roles without invalid cross-products, and cannot measure fix
convergence across a real review/fix loop. Without ordered pair treatments, harness-pair
selection remains hand-assembled research rather than a controlled experiment.

## What Changes

- **Named ordered-pair treatment form.** Manifests may declare treatments as an explicit
  list of named pairs, each with a stable `id` and per-role coordinates for `primary` and
  `reviewer` (`harness`, `model`, `effort`, and other role-local fields). Cartesian axis
  form remains supported for existing single-role experiments.
- **Mutual-exclusion validation.** A manifest that mixes Cartesian axes with named pairs,
  reuses a pair id, omits a required paired role, or places unknown fields on a role
  coordinate is rejected before any cell runs.
- **Two paired execution modes.**
  - `implementing-paired`: primary implements → reviewer reviews the **actual** primary
    git diff → blocking findings route to primary fix → reviewer re-reviews the resulting
    diff (no fabricated extra review after that).
  - `pipeline-paired`: the deployable graph — planning → independent plan-review →
    primary plan revision → implementation → standard review / fix-1 → adversarial
    review / fix-2 — preserving pipeline.yml slot coupling and reviewer overrides.
- **Live handoffs, not fixture-only review input.** Reviewer stages receive the actual
  plan, plan-review feedback, revised plan, current worktree diff, formatted review-1
  context, and blocking findings produced earlier in the same cell — never a frozen
  synthetic review artifact in place of the primary's output.
- **Production prompt builders and output gates.** Every paired-stage invocation reuses
  production prompt builders and output/verdict gates. Implementation and fix may append
  only an eval-specific no-commit / no-push execution override; no eval-local substitute
  for the production review or planning contracts.
- **Policy, provenance, and isolation.** Production review-policy partitioning applies;
  strict / tolerant / unparseable verdict provenance is reported separately. The eval
  instruction and command boundary stays active for every harness invocation and is
  restored only for clean diff/check collection. All work remains isolated from
  production GitHub writes.
- **Evidence and summary.** Cell and summary records carry pair identity, per-role
  coordinates, whether fix was invoked, blocking findings before/after fix, malformed
  review counts, quality, duration, and reliability. Deterministic implementation
  grading remains applicable to the final paired outcome.
- **Fixture allowance.** Generator-owned `plugin/` mirror paths may appear in fixture
  allowed-change boundaries when core edits require them.
- **Tests.** Fake-backed coverage for no-fix, fix-and-converge, malformed review output,
  preflight/auth failure attribution, routing/overrides, contract gates, isolation,
  no-GitHub-write behavior, and evidence semantics.

## Capabilities

### New Capabilities
- `eval-paired-treatments`: Named ordered primary/reviewer pair treatments; pair-loop and
  pipeline-paired stage graphs; live handoffs; role-attributed failures; pair evidence and
  summary fields.

### Modified Capabilities
- `stage-eval-runner`: Manifest validation and plan expansion accept the named-pair form
  and new modes (`implementing-paired`, `pipeline-paired`); per-cell timeout spans the
  full pair loop; cell identity preserves ordered pair coordinates.
- `eval-agent-isolation-boundary`: Instruction/command boundary remains installed across
  every multi-role harness invocation in a paired cell and is restored only for clean
  evidence collection.
- `eval-fixture-contract`: Fixtures may allow generator-owned plugin mirror paths when a
  core change requires the mirror.
- `eval-graders`: Deterministic implementation grading applies to the final worktree
  state of a paired cell outcome.
- `eval-comparative-reporting`: Summary output includes pair identity and pair-loop
  evidence fields (fix invocation, blocking findings before/after, malformed reviews)
  alongside quality, duration, and reliability.

## Impact

- `core/scripts/evals/types.ts` — named-pair treatment shapes, new modes, pair evidence
  detail fields.
- `core/scripts/evals/manifest.ts` — dual-form validation and pair-aware plan expansion.
- `core/scripts/evals/executor.ts` / `stage-adapters.ts` — multi-role pair loop and
  pipeline-paired graph; production prompt-builder reuse; live handoff plumbing.
- `core/scripts/evals/agent-contract.ts` / `boundary-shim.ts` — boundary lifecycle across
  multi-invocation cells.
- `core/scripts/evals/grading/*` and `reporting/*` — grade and summarize paired outcomes.
- `core/scripts/evals/fixture.ts` — plugin-mirror path allowance.
- `core/test/evals-*.test.ts` — new and extended fake-backed coverage.
- `plugin/` — regenerated mirror after `core/` edits.
- Existing Cartesian manifests and single-stage modes remain valid and unchanged.

## Out of Scope

- Turnkey campaign CLI, capability discovery, baseline fingerprints, and decision
  recommendation reports (#602–#604, #653–#655, #637).
- OpenSpec planning-path fidelity gap beyond what pipeline-paired already requires (#657).
- Automatically writing a chosen pair into production `.github/pipeline.yml`.
- Changing production review policy thresholds, the pipeline never-merges rule, or
  single-role Cartesian eval behavior.

## Acceptance Criteria

- [ ] Manifest validation rejects mixed Cartesian/named forms, duplicate pair IDs,
      missing primary or reviewer roles, and unknown role-coordinate fields, naming the
      offending field and executing no cell.
- [ ] A plan-only expansion of a valid named-pair manifest preserves each pair's `id` and
      exact per-role coordinates (`harness` / `model` / `effort` for primary and reviewer)
      on every planned cell.
- [ ] In `implementing-paired` mode, the reviewer prompt/input includes the actual git
      diff produced by the primary implementation in that cell, not only the fixture's
      frozen review stage-entry artifact.
- [ ] When the first review yields blocking findings under production review-policy
      partitioning, the primary fix stage runs and a second review runs on the post-fix
      diff; when the first review yields no blocking findings, fix is not invoked.
- [ ] Malformed / unparseable review output is recorded with explicit parse provenance
      and is never treated as approval or as a zero-finding pass.
- [ ] The manifest per-cell timeout covers the entire pair loop (all role invocations for
      that cell); a timeout terminates the cell as `timeout`, not as a completed treatment.
- [ ] Authentication or preflight failure on the primary role is attributed to primary;
      the same on the reviewer role is attributed to reviewer; neither is scored as a
      quality outcome.
- [ ] Deterministic implementation grading runs against the final worktree state of a
      completed paired cell and produces the same class of grade records as single-role
      implementing cells.
- [ ] Summary / cell evidence includes pair identity, whether fix was invoked, blocking
      finding counts before and after fix (when applicable), malformed review counts,
      quality, duration, and reliability rates.
- [ ] `pipeline-paired` executes the ordered deployable graph (planning → independent
      plan-review → primary plan revision → implementation → standard review/fix-1 →
      adversarial review/fix-2), reuses production prompt builders and output gates, and
      preserves pipeline.yml slot coupling plus reviewer overrides.
- [ ] Live handoffs pass plan, plan-review feedback, revised plan, current diff,
      formatted review-1 context, and blocking findings between stages of the same cell.
- [ ] The eval instruction and command boundary is active for every harness invocation in
      a paired cell and is restored only for clean diff/check collection.
- [ ] Review-2 / pre-fix-2 findings are labeled separately from the final post-fix-2
      diff; no third review is fabricated after fix-2.
- [ ] Strict / tolerant / unparseable verdict provenance is reported separately for each
      review invocation.
- [ ] Fixtures may include generator-owned `plugin/` mirror paths in allowed-change
      boundaries when core edits require them; validation does not reject those paths
      solely for being under `plugin/`.
- [ ] No paired-cell execution performs a production GitHub write (label, comment, PR,
      push to production branch); denials/refusals are recorded.
- [ ] Tests with injected fakes cover: no-fix happy path, fix-and-converge path,
      malformed review output, primary and reviewer preflight/auth failure, routing and
      overrides, contract gates, isolation boundary, no-write behavior, and pair evidence
      fields — with no live model, network, or real git calls required for those tests.
- [ ] `npm run ci` passes from the repo root after implementation, including
      `build.mjs --check` with a regenerated `plugin/` mirror committed alongside `core/`.
