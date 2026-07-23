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

Each digest round SHALL carry its round number, the short reviewed SHA, and one entry per blocking finding of that round. Each finding entry SHALL carry the finding's `key`, its `surface` (the `surfaceKey` value `normalize(file) | category`), its `severity`, its `title`, and a `resolution` of exactly one of `resolved-by-fix`, `overridden`, or `still-open`. Each finding entry SHALL additionally carry the finding's `confidence` and its `rejectedAlternatives` (the design alternatives the finding's recommendation required removed or replaced) when the source review artifact records them; when the source rung of the fallback ladder cannot supply either value, the entry SHALL still be emitted with its remaining fields and SHALL carry no confidence and an empty rejected-alternatives list.

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

#### Scenario: Entry carries confidence and rejected alternatives when the artifact records them

- **WHEN** a round's review artifact records a blocking finding with a confidence value and a non-empty rejected-alternatives list
- **THEN** that finding's digest entry SHALL carry the same confidence value
- **AND** SHALL carry the same rejected-alternatives list

#### Scenario: Legacy comment without confidence still yields an entry

- **WHEN** a round's entries are recovered from the blocking-keys or blocking-surfaces marker rungs, which record neither confidence nor rejected alternatives
- **THEN** the entries SHALL still be emitted with their key, surface, severity, title, and resolution
- **AND** SHALL carry no confidence and an empty rejected-alternatives list
- **AND** digest derivation SHALL NOT throw

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

The `review_adversarial.md` template SHALL carry a `{{prior_rounds_digest}}` placeholder, populated
by both `buildReviewAdversarialPrompt` and `buildDeltaReviewPrompt`. When the digest contains at
least one prior round, the rendered section SHALL frame the listed `resolved-by-fix` and
`overridden` entries as settled constraints and SHALL instruct the reviewer that re-raising a
settled **finding** requires a genuinely new third option, not a reversal, while stating that a new
and distinct defect on the same file or surface is an ordinary finding requiring no acknowledgment.

When no prior round is recoverable — including every round-1 review — the placeholder SHALL be
substituted with the empty string, and the rendered prompt SHALL be byte-identical to the prompt the
same inputs produce without the cross-round digest. `review_standard.md` SHALL NOT carry the
placeholder.

#### Scenario: Round 2 after a round-1 verdict receives the digest

- **WHEN** an adversarial review round runs and a trusted round-1 review comment with blocking
  findings exists
- **THEN** the rendered prompt SHALL contain the digest section listing that round's blocking
  findings and their resolutions

#### Scenario: Digest distinguishes re-raise from new defect

- **WHEN** the digest section is rendered with at least one settled entry
- **THEN** it SHALL state that `prior_round_acknowledgment` is required only for a finding that
  re-raises a settled finding
- **AND** SHALL state that a new, distinct defect on the same file or surface requires no
  acknowledgment

#### Scenario: Pre-merge delta review receives the digest

- **WHEN** the pre-merge delta review prompt is built for a PR with prior trusted review rounds
- **THEN** the rendered prompt SHALL contain the digest section

#### Scenario: No prior rounds — empty section, unchanged prompt

- **WHEN** a review prompt is built and no trusted prior review comment is recoverable
- **THEN** `{{prior_rounds_digest}}` SHALL be substituted with the empty string
- **AND** the rendered prompt SHALL be byte-identical to the rendering without the cross-round
  digest for the same inputs

#### Scenario: Round 1 template carries no digest

- **WHEN** `review_standard.md` is rendered
- **THEN** it SHALL contain no `{{prior_rounds_digest}}` placeholder and no digest section

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

### Requirement: A blocking finding that re-raises a settled finding SHALL require an explicit prior-round acknowledgment

`ReviewFinding` SHALL carry an optional `prior_round_acknowledgment` string field, present in
`REVIEW_VERDICT_SCHEMA_BLOCK`, in the finding field guard, and in `REVIEW_SCHEMA_FIELDS`, so the
existing schema drift guard covers it. The reviewer prompt SHALL instruct that this field is
required when a finding re-raises a **finding** the digest marks settled — not when it merely
touches a file or surface a prior round already fixed — and SHALL state that it must name the prior
round and explain why a new resolution, not a reversal, is warranted.

A digest finding entry SHALL be **settled** when its most recent resolution is `resolved-by-fix` or
`overridden`. `review-history.ts` SHALL expose a pure accessor returning the settled entries as
records carrying the settled finding's `key`, `surface`, `title`, and settling round number.

`review-history.ts` SHALL expose a pure, deterministic re-raise matcher that reports whether a new
finding re-raises a given settled entry. The matcher SHALL require **both** of the following, and
SHALL perform no filesystem, network, git, or subprocess access:

1. The finding's `surfaceKey` is non-null and equal to the settled entry's surface; when the settled
   entry has no recorded surface, this condition SHALL be satisfied only by condition 2's key
   equality.
2. The finding's `findingKey` equals the settled entry's key, **or** the normalized-title similarity
   between the finding's title and the settled entry's title is greater than or equal to an exported
   similarity threshold constant.

Surface identity alone SHALL NOT constitute a match. A settled entry whose title was unrecoverable
SHALL be eligible for the key branch only and SHALL NOT be matched by title similarity.

`partitionFindings` SHALL move a finding to the advisory partition with reason
`reversal-unacknowledged` when all of the following hold: the finding would otherwise be blocking
under the active `review_policy`; the matcher reports it re-raises at least one settled entry; and
its `prior_round_acknowledgment` is absent, empty, or whitespace-only. A finding that carries a
non-empty `prior_round_acknowledgment` SHALL block exactly as it would without this requirement. A
finding that matches no settled entry SHALL be partitioned by the active `review_policy` alone.
When no settled entries are supplied, partitioning behavior SHALL be unchanged.

#### Scenario: New defect on a previously-fixed surface blocks

- **WHEN** a prior round's blocking finding on surface `S` is settled `resolved-by-fix`
- **AND** a later round returns a blocking-severity finding on `S` whose `findingKey` differs from
  the settled entry's key and whose title similarity to it is below the threshold
- **AND** that finding carries no `prior_round_acknowledgment`
- **THEN** the finding SHALL land in the blocking partition per the active `review_policy`
- **AND** SHALL NOT be demoted with reason `reversal-unacknowledged`

#### Scenario: True re-raise by key is demoted to advisory

- **WHEN** a later round returns a blocking-severity finding on a settled entry's surface whose
  `findingKey` equals that entry's key
- **AND** the finding carries no `prior_round_acknowledgment`
- **THEN** the finding SHALL land in the advisory partition with reason `reversal-unacknowledged`
- **AND** SHALL NOT appear in the round's blocking keys

#### Scenario: True re-raise after the fix moved the code is demoted by title similarity

- **WHEN** a later round returns a blocking-severity finding on a settled entry's surface whose
  `findingKey` differs (different line band or severity) but whose normalized-title similarity to
  the settled entry is at or above the threshold
- **AND** the finding carries no `prior_round_acknowledgment`
- **THEN** the finding SHALL land in the advisory partition with reason `reversal-unacknowledged`

#### Scenario: Settled entry without a recoverable title cannot match by similarity

- **WHEN** a settled digest entry was recovered from a legacy marker and carries no usable title
- **AND** a later blocking finding on that entry's surface has a different `findingKey`
- **THEN** the matcher SHALL report no match
- **AND** the finding SHALL be partitioned by the active `review_policy` alone

#### Scenario: Acknowledged re-raise blocks normally

- **WHEN** a finding the matcher reports as a re-raise carries a non-empty
  `prior_round_acknowledgment`
- **THEN** it SHALL land in the blocking partition exactly as it would under the policy without this
  requirement

#### Scenario: Unsettled surface is unaffected

- **WHEN** a blocking finding's surface is `still-open` in the digest, or appears in no digest round
- **THEN** the finding SHALL be partitioned by the active `review_policy` alone
- **AND** the absence of `prior_round_acknowledgment` SHALL NOT demote it

#### Scenario: No settled entries — partitioning unchanged

- **WHEN** `partitionFindings` is called with no settled entries
- **THEN** its output SHALL be identical to its output for the same findings, policy, and overrides
  before this change

---

### Requirement: A demoted reversal SHALL name the settled finding it re-raises in the comment and the event

A finding demoted for `reversal-unacknowledged` SHALL be rendered in the posted review comment with
a `REVERSAL-UNACKNOWLEDGED` tag that identifies the settled finding it was matched against — its
key and its title — together with the round that settled it. The pipeline SHALL emit exactly one
event per demotion recording the demoted finding's key, its surface, the settled finding's key, the
settling round, and the match basis (key equality or title similarity). The finding SHALL NOT be
silently dropped from the comment.

#### Scenario: Comment tag names the settled finding

- **WHEN** a finding is demoted for `reversal-unacknowledged`
- **THEN** the posted review comment SHALL render that finding with a `REVERSAL-UNACKNOWLEDGED` tag
  containing the settled finding's key, its title, and the settling round number

#### Scenario: Event records the matched settled finding and basis

- **WHEN** a finding is demoted for `reversal-unacknowledged`
- **THEN** exactly one event SHALL be emitted carrying the demoted finding's key, its surface, the
  settled finding's key, the settling round number, and the match basis

---

### Requirement: Regression coverage SHALL pin both the oscillation histories and the mis-fire history

The test suite SHALL include regression tests built from fake comment fixtures with no network,
git, or subprocess access.

The oscillation replays SHALL be retained: a castrecall-#5-style history (round 1 raises no cap on a
surface, round 2 demands a hard cap and the fix is accepted, round 3 re-litigates the cap) and a
castrecall-#61-style history (401/403 semantics reversed across rounds on the same surface). Each
SHALL assert that the round-3 prompt contains the earlier positions for that surface marked as
settled constraints, and that a round-3 blocking finding re-raising the settled finding without
`prior_round_acknowledgment` is demoted to advisory.

