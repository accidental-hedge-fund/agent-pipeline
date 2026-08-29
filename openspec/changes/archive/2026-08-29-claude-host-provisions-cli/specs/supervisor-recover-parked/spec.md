## MODIFIED Requirements

### Requirement: Unit coverage SHALL prove eligibility, budget, deterministic-first, and fix-vs-override with injected deps

The change SHALL include unit tests that inject I/O via deps and perform no real network, git, or subprocess calls. Coverage SHALL include at least: stale/below-high reflow; structured CRITICAL refuse despite nit prose; same fingerprint after new commit refuses second pass; deterministic scratch/stale-SHA clear without override and without spending senior budget; extra fix allowed for HIGH/CRITICAL while override of those keys is refused. After any `core/` implementation edits, `node scripts/build.mjs` SHALL run and changed SKILL/catalog outputs SHALL be committed when required by the freshness gate; no copied core mirror is required.

#### Scenario: CRITICAL-with-nit-prose fixture refuses override

- **WHEN** unit tests run the recover-parked pure eligibility / command fixture with structured CRITICAL and prose "nit"
- **THEN** the test SHALL fail if an override for that key is recorded

#### Scenario: Deterministic-first fixture records no supervisor override

- **WHEN** unit tests run a scratch-only or stale-SHA park fixture that deterministic recover clears
- **THEN** the test SHALL fail if a supervisor override was recorded or senior fingerprint budget was spent

#### Scenario: Negative fixtures cover each protected structured condition

- **WHEN** unit tests run recover-parked fixtures for structured HIGH, CRITICAL, `category: security`, `human-decision-required`, and missing-authority residuals
- **THEN** each fixture SHALL fail if an override for the protected key/class is recorded
- **AND** classifier prose SHALL not unlock override in any of those fixtures

#### Scenario: Partial-override subset fixture refuses second senior pass

- **WHEN** unit tests spend a pass for keys including both eligible and HIGH/CRITICAL keys, apply only eligible overrides, then re-invoke with the remaining HIGH/CRITICAL subset
- **THEN** the test SHALL fail if a second supervisor pass (override batch or budgeted extra fix) runs for that subset
