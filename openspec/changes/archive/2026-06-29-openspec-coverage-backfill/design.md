## Context

The pipeline CLI has a well-established pattern for no-issue-number sub-commands: a positional keyword is detected early in the dispatch block (`isReleaseCommand`, `isIntakeCommand`, `isSweepCommand`, …), a dedicated `stages/<name>.ts` handler is imported and called, and all external I/O is injectable via a `<Name>Deps` interface (`ReleaseDeps`, `IntakeDeps`, `SweepDeps`). `openspec.ts` already exposes the read-only primitives backfill needs: `isInitialized`, `isActive`, `listChangeDirs`, living-spec reads, and `validate`. The forward OpenSpec flow (`openspec-integration`) specs each *new* change; nothing closes the *backward* gap for behavior that predates adoption. `backfill` is the maintenance counterpart — it reads accepted behavior, compares it to the living contract, and (on opt-in) proposes additive coverage as a reviewable, OpenSpec-native change.

## Goals / Non-Goals

**Goals:**
- Add `backfill` as a no-issue-number sub-command using the existing dispatch + injectable-deps patterns.
- Make the *preview* the safe default: a non-mutating coverage report that never writes a spec, issue, branch, or PR.
- Classify candidate legacy behavior into four evidence-graded groups and attach provenance to every candidate.
- On `--apply`, emit additive coverage as an OpenSpec **change** (deltas), validated before a PR is opened, so the existing per-change/archive flow remains the single mechanism that folds specs into the living contract.
- Keep the model-invoking boundary to the behavior-analysis / candidate-drafting step so coverage comparison, file authoring, validation, and PR creation are deterministic and unit-testable.

