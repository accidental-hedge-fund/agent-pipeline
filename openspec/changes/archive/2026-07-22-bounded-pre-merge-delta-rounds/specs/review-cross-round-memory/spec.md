## MODIFIED Requirements

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

## ADDED Requirements

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
