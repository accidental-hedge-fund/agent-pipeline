## ADDED Requirements

### Requirement: Config SHALL accept an optional strict `git` block with `push_auth`

`PartialConfigSchema` SHALL accept an optional `git` key. When present, it SHALL validate against a strict sub-schema that may include `push_auth` (string). The admitted `push_auth` values SHALL be:

- `ssh` — SSH transport (also the default when `git` or `push_auth` is absent)
- `https-token:<ENV_NAME>` — HTTPS transport using the environment variable named by `<ENV_NAME>` (env-var name only; never a literal secret)

An unknown key under `git:` SHALL be rejected by strict schema validation. Invalid `push_auth` strings (including empty `https-token:` suffix, non-matching env-var name characters, reserved unimplemented `app`, or values that embed credential material) SHALL cause `resolveConfig()` to throw with a parse error that identifies `git.push_auth` (or the offending field).

The resolved `PipelineConfig` SHALL expose a structured push-auth representation derived from this field (mechanism `ssh` by default; or `https-token` plus the env-var name). Default behavior when the block is absent SHALL remain SSH and SHALL NOT require any new file keys for existing repos.

#### Scenario: git.push_auth ssh accepted

- **WHEN** `.github/pipeline.yml` sets:
  ```yaml
  git:
    push_auth: ssh
  ```
- **THEN** `resolveConfig()` SHALL accept it and resolve push-auth mechanism `ssh`

#### Scenario: git.push_auth https-token with env name accepted

- **WHEN** `.github/pipeline.yml` sets:
  ```yaml
  git:
    push_auth: https-token:GITHUB_PUSH_TOKEN
  ```
- **THEN** `resolveConfig()` SHALL accept it and resolve mechanism `https-token` with token environment name `GITHUB_PUSH_TOKEN`
- **AND** the resolved config SHALL NOT store the secret value of that variable

#### Scenario: git block absent defaults to SSH

- **WHEN** `.github/pipeline.yml` does not include a `git:` key
- **THEN** the resolved config SHALL use push-auth mechanism `ssh`

#### Scenario: unknown key under git rejected

- **WHEN** `.github/pipeline.yml` sets `git: { force_https: true }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the unknown key under `git`

#### Scenario: invalid push_auth value rejected

- **WHEN** `.github/pipeline.yml` sets `git.push_auth` to an invalid value (for example `app`, `https-token:`, or a non-matching form)
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `git.push_auth`

#### Scenario: push_auth never accepts a literal secret as the configured value form

- **WHEN** an operator attempts to set `git.push_auth` to a form that embeds a raw token value rather than `https-token:<ENV_NAME>`
- **THEN** `resolveConfig()` SHALL reject the value
- **AND** SHALL NOT persist that raw token into resolved config
