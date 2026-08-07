## Why

The eval isolation narrative and fixture corpus both over-claim. Fixtures pin a `base_commit` that may be absent from operator clones (and shallow CI checkouts), turning every cell into a permanent `infra_error` before any model work. `EvalGhSurface` is constructed and typed through the cell path but never injected into real harness children — only unit tests exercise it — while docs and specs can be read as guaranteeing stronger “no production GitHub write” protection than PATH + credential strip + command-boundary actually provide. The 2026-07-28 campaign also showed runnable-looking fixtures that fail for wrong test roots, missing cell bootstrap, incomplete `allowed_change_paths` (missing generator-owned `plugin/` mirrors), or seeded defects already fixed at the pinned base. Without a fixture-integrity preflight classified as infrastructure, those failures waste provider spend and pollute quality statistics.

This change bridges shipped #607 (PATH/contract isolation) and deferred #618 (OS-level sandbox on v2.0.0) by making fixtures preflight-honest and isolation language match enforcement.

## What Changes

- **Fixture base_commit object reachability.** A doctor-style and/or CI gate verifies every committed fixture’s full `base_commit` SHA is a reachable git object in the operator/CI clone (or the fixture/corpus documents an explicit fetch/bootstrap that materializes it before cells run). Missing objects fail the gate with the fixture id and SHA named — they do not become silent per-cell infra noise after provider spend.
- **Fixture integrity preflight beyond the SHA.** Extend preflight so it exercises fixtures under the same cwd, dependency/bootstrap surface, sandbox, and generator policy as a real cell: command/path resolution (e.g. `core/test/...` vs root `test/...`), public baseline health at the pin, seeded hidden probes that actually fail at the pin, and `allowed_change_paths` that admit generator-owned `plugin/` outputs when public checks require mirror regen. Stale or non-biting fixtures are marked invalid before experiment execution.
- **`EvalGhSurface` disposition (wire or reword — not both half-done).** Either wire the evaluation-mode GitHub surface into every real in-process stage path that can call mutating `gh` helpers, **or** remove dead type plumbing and reword specs/tests so they no longer claim production-write protection via that surface for local-CLI harness children. The process boundary (deny shim + credential strip) remains the enforcement for external CLIs.
- **Honest isolation docs and specs.** Document isolation as a **validity fence for cooperative agents** (confused-agent prevention), not multi-tenant security against a hostile process. Absolute-path escapes and OS sandbox remain out of scope (#618).
- **Smoke-only corpus labeling.** Fixtures with empty `grader_refs` are explicitly labeled smoke-only (field or equivalent contract mark) so they are not mistaken for graded quality measurements.
- **Infrastructure vs quality classification.** Diagnostic/preflight attempts and fixture-integrity failures remain visibly classified as infrastructure (`infra_error` / gate failure) and SHALL NOT be pooled into quality or model-comparison statistics.

Out of scope: OS-level UID/namespace sandbox (#618, v2.0.0); full production-stage prompt fidelity for all stages; re-running historical eval campaigns.

## Acceptance Criteria

- [ ] Every committed fixture under `core/evals/fixtures/` has a `base_commit` that is a reachable git object in a full clone used by CI (or documents an explicit bootstrap that materializes the object before cells run); a missing object fails a named doctor/CI check with fixture id and SHA.
- [ ] Fixture integrity preflight (doctor and/or eval-run gate) fails a fixture whose public checks reference unresolvable paths under the cell-like cwd, whose cell bootstrap surface required by those checks is absent, or whose `allowed_change_paths` omit generator-owned `plugin/` paths required when public checks regenerate the mirror.
- [ ] For fixtures that declare seeded defects or hidden probes intended to bite, preflight proves the public baseline is healthy at the pin and the seeded/hidden probe fails at the pin; a non-biting or already-fixed seed fails the gate naming the fixture.
- [ ] Empty-`grader_refs` fixtures are explicitly marked smoke-only in the fixture contract and are distinguishable from graded fixtures by loaders/reporting without reading docs alone.
- [ ] Specs, SKILL docs, and tests state isolation as a cooperative-agent validity fence; they do not claim multi-tenant or hostile-agent security beyond PATH/credential/command-boundary enforcement.
- [ ] `EvalGhSurface` is either (a) invoked on every real in-process mutating `gh` call path used by eval execution, with a regression test proving a refused write is recorded, or (b) removed/reworded so no test or living requirement claims harness-child production-write protection via that surface alone.
- [ ] Fixture preflight and integrity failures are classified as infrastructure (gate fail / `infra_error`) and never contribute to graded quality aggregates or comparative model scores.
- [ ] `npm run ci` is green; if `core/` changes, `plugin/` is regenerated in the same change.

## Capabilities

### New Capabilities

- `eval-fixture-preflight`: doctor/CI/eval-run integrity gate that proves each committed fixture is object-reachable and cell-runnable (path resolution, bootstrap surface, baseline health, biting probes, generator-owned allowed outputs) and classifies failures as infrastructure before provider spend.

### Modified Capabilities

- `eval-fixture-contract`: require reachable `base_commit` policy (or documented bootstrap); admit explicit smoke-only labeling for empty `grader_refs`; align allowed-change / generator-path expectations with preflight.
- `eval-agent-isolation-boundary`: restate threat model as cooperative validity fence; clarify that process boundary + credential strip — not `EvalGhSurface` injection into harness children — is the local-CLI write denial path; dispose of ornamental surface claims.
- `stage-eval-runner`: align “no production GitHub writes” requirements with actual enforcement layers; require fixture integrity preflight before experiment cell execution when fixtures are referenced; keep preflight/infra failures out of quality pools.

## Impact

- `core/evals/fixtures/*.json` — smoke-only marks; possible `allowed_change_paths` / path / seed fixes for corpus integrity.
- `core/scripts/evals/fixture.ts`, `types.ts` — contract fields (smoke-only), validation hooks.
- `core/scripts/evals/gh-eval-surface.ts`, `executor.ts`, `paired-loop.ts` — wire or delete/reword `EvalGhSurface` plumbing on real paths.
- `core/scripts/evals/run.ts` / doctor integration — preflight gate entry points; infra classification.
- New or extended preflight module under `core/scripts/evals/` (and/or doctor check registration).
- `core/test/*evals*` — regression tests for reachability validation (injected git seam), smoke-only labeling, surface disposition, preflight infra classification; no live model calls in unit tests.
- Living specs under `openspec/specs/{eval-fixture-contract,eval-agent-isolation-boundary,stage-eval-runner}/` after archive; host SKILL.md isolation wording if regenerated from core/docs sources.
- Related issues: #618 (OS isolation, out of scope), #606, #607 (closed), #600–#604.
