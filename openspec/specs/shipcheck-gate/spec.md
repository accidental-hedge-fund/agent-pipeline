# shipcheck-gate Specification

## Purpose
TBD - created by archiving change private-eval-shipcheck-gate. Update Purpose after archive.
## Requirements
### Requirement: Repo opts in via shipcheck_gate config block
A repo opts in to the shipcheck gate by declaring a `shipcheck_gate` block in `.github/pipeline.yml` with `enabled: true`. The gate SHALL be disabled by default when the block is absent or when `enabled` is `false`.

#### Scenario: shipcheck_gate block present with enabled true
- **WHEN** `.github/pipeline.yml` contains `shipcheck_gate.enabled: true`
- **THEN** `PipelineConfig.shipcheck_gate.enabled` SHALL be `true`

#### Scenario: shipcheck_gate block absent
- **WHEN** `.github/pipeline.yml` has no `shipcheck_gate` block
- **THEN** `PipelineConfig.shipcheck_gate.enabled` SHALL default to `false`

#### Scenario: shipcheck_gate.enabled false
- **WHEN** `.github/pipeline.yml` contains `shipcheck_gate.enabled: false`
- **THEN** `PipelineConfig.shipcheck_gate.enabled` SHALL be `false`

---

### Requirement: shipcheck-gate is a distinct pipeline stage between eval-gate and ready-to-deploy
The constant `STAGES` SHALL include `"shipcheck-gate"` positioned after `"eval-gate"` and before `"ready-to-deploy"`. The orchestrator dispatch table SHALL route `"shipcheck-gate"` to the shipcheck stage handler.

#### Scenario: STAGES ordering
- **WHEN** the `STAGES` constant is inspected
- **THEN** `"shipcheck-gate"` SHALL appear at an index greater than the index of `"eval-gate"`
- **AND** `"shipcheck-gate"` SHALL appear at an index less than the index of `"ready-to-deploy"`

#### Scenario: dispatch routes shipcheck-gate
- **WHEN** the current stage label is `pipeline:shipcheck-gate`
- **THEN** the orchestrator SHALL call the shipcheck stage handler

---

### Requirement: shipcheck-gate stage is skipped when shipcheck_gate is not enabled
When `shipcheck_gate.enabled` is false (or the config block is absent), the `shipcheck-gate` stage SHALL transition immediately to `ready-to-deploy` with a "step disabled" log line, without invoking any harness and without posting any comment.

#### Scenario: shipcheck_gate disabled — stage is skipped
- **WHEN** the current stage is `shipcheck-gate`
- **AND** `cfg.shipcheck_gate.enabled` is `false`
- **THEN** the stage SHALL call `transition(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "shipcheck-gate step disabled; skipping.")`
- **AND** SHALL NOT invoke the reviewer harness
- **AND** SHALL NOT post any comment

---

### Requirement: Reviewer harness evaluates the rubric; implementing harness is excluded
The `shipcheck-gate` stage SHALL invoke `cfg.harnesses.reviewer` (the reviewer role harness) with the shipcheck prompt. The implementing harness (`cfg.harnesses.implementer`) SHALL NOT be invoked during shipcheck evaluation. This separation ensures the builder does not self-certify.

#### Scenario: reviewer harness is invoked
- **WHEN** the current stage is `shipcheck-gate`
- **AND** `cfg.shipcheck_gate.enabled` is `true`
- **THEN** the stage SHALL invoke `cfg.harnesses.reviewer` with the assembled shipcheck prompt
- **AND** SHALL NOT invoke `cfg.harnesses.implementer`

---

### Requirement: Rubric is loaded from the repo-local rubric_path
The stage SHALL load the rubric text from the file at `cfg.shipcheck_gate.rubric_path` (default `.github/shipcheck-rubric.md`) relative to the repo root. If the file does not exist, the stage SHALL use the issue's acceptance criteria as the rubric (falling back to the issue body when ACs are absent) and SHALL log a warning identifying the missing file.

#### Scenario: rubric file present
- **WHEN** `cfg.shipcheck_gate.rubric_path` resolves to an existing file
- **THEN** the stage SHALL read and embed that file's contents in the shipcheck prompt as the rubric

