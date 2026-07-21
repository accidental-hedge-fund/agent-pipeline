## MODIFIED Requirements

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
