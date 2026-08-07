## Context

Eval cells check out an immutable fixture `base_commit`, install a cooperative isolation boundary
(#607: instruction contract + PATH deny shim + credential strip), invoke a local CLI or API
treatment, then grade. Three honesty gaps remain after #607:

1. **Corpus may not be runnable.** Every fixture currently pins
   `b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd`. Schema validation only checks “full 40-char SHA,” not
   object reachability. Shallow clones, partial fetches, and future pins of unpushed commits yield
   permanent worktree `infra_error`s after experiment start. The 2026-07-28 campaign also saw wrong
   test roots (`test/` vs `core/test/`), missing cell bootstrap for `npm run ci`, incomplete
   `allowed_change_paths` (no generator-owned `plugin/` mirrors), and a seeded defect already fixed
   at the pin (non-biting).

2. **`EvalGhSurface` is ornamental on the real CLI path.** `runCell` builds
   `createEvalGhSurface(recorder)` and threads it as `gh:` on `HarnessInvokeArgs` /
   `PairedLoopInput`, but `realInvokeHarness` never passes it into `harness.invoke`, and
   `paired-loop.ts` never calls any surface method. Unit tests in `evals-gh-surface.test.ts` prove
   the class in isolation. Living requirements still lead with “enforced by the evaluation-mode
   GitHub surface,” which overstates protection for local-CLI children.

3. **Docs can be read as multi-tenant security.** Credential strip + PATH shim stop *cooperative*
   confused agents and *ordinary* `gh`/`git`/`pipeline` invocations. They do not stop absolute-path
   escapes, alternate binaries, or hostile multi-tenant isolation (#618). Specs should say so.

This change is intent-only for planning; implementation follows the decisions below.

## Goals / Non-Goals

**Goals:**

- Fail fast on non-runnable fixtures before provider spend, with infrastructure classification.
- Prove base commits are objects (or document an explicit bootstrap that materializes them).
- Align `EvalGhSurface` claims with real call paths (wire in-process **or** reword/delete dead claims).
- Label empty-`grader_refs` fixtures as smoke-only.
- Document isolation as a cooperative validity fence, not OS multi-tenant security.
- Keep unit tests dependency-injected (no live model; git object checks via injectable seams).

**Non-Goals:**

- OS UID/namespace sandbox (#618 / v2.0.0).
- Full production-stage prompt fidelity for all stages.
- Re-scoring historical 2026-07 campaigns.
- Making isolation a security product against hostile agents.
- Autonomous merges or production GitHub writes from eval paths.

## Decisions

### 1. Layered fixture integrity preflight (cheap static → cell-like deep)

**Decision.** Introduce an `eval-fixture-preflight` capability with two tiers:

| Tier | When | What |
|------|------|------|
| **Static** | `pipeline doctor` (model-free) and always before experiment expansion | Schema already covered by loader; **object reachability** of every referenced `base_commit` via injectable `git cat-file -t <sha>` (or equivalent); static path-token sanity on check command strings (e.g. reject bare `test/` roots when the corpus policy is `core/test/`); smoke-only field consistency (empty `grader_refs` ⇔ smoke-only mark). |
| **Deep / cell-like** | Before first treatment of an experiment that references the fixture; optional doctor flag for maintainers | Temporary worktree at the pin using the same layout helpers as `runCell`; same dependency/bootstrap surface public checks assume (e.g. `npm ci` / existing install policy); run **public baseline** (must pass) and **seeded/hidden biting probes** (must fail when declared as ground truth); validate that when public checks regenerate `plugin/`, `allowed_change_paths` includes the corresponding generator-owned paths or an explicit corpus policy documents the exception. |

Both tiers classify failure as **infrastructure** (doctor exit 1 / experiment abort / `infra_error` with a preflight-named reason). Neither invokes a model. Neither contributes scores to quality aggregates.

**Alternatives rejected.** (a) *Only document “fetch this SHA” in README* — operators still burn provider budget when they forget. (b) *Only per-cell worktree failure* — status quo; too late and mixes with real infra noise. (c) *Always deep-preflight every doctor* — too slow for the default model-free doctor path.

### 2. Reachability policy: object present in clone, with optional documented bootstrap

**Decision.** Default policy for committed corpus fixtures: `base_commit` MUST resolve to a git
object of type `commit` in the clone used to run doctor/CI/eval. CI already checks out full history
and tags (`fetch-depth: 0`) for other generators; the reachability check rides that guarantee.

If a future fixture must pin an object not in default history, the fixture (or corpus manifest)
MUST declare an explicit **bootstrap** (e.g. fetch ref/URL) that preflight runs before cells; absent
bootstrap + missing object = hard fail naming fixture id and SHA.

**Alternatives rejected.** Soft-warn and continue — recreates permanent infra_error cells.

### 3. Smoke-only labeling for empty `grader_refs`

**Decision.** Add an explicit fixture field (e.g. `role: "smoke" | "graded"` or
`smoke_only: true`) rather than inferring solely from empty `grader_refs`. Validation rules:

- `grader_refs: []` ⇒ MUST be marked smoke-only.
- Non-empty `grader_refs` ⇒ MUST NOT be smoke-only.
- Loaders and reporting expose the mark so smoke fixtures cannot be silently pooled into graded
  comparative reports.

Corpus migration: mark current empty-`grader_refs` fixtures smoke-only in the same change that
implements the field.

**Alternatives rejected.** Infer-only from empty arrays — easy to misread; no stable API for
reporting.

### 4. `EvalGhSurface` disposition: keep as in-process refuse surface; stop claiming harness-child injection

**Decision.** Prefer **reword + trim dead wiring** over fake “injection” into external CLIs:

1. **Keep** `createEvalGhSurface` / `MUTATING_GH_OPERATIONS` as the unit-testable refuse-and-record
   surface for **evaluator-owned in-process** code that accepts a `gh` dependency seam.
2. **Require** any eval execution path that *does* call mutating helpers in-process to use that
   surface (regression: refused op recorded on boundary evidence).
3. **Do not claim** that the surface is injected into local-CLI harness children. Local-CLI write
   denial remains: PATH deny shim (`boundary-shim`) + credential strip (`isolatedGhEnv`) +
   instruction contract.
4. **Remove or stop threading** unused `gh: EvalGhSurface` through `realInvokeHarness` /
   `HarnessInvokeArgs` / `PairedLoopInput` unless a call site actually invokes it. Dead parameters
   that invite false confidence are worse than a short comment pointing at the real layers.
5. **Update** living specs (`stage-eval-runner` “no production writes”, isolation boundary docs)
   to describe the layered enforcement honestly.

If implementation discovers an in-process stage path that mutates via `gh.ts` without the surface,
**wire** the surface there (still not into the harness child env). That satisfies “wire or delete”
without lying about CLI injection.

**Alternatives rejected.** (a) *Pass `EvalGhSurface` into `harness.invoke` env as JSON* — harnesses
do not call it; theater. (b) *Delete the module entirely* — loses a clean unit-test refuse registry
and a real seam for future in-process e2e stage wiring.

### 5. Isolation language: validity fence for cooperative agents

**Decision.** Specs and operator-facing docs SHALL state:

- Threat model: **confused cooperative agent** following repo workflow docs or ordinary CLI habits.
- Guarantees: ordinary `gh` / `git push|commit|worktree` / `pipeline` on PATH are denied or
  de-credentialed; denials are durable evidence.
- Non-guarantees: absolute-path binaries, custom scripts, multi-tenant hostile isolation, kernel
  namespaces — deferred to #618.

This matches the #607 design non-goal and closes the “docs outrun enforcement” finding.

### 6. Preflight classification and quality isolation

**Decision.** Preflight outcomes use a dedicated reason namespace (e.g.
`fixture_preflight:<check>:<fixture_id>`) and `result_class`/`gate` channels that reporting already
treats as non-quality (`infra_error`, doctor fail, experiment abort). Comparative reporting and
grader entry points MUST ignore preflight-only attempts. A regression test proves a deliberate
preflight failure does not appear in graded quality aggregates.

### 7. Dependency seams for tests

**Decision.** Preflight object checks and deep checks take injectable deps (`catFile`,
`createWorktree`, `runChecks`, `runCommand`) matching `CellExecutionDeps` style. Unit tests never
spawn real git for logic branches they can fake; an optional integration-style test may use the
real repo object for the current corpus pin when the suite runs inside a full clone (document
skip/fail policy if object missing).

## Risks / Trade-offs

- **[Risk] Deep preflight is slow (worktree + `npm run ci` baseline).** → Mitigation: static tier
  always; deep tier only for fixtures referenced by the experiment (or opt-in doctor flag); share
  one worktree per unique `base_commit` within a preflight batch; bound timeouts; prefer targeted
  baseline commands when fixtures declare lighter public checks than full CI.
- **[Risk] Reachability fails on intentional shallow developer clones.** → Mitigation: doctor
  remediation text names the SHA and suggests `git fetch` / full clone; CI already full-history.
- **[Risk] Rewording `EvalGhSurface` looks like a security regression.** → Mitigation: do not
  remove PATH/credential boundary; only remove false claims; keep refuse surface for in-process
  paths; document layered model in specs.
- **[Risk] Smoke-only field is a schema bump.** → Mitigation: small additive field with loader
  defaults derived during migration; reject inconsistent combinations.
- **[Risk] Fixing non-biting seeds changes eval comparability.** → Mitigation: exclude/replace
  broken seeds with new fixture ids rather than silently retargeting graded history; record
  provenance.

## Migration Plan

1. Land OpenSpec change (this proposal/design/specs/tasks).
2. Implement static preflight + smoke-only field; mark corpus smoke fixtures; regenerate plugin if
   core changes.
3. Implement deep preflight for experiment entry; fix corpus path/allowed/plugin/seed issues that
   fail the gate.
4. Apply `EvalGhSurface` disposition (reword specs + trim dead plumbing; wire any real in-process
   mutators found).
5. Update host SKILL / docs isolation wording as part of the same change or docs generator path.
6. Archive OpenSpec at pre-merge; `openspec validate --all` green.

Rollback: revert the change branch; corpus remains no worse than today if preflight is additive.

## Open Questions

- Exact fixture field name for smoke-only (`smoke_only: true` vs `role: "smoke"`) — pick one at
  implementation; specs use the concept “smoke-only mark.”
- Whether deep preflight is a doctor subflag (`--eval-fixtures`) only, or also automatic on
  `pipeline evals run` (recommended: automatic on run, opt-in on doctor for maintainers).
- How aggressively to expand `allowed_change_paths` for plugin mirrors when public check is full
  `npm run ci` (list explicit paths vs glob policy) — prefer explicit paths matching existing
  fixture-contract plugin admission, with preflight verifying listed generator outputs cover the
  check’s regen surface for that fixture’s intended edits.
