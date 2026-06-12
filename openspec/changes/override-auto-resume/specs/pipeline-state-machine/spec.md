## MODIFIED Requirements

### Requirement: needs-human is resumable via --override without manual relabeling

The `needs-human` stage SHALL be resumable by the `--override` path without the operator manually relabeling the issue. When `--override` is invoked on an item at `needs-human`, the pipeline SHALL read the target review round from the `## Pipeline: Review ceiling reached` comment, flip the label from `pipeline:needs-human` to `pipeline:review-<round>`, and enter the advance loop. The advance loop's `needs-human` break point (for non-override entry) SHALL remain unchanged — only the `--override` code path performs the automatic flip.

#### Scenario: --override on needs-human reads round from ceiling comment

- **WHEN** an operator invokes `--override` on an item at stage `needs-human`
- **AND** the item has a `## Pipeline: Review ceiling reached` comment encoding `round: N`
- **THEN** the pipeline SHALL flip the label to `pipeline:review-N` before entering the advance loop
- **AND** SHALL NOT require the operator to relabel manually

#### Scenario: advance loop still breaks on needs-human without --override

- **WHEN** the advance loop reaches `needs-human` via normal stage progression (not via `--override`)
- **THEN** the loop SHALL break and surface the ceiling comment, unchanged from prior behavior
- **AND** SHALL NOT attempt to flip the label automatically