#### Scenario: rubric file absent — fallback to issue ACs
- **WHEN** the file at `rubric_path` does not exist
- **THEN** the stage SHALL log a warning identifying the missing file
- **AND** SHALL use the issue body's acceptance-criteria section (or full issue body) as the rubric in the prompt

---

### Requirement: Shipcheck prompt includes issue body, plan, changed files, eval summary, and OpenSpec deltas
The shipcheck prompt sent to the reviewer harness SHALL include: (1) the rubric text, (2) the issue body, (3) the plan and acceptance criteria from the planning stage output (if available), (4) a summary of changed files (file names and line-count deltas), (5) the eval summary from the evidence bundle when available, and (6) OpenSpec change deltas when the issue references an OpenSpec change.

#### Scenario: full context assembled
- **WHEN** planning output, changed files, and an evidence bundle with eval results are all available
- **THEN** the assembled prompt SHALL contain sections for rubric, issue body, plan/ACs, changed-files summary, and eval summary

#### Scenario: eval results absent
- **WHEN** no evidence bundle eval entry is available (e.g. eval-gate disabled)
- **THEN** the prompt SHALL note "eval results: not available" rather than omitting the section entirely

---

### Requirement: Reviewer returns a structured shipcheck verdict
The reviewer harness SHALL return a JSON object conforming to the `ShipcheckVerdict` schema: `{ verdict: "pass" | "partial" | "fail", summary: string, criteria: Array<{ criterion: string, result: "pass" | "fail" | "na", note: string }> }`. The schema SHALL be single-sourced in `review-schema.ts` alongside the review verdict schema and drift-guarded by the existing schema constant test.

#### Scenario: valid verdict returned
- **WHEN** the reviewer returns valid JSON matching `ShipcheckVerdict`
- **THEN** the stage SHALL parse the verdict without fallback
- **AND** `criteria` SHALL list one entry per rubric criterion evaluated

#### Scenario: unparseable reviewer output — conservative fallback
- **WHEN** the reviewer output contains no JSON matching `ShipcheckVerdict`
- **THEN** the verdict SHALL default to `"fail"` with `summary` set to the raw output (truncated)
- **AND** a warning SHALL be logged

---

### Requirement: Advisory mode records findings without blocking; gate mode blocks on fail
`cfg.shipcheck_gate.mode` SHALL control blocking behavior. In `advisory` mode (default) the stage SHALL post the verdict comment and transition to `ready-to-deploy` regardless of the verdict. In `gate` mode the stage SHALL block `ready-to-deploy` on a `fail` verdict (and optionally on `partial` when `block_on_partial` is `true`, default `false`).

#### Scenario: advisory mode — fail verdict still advances
- **WHEN** `cfg.shipcheck_gate.mode` is `"advisory"` (or absent/default)
- **AND** the reviewer returns `verdict: "fail"`
- **THEN** the stage SHALL post the verdict comment
- **AND** SHALL transition to `ready-to-deploy`

#### Scenario: gate mode — fail verdict blocks
- **WHEN** `cfg.shipcheck_gate.mode` is `"gate"`
- **AND** the reviewer returns `verdict: "fail"`
- **THEN** the stage SHALL call `setBlocked` and SHALL NOT advance to `ready-to-deploy`

#### Scenario: gate mode — pass verdict advances
- **WHEN** `cfg.shipcheck_gate.mode` is `"gate"`
- **AND** the reviewer returns `verdict: "pass"`
- **THEN** the stage SHALL transition to `ready-to-deploy`

#### Scenario: gate mode — partial verdict respects block_on_partial
- **WHEN** `cfg.shipcheck_gate.mode` is `"gate"`
- **AND** `cfg.shipcheck_gate.block_on_partial` is `false` (default)
- **AND** the reviewer returns `verdict: "partial"`
- **THEN** the stage SHALL post the verdict comment and transition to `ready-to-deploy`

---