The suite SHALL additionally include a replay of the observed mis-fire: round 1 blocking findings on
surface `S` all settled `resolved-by-fix`, and a round-2 blocking-severity, high-confidence finding
on `S` describing a distinct defect with no `prior_round_acknowledgment`. It SHALL assert that the
round-2 finding lands in the blocking partition, and that a variant of the same fixture whose
round-2 finding genuinely re-raises the settled finding lands in the advisory partition with reason
`reversal-unacknowledged`.

#### Scenario: Mis-fire replay blocks the new defect

- **WHEN** `partitionFindings` runs over the mis-fire fixture's round-2 finding with the settled
  entries derived from its round-1 comment
- **THEN** that finding SHALL appear in the blocking partition
- **AND** no advisory entry SHALL carry reason `reversal-unacknowledged`

#### Scenario: Mis-fire replay variant demotes a true re-raise

- **WHEN** the same fixture's round-2 finding is replaced by one that re-raises the settled finding
  and carries no `prior_round_acknowledgment`
- **THEN** that finding SHALL appear in the advisory partition with reason `reversal-unacknowledged`

#### Scenario: Cap-reversal history still demotes an unacknowledged re-raise

- **WHEN** the round-3 review prompt is built from the cap-reversal fixture history
- **THEN** the prompt SHALL contain the round-1 and round-2 positions for that surface marked as
  settled
