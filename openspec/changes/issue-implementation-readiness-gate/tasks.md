## 1. Config and types

- [x] 1.1 Add `issue_readiness` to `PipelineConfig`, `DEFAULT_CONFIG` (`enabled: false`, `timeout: 600`), and `PartialConfigSchema` with `.describe()` on `enabled` and `timeout`, and verify a unit test accepts `enabled: true`, defaults an absent block to disabled/`timeout: 600`, and rejects an unknown sub-key
- [x] 1.2 Add `issue_readiness.enabled` to `RIGOR_GATING_PATHS` and verify the existing rigor-path schema test still passes
- [x] 1.3 Document `issue_readiness` in the init/sync scaffold template as default-off and verify a freshly scaffolded file round-trips through `resolveConfig()` with `enabled === false`

## 2. Admission stage and labels

- [x] 2.1 Insert `needs-spec` into `STAGES` between `backlog` and `ready` and verify the STAGES-order test lists `needs-spec` at that index and that it is not in `TERMINAL_STAGES`
- [x] 2.2 Handle `dispatch("needs-spec")` as a non-advancing wait (no worktree, no planning/implementation) and verify a unit test of that case records zero worktree and zero harness calls
- [x] 2.3 Include `pipeline:needs-spec` in `desiredPipelineLabels()` / `ensurePipelineLabels` and verify the desired-label unit test contains that name
- [x] 2.4 Treat `pipeline:needs-spec` as pre-pipeline in loop precondition exclusion (same class as `pipeline:backlog`) and verify a fake-driven test excludes it with required stage `pipeline:ready`

## 3. Shared gate module

- [x] 3.1 Add a single-sourced admission verdict schema (`ready` | `needs_spec` plus deficiencies and `proposed_body`) and a prompt template, and verify a drift-guard test fails if the prompt schema block diverges
- [x] 3.2 Implement title/body/treatment hashing and owned-comment marker parse/format, and verify tests cover match, body change, and treatment change
- [x] 3.3 Implement the shared gate with an injectable `deps` seam (fresh issue fetch, comment list/create/update, label add/remove, clock, Implementer invoke using `harnesses.implementer` + `models.planning` + `effort.planning` including `auto`), and verify no unit test performs real network, git, or subprocess I/O
- [x] 3.4 Admit a semantically complete issue that lacks canonical headings, and verify a fixture without Summary/User story headings returns `ready` when outcome, observable acceptance criteria, non-goals, and no contradiction are present
- [x] 3.5 Reject missing acceptance criteria and unresolved contradictions as `needs_spec`, and verify those fixtures return `needs_spec` with deficiencies and a five-section proposed body
- [x] 3.6 On `needs_spec`, write or update exactly one owned comment and transition `ready` → `needs-spec` without editing the issue body, milestone, unrelated labels, or files, and verify fake call logs match that write surface
- [x] 3.7 Reuse a matching hash-and-treatment record without a model call or new comment, including triage-back-to-ready of an unchanged thin issue, and verify invoke-count stays at zero while the issue returns to `pipeline:needs-spec`
- [x] 3.8 Map harness, timeout, and schema failures to typed `gate-unavailable` with no reviewer/structural/provider/model fallback and no GitHub writes, and verify those fakes record zero label/comment mutations

## 4. Ready dispatch seam

- [x] 4.1 Call the shared gate from `dispatch("ready")` before the live-planning marker and `planningAdvance` when `issue_readiness.enabled` is true, and verify a thin-issue test never claims the marker or calls planningAdvance
- [x] 4.2 Skip the gate when `enabled` is false and verify ready dispatch still claims the marker and calls planningAdvance exactly as today
- [x] 4.3 After a `ready` verdict, keep `ready → planning` before the authoring harness/worktree, and verify an admitted-issue test still sets `pipeline:planning` before the authoring invoke
- [x] 4.4 Skip the gate for mid-flight stages and verify an `implementing` dispatch does not fetch for issue-readiness evaluation

## 5. Pickup paths and multi-item behavior

- [x] 5.1 Prove direct advance/single, queue item dispatch, loop/supervisor redispatch, train, and ship each hit the shared gate (directly or via ready dispatch) with a test that would admit a thin issue if that path skipped the call
- [x] 5.2 Exclude `pipeline:needs-spec` from queue autonomous eligibility and verify a backlog mix of `needs-spec` and `ready` only dispatches `ready`
- [x] 5.3 Record structured `needs_spec` in queue/loop output without aborting independent siblings, and verify a two-item fake batch continues the independent issue
- [x] 5.4 On `gate-unavailable`, fail direct single with a non-zero exit; in multi-item runs block the affected issue and selected dependents and continue independents; verify both with injected fakes
- [x] 5.5 Keep `pipeline triage <N> --stage ready` deterministic (no model call) and verify the existing no-harness triage test still passes while a follow-up pickup test still runs the gate

## 6. Dogfood, docs, and packaging

- [x] 6.1 Set `issue_readiness.enabled: true` in this repository's `.github/pipeline.yml` and verify `resolveConfig()` on that file returns `enabled === true`
- [x] 6.2 Update status/help text so `needs-spec` is described as an admission hold (apply spec, then `pipeline triage <N> --stage ready`) and verify `--help` / status copy names that label
- [x] 6.3 Regenerate config docs (`docs/config.md`) from the schema after description changes and verify the docs freshness check is green
- [x] 6.4 After any `core/` edit, run `node scripts/build.mjs` and commit the regenerated `plugin/` in the same change, and verify `node scripts/build.mjs --check` passes
- [x] 6.5 Run `npm run ci` from the repo root and verify it passes, including `openspec validate --all`

## 7. Review-1 provenance, draft schema, and stale dispatch

- [x] 7.1 Reuse or update only verified Pipeline-authored comments (actor + attestation + marker); ignore foreign or malformed marker-bearing comments
- [x] 7.2 Treat a `needs_spec` draft that omits canonical headings or lists them out of order as `gate-unavailable` with no GitHub mutation
- [x] 7.3 Return `stale-dispatch` when the live stage is no longer `ready` at fetch or immediately before a `needs_spec` mutation, with no comment or label writes