### Requirement: Result is posted to the issue/PR with per-criterion detail
The stage SHALL post a comment to the issue (and PR when one exists) that includes: the overall verdict (`pass`/`partial`/`fail`), the summary, and a per-criterion breakdown table. In advisory mode the comment SHALL be labeled "Shipcheck (advisory)". In gate mode the comment SHALL be labeled "Shipcheck" with a clear block or pass outcome.

#### Scenario: advisory mode comment label
- **WHEN** `cfg.shipcheck_gate.mode` is `"advisory"`
- **THEN** the posted comment header SHALL include the text "advisory"

#### Scenario: per-criterion table present
- **WHEN** the reviewer returns a verdict with non-empty `criteria`
- **THEN** the comment SHALL include a table or list with one row per criterion showing `result` and `note`

---

### Requirement: Gate is bounded by max_rounds; timeout surfaces as needs-human or advisory warning
`cfg.shipcheck_gate.max_rounds` (default 1) limits the number of reviewer invocations. If the verdict is not parseable after all rounds, the stage SHALL: in gate mode, call `setBlocked` with a `needs-human` blocker kind; in advisory mode, log a warning and advance to `ready-to-deploy`. The gate SHALL NOT silently pass on parse failure or timeout in either mode.

#### Scenario: parse failure in gate mode after max_rounds
- **WHEN** `cfg.shipcheck_gate.mode` is `"gate"`
- **AND** the reviewer output is unparseable after `max_rounds` attempts
- **THEN** the stage SHALL call `setBlocked` with blocker kind `needs-human`
- **AND** SHALL NOT advance to `ready-to-deploy`

#### Scenario: parse failure in advisory mode after max_rounds
- **WHEN** `cfg.shipcheck_gate.mode` is `"advisory"`
- **AND** the reviewer output is unparseable after `max_rounds` attempts
- **THEN** the stage SHALL log a warning
- **AND** SHALL transition to `ready-to-deploy`

### Requirement: shipcheck-gate blocks when the worktree head differs from the PR head

The `shipcheck-gate` stage SHALL, before invoking the reviewer harness and before
any transition to `ready-to-deploy`, compare the issue worktree's local HEAD commit
to the linked PR's head commit. When a worktree exists for the issue and its local
HEAD differs from the PR head, the stage SHALL call `setBlocked` with blocker kind
`head-drift` and SHALL NOT advance to `ready-to-deploy`. The block reason SHALL name
both the local HEAD SHA and the PR head SHA. When no worktree exists for the issue
(or no PR is linked), the stage SHALL skip the worktree-head comparison rather than
crashing.

This prevents a local-only or unpushed post-shipcheck fix from marking a stale PR
ready: the reviewer evaluates the worktree, so without this check a fix that was
committed locally but never pushed could pass shipcheck while the PR a human merges
does not contain the fix.

#### Scenario: worktree HEAD differs from PR head — blocked, not advanced

- **WHEN** the current stage is `shipcheck-gate` and `cfg.shipcheck_gate.enabled` is `true`
- **AND** a worktree exists for the issue whose local HEAD SHA differs from the linked PR head SHA
- **THEN** the stage SHALL call `setBlocked(...)` with blocker kind `head-drift`
- **AND** SHALL NOT transition to `ready-to-deploy`
- **AND** the block reason SHALL include both the local HEAD SHA and the PR head SHA

#### Scenario: worktree HEAD matches PR head — comparison passes

- **WHEN** the current stage is `shipcheck-gate`
- **AND** the worktree's local HEAD SHA equals the linked PR head SHA
- **THEN** the worktree-head comparison SHALL pass and the stage SHALL continue (it SHALL NOT block with `head-drift`)

#### Scenario: no worktree — comparison skipped

- **WHEN** the current stage is `shipcheck-gate`
- **AND** no worktree exists for the issue
- **THEN** the stage SHALL skip the worktree-head comparison without raising an error
- **AND** SHALL continue to the post-verdict re-validation check

---

### Requirement: shipcheck verdict comment records the evaluated head SHA

The shipcheck verdict comment SHALL embed the full 40-character SHA of the PR head
it evaluated, on its own line as the HTML-comment sentinel
`<!-- shipcheck-sha: <full-sha> -->`. The stage SHALL provide a pure extractor that
reads this sentinel from a comment body and returns the SHA (or null when absent),
mirroring the `reviewed-sha` sentinel of `review-sha-gating`.