- **AND** a round-3 blocking finding re-raising the settled finding without
  `prior_round_acknowledgment` SHALL be demoted to advisory

#### Scenario: Auth-semantics reversal history still demotes an unacknowledged re-raise

- **WHEN** the round-3 review prompt is built from the 401/403 reversal fixture history
- **THEN** the prompt SHALL contain the prior rounds' accepted position for that surface marked as
  settled
- **AND** a round-3 blocking finding re-raising the settled finding without
  `prior_round_acknowledgment` SHALL be demoted to advisory

---

### Requirement: A blocking finding that reinstates a settled finding's rejected alternative SHALL require an explicit prior-round acknowledgment

`ReviewFinding` SHALL carry an optional `rejected_alternatives` array of strings, present in the verdict schema block, in the finding field guard, and in the schema field constant, so the existing schema drift guard covers it. The reviewer prompt SHALL instruct that a finding whose recommendation requires removing or replacing an existing design MUST name the alternative being ruled out in this field.

`review-history.ts` SHALL expose a pure, deterministic matcher reporting whether a new finding's `recommendation` reinstates an alternative recorded in a settled entry's rejected alternatives. The matcher SHALL require **both** that the finding's `surfaceKey` is non-null and equal to the settled entry's surface, **and** that the normalized-token similarity between the finding's `recommendation` and at least one of that entry's rejected alternatives is greater than or equal to an exported similarity threshold constant. The matcher SHALL perform no filesystem, network, git, or subprocess access. A settled entry with an empty rejected-alternatives list SHALL never match.

