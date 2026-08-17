## 1. Shared classifier

- [x] 1.1 Export one three-way comment classifier next to `findUnacknowledgedComments` (`pipeline-or-operational` / `operator-scope-change` / `ambiguous-trusted`) and the closed operational-note phrase list from design D3.
- [x] 1.2 Apply D1: trusted-actor registered review/delta heading plus a terminal `review-artifact` or `pipeline-attest` line is `pipeline-or-operational` even when `bodyHash` fails. Human text after the last artifact line is not terminal.
- [x] 1.3 Apply D3: trusted-actor operational notes (grill / ship-halt / don’t-comment) without a product-scope-change clause are `pipeline-or-operational`. A mixed body (`grill locked — please also change X`) is `operator-scope-change`.
- [x] 1.4 Apply D4: trusted-actor registered heading without a terminal artifact is `ambiguous-trusted`, not `operator-scope-change`. Untrusted forged headings stay `operator-scope-change`.
- [x] 1.5 Keep `findUnacknowledgedComments` returning only `operator-scope-change`. Do not loosen `NEGATION_PATTERNS`. Do not change `getGhActor` / `trusted_override_actors` trust. Do not edit the #1098 hash-after-banner bind.

## 2. Call sites

- [x] 2.1 In `review-routing.ts`, if `operator-scope-change` is non-empty: keep the existing warning + `setBlocked(..., "needs-human")`. If only `ambiguous-trusted` remains: do not use `needs-human`; start in-engine re-plan or `setBlocked` with a recover-class kind that projects to `workflow-engine-defect` (D5).
- [x] 2.2 Apply the same branch in `fix.ts`. No third copy of the predicate.
- [x] 2.3 Leave `pipeline unblock` / operator-surface acknowledgement anchors unchanged.

## 3. Tests

- [x] 3.1 Review-2-shaped body with `instead` + valid matching `review-artifact` → `findUnacknowledgedComments` returns [].
- [x] 3.2 Review-2-shaped body with `instead` + terminal `review-artifact` + invalid `bodyHash`, trusted `gh` actor → not unacknowledged and does not `setBlocked` needs-human. Invert or replace `unverified trusted-actor review-shaped body with instead still counts (#1098)`.
- [x] 3.3 Grill / ship-halt / “don’t comment” without `## Pipeline:` after a plan → does not `setBlocked` needs-human.
- [x] 3.4 Plain “please also change X” from a non-pipeline author after the plan → still unacknowledged.
- [x] 3.5 Verified trusted-actor `## Pipeline: Unblocked` still clears a prior real human comment.
- [x] 3.6 Human suffix after the last artifact line still counts. Untrusted forged `## Review N` + copied artifact still counts. Mixed operational + scope-change still counts.
- [x] 3.7 `ambiguous-trusted` does not `setBlocked` needs-human; it starts re-plan or a recover-class block. Same outcome from the fix and review-routing call sites (injected deps).
- [x] 3.8 Tests inject deps. No real network, git, or subprocess.

## 4. Mirror and gate

- [x] 4.1 After `core/` edits, run `node scripts/build.mjs` and commit regenerated `plugin/`.
- [x] 4.2 Run `npm run ci`. Do not claim green until that command exits 0.