#### Scenario: verdict comment carries the shipcheck-sha sentinel

- **WHEN** the shipcheck stage posts a verdict comment for a PR whose head SHA is `<full-sha>`
- **THEN** the comment body SHALL contain the line `<!-- shipcheck-sha: <full-sha> -->`
- **AND** the extractor applied to that body SHALL return `<full-sha>`

#### Scenario: extractor returns null for a comment without the sentinel

- **WHEN** the extractor is applied to a comment body that has no `shipcheck-sha` sentinel
- **THEN** it SHALL return `null`

---

### Requirement: shipcheck-gate re-validates a post-verdict code fix instead of advancing directly

On entry to `shipcheck-gate`, the stage SHALL determine whether a developer/fix
commit has landed on the PR head since the head a prior shipcheck verdict evaluated.
It SHALL read the most recent shipcheck verdict comment authored by the
authenticated `gh` actor and extract its `shipcheck-sha`. When that recorded SHA is
present and differs from the current PR head, and at least one commit between the
recorded SHA and the current head is NOT a pipeline-internal commit (per
`isPipelineInternalCommit`), the stage SHALL transition `shipcheck-gate → pre-merge`
— routing the new head back through CI status checks, the review-SHA gate, and
eval-gate — rather than transitioning to `ready-to-deploy`. Before routing back, the
stage SHALL post a notice naming the stale and current head SHAs.

When the recorded SHA equals the current PR head, when every commit since the
recorded SHA is pipeline-internal (e.g. the OpenSpec archive commit), or when no
prior shipcheck verdict comment exists (first entry), the stage SHALL proceed with
the reviewer evaluation as before — it SHALL NOT route back. Only shipcheck verdict
comments authored by the authenticated `gh` actor SHALL be trusted as the recorded
SHA source.

When a prior verdict comment by the authenticated actor exists but carries no
`shipcheck-sha` sentinel (a legacy comment posted by an older harness version), the
stage SHALL treat it as an unknown prior verdict and SHALL transition
`shipcheck-gate → pre-merge` once, posting a `<!-- shipcheck-revalidation-sha: <current-head> -->`
notice after the transition, so the new head is validated before shipcheck proceeds.
The existing idempotency guard (`alreadyRoutedForCurrentHead`) prevents this migration
route from repeating once the notice is posted.

#### Scenario: developer commit landed since the prior shipcheck verdict — route back to pre-merge

- **WHEN** the current stage is `shipcheck-gate` and `cfg.shipcheck_gate.enabled` is `true`
- **AND** a prior shipcheck verdict comment by the authenticated actor records a `shipcheck-sha` that differs from the current PR head
- **AND** at least one commit between that SHA and the current head is not a pipeline-internal commit
- **THEN** the stage SHALL transition `shipcheck-gate → pre-merge`
- **AND** SHALL NOT transition to `ready-to-deploy`
- **AND** SHALL post a notice naming the stale and current head SHAs before routing back

#### Scenario: recorded shipcheck-sha equals current head — proceed

- **WHEN** the current stage is `shipcheck-gate`
- **AND** the prior shipcheck verdict comment's `shipcheck-sha` equals the current PR head
- **THEN** the stage SHALL proceed with the reviewer evaluation and SHALL NOT route back to `pre-merge`

#### Scenario: only pipeline-internal commits since the prior shipcheck verdict — proceed