`partitionFindings` SHALL move a finding to the advisory partition with reason `settled-alternative-reinstated` when all of the following hold: the finding would otherwise be blocking under the active `review_policy`; the matcher reports it reinstates at least one settled entry's rejected alternative; and its `prior_round_acknowledgment` is absent, empty, or whitespace-only. This guard SHALL be evaluated independently of the `reversal-unacknowledged` guard, so a finding with a new `findingKey` and a title similarity below the reversal threshold SHALL still be demoted when it reinstates a settled rejected alternative. A finding carrying a non-empty `prior_round_acknowledgment` SHALL block exactly as it would without this requirement. When no settled entry records a rejected alternative, partitioning behavior SHALL be unchanged.

#### Scenario: New-key re-framed finding reinstating a rejected design is demoted

- **WHEN** a prior round's settled finding on surface `S` recorded a rejected alternative "hold the connection lock across remote fetches"
- **AND** a later round returns a blocking-severity finding on `S` whose `findingKey` is new, whose title similarity to the settled entry is below the reversal threshold, and whose `recommendation` is "serialize remote fetches per connection under the connection lock"
- **AND** that finding carries no `prior_round_acknowledgment`
- **THEN** the finding SHALL land in the advisory partition with reason `settled-alternative-reinstated`
- **AND** SHALL NOT appear in the round's blocking keys

#### Scenario: Acknowledged reinstatement blocks normally

- **WHEN** a finding the alternative matcher reports as a reinstatement carries a non-empty `prior_round_acknowledgment`
- **THEN** it SHALL land in the blocking partition exactly as it would under the policy without this requirement

#### Scenario: Different surface is not matched

- **WHEN** a blocking finding's `recommendation` matches a settled entry's rejected alternative but its `surfaceKey` differs from that entry's surface
- **THEN** the matcher SHALL report no match
- **AND** the finding SHALL be partitioned by the active `review_policy` alone

#### Scenario: Settled entry with no rejected alternatives never matches

- **WHEN** every settled entry carries an empty rejected-alternatives list
- **THEN** the matcher SHALL report no match for any finding
- **AND** partitioning output SHALL be identical to its output for the same findings, policy, and overrides before this change

#### Scenario: Matcher is pure

- **WHEN** the matcher is invoked twice with the same finding and settled entries
- **THEN** it SHALL return the same result both times
- **AND** SHALL make no filesystem, network, git, or subprocess call

---

### Requirement: A demoted reinstatement SHALL name the settled finding and alternative in the comment and the event

A finding demoted for `settled-alternative-reinstated` SHALL be rendered in the posted review comment with a `SETTLED-ALTERNATIVE-REINSTATED` tag identifying the settled finding's key, the matched rejected-alternative text, and the round that settled it. The pipeline SHALL emit exactly one event per demotion recording the demoted finding's key, its surface, the settled finding's key, the settling round, and the matched alternative text. The finding SHALL NOT be silently dropped from the comment.

