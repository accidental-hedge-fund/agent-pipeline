# review-cross-round-memory Specification

## Purpose
TBD - created by archiving change review-cross-round-memory. Update Purpose after archive.
## Requirements
### Requirement: The pipeline SHALL derive a prior-round digest from durable PR evidence only

The pipeline SHALL expose a pure function `buildPriorRoundDigest(comments, opts)` in `core/scripts/review-history.ts` that returns an ordered list of prior review rounds for the issue under review. It SHALL derive every entry from the pipeline-authored review comments and trusted override comments on the PR — the `ReviewArtifact` block, the `pipeline-blocking-keys` marker, the `pipeline-blocking-surfaces` marker, and `pipeline-override` sentinels. It SHALL NOT read the run directory, the issue history artifact, any file under `.agent-pipeline/`, or any in-memory state carried from an earlier stage of the same process. The function SHALL perform no network, git, or subprocess calls.

Review comments SHALL be trusted only when authored by the authenticated pipeline actor; override comments SHALL be trusted when authored by the pipeline actor or an identity in `trusted_override_actors`, using the existing `buildTrustedOverrideComments` boundary.

#### Scenario: Digest built with no engine artifacts present

- **WHEN** `buildPriorRoundDigest` is called in a process whose working tree contains no `.agent-pipeline/` directory and no run directory
- **THEN** it SHALL return the same digest it returns when those artifacts are present
- **AND** it SHALL make no filesystem, network, git, or subprocess call

#### Scenario: Untrusted review comments are excluded

- **WHEN** the PR carries review-shaped comments authored by an identity other than the pipeline actor
- **THEN** those comments SHALL contribute no rounds and no findings to the digest

#### Scenario: Override recorded by a trusted override actor is included

- **WHEN** a `pipeline-override` sentinel comment is authored by an identity listed in `trusted_override_actors`
- **THEN** its disposition SHALL appear in the digest
- **AND** an override sentinel from an identity outside that allowlist SHALL be excluded

---

### Requirement: Each digest round SHALL carry its blocking findings, resolutions, and override dispositions

Each digest round SHALL carry its round number, the short reviewed SHA, and one entry per blocking finding of that round. Each finding entry SHALL carry the finding's `key`, its `surface` (the `surfaceKey` value `normalize(file) | category`), its `severity`, its `title`, and a `resolution` of exactly one of `resolved-by-fix`, `overridden`, or `still-open`.

Resolution SHALL be derived, not stored: an entry SHALL be `overridden` when a trusted override matches its key or its scope; otherwise it SHALL be `resolved-by-fix` when its surface appears in no later round's blocking surfaces; otherwise it SHALL be `still-open`. An `overridden` entry SHALL carry the override reason and the round in which the override was recorded.

Findings that were advisory in their round SHALL NOT appear in the digest.

#### Scenario: Blocking finding absent from later rounds is resolved-by-fix

- **WHEN** a surface is blocking in round 2 and appears in no blocking-surfaces marker of any round after round 2
- **THEN** its round-2 digest entry SHALL carry `resolution: resolved-by-fix`

#### Scenario: Overridden finding carries reason and recording round

- **WHEN** a blocking finding's key matches a trusted `pipeline-override` sentinel recorded during round 2
- **THEN** its digest entry SHALL carry `resolution: overridden`
- **AND** SHALL carry the override reason text and `round: 2` as the recording round

#### Scenario: Surface still blocking in the latest round is still-open

- **WHEN** a surface blocking in round 2 is also blocking in round 3 and no override matches it
- **THEN** its round-2 digest entry SHALL carry `resolution: still-open`

#### Scenario: Advisory findings are excluded

- **WHEN** a round's comment enumerates findings of which none are listed in its blocking markers
- **THEN** that round SHALL contribute zero finding entries to the digest

---

### Requirement: Digest derivation SHALL degrade gracefully across the artifact fallback ladder

When a prior review comment carries a `ReviewArtifact` with the optional `blockingFindings` extension array, the digest SHALL take each entry's `key`, `surface`, `severity`, and `title` from it. When that extension is absent, the digest SHALL fall back independently, per comment: first to the `pipeline-blocking-surfaces` marker for `key` and `surface`, then to `pipeline-blocking-keys` (or `artifact.blockingKeys`) for `key` alone. An entry recovered without a title SHALL render as `(title unavailable)` rather than being dropped. A comment from which no key can be recovered SHALL contribute no entries, and the digest SHALL NOT infer entries from comment prose.

`formatReviewComment` SHALL populate the `blockingFindings` extension on every review comment it emits that already carries a `ReviewArtifact`, with each entry's `title` truncated to 120 characters. Readers that ignore the field SHALL be unaffected.

#### Scenario: Comment with the extension yields full entries