**Non-Goals:**
- Changing application code while backfilling specs.
- Declaring every observed behavior to be desired product behavior.
- Rewriting existing GitHub issue bodies (that is `sweep`'s job).
- Replacing the normal per-change OpenSpec planning/archive flow — backfill *uses* it (authors a change, opens a PR; a human merges and the existing archive step lands it).
- Creating a permanent external knowledge store for repository behavior.
- Auto-merging or approving spec-backfill PRs, or guaranteeing complete historical coverage in one run.

## Decisions

**Decision: preview is the default; `--apply` is the only mutating mode.**
Mirrors `sweep`'s preview-by-default / `--apply`-to-write contract, but backfill needs no separate `--dry-run` flag because the absence of `--apply` *is* the preview. The preview report ends with an explicit "no specs, issues, branches, or PRs were changed" line so the non-mutation is verifiable, not implied. (`--apply` without a resolvable slice is a usage error, not a silent no-op.)

**Decision: coverage is computed from living-spec *content*, never from workspace presence.**
The central safety property for partial adoption. `isInitialized` (does `openspec/` exist) gates *activation* but MUST NOT be read as "covered." Backfill enumerates candidate accepted behaviors and, for each, decides covered/missing by matching against the *requirements present in living specs* — so a repo with an `openspec/` directory and three specs is still reported as missing the behaviors those three specs don't describe. Absent and empty workspaces are handled the same way (zero living requirements → everything is a candidate).

**Decision: four evidence-graded groups; only "missing-coverage" with sufficient, non-conflicting evidence is eligible for the living specs.**
- *already-covered* — the behavior maps to an existing living requirement; no action.
- *missing-coverage* — accepted behavior with sufficient, non-conflicting provenance and no existing requirement; eligible to be proposed.
- *conflicting-evidence* — the candidate contradicts an existing living requirement, or evidence sources disagree; never auto-written, surfaced for human decision.
- *uncertain-evidence* — provenance is too weak to justify codifying; never auto-written, surfaced for human decision.
This is the mechanism that prevents "automatically declaring every observed behavior to be desired product behavior." The bar to enter the living specs is *sufficient, non-conflicting evidence* — everything else routes to a human.

**Decision: provenance is mandatory and concrete.**
Each candidate carries (a) the user-visible behavior it describes and (b) ≥1 concrete provenance reference — a test file, a documentation/README section, a code path, or merged history — that demonstrates the behavior is *accepted*, not accidental. Provenance is what a reviewer reads to distinguish intentional product behavior from an implementation detail; a candidate with no concrete provenance is `uncertain-evidence` by construction, not `missing-coverage`.

**Decision: apply authors an OpenSpec change (deltas), it does not write living specs directly.**
This respects the "don't replace the per-change/archive flow" non-goal and reuses the reviewable unit the rest of the pipeline already understands. `--apply` writes `openspec/changes/<backfill-id>/` containing `proposal.md`, `tasks.md` (trivial — "review and merge this backfill slice"), and `## ADDED Requirements` spec deltas for the selected slice. The living specs change only when a human merges the PR and the existing archive step runs. This also gives a free, well-understood diff surface: the PR shows exactly which requirements are being added.

**Decision: distinguish accepted-existing from new-intended via an explicit annotation.**
Each backfilled requirement carries a marker (a leading provenance/`Backfilled:` note in the requirement body) recording that it codifies *pre-existing accepted behavior* and citing its evidence. Forward-looking requirements added by the normal flow have no such marker. The annotation survives archive into the living specs, so the contract itself remains legible about which lines were backfilled.

**Decision: validate before the PR, not after.**
"Validates the resulting workspace before reporting success" is realized by running `openspec validate` on the authored change *in the worktree* before opening any PR. A structurally invalid slice never becomes a PR; it aborts with an actionable blocker that names the validation failure. This mirrors how planning already gates a change on `openspec validate` before advancing.

**Decision: spec-only guard on the apply diff.**
Because backfill must not change application behavior, the apply path asserts that the slice's diff touches only paths under `openspec/`. If any non-`openspec/` path would change, it aborts before opening the PR. This makes "without changing application behavior" a checked invariant, not a hope.

**Decision: idempotency = recognize behavior already in living specs *or* already in an open backfill PR.**
A re-run compares candidates against both the living specs and any open backfill change/PR for the repo. A behavior whose requirement already landed reads as already-covered; a behavior already proposed but not yet merged reads as already-proposed (skipped, not re-proposed). Both paths produce no duplicate requirement.

**Decision: single model boundary.**
Following `intake`/`sweep`: the behavior-analysis / candidate-drafting step (enumerate candidate behaviors, draft requirement text, grade evidence, attach provenance) is the model-invoking part. Coverage comparison against living specs, group assignment from the graded evidence, file authoring, `openspec validate`, the spec-only guard, and PR creation are deterministic given the drafted candidates — so the bulk of the logic is unit-testable without a model.

**Decision: injectable deps seam covers all external calls.**
`BackfillDeps` injects `runHarness` (model), living-spec/workspace reads, `validate`, `writeFile`, `gitCreateBranch`, `gitCommit`, `createPR`, and `log`. Production builds `realBackfillDeps()`; tests supply fakes. No network, git, or subprocess in unit tests — matching `ReleaseDeps`/`IntakeDeps`/`SweepDeps`.

## Risks / Trade-offs

- *Candidate quality depends on evidence quality.* A repo with thin tests/docs yields mostly `uncertain-evidence`. That is the intended behavior — backfill reports the gap rather than guessing. The preview lets a maintainer inspect before applying anything.
- *Over-eager "missing-coverage."* A behavior the maintainer considers an accident could be drafted as missing-coverage. Mitigation: the apply path is opt-in, scoped (`--capability`), spec-only, and lands as a reviewable PR a human must merge — the human is the final gate on "is this desired product behavior."
- *Living-spec false matches.* The covered/missing decision could mis-match a candidate to an unrelated requirement. Mitigation: provenance is shown in the report so a maintainer can audit each already-covered classification; conservative matching prefers reporting missing over silently swallowing a candidate.
- *Idempotency drift if requirement text is re-drafted.* If a re-run re-words a previously-proposed requirement, naive text matching could fail to recognize it. Mitigation: recognition keys on the behavior identity / provenance, not on verbatim requirement prose, so a re-worded draft of the same behavior still de-duplicates.
- *Repo scale.* A large repo can surface many candidates. Mitigation: the report is grouped and counted with a "what to review next" summary, and `--capability` scopes both preview and apply to one capability so slices stay small and reviewable.
