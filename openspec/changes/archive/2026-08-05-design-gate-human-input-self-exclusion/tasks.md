## 1. Inventory and gap audit

- [x] 1.1 Audit every design-gate issue/PR comment post site under `core/scripts/` (stage handler, helpers, punch-list / needs-human paths) and list the exact renderers that produce `## Design Interrogation` bodies.
  - **Result:** All design-gate issue comments post via a single renderer: `buildDesignGateComment` in `core/scripts/stages/design_gate.ts` (progress, resolution, punch-list / needs-human, decision-record, and failure notes). No other path emits `## Design Interrogation`.
- [x] 1.2 Compare living code against this change's requirements: `PIPELINE_COMMENT_HEADERS`, `PIPELINE_SENTINEL_MARKERS` / attest markers, `PIPELINE_COMMENT_KINDS` membership for `design-interrogation`, `buildDesignGateComment` (or equivalent) attestation order, `isVerifiedDesignGateOutput` / `isVerifiedPipelineOutput` composition, and `findUnacknowledgedComments` self-exclusion. Record residual gaps only (do not re-implement already-correct paths).
  - **Residual gaps closed by this change:** living OpenSpec deltas (already authored); unit coverage for `classifyComment("## Design Interrogation")`, genuine human after design-gate, and non-trusted forged design-gate body. Engine paths were already correct on main (`## Design Interrogation` header, `design-interrogation` registry kind, `attestPipelineComment` after `design-gate-state`, `isVerifiedDesignGateOutput` recovery, `findUnacknowledgedComments` verified-output self-exclusion). Intentionally **not** adding `design-gate-state` to `PIPELINE_SENTINEL_MARKERS` (forgeable-substring trust is out of scope; verification is the durable-state contract).

## 2. Classification inventory

- [x] 2.1 Ensure `classifyComment` returns `pipeline` for bodies that start with `## Design Interrogation` (header inventory includes the design-gate heading).
- [x] 2.2 Ensure bodies carrying a terminal `pipeline-attest` marker classify as `pipeline` (existing #471 sentinel path), and document that design-gate durable-state verification is a verification concern, not a substitute for forgeable substring trust.

## 3. Verified-output contract for design-gate posts

- [x] 3.1 Register comment kind `design-interrogation` in `PIPELINE_COMMENT_KINDS` with heading `## Design Interrogation` and `verify: "pipeline-attest"` if missing.
- [x] 3.2 Ensure the real design-gate progress renderer embeds `design-gate-state` then appends terminal `pipeline-attest` via `attestPipelineComment("design-interrogation", …)` (attest last).
- [x] 3.3 Ensure `isVerifiedPipelineOutput` returns true for (a) valid pipeline-attest bodies and (b) terminal decodable design-gate-state design-interrogation bodies without pipeline-attest (recovery path), and false for non-decodable / non-terminal shapes.
- [x] 3.4 Confirm no other design-gate post path bypasses the attested renderer without a justified registry `exempt` entry.

## 4. Human-input gate self-exclusion

- [x] 4.1 Ensure `findUnacknowledgedComments` returns `[]` for trusted-actor plan → design-gate progress only histories, including challenge prose that matches `NEGATION_PATTERNS`.
- [x] 4.2 Preserve forge resistance: non-trusted authors, non-decodable design-gate-shaped bodies with objection wording, and human text after terminal markers still count as unacknowledged.
- [x] 4.3 Preserve genuine human comments after the plan as unacknowledged (no gate weakening).

## 5. Tests

- [x] 5.1 Unit test: `classifyComment("## Design Interrogation\n…")` → `pipeline`.
- [x] 5.2 Unit test: real design-gate renderer body verifies via `isVerifiedPipelineOutput` and, for a trusted actor after a plan comment, `findUnacknowledgedComments` → `[]`.
- [x] 5.3 Unit test: free-form human comment after plan still unacknowledged.
- [x] 5.4 Unit test: terminal decodable design-gate-state without pipeline-attest (stale shape) does not gate when trusted (#784 / #872 recovery).
- [x] 5.5 Unit test: non-decodable design-gate-shaped body with objection wording still gates; human text after terminal design-gate-state still gates.
- [x] 5.6 Confirm registry behavioral drift guard covers `design-interrogation` (or extend it if the kind was missing).

## 6. Docs and packaging

- [x] 6.1 Keep living OpenSpec deltas in this change as the source of truth; no need to hand-edit archived living specs until pre-merge archive.
- [x] 6.2 If `core/` changes, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
  - Test-only `core/test/` edits do not require a plugin mirror regen; re-check if any `core/scripts/` source changes.
- [x] 6.3 Run `npm run ci` from the repo root and fix failures until green.
