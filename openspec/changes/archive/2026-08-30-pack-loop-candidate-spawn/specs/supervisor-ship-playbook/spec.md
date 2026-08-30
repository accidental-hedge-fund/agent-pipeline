## MODIFIED Requirements

### Requirement: Ship playbook FRG pack wait SHALL inherit Tugboat live-loop wait

The documented alternate chain playbook SHALL inherit Tugboat's Factory Reliability Gate (FRG) pack wait law. Because the playbook execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh`, wait-until-terminal while the bound pack loop is live SHALL apply to a playbook-started ship. Live SHALL mean the same authoritative pack-loop liveness status Tugboat reads from prepare JSON `liveness`. A non-terminal ledger SHALL NOT prove live. The playbook SHALL NOT keep a second pack wait that fails the ship at the CI poll cap while prepare status is `in_progress` and the bound loop is live. Shared pack helpers used by Tugboat and the playbook SHALL stay in sync if wait-continue vs wait-fail classification is shared. Unreadable identity evidence SHALL consume the bounded observation window and then fail closed in those shared helpers. It SHALL NOT count as live after that window.

#### Scenario: Playbook-started ship does not fail a live pack at 20 minutes

- **WHEN** the ship playbook execs Tugboat for milestone `v1.39.5`
- **AND** prepare returns `status: "in_progress"` for a live bound pack loop
- **AND** 20 minutes of wait ticks have elapsed
- **THEN** the ship SHALL NOT mark `frg-pack` failed for wait-budget exhaustion
- **AND** it SHALL keep `state.json` at `frg-pack` / `running`

#### Scenario: Playbook does not keep a second short FRG wait

- **WHEN** an automated check inspects the playbook source and Tugboat wait helpers
- **THEN** the playbook SHALL NOT implement a second FRG wait loop that copies `RELEASE_WAIT_*` as live-loop pack-fail
- **AND** wait-continue vs wait-fail SHALL match Tugboat when those helpers are shared

#### Scenario: Shared helpers treat unreadable liveness as wait-continue

- **WHEN** shared pack helpers classify wait-continue vs wait-fail
- **AND** bound-loop identity evidence is unreadable or malformed
- **AND** the bounded observation window has not expired
- **THEN** the decision SHALL be continue
- **AND** Tugboat and the playbook helpers SHALL match

#### Scenario: Shared helpers treat unreadable identity as fail-closed after the observation window

- **WHEN** shared pack helpers classify wait-continue vs wait-fail
- **AND** bound-loop identity evidence is unreadable or malformed
- **AND** the bounded observation window has expired
- **THEN** the decision SHALL be fail closed with a typed observer or identity error
- **AND** Tugboat and the playbook helpers SHALL match
- **AND** the decision SHALL NOT be continue-as-live