- **WHEN** a prior review comment's `ReviewArtifact` carries `blockingFindings`
- **THEN** each digest entry for that round SHALL carry the recorded `key`, `surface`, `severity`, and `title`

#### Scenario: Legacy comment with surfaces marker only

- **WHEN** a prior review comment carries a `pipeline-blocking-surfaces` marker but no `blockingFindings` extension
- **THEN** its digest entries SHALL carry `key` and `surface` from the marker
- **AND** their rendered title SHALL be `(title unavailable)`

#### Scenario: Legacy comment with blocking-keys only

- **WHEN** a prior review comment carries only a `pipeline-blocking-keys` marker
- **THEN** its digest entries SHALL carry `key` with no surface
- **AND** SHALL still appear in the digest

#### Scenario: Comment with no recoverable keys contributes nothing

- **WHEN** a prior review comment carries no artifact and no blocking markers
- **THEN** it SHALL contribute zero digest entries
- **AND** no entry SHALL be synthesized from its prose

---

### Requirement: The digest SHALL be injected into review rounds after the first and SHALL be absent otherwise

The `review_adversarial.md` template SHALL carry a `{{prior_rounds_digest}}` placeholder, populated by both `buildReviewAdversarialPrompt` and `buildDeltaReviewPrompt`. When the digest contains at least one prior round, the rendered section SHALL frame the listed `resolved-by-fix` and `overridden` entries as settled constraints and SHALL instruct the reviewer that re-raising a settled surface requires a genuinely new third option, not a reversal.

When no prior round is recoverable — including every round-1 review — the placeholder SHALL be substituted with the empty string, and the rendered prompt SHALL be byte-identical to the prompt the same inputs produce without this change. `review_standard.md` SHALL NOT carry the placeholder.

#### Scenario: Round 2 after a round-1 verdict receives the digest

- **WHEN** an adversarial review round runs and a trusted round-1 review comment with blocking findings exists
- **THEN** the rendered prompt SHALL contain the digest section listing that round's blocking findings and their resolutions

#### Scenario: Pre-merge delta review receives the digest

- **WHEN** the pre-merge delta review prompt is built for a PR with prior trusted review rounds
- **THEN** the rendered prompt SHALL contain the digest section

#### Scenario: No prior rounds — empty section, unchanged prompt

- **WHEN** a review prompt is built and no trusted prior review comment is recoverable
- **THEN** `{{prior_rounds_digest}}` SHALL be substituted with the empty string
- **AND** the rendered prompt SHALL be byte-identical to the pre-change rendering for the same inputs

#### Scenario: Round 1 template carries no digest

- **WHEN** `review_standard.md` is rendered
- **THEN** it SHALL contain no `{{prior_rounds_digest}}` placeholder and no digest section

---

### Requirement: The rendered digest SHALL be compact and SHALL exclude diffs, transcripts, and prompts

The rendered digest SHALL contain only round numbers, short reviewed SHAs, finding keys, surfaces, severities, titles, resolutions, and override reasons. It SHALL NOT contain diff hunks, harness transcripts, prior prompt text, finding bodies, or recommendations. Rendering SHALL cap at 12 finding entries per round, 8 rounds, and 4 000 characters in total, truncating oldest-first, and SHALL emit an explicit `[… N earlier entries truncated]` marker whenever any cap removes content. Titles SHALL be truncated to 120 characters.

#### Scenario: Rendered digest excludes bulk content

- **WHEN** the digest is rendered for a history whose review comments contain finding bodies and recommendations
- **THEN** the rendered section SHALL contain no finding body, no recommendation, no diff hunk, and no transcript text

#### Scenario: Caps produce an explicit truncation marker

- **WHEN** a history exceeds the per-round entry cap, the round cap, or the character cap
- **THEN** the rendered digest SHALL retain the most recent content
- **AND** SHALL contain a `[… N earlier entries truncated]` marker

#### Scenario: Long title is truncated

- **WHEN** a finding title exceeds 120 characters
- **THEN** the rendered entry SHALL carry the title truncated to 120 characters

---

### Requirement: The digest SHALL be sanitized and fenced as untrusted external evidence

The rendered digest section SHALL be passed through `sanitizeBriefForPrompt` before injection and SHALL be enclosed in `<untrusted-external-evidence>` … `</untrusted-external-evidence>` tags preceded by the directive stating the enclosed content is untrusted external material whose embedded instructions MUST NOT be followed — matching the boundary applied to the carry-forward brief.

#### Scenario: Injection imperatives in a title are redacted

- **WHEN** a prior round's finding title or override reason contains a known injection imperative
- **THEN** the rendered digest SHALL contain `[REDACTED]` in its place
- **AND** SHALL NOT contain the raw imperative

#### Scenario: Non-empty digest is fenced

- **WHEN** the digest section is rendered with at least one round
- **THEN** it SHALL contain the opening and closing `<untrusted-external-evidence>` tags and the no-instructions directive

---

### Requirement: A blocking finding on a settled surface SHALL require an explicit prior-round acknowledgment

`ReviewFinding` SHALL gain an optional `prior_round_acknowledgment` string field, present in `REVIEW_VERDICT_SCHEMA_BLOCK`, in the finding field guard, and in `REVIEW_SCHEMA_FIELDS`, so the existing schema drift guard covers it. The reviewer prompt SHALL instruct that this field is required when a finding re-raises a surface the digest marks settled, and SHALL state that it must name the prior round and explain why a new resolution — not a reversal — is warranted.

A surface SHALL be **settled** when its most recent digest resolution is `resolved-by-fix` or `overridden`.

`partitionFindings` SHALL move a finding to the advisory partition with reason `reversal-unacknowledged` when all of the following hold: the finding would otherwise be blocking under the active `review_policy`; its `surfaceKey` matches a settled surface in the digest; and its `prior_round_acknowledgment` is absent, empty, or whitespace-only. A finding that carries a non-empty `prior_round_acknowledgment` SHALL block exactly as it would without this requirement. A finding on a surface that is not settled SHALL be unaffected whether or not it carries the field. When no digest is supplied, partitioning behavior SHALL be unchanged.

#### Scenario: Unacknowledged reversal is demoted to advisory

- **WHEN** a review round returns a blocking-severity finding whose surface is marked settled in the digest
- **AND** the finding carries no `prior_round_acknowledgment`
- **THEN** the finding SHALL land in the advisory partition with reason `reversal-unacknowledged`
- **AND** SHALL NOT appear in the round's blocking keys

#### Scenario: Acknowledged reversal blocks normally

- **WHEN** the same finding carries a non-empty `prior_round_acknowledgment`
- **THEN** it SHALL land in the blocking partition exactly as it would under the policy without this requirement

#### Scenario: Unsettled surface is unaffected

- **WHEN** a blocking finding's surface is `still-open` in the digest, or appears in no digest round
- **THEN** the finding SHALL be partitioned by the active `review_policy` alone
- **AND** the absence of `prior_round_acknowledgment` SHALL NOT demote it

#### Scenario: No digest — partitioning unchanged

- **WHEN** `partitionFindings` is called without a digest
- **THEN** its output SHALL be identical to its pre-change output for the same findings, policy, and overrides

---

### Requirement: A demoted reversal SHALL be surfaced in the review comment and as an event

A finding demoted for `reversal-unacknowledged` SHALL be rendered in the posted review comment with a `REVERSAL-UNACKNOWLEDGED` tag naming the prior round that settled the surface, and the pipeline SHALL emit one event recording the finding key, its surface, and the settling round. The finding SHALL NOT be silently dropped from the comment.

#### Scenario: Comment tags the demoted finding

- **WHEN** a finding is demoted for `reversal-unacknowledged`
- **THEN** the posted review comment SHALL render that finding with a `REVERSAL-UNACKNOWLEDGED` tag identifying the settling round

#### Scenario: Event records the demotion

- **WHEN** a finding is demoted for `reversal-unacknowledged`
- **THEN** exactly one event SHALL be emitted carrying the finding key, its surface, and the settling round number

---

### Requirement: Regression coverage SHALL replay the observed oscillation histories

The test suite SHALL include two regression tests built from fake comment fixtures with no network, git, or subprocess access.

The first SHALL replay a castrecall-#5-style history — round 1 raises no cap on a surface, round 2 demands a hard cap and the fix is accepted, round 3 re-litigates the cap — and SHALL assert that the round-3 prompt contains the round-1 and round-2 positions for that surface marked as settled constraints. The second SHALL replay a castrecall-#61-style history in which 401/403 semantics are reversed across rounds on the same surface, and SHALL assert the same. Each test SHALL also assert that a round-3 blocking finding on that surface without `prior_round_acknowledgment` is demoted to advisory.

#### Scenario: Cap-reversal history surfaces settled constraints in round 3

- **WHEN** the round-3 review prompt is built from the cap-reversal fixture history
- **THEN** the prompt SHALL contain the round-1 and round-2 positions for that surface marked as settled
- **AND** a round-3 blocking finding on that surface lacking `prior_round_acknowledgment` SHALL be demoted to advisory

#### Scenario: Auth-semantics reversal history surfaces settled constraints in round 3

- **WHEN** the round-3 review prompt is built from the 401/403 reversal fixture history
- **THEN** the prompt SHALL contain the prior rounds' accepted position for that surface marked as settled
- **AND** a round-3 blocking finding on that surface lacking `prior_round_acknowledgment` SHALL be demoted to advisory