- **WHEN** the current stage is `shipcheck-gate`
- **AND** the current PR head differs from the recorded `shipcheck-sha`
- **AND** every commit between the recorded SHA and the current head is a pipeline-internal commit (`isPipelineInternalCommit`)
- **THEN** the stage SHALL proceed and SHALL NOT route back to `pre-merge` (preventing a non-converging route-back loop on the pipeline's own archive commit)

#### Scenario: first entry — no prior shipcheck comment — proceed and record SHA

- **WHEN** the current stage is `shipcheck-gate` and no prior shipcheck verdict comment exists for the issue
- **THEN** the stage SHALL proceed with the reviewer evaluation
- **AND** the verdict comment it posts SHALL record the evaluated PR head SHA via the `shipcheck-sha` sentinel

#### Scenario: legacy verdict comment (no sentinel) triggers migration routing to pre-merge

- **WHEN** the current stage is `shipcheck-gate`
- **AND** a prior shipcheck verdict comment authored by the authenticated actor exists but has no `shipcheck-sha` sentinel (legacy comment)
- **AND** no `shipcheck-revalidation-sha` notice for the current head has been posted yet
- **THEN** the stage SHALL transition `shipcheck-gate → pre-merge`
- **AND** SHALL NOT proceed to the reviewer evaluation
- **AND** SHALL NOT transition to `ready-to-deploy`
- **AND** SHALL post a notice with `<!-- shipcheck-revalidation-sha: <current-head> -->` after the transition

#### Scenario: revalidation notice is only posted after a successful transition (idempotency marker not orphaned)

- **WHEN** the stage is routing to `pre-merge` (developer commit or legacy migration)
- **AND** the label transition fails before completing
- **THEN** the `<!-- shipcheck-revalidation-sha: … -->` notice SHALL NOT be posted
- **AND** the next run SHALL still route to `pre-merge` (no orphaned idempotency marker)

#### Scenario: a commit made after a failed shipcheck does not advance directly to ready-to-deploy

- **WHEN** shipcheck-gate previously blocked at PR head `H1` and the operator pushed a fix moving the PR head to `H2`
- **AND** shipcheck-gate is re-entered with the worktree HEAD equal to `H2` (the fix is pushed)
- **THEN** the stage SHALL NOT transition directly to `ready-to-deploy`
- **AND** SHALL transition `shipcheck-gate → pre-merge` to re-validate `H2` through CI status checks, the review-SHA gate, and eval-gate

#### Scenario: re-entered after routing to pre-merge for the same head — idempotency guard proceeds with reviewer

- **WHEN** the stage previously routed `shipcheck-gate → pre-merge` for PR head `H2` (posting a notice with `<!-- shipcheck-revalidation-sha: H2 -->`)
- **AND** pre-merge/eval completes and shipcheck-gate is re-entered still at head `H2`
- **THEN** the stage SHALL detect the revalidation-sha notice authored by the authenticated actor and SHALL NOT route back to `pre-merge` again
- **AND** SHALL proceed with the reviewer evaluation for `H2`
- **AND** on a pass verdict SHALL transition to `ready-to-deploy`
- (This prevents the route-back from looping: the prior shipcheck verdict still records `H1`, so without this guard the same developer-commit condition would trigger indefinitely.)

#### Scenario: authenticated actor cannot be resolved — fail closed

- **WHEN** the current stage is `shipcheck-gate`
- **AND** a PR is linked (`prNumber` is non-null)
- **AND** the `gh` actor lookup returns null (transient auth failure)
- **THEN** the stage SHALL call `setBlocked` with blocker kind `needs-human`
- **AND** SHALL NOT proceed to the reviewer evaluation
- **AND** SHALL NOT transition to `ready-to-deploy`

#### Scenario: PR head changes during reviewer run — post-review head-coherence recheck routes to pre-merge

- **WHEN** the reviewer harness completes evaluation of PR head `H2`
- **AND** the PR head has since been updated to `H3` during the reviewer run (a push after the pre-review head fetch)
- **THEN** the stage SHALL re-fetch the PR head after the reviewer completes
- **AND** SHALL NOT transition to `ready-to-deploy`
- **AND** SHALL transition `shipcheck-gate → pre-merge` to re-validate the new head `H3`

#### Scenario: worktree head changes during reviewer run — post-review recheck blocks with head-drift

- **WHEN** the reviewer harness completes evaluation of PR head `H2`
- **AND** the worktree HEAD has since been updated (a local commit during the reviewer run)
- **AND** the worktree HEAD no longer matches the evaluated PR head `H2`
- **THEN** the stage SHALL call `setBlocked` with blocker kind `head-drift`
- **AND** SHALL NOT transition to `ready-to-deploy`