#### Scenario: Comment tag names the settled finding and alternative

- **WHEN** a finding is demoted for `settled-alternative-reinstated`
- **THEN** the posted review comment SHALL render that finding with a `SETTLED-ALTERNATIVE-REINSTATED` tag containing the settled finding's key, the matched alternative text, and the settling round number

#### Scenario: Event records the matched settled finding and alternative

- **WHEN** a finding is demoted for `settled-alternative-reinstated`
- **THEN** exactly one event SHALL be emitted carrying the demoted finding's key, its surface, the settled finding's key, the settling round number, and the matched alternative text

---

### Requirement: The digest SHALL present override-settled trade-offs as binding settled constraints

The rendered digest SHALL present entries whose resolution is `overridden` as settled constraints of the same standing as `resolved-by-fix` entries, rendering the override's disposition rationale and, when recorded, the alternatives that entry ruled out. The digest preamble SHALL state explicitly that an operator override settles a trade-off as bindingly as a fix does, and that re-raising an override-settled trade-off as blocking — including under a re-framed axis or a new finding key — requires the `prior_round_acknowledgment` field. The preamble text SHALL be covered by a drift-guarding test.

#### Scenario: Override-settled entry renders with rationale and rejected alternatives

- **WHEN** the digest contains an entry with resolution `overridden` carrying an override reason and a non-empty rejected-alternatives list
- **THEN** the rendered digest SHALL show that entry as settled
- **AND** SHALL include its override rationale and its rejected alternatives

#### Scenario: Preamble names override as binding

- **WHEN** the digest is rendered for injection into a review round
- **THEN** the preamble SHALL state that an operator override settles a trade-off as bindingly as a fix does
- **AND** SHALL state that re-raising an override-settled trade-off as blocking requires `prior_round_acknowledgment`

---

### Requirement: The pipeline SHALL expose a pure confidence-trend churn detector over settled axes

`review-history.ts` SHALL expose a pure, deterministic detector that, given a round's blocking findings and the prior-round digest, reports whether the round is suspected churn and, when it is, the settled axes involved with their prior maximum and new confidences. An **axis** SHALL be the `surfaceKey` value. The detector SHALL report suspected churn only when **all** of the following hold: the round has at least one blocking finding; every blocking finding's `surfaceKey` is non-null and every digest entry on that axis is settled (`resolved-by-fix` or `overridden`); every blocking finding carries a `confidence`; every digest entry contributing a prior maximum on those axes carries a `confidence`; and every blocking finding's confidence is strictly less than the prior maximum confidence recorded on its axis. Otherwise it SHALL report no churn. The detector SHALL perform no filesystem, network, git, or subprocess access.

#### Scenario: Declining confidence on wholly settled axes reports churn

- **WHEN** every blocking finding of a round sits on an axis whose digest entries are all settled, and every new confidence is strictly below its axis's prior maximum
- **THEN** the detector SHALL report suspected churn
- **AND** SHALL name each involved axis with its prior maximum and new confidences

#### Scenario: A finding on an unsettled axis suppresses the flag

- **WHEN** one blocking finding of the round sits on an axis with a `still-open` digest entry
- **THEN** the detector SHALL report no suspected churn

#### Scenario: Non-declining confidence suppresses the flag

- **WHEN** every blocking finding sits on a settled axis but one confidence equals or exceeds its axis's prior maximum
- **THEN** the detector SHALL report no suspected churn

#### Scenario: Missing confidence suppresses the flag

- **WHEN** a blocking finding or a prior digest entry on its axis carries no confidence value
- **THEN** the detector SHALL report no suspected churn

#### Scenario: Detector is pure

- **WHEN** the detector is invoked twice with the same findings and digest
- **THEN** it SHALL return the same result both times
- **AND** SHALL make no filesystem, network, git, or subprocess call

