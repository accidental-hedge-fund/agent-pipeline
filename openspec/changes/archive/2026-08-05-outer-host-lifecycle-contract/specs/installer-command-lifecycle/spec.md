## ADDED Requirements

### Requirement: Installer host lifecycle actions SHALL be driven by outer-host install profile data

Install, update, and uninstall actions that manage host skill trees and command surfaces SHALL
read managed artifact paths, install mode, and user-owned exclusion rules from the target host's
outer-host install/invocation profile (manifest/registry) rather than treating a closed
host-name switch as the only extension model for new hosts. Built-in hosts MAY keep equivalent
behavior by encoding today's paths and modes in their manifests.

Existing host-specific requirements (Claude config-dir command embedding, uninstall of
`pipeline:*.md` only, dry-run no-write) remain in force; this requirement adds the
manifest-driven extension boundary.

#### Scenario: Managed command install uses profile-declared paths

- **WHEN** install runs for a registered host whose install profile declares a managed commands
  surface and skill tree
- **THEN** the installer SHALL write managed pipeline command/skill artifacts to the declared
  destinations
- **AND** a newly registered host with a complete install profile SHALL NOT require a new
  hard-coded host-name install function as the sole supported way to know those destinations

#### Scenario: Uninstall still preserves non-managed files

- **WHEN** uninstall runs for a host whose install profile declares managed `pipeline:*.md`
  (or equivalent) artifacts
- **AND** the commands directory also contains unrelated user files
- **THEN** only managed pipeline artifacts SHALL be removed
- **AND** unrelated user-owned files SHALL remain
