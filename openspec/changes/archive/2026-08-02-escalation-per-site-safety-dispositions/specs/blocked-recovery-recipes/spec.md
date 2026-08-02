## ADDED Requirements

### Requirement: Every setBlocked production site SHALL couple to the escalation disposition inventory

Every production `setBlocked` call site SHALL appear in the escalation-site disposition inventory
with a stable site id, module path, blocker kind (when known), and safety disposition. The
existing `BlockerKind` / `BLOCKER_RECIPES` exhaustiveness requirements remain in force: kind-specific
operator recipes continue to render for human unblock guidance. Disposition governs automatic
retry eligibility before the block is raised; recipes govern post-block operator guidance. A site
MUST NOT call `setBlocked` for a pure `transient-retryable` failure until the site-local bounded
wrapper has exhausted its budget (or a non-transient classification is proven).

#### Scenario: Inventory row exists for each production setBlocked site

- **WHEN** the disposition drift-guard scans production `setBlocked` call sites
- **THEN** each site SHALL match an inventory entry carrying disposition and site id
- **AND** the test SHALL fail if a site is missing

#### Scenario: Transient-retryable path does not first-hop setBlocked on a single 5xx

- **WHEN** a `transient-retryable` site encounters a single retryable gh 5xx before budget
  exhaustion
- **THEN** the site SHALL retry via its wrapper
- **AND** SHALL NOT call `setBlocked` solely for that first transient failure

#### Scenario: BlockerKind recipes remain exhaustive

- **WHEN** a new `BlockerKind` is required by a dispositioned site
- **THEN** `BLOCKER_RECIPES` and recipe snapshot coverage SHALL include that kind
- **AND** the kind SHALL project into the canonical stage-diagnostic reason vocabulary
)