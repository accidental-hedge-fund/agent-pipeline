## 1. Environment-fidelity fixture contract

- [ ] 1.1 In `core/scripts/evals/fixture.ts`, add an optional `environment` list to the fixture
      type: each entry declares `name`, `mode` (`live | simulated | forbidden`), a mode `version`,
      `required_permissions`, `initial_state`, `expected` outputs/errors, and deterministic
      `setup`/`teardown`.
- [ ] 1.2 Extend fixture validation to reject an unknown `mode`, or a dependency missing a required
      field, naming the fixture and the offending dependency/field — mirroring the existing
      missing-field rejection. A fixture declaring no `environment` entries stays valid.
- [ ] 1.3 Bump `schema_version` handling if needed so the new field is additive: fixtures without an
      `environment` field remain valid; genuinely unsupported versions still reject.

## 2. Default-safe modes and explicit live selection

- [ ] 2.1 Encode the default-mode rule: a newly declared dependency defaults to `simulated` (when a
      deterministic stand-in is possible) or `forbidden`; `live` is never the default.
- [ ] 2.2 Require an explicit maintainer selection to set a dependency `live` when it can incur
      cost, mutate external state, or access production data; surface the risk and refuse to promote
      a draft that silently defaulted to `live`.

## 3. Environment-and-surface provenance hash

- [ ] 3.1 Derive an environment-and-surface provenance hash over the resolved environment-fidelity
      contract plus the resolved capability-surface inventory; expose it off the loaded fixture.
- [ ] 3.2 In `core/scripts/evals/run.ts` / `results.ts`, record that hash on every cell record
      alongside `prompt_hash`/`config_hash`/`base_sha`; assert identical inputs hash identically and
      a single mode/surface change changes the hash.

## 4. Harvest workflow — evidence intake

- [ ] 4.1 Add `core/scripts/evals/harvest.ts`. Accept one or more evidence references: normal run
      artifacts, `pipeline improve` clusters, or `correction_event` / control proposals (#499/#500).
- [ ] 4.2 Run every evidence excerpt through the existing `artifact-sanitize` path (secret redaction
      + injection screen) before it can enter a draft or proposal body; never copy raw production
      payloads or secrets.
- [ ] 4.3 Handle missing/empty evidence explicitly with a clear error rather than emitting a
      degraded draft.

## 5. Capability-surface inventory + single-ability proposal

- [ ] 5.1 Resolve and emit a capability-surface inventory for the candidate: stage, materialized
      prompts, harness/model configuration, tools/hooks, repository paths, referenced services/data
      dependencies.
- [ ] 5.2 Propose exactly one bounded ability or failure mode; record source evidence, affected
      runs/items, recurrence count when available, and why an eval (per #500's graduation ladder) is
      the appropriate control level.

## 6. Draft rendering to the fixture + grader contracts

- [ ] 6.1 Render a draft conforming to the #432/#433 fixture contract: immutable `base_commit`, task
      input, stage-entry artifacts, public/hidden checks, `acceptance_criteria`,
      `allowed_change_paths`, `grader_refs` (+versions), `category`, `risk`, `provenance: harvested`,
      and the `environment` contract.
- [ ] 6.2 Confirm the rendered draft loads under the existing fixture loader.

## 7. Iterative revision + promotion authority boundary

- [ ] 7.1 Support iterative maintainer revision of the proposed ability, task, dependency modes,
      checks, and grader; re-render a consistent draft after each edit.
- [ ] 7.2 Keep draft-only the default. Repository writes require an explicit `--apply`/`--promote`
      action and produce a normal diff; the command never queues, advances, overrides, merges, or
      deploys. Wire the command to `gh-eval-surface.ts` so no production GitHub write is possible.
- [ ] 7.3 On promotion, validate the draft with the existing eval loader (reject an invalid draft by
      offending field) and optionally generate a plan-only experiment proving the draft expands into
      an executable cell plan without a live model or production GitHub write.

## 8. CLI wiring + config

- [ ] 8.1 Add a `pipeline evals harvest` subcommand dispatch in `core/scripts/pipeline.ts`
      (draft-only default; explicit `--apply`/`--promote`).
- [ ] 8.2 If gating is needed, add a fixtures/harvest config block in `core/scripts/config.ts`
      (e.g. default-mode policy) that rejects unknown keys.

## 9. Tests + mirror + CI

- [ ] 9.1 Fixtures + tests covering: harvested correction evidence, ordinary run-failure evidence,
      `live`/`simulated`/`forbidden` dependencies, missing evidence, secret-bearing traces,
      iterative edits, rejected drafts, and explicit promotion. Prove each test bites without the
      change.
- [ ] 9.2 Test the environment-contract validation (unknown mode / incomplete dependency rejected by
      name), the default-safe mode + explicit-live-selection rule, and the provenance-hash
      sensitivity (identical inputs equal; single mode/surface change differs).
- [ ] 9.3 `node scripts/build.mjs` to regenerate the `plugin/` mirror; run `npm run ci` from root
      until green (`ci:core`, mirror check, install smoke, `openspec validate --all`).
