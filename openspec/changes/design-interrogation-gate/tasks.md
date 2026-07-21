# Tasks — risk-triggered design-interrogation gate (#436)

## 1. Types & configuration

- [x] 1.1 Add `design-gate` to `STAGES` between `implementing` and `review-1`, and to
      `MODEL_INVOKING_STAGES`; leave `PROMPT_CONTAINED_STAGES` unchanged. Add a runtime test asserting
      the full `STAGES` order and both membership facts (types are stripped, not checked).
- [x] 1.2 Add `PipelineConfig.design_gate` (`enabled`, `triggers`, `extra_triggers`, `max_rounds`,
      `block_threshold`, `min_confidence`, `limits`) with the documented defaults in `DEFAULT_CONFIG`.
- [x] 1.3 Extend `PartialConfigSchema` with a strict `design_gate` object; verify an unknown nested key
      produces a parse error and that omitting the block yields `enabled: false`.
- [x] 1.4 Add the `DesignDecisionRecord`, `DesignChallenge`, `DesignInterrogationVerdict`, and
      `DesignGateState` types.

## 2. Deterministic triggering

- [x] 2.1 Define the built-in trigger classes (`concurrency`, `storage`, `auth`, `migration`,
      `infrastructure`, `public-api`, `architecture`) as named glob/label/size rule sets.
- [x] 2.2 Implement pure `evaluateDesignGateTrigger(inputs) → { triggered, matched, reason }` with no
      network/git/subprocess access; merge `extra_triggers` globs into their classes.
- [x] 2.3 Unit-test: disabled → `gate-disabled`; enabled with no match → `no-trigger-matched`; each
      built-in class matches its representative path/label/size; repeat-call determinism.

## 3. Decision record

- [x] 3.1 Author `core/scripts/prompts/design_decision_record.md` — emit the schema-versioned record,
      require alternatives with `rejected_because`, evidence citations, generalization boundary, and
      uncertainty; explicitly forbid chain-of-thought.
- [x] 3.2 Implement validation (required fields, non-empty `alternatives`, recognized `schema_version`)
      that rejects and re-requests rather than accepting a partial record.
- [x] 3.3 Implement bounding: `max_decisions`, `max_field_chars`, `max_artifact_bytes`, each with an
      explicit truncation marker and a recorded dropped-count.
- [x] 3.4 Apply the existing secret-redaction helpers before persisting or embedding the record.
- [x] 3.5 Persist to the run directory and embed as a hidden base64 artifact block in the gate comment;
      keep prior versions retrievable across revisions.
- [x] 3.6 Tests: valid record accepted; missing field rejected; empty `alternatives` rejected; unknown
      `schema_version` refused; truncation markers; redaction; revision preserves the prior version.

## 4. Interrogation round

- [x] 4.1 Single-source `DESIGN_CHALLENGE_SCHEMA_BLOCK` and author
      `core/scripts/prompts/design_interrogation.md` with `{{schema_block}}`; add the prompt/schema
      drift-guard test alongside the existing ones in `prompt-loader.test.ts`.
- [x] 4.2 Invoke `cfg.harnesses.reviewer` with its model/effort; record `reviewerIdentity` and
      `reviewerIndependence` (`independent` | `same-harness-fallback`).
- [x] 4.3 Parse the verdict conservatively (approve, or 3–7 challenges); malformed or out-of-band
      output → one bounded re-ask → block. Never treat unparseable output as approval.
- [x] 4.4 Implement `challengeKey = sha1(severity | decision_id | normalize(title))` truncated to 8 hex,
      reusing the `findingKey` title normalization.
- [x] 4.5 Partition challenges into blocking vs advisory by `block_threshold` + `min_confidence`.
- [x] 4.6 Tests: clean approval; malformed output re-ask then block; challenge-count band; key
      stability across rewording and instability across severity/decision change; blocking partition.

## 5. Response loop, routing, and convergence

- [x] 5.1 Implement the response round: `defended` (evidence required), `revised` (record re-emitted),
      `uncertainty-accepted` (recorded in the record); reject unsupported dispositions.
- [x] 5.2 Carry dispositions forward across re-review so a resolved challenge is not re-litigated.
- [x] 5.3 Bound the loop at `max_rounds`; early-park at `needs-human` when a prior-round blocking
      `challengeKey` recurs, without consuming budget.
- [x] 5.4 Post the punch-list comment (challenge key, severity, required action) before any
      `needs-human` transition; never auto-advance to `review-1` with a blocking challenge unresolved.
- [x] 5.5 Block with a harness-failure blocker when the reviewer harness is unavailable.
- [x] 5.6 Disposition out-of-scope challenges as deferred follow-ups without blocking.
- [x] 5.7 Tests: defense accepted; revision required; recurring blocking challenge parks early; budget
      exhaustion parks; advisory-only advances; unavailable reviewer blocks; unresolved blocking
      challenge prevents any diff-review invocation.

## 6. Stage wiring & resume

- [x] 6.1 Add `core/scripts/stages/design_gate.ts` with a `Deps` seam (gh / harness / worktree fakes)
      matching the existing stage-test pattern; wire dispatch in `pipeline.ts`.
- [x] 6.2 Fast-path the untriggered case: advance to `review-1` with a recorded reason and zero harness
      calls.
- [x] 6.3 Persist `DesignGateState` (trigger record, record versions, per-round challenges,
      dispositions, round counter) and rehydrate on re-entry; resume at the first incomplete round.
- [x] 6.4 Inject the "gate is armed" addendum into `implementing.md` only when the gate is enabled.
- [x] 6.5 Tests: disabled pass-through leaves stage sequence and outputs otherwise unchanged; crash
      after verdict does not re-invoke the reviewer; crash before any verdict does not re-run
      `implementing`.

## 7. Evidence, surfacing, docs, and gate

- [x] 7.1 Add the `designInterrogation` record to the evidence bundle (untriggered = reason only;
      triggered = full chain) with redaction applied.
- [x] 7.2 Render the design-interrogation section in the human-readable run summary, including the
      same-harness fallback disclosure and the one-line reason when untriggered.
- [x] 7.3 Surface the gate's stage/blocker state in `--status` / `status-json.ts` consistently with the
      other gates.
- [x] 7.4 Document `design_gate` in the README/config docs, noting it is off by default.
- [x] 7.5 Regenerate the mirror (`node scripts/build.mjs`) and commit `plugin/` in the same change.
- [x] 7.6 Run `npm run ci` from the repo root and confirm it is green (core tests, mirror check,
      install smoke, `openspec validate --all`).
