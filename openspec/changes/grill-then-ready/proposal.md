## Why

Thin or decision-incomplete GitHub issues still reach planning with product choices missing. Planning then invents those choices after execution starts. Operators need a per-issue grill that looks up repository facts, lets the reviewer accept or challenge recommended defaults, and leaves only operator-required authority for a human — while merged #1238 stays an independent pickup-time readiness gate.

## What Changes

- Keep existing `pipeline refine-spec --title/--body` compatible and non-mutating.
- Add `pipeline refine-spec --issue N`: one Implementer planning-treatment call, then one Reviewer call on the Decisions artifact only. Preview writes nothing.
- Add `pipeline refine-spec apply --issue N` with stdin XOR `--proposal-file PATH`: verify the signed preview envelope, write only the issue body, invoke no model. Refuse drift, MAC failure, expiry, replay, oversize/empty/dual input, and any reviewer `challenge` (exit 2).
- Embed a versioned Pipeline-owned Decisions artifact in the issue body. The readable `## Decisions` section is rendered from that artifact; divergence fails validation. The body remains the specification. Comments and handoffs prove provenance; they do not replace the body.
- Closed authority taxonomy. Scope, security, irreversible operations, merge/release, and human-attestation require an authenticated hash-bound `pipeline handoff answer`. Reviewer `accept` is provenance of an automatic non-authority default, not operator authority.
- `pipeline triage N --stage ready` stays model-free. It re-fetches and validates the Decisions artifact. Incomplete or stale artifacts exit 2 with no label change. A valid request changes only the pipeline stage label. Pickup still runs #1238 against fresh GitHub state.
- Typed `CONTEXT.md` proposals may appear in the preview. Refinement never edits repository files. A required context change blocks readiness until a separate reviewed PR lands and its integration-base reference is recorded.
- Reconcile ADR 0002 and `CONTEXT.md` with this command split, #1238 comment-as-evidence, and reviewer-accept provenance. ADR 0002 today says bare `pipeline triage N` rewrites the body; this change supersedes that sentence.

This is a class-level pre-admission grill and deterministic ready gate, not a path-local mole. The next thin issue uses the same preview, apply, handoff, and `--stage ready` path.

## Capabilities

### New Capabilities

- `grill-then-ready-refinement`: per-issue grill preview and apply; versioned Decisions artifact; facts and bounded dependency closure; reviewer accept/challenge; operator-required authority via existing handoff answer; typed CONTEXT proposals; deterministic `--stage ready` artifact validation; relationship to #1238 (complement, never replace).

### Modified Capabilities

- `refine-spec-preview`: keep `--title/--body` non-mutating; add `--issue` preview and `apply`; issue preview makes two harness calls (Implementer, then Reviewer on Decisions only).
- `triage-sub-command`: `--stage ready` validates the Decisions artifact with no model; refuse incomplete or stale artifacts without changing labels; `--stage backlog` stays a label write.
- `command-registry`: expand `refine-spec` allowed flags and help for `--issue` and `apply`; keep `--title/--body` discoverable.
- `pipeline-state-machine`: `refine-spec --issue` and `apply` SHALL NOT advance stage labels; apply MAY edit the issue body only.
- `human-question-handoff`: extend the existing authenticated `pipeline handoff answer` boundary for pre-admission Decision nodes bound to repository, issue, node ID, frontier fingerprint, and source body hash. Do not add a second answer ledger.
- `issue-implementation-readiness-gate`: `--stage ready` remains an admission request and SHALL NOT invoke the #1238 model; a successful grill-ready label write is not a pickup bypass; #1238 comments stay verdict evidence, not the specification.

## Impact

- **CLI:** `core/scripts/stages/refine-spec.ts` (preview/apply), `core/scripts/stages/triage.ts` (ready artifact gate), `core/scripts/command-registry.ts`, `core/scripts/pipeline.ts` dispatch/help, `core/scripts/command-docs.ts`, host SKILL verb tables via `node scripts/build.mjs`.
- **Artifact / authority:** new Decisions schema and prompt templates; existing `human-question-handoff` store and `pipeline handoff answer`; no new handoff CLI verb.
- **GitHub writes:** apply writes the issue body only. Handoff answer materializes the accepted answer into the body and records provenance. `--stage ready` writes only the stage label. Preview writes nothing. Title, milestone, comments, and project files stay unchanged on apply and triage.
- **Docs:** `docs/adr/0002-decisions-live-in-the-issue-body.md`, root `CONTEXT.md` intake glossary (Grill, Decisions, Authority node, reviewer-accept).
- **Tests:** injected GitHub, dependency, harness, handoff, reviewer, clock, and drift seams. No real network, git, or subprocess in unit tests.
- **Packaging:** regenerate SKILL overlay after any `core/` edit. `npm run ci` must pass.

## Acceptance Criteria

- [ ] Existing `pipeline refine-spec --title/--body` stays compatible and non-mutating (no GitHub, git, or tracked-file writes).
- [ ] `pipeline refine-spec --issue N` makes one configured planning-treatment Implementer call, then one Reviewer call on the Decisions artifact only, and writes nothing.
- [ ] `pipeline refine-spec apply --issue N` writes the exact previewed body without another model call and refuses title/body drift with exit 2 and no mutation.
- [ ] Apply refuses a proposal that contains any reviewer `challenge` (non-zero exit, body unchanged).
- [ ] Thin issues receive a canonical Decisions artifact and remain non-ready while any operator-required node is unresolved.
- [ ] Reviewer `accept` cannot settle scope, security, irreversible-operations, merge/release, or human-attestation nodes.
- [ ] Reviewer `accept` on a taxonomy-validated non-authority node records `settled-by: reviewer-accept` and does not wait for a handoff.
- [ ] Model-authored provenance cannot settle operator-required authority; an authenticated hash-bound `pipeline handoff answer` can, and Pipeline materializes that answer into the body.
- [ ] The Implementer cannot mark its own nodes `accept`.
- [ ] Non-authority automatic defaults require closed-taxonomy validation; unknown or disputed classes stay unresolved authority.
- [ ] Comment-only answers, GitHub review comments, and issue comments do not become specification decisions.
- [ ] Dependency cycles, inaccessible or missing dependencies, malformed declarations, and closure-limit exhaustion fail as typed unresolved facts (no silent truncate, no second parser).
- [ ] Required context changes block readiness until a reviewed integration-base reference exists; refinement performs no repository-file write.
- [ ] `pipeline triage N --stage ready` is model-free and refuses incomplete or stale artifacts with exit 2 and no label change.
- [ ] A valid `--stage ready` changes only the pipeline stage label; pickup still runs the #1238 issue-implementation-readiness gate against fresh GitHub state.
- [ ] Unit tests inject GitHub, dependency, harness, handoff, reviewer, clock, and drift seams and would fail without the corresponding behavior.
- [ ] ADR 0002 and `CONTEXT.md` name `refine-spec` as the grill, reviewer-accept as provenance not authority, and #1238 comments as verdict evidence not the spec.
- [ ] `node scripts/build.mjs` and `npm run ci` pass with SKILL overlay, catalog, and OpenSpec current.
