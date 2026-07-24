## ADDED Requirements

### Requirement: The Pi adapter's missing-CLI install guidance SHALL name the maintained npm package

The Pi adapter's `missing-cli` preflight guidance SHALL direct users to install the
maintained npm package `@earendil-works/pi-coding-agent`, and SHALL NOT name the deprecated
package `@mariozechner/pi-coding-agent`. The deprecated package's own npm notice directs
users to the maintained package, so naming it in the pipeline's user-facing guidance would
install an unmaintained package. This constraint applies to every user-facing occurrence of
the package name in the executable adapter source (the `missing-cli` message and any
provenance comment), and SHALL hold identically in both the `core/` source and its
generated packaged-plugin mirror.

The change SHALL be backed by a regression assertion so the user-facing install guidance
cannot drift back to the deprecated package name. Because the binary name (`pi`) and the
preflight probe arguments are unchanged, this SHALL NOT alter the adapter's presence check,
argv, capabilities, or any preflight outcome other than the text of the install guidance.

#### Scenario: Missing Pi CLI guidance names the maintained package

- **WHEN** the Pi adapter's preflight reports that the `pi` CLI is not present on `PATH`
- **THEN** the returned guidance SHALL name `@earendil-works/pi-coding-agent` as the package
  to install
- **AND** the guidance SHALL NOT contain the deprecated package name
  `@mariozechner/pi-coding-agent`

#### Scenario: A regression assertion guards against drift to the deprecated name

- **WHEN** the adapter test suite runs
- **THEN** an assertion SHALL confirm the Pi adapter's missing-CLI guidance names
  `@earendil-works/pi-coding-agent`
- **AND** that assertion SHALL fail if the deprecated name `@mariozechner/pi-coding-agent`
  reappears in the user-facing install guidance

#### Scenario: Presence detection is unchanged by the guidance update

- **WHEN** the `pi` binary installed by `@earendil-works/pi-coding-agent` is present on
  `PATH`
- **THEN** the Pi adapter's presence check SHALL pass using the same probe arguments as
  before the guidance update
- **AND** the `missing-cli` outcome SHALL be returned only when the `pi` binary is absent
