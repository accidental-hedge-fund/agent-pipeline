# Hermes factory deployment on `agent-box`

This runbook installs the disabled factory pilot. Hermes is the supervisor.
The native Buzz gateway is the access path. Agent Pipeline remains the work
engine. This deployment does not add an MCP server or a second state machine.

Read the [factory plan](../grok-supervised-factory-plan.md) and the
[source receipts](../../ops/hermes-factory/SOURCES.md) before a live run.

## Trust boundary

The Buzz relay and native gateway enforce relay authentication, private-channel
membership, the operator key allowlist, the channel allowlist, and mention
gating. Hermes supplies the relay-observed user, channel, message, thread, and
time fields to the wrapper. The wrapper checks these fields. It does not verify
the Nostr event signature again.

Hermes and the wrapper run as the `mcomardo` user, which has broad local
authority through passwordless sudo. A malicious same-user process can read or
control local resources. File modes, prompts, process separation, and cgroups
reduce accidental propagation. They do not create a privilege boundary. The
#898 wrapper does not pass the FRG key or its path through candidate process
inputs, and its fixed attestor does not import or execute candidate code. Issues
#618, #899, or later hardening own stronger privilege separation.

Never put a private key, OAuth data, GitHub token, FRG key, operator key,
channel UUID, completed grant, or private network address in this repository.

## Fixed values

| Item | Required value |
|---|---|
| Hermes | tag `v2026.8.3`, package `0.20.0`, commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb` |
| Buzz | tag `v0.5.2`, commit `3e48f1b2365d326ee1c9582448d86a99b44ecd5d` |
| Hermes provider | `xai-oauth` |
| Grok model | `grok-4.5` only |
| Reviewer | Codex |
| Hermes profile | `pipeline-factory` |
| Buzz stream | private `pipeline-factory` |
| First-run production Pipeline | installed Codex skill, version `1.31.1` |
| Production launcher | `/usr/bin/node /home/mcomardo/.codex/skills/pipeline/scripts/pipeline.mjs` |
| External production pin | `/home/mcomardo/.local/state/hermes-factory/production-engine-pin.json` |
| First target release | `v1.33.0` |

Do not use `/usr/local/bin/pipeline`. Do not use a floating Hermes, Buzz, or
Pipeline command.

The first run has three separate code identities:

1. The installed Pipeline `v1.31.1` launcher runs issue waves, merges, pin
   operations, and installed-version checks.
2. The wrapper comes from the exact reviewed and merged pull request #898
   commit. Record it as `wrapper_git_sha`. It is a bootstrap artifact, not a
   released Pipeline checkout.
3. After all issue waves merge, the wrapper fetches final `main` into a clean
   detached control checkout. It records that observed commit as the integrated
   candidate in the journal. It uses this exact checkout for FRG and release
   preparation. This identity is not a static copy of the #898 commit.

Production stays at `v1.31.1` until `v1.33.0` is published and verified. The
factory then promotes the external pin and installs the exact tag. The next run
must use the newly installed launcher. Keep the reviewed #898 wrapper and its
machine config in place. Later releases derive their identities from the
verified installed pin and fresh `main`; they do not require a new wrapper or a
manual release-identity config edit.

## 1. Prepare paths

Run host commands as `mcomardo`. Replace each `REPLACE` value.

```bash
FACTORY_SOURCE_DIR=/REPLACE/WITH/REVIEWED/898/CHECKOUT
CONTROL_DIR=/home/mcomardo/dev/agent-pipeline-factory-control
ARTIFACT_DIR=/home/mcomardo/.local/state/hermes-factory/install-artifact
HERMES_INSTALL_DIR=/home/mcomardo/.local/opt/hermes-agent-v2026.8.3
BUZZ_SOURCE_DIR=/home/mcomardo/.local/src/buzz-v0.5.2
BUZZ_INSTALL_DIR=/home/mcomardo/.local/opt/buzz-v0.5.2
PRODUCTION_PIN=/home/mcomardo/.local/state/hermes-factory/production-engine-pin.json

install -d -m 0755 /home/mcomardo/.local/opt /home/mcomardo/.local/src
install -d -m 0700 \
  /home/mcomardo/.config/hermes-factory \
  /home/mcomardo/.local/state/hermes-factory \
  /home/mcomardo/.local/state/hermes-factory/inbox \
  /home/mcomardo/.local/state/hermes-factory/frg-scorer-requests
```

Create dedicated control and install-artifact clones if they do not exist.
Keep them separate from a developer checkout:

```bash
git clone https://github.com/accidental-hedge-fund/agent-pipeline.git "$CONTROL_DIR"
git clone https://github.com/accidental-hedge-fund/agent-pipeline.git "$ARTIFACT_DIR"
```

Restore the last verified `v1.31.1` production-pin receipt to
`$PRODUCTION_PIN`. Set mode `0600`. Do not infer or generate this receipt from
the current source checkout. Stop if the verified receipt is not available.

Record the current state:

```bash
id
gh auth status
test -r "$PRODUCTION_PIN"
chmod 0600 "$PRODUCTION_PIN"
/usr/bin/node /home/mcomardo/.codex/skills/pipeline/scripts/pipeline.mjs --version
AGENT_PIPELINE_PRODUCTION_PIN="$PRODUCTION_PIN" \
  /usr/bin/node /home/mcomardo/.codex/skills/pipeline/scripts/pipeline.mjs \
  factory-pin show
```

The version must be `1.31.1`. Stop if the external pin and the installed
version do not agree.

## 2. Install pinned Hermes and Buzz

Download and verify the exact Hermes installer:

```bash
HERMES_INSTALLER_FILE="$(mktemp)"
trap 'rm -f "$HERMES_INSTALLER_FILE"' EXIT
curl -fsSL \
  https://raw.githubusercontent.com/NousResearch/hermes-agent/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/scripts/install.sh \
  -o "$HERMES_INSTALLER_FILE"
printf '%s  %s\n' \
  45f589461248c7a6ec3aecd7522a69dd49c5c8dbf4798ba1296af5c0c5e7ccd3 \
  "$HERMES_INSTALLER_FILE" | sha256sum -c -

bash "$HERMES_INSTALLER_FILE" \
  --branch main \
  --commit 3c27eb6234bf91b8ceee9e9071591b31e9b148cb \
  --force-commit \
  --dir "$HERMES_INSTALL_DIR" \
  --hermes-home /home/mcomardo/.hermes \
  --skip-setup --skip-browser --no-skills
```

Verify the source and package:

```bash
test "$(git -C "$HERMES_INSTALL_DIR" rev-parse HEAD)" = \
  3c27eb6234bf91b8ceee9e9071591b31e9b148cb
git -C "$HERMES_INSTALL_DIR" diff --quiet
git -C "$HERMES_INSTALL_DIR" diff --cached --quiet
test "$("$HERMES_INSTALL_DIR/venv/bin/python" -c \
  'import importlib.metadata; print(importlib.metadata.version("hermes-agent"))')" = 0.20.0
```

Buzz v0.5.2 has no Linux CLI release asset. Build the exact source:

```bash
git clone https://github.com/block/buzz.git "$BUZZ_SOURCE_DIR"
git -C "$BUZZ_SOURCE_DIR" checkout --detach \
  3e48f1b2365d326ee1c9582448d86a99b44ecd5d
test "$(git -C "$BUZZ_SOURCE_DIR" rev-parse v0.5.2^{commit})" = \
  3e48f1b2365d326ee1c9582448d86a99b44ecd5d
git -C "$BUZZ_SOURCE_DIR" diff --quiet
git -C "$BUZZ_SOURCE_DIR" diff --cached --quiet

rustup toolchain install 1.95.0 --profile minimal
cargo +1.95.0 build --manifest-path "$BUZZ_SOURCE_DIR/Cargo.toml" \
  --locked --release -p buzz-cli
install -Dm0755 "$BUZZ_SOURCE_DIR/target/release/buzz" \
  "$BUZZ_INSTALL_DIR/bin/buzz"
sha256sum "$BUZZ_INSTALL_DIR/bin/buzz" | \
  tee "$BUZZ_INSTALL_DIR/buzz.sha256"
```

Keep the binary digest in the host deployment record. `buzz --version` does
not prove the source tag for this release.

## 3. Create the Buzz identity and stream

Use a Buzz owner identity for these steps:

1. Create a dedicated Nostr keypair for Hermes.
2. Create one stream named `pipeline-factory` with private visibility.
3. Add the operator and the Hermes identity. Give Hermes the Bot role.
4. Record the channel UUID, factory 64-hex public key, and operator lowercase
   64-hex public key.
5. Remove every unexpected member.

Example owner commands are:

```bash
buzz channels create --name pipeline-factory --type stream --visibility private
buzz channels add-member --channel REPLACE_CHANNEL_UUID \
  --pubkey REPLACE_FACTORY_HEX_PUBKEY --role bot
buzz channels members --channel REPLACE_CHANNEL_UUID
```

## 4. Fix split DNS and verify TLS

```bash
BUZZ_FQDN=REPLACE_WITH_BUZZ_FQDN
getent ahosts "$BUZZ_FQDN"
resolvectl query "$BUZZ_FQDN"
curl -fsS "https://$BUZZ_FQDN/health"
openssl s_client -connect "$BUZZ_FQDN:443" \
  -servername "$BUZZ_FQDN" -verify_return_error </dev/null
```

The health response must be `ok`. TLS must verify for the exact host name.

Tailscale split DNS can claim a parent zone and return `SERVFAIL` for the public
Buzz name. Compare the system result with the expected resolver:

```bash
resolvectl status
tailscale status
dig +short "$BUZZ_FQDN"
dig +short @REPLACE_WITH_EXPECTED_DNS_SERVER "$BUZZ_FQDN"
```

Correct the DNS route or conditional forwarder. Do not add an `/etc/hosts`
entry. Repeat the system-resolver and TLS checks after the correction.

## 5. Install the private Hermes profile

```bash
HERMES_PYTHON="$HERMES_INSTALL_DIR/venv/bin/python"
PROFILE_DIR=/home/mcomardo/.hermes/profiles/pipeline-factory

"$HERMES_PYTHON" -m hermes_cli.main profile create pipeline-factory \
  --description "Supervises one scoped Agent Pipeline release."

install -Dm0600 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/hermes/config.yaml.example" \
  "$PROFILE_DIR/config.yaml"
install -Dm0600 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/hermes/profile.env.example" \
  "$PROFILE_DIR/.env"
install -Dm0600 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/hermes/buzz-credentials.json.example" \
  "$PROFILE_DIR/buzz-credentials.json"
install -Dm0444 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/hermes/SOUL.md.example" \
  "$PROFILE_DIR/SOUL.md"
install -Dm0444 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/hermes/skills/pipeline-factory/SKILL.md" \
  "$PROFILE_DIR/skills/pipeline-factory/SKILL.md"
```

Replace all placeholders in the three mode `0600` files. Put the dedicated
`nsec` only in `buzz-credentials.json`. The profile `.env` contains only the
credential-file path and an optional NIP-OA tag. The factory controller does
not load this file.

Keep these exact settings:

- `model.provider: xai-oauth`;
- `model.default: grok-4.5`;
- `fallback_providers: []` and no `fallback_model`;
- `platform_toolsets.buzz: [terminal, no_mcp]`;
- one private channel UUID, one operator key, and `require_mention: true`;
- operator slash commands limited to `status`;
- curator disabled and skill files read-only.

Complete the profile-specific OAuth flow:

```bash
"$HERMES_PYTHON" -m hermes_cli.main -p pipeline-factory \
  auth add xai-oauth --no-browser
"$HERMES_PYTHON" -m hermes_cli.main -p pipeline-factory doctor
```

Do not set `XAI_API_KEY` as a fallback.

## 6. Provision and prove the FRG key

The host FRG key must match the GitHub Actions secret used by auto-tag. GitHub
does not permit secret readback. If the current common value is not known,
rotate both copies in one controlled session:

```bash
set +x
FRG_KEY_FILE=/home/mcomardo/.config/hermes-factory/frg-attestation-key
umask 077
openssl rand -hex 32 | tee "$FRG_KEY_FILE" | \
  gh secret set PIPELINE_FRG_ATTESTATION_KEY \
  --repo accidental-hedge-fund/agent-pipeline
chmod 0600 "$FRG_KEY_FILE"
```

The long-lived gateway and the live factory controller do not load this file.
Only the separate FRG scorer and tag-validation unit loads it as a systemd
credential. The wrapper does not put the key or its path in the candidate
environment, inherited file descriptors, candidate-action cgroup credential
mount, request, result, error, log, or notice. The fixed attestor does not
import or execute candidate code, start a child process, or use the network.

Mode `0600` on `$FRG_KEY_FILE` reduces accidental exposure. It does not stop a
malicious `mcomardo` process or passwordless sudo from reading or controlling
local resources. The pilot accepts this limitation. Issues #618, #899, or later
hardening own privilege separation.

Use the example challenge workflow in a separate reviewed change. Generate a
public random challenge. Run the workflow and the local script on the same
challenge:

```bash
CHALLENGE="$(openssl rand -hex 32)"
PIPELINE_FRG_ATTESTATION_KEY_FILE="$FRG_KEY_FILE" \
  /usr/bin/node \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/calibration/frg-key-challenge.mjs" \
  "$CHALLENGE"
```

The reviewed workflow is
`ops/hermes-factory/calibration/frg-key-challenge.workflow.yml.example`.
Its log prints only the public challenge and its HMAC. The local and Actions
`hmac_sha256` values must be equal. A mismatch means the keys differ. Rotate
both copies and repeat. Do not print or copy the secret. Remove the temporary
challenge workflow after the proof. Keep the Actions secret for auto-tag.

## 7. Install the wrapper and services

First, prove that the wrapper source is the exact reviewed and merged #898
commit. Do not copy it from a release tag:

```bash
WRAPPER_GIT_SHA=REPLACE_WITH_MERGED_898_COMMIT
test "$WRAPPER_GIT_SHA" != 0000000000000000000000000000000000000000
test "$(git -C "$FACTORY_SOURCE_DIR" rev-parse HEAD)" = "$WRAPPER_GIT_SHA"
git -C "$FACTORY_SOURCE_DIR" diff --quiet
git -C "$FACTORY_SOURCE_DIR" diff --cached --quiet

install -d -m 0755 /home/mcomardo/.local/lib/hermes-factory
cp -a "$FACTORY_SOURCE_DIR/ops/hermes-factory/." \
  /home/mcomardo/.local/lib/hermes-factory/
```

Install and edit the machine config. Keep `enabled` set to `false`:

```bash
install -Dm0600 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/config.example.json" \
  /home/mcomardo/.config/hermes-factory/config.json
install -Dm0600 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/deployment-receipt.json.example" \
  /home/mcomardo/.local/state/hermes-factory/deployment-receipt.json

install -Dm0644 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/systemd/hermes-gateway-pipeline-factory.service" \
  /home/mcomardo/.config/systemd/user/hermes-gateway-pipeline-factory.service
install -Dm0644 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/systemd/hermes-factory.service" \
  /home/mcomardo/.config/systemd/user/hermes-factory.service
install -Dm0644 \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/systemd/hermes-factory-frg@.service" \
  /home/mcomardo/.config/systemd/user/hermes-factory-frg@.service
```

Set `wrapper_git_sha` to the #898 commit. For the v1.33.0 bootstrap only, set
`bootstrap_base_git_sha` to the exact clean `main` commit at the start of the
issue train and set `candidate_version` to the bootstrap target. Set
`production_pin_file` to the fixed external path. Keep the production launcher
exact. Keep `frg_scorer_unit_template` set to
`hermes-factory-frg@.service`. Set `frg_scorer_request_dir` to the mode `0700`
request directory under the factory state. Set `pipeline_loop_state_dir` to the
exact host Pipeline loop-run directory. Configure the standalone pinned Hermes
sender as `notification_command`:

```json
[
  "/home/mcomardo/.local/opt/hermes-agent-v2026.8.3/venv/bin/python",
  "-m", "hermes_cli.main", "-p", "pipeline-factory", "send",
  "--to", "buzz:{chat_id}:{thread_id}", "--file", "-", "--quiet"
]
```

This notifier reads JSON from standard input. It loads the Buzz credential
inside the pinned Hermes process. The controller never receives the Nostr key.

The candidate launcher must point to the control checkout. The wrapper must
fetch and bind the clean detached final-main commit after the issue train. It
must verify the observed commit, target version, FRG pack manifest, and command
paths before it starts FRG or release work. After v1.33.0, do not update static
bootstrap-base or candidate-version values to select a release. The stable
wrapper derives the next start from the verified installed pin and fresh
`main`, then uses the candidate-native handoff described below.

Fill the local deployment receipt as each identity is proved. Record the
integrated candidate from the wrapper journal after the issue train. Do not put
an operator key, channel UUID, credential, or grant in this receipt.

Verify systemd syntax and enable linger:

```bash
systemd-analyze --user verify \
  /home/mcomardo/.config/systemd/user/hermes-gateway-pipeline-factory.service \
  /home/mcomardo/.config/systemd/user/hermes-factory.service \
  /home/mcomardo/.config/systemd/user/hermes-factory-frg@.service
sudo loginctl enable-linger mcomardo
loginctl show-user mcomardo -p Linger
systemctl --user daemon-reload
systemctl --user enable --now hermes-gateway-pipeline-factory.service
systemctl --user is-enabled hermes-gateway-pipeline-factory.service
systemctl --user is-enabled hermes-factory.service || true
```

`Linger=yes` is required. The gateway must be enabled. The factory release unit
and scorer template must be disabled or static. They have no `[Install]`
section.

The wrapper creates a mode `0700` request directory at
`~/.local/state/hermes-factory/frg-scorer-requests`. It writes one
create-exclusive `%i.json` request there. It then starts the matching
`hermes-factory-frg@%i.service` instance and polls for one bounded result. The
template runs only the fixed wrapper-local trusted attestor in
`frg-runner.mjs score`. The wrapper does not pass the credential or its path to
the synthetic issue loop or candidate process through its environment,
inherited file descriptors, or cgroup credential mount. The scorer reads
`$CREDENTIALS_DIRECTORY/frg_attestation_key`, validates and scores the exact
unsigned evidence, and writes only the bounded result. It starts no child
process, uses no network, and does not import or execute candidate code or other
request-selected code.

The attestation request contains only versioned identity fields,
wrapper-approved data paths under fixed allowed roots, and expected digests.
It must not contain the candidate checkout as an executable source, an
executable path, module name, command, network target, caller pass claim, or
candidate-selected signer. The scorer rejects traversal, symlink escape,
unexpected file types, digest mismatch, and fields outside the closed schema.
It does not run a model, issue loop, merge, install, or general shell.

For v1.33.0, the scorer uses the policy snapshot pinned with the reviewed #898
wrapper. For each later release, it uses only the signer from the verified
current production engine through the wrapper-owned closed selection rule. It
stops on an unsupported request schema, evidence schema, signer, or policy. It
never loads a signer from the candidate.
The scorer unit uses `BindsTo=` and `PartOf=` for
`hermes-factory.service`. Stopping the live factory therefore also stops an
active credential-bearing scorer.

The wrapper runs each durable Pipeline mutation in a transient user unit. Its
name binds the grant fingerprint, action kind, and action ID. The wrapper stores
the unit name, Pipeline run ID, JSONL event path, and last event cursor in the
journal. Mode `0700` action directories contain bounded output and diagnostic
files. A mode `0600` child environment file exists only while its unit runs.
The wrapper removes that file after completion. It never contains the Buzz or
FRG key. Do not enable a transient unit or reuse it for another action.

## 8. Run the calibration gate

Keep the production machine config disabled during all pre-enable checks.

### Profile path, artifact, and service identity

```bash
HERMES_HOME="$PROFILE_DIR" "$HERMES_PYTHON" -m hermes_cli.main \
  -p pipeline-factory profile show pipeline-factory | \
  tee /home/mcomardo/.local/state/hermes-factory/profile-show.txt
rg -F "$PROFILE_DIR" \
  /home/mcomardo/.local/state/hermes-factory/profile-show.txt

sha256sum -c "$BUZZ_INSTALL_DIR/buzz.sha256"
systemctl --user show hermes-gateway-pipeline-factory.service \
  -p ExecStart -p Environment -p UnsetEnvironment
systemctl --user show hermes-factory.service \
  -p ExecStart -p Environment -p UnsetEnvironment -p LoadCredential
systemctl --user cat hermes-factory-frg@.service
```

The profile command must resolve to exactly `pipeline-factory`. The service
must use the versioned Python and Buzz paths. The gateway and factory controller
must not have the Buzz key or FRG key in their systemd environment or credential
set. Only the separate scorer unit can receive the FRG credential.

### Model, fallback, and live tool catalog

```bash
"$HERMES_PYTHON" -m hermes_cli.main -p pipeline-factory \
  config get model.provider
"$HERMES_PYTHON" -m hermes_cli.main -p pipeline-factory \
  config get model.default
"$HERMES_PYTHON" -m hermes_cli.main -p pipeline-factory fallback list
HERMES_HOME="$PROFILE_DIR" "$HERMES_PYTHON" \
  "$FACTORY_SOURCE_DIR/ops/hermes-factory/calibration/check-hermes-buzz-scope.py"
```

Require `xai-oauth`, `grok-4.5`, and no fallback. The scope script must report
only the `terminal` toolset and the `terminal` and `process` tools. It must not
report MCP, file, browser, delegation, update, configuration, or skill tools.

Run one harmless status turn. Use provider/runtime metadata to prove the
effective model is `grok-4.5`. Do not use the model's own text as identity
proof.

### Prove update and self-modification denial

Save the installed profile hashes:

```bash
sha256sum "$PROFILE_DIR/config.yaml" "$PROFILE_DIR/SOUL.md" \
  "$PROFILE_DIR/skills/pipeline-factory/SKILL.md" > \
  /home/mcomardo/.local/state/hermes-factory/profile.sha256
```

From the operator identity, send each command in the private channel:

```text
/update
/config
/skills
/learn
/curator
/reload-skills
```

The gateway must deny each command. The service must not restart or update.
Then run:

```bash
sha256sum -c \
  /home/mcomardo/.local/state/hermes-factory/profile.sha256
journalctl --user -u hermes-gateway-pipeline-factory.service \
  --since '10 minutes ago' --no-pager -o cat
```

The hashes must not change. The exact catalog check must still pass. The
operator is not a slash-command admin. Prompt and slash limits are not an OS
boundary: the Terminal tool still runs as `mcomardo`.

### Production Pipeline doctor

Use the installed `v1.31.1` launcher and the external pin in one transient
unit:

```bash
PIPELINE_DOCTOR_UNIT="pipeline-factory-doctor-$(date +%s)"
systemd-run --user --collect --wait --pipe \
  --unit "$PIPELINE_DOCTOR_UNIT" \
  --property="WorkingDirectory=$CONTROL_DIR" \
  --setenv="PATH=/home/mcomardo/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  --setenv="AGENT_PIPELINE_PRODUCTION_PIN=$PRODUCTION_PIN" \
  /usr/bin/node \
  /home/mcomardo/.codex/skills/pipeline/scripts/pipeline.mjs \
  doctor --json --harness-smoke --engine-track pinned \
  --repo-path "$CONTROL_DIR" --base main --profile codex
```

The doctor result must pass and must identify version `1.31.1`.

### Buzz membership, send, receive, and NIP-42

Use the dedicated credential only in the exact Buzz process:

```bash
BUZZ_PRIVATE_KEY="$(jq -er .nsec "$PROFILE_DIR/buzz-credentials.json")" \
BUZZ_RELAY_URL="https://$BUZZ_FQDN" \
  "$BUZZ_INSTALL_DIR/bin/buzz" users get | jq -e .
BUZZ_PRIVATE_KEY="$(jq -er .nsec "$PROFILE_DIR/buzz-credentials.json")" \
BUZZ_RELAY_URL="https://$BUZZ_FQDN" \
  "$BUZZ_INSTALL_DIR/bin/buzz" channels members \
  --channel REPLACE_CHANNEL_UUID | jq -e .
```

Require the exact private channel, operator membership, Hermes Bot membership,
and no unexpected member.

Send one harmless outbound message through the same pinned notifier path:

```bash
printf '%s\n' 'factory calibration: outbound' | \
  "$HERMES_PYTHON" -m hermes_cli.main -p pipeline-factory send \
  --to buzz:REPLACE_CHANNEL_UUID:REPLACE_THREAD_EVENT_ID \
  --file - --quiet
```

The operator must see the message in the exact thread. The operator then sends
a unique mentioned status message. Hermes must reply in the same thread. Send
the same message without a mention. Hermes must not act. Add a temporary second
identity to the channel. A mentioned message from it must be denied. Remove the
temporary identity.

Restart the native gateway and prove WebSocket NIP-42 operation:

```bash
systemctl --user restart hermes-gateway-pipeline-factory.service
systemctl --user is-active hermes-gateway-pipeline-factory.service
journalctl --user -u hermes-gateway-pipeline-factory.service \
  --since '5 minutes ago' --no-pager -o cat | \
  rg 'Buzz: connected .* via websocket'
```

The config uses `transport: websocket`. A NIP-42 failure must stop the gateway.
Do not accept a polling fallback.

### Rollback-path rehearsal

Reinstall the current verified production pin before a live grant. This tests
the rollback artifact and install path without selecting a new version:

```bash
PIN_SHA256_BEFORE="$(sha256sum "$PRODUCTION_PIN" | cut -d' ' -f1)"
REHEARSAL_TAG="$(jq -er '.pin.tag' "$PRODUCTION_PIN")"
REHEARSAL_SHA="$(jq -er '.pin.git_sha' "$PRODUCTION_PIN")"
test "$REHEARSAL_TAG" = v1.31.1

git -C "$ARTIFACT_DIR" fetch origin \
  "refs/tags/$REHEARSAL_TAG:refs/tags/$REHEARSAL_TAG"
test "$(git -C "$ARTIFACT_DIR" cat-file -t \
  "refs/tags/$REHEARSAL_TAG")" = tag
test "$(git -C "$ARTIFACT_DIR" rev-parse \
  "refs/tags/$REHEARSAL_TAG^{}")" = "$REHEARSAL_SHA"
git -C "$ARTIFACT_DIR" checkout --detach "$REHEARSAL_SHA"

for host in claude codex grok; do
  AGENT_PIPELINE_PRODUCTION_PIN="$PRODUCTION_PIN" \
    /usr/bin/node "$ARTIFACT_DIR/scripts/install.mjs" install --host "$host"
done

test "$(sha256sum "$PRODUCTION_PIN" | cut -d' ' -f1)" = \
  "$PIN_SHA256_BEFORE"
test "$(/usr/bin/node \
  /home/mcomardo/.codex/skills/pipeline/scripts/pipeline.mjs --version)" = \
  1.31.1
```

Run the transient production doctor again. If the pin changes, a host install
fails, or doctor fails, keep the factory disabled.

### Scope rejection, redaction, and fail-closed start

Use a separate calibration config and state directory. Keep the production
config disabled. The calibration config can be enabled only after the operator
approves its bounded test grant. Never start `factory.mjs run` with this grant.

Use `validate` on the inbox file. Change one repository, base, sender, channel,
issue limit, expiry, or model field and prove rejection before any GitHub
mutation. Admit the unchanged calibration grant into its separate state. Run
`calibrate-notice` with a random non-secret canary. Require `[REDACTED]` in the
thread and no raw canary in Buzz, journals, service logs, profile logs, prompts,
or committed files.

```bash
CALIBRATION_CONFIG=/home/mcomardo/.config/hermes-factory/calibration.json
CALIBRATION_GRANT=/home/mcomardo/.local/state/hermes-factory-calibration/inbox/REPLACE_EVENT_ID.json
CALIBRATION_ACTIVE=/home/mcomardo/.local/state/hermes-factory-calibration/active-grant.json

/usr/bin/node /home/mcomardo/.local/lib/hermes-factory/factory.mjs admit \
  --config "$CALIBRATION_CONFIG" --grant "$CALIBRATION_GRANT"
export PIPELINE_FACTORY_SECRET_CANARY="factory-calibration-$(openssl rand -hex 16)"
/usr/bin/node /home/mcomardo/.local/lib/hermes-factory/factory.mjs \
  calibrate-notice --config "$CALIBRATION_CONFIG" \
  --grant "$CALIBRATION_ACTIVE" \
  --canary-env PIPELINE_FACTORY_SECRET_CANARY

if rg -F "$PIPELINE_FACTORY_SECRET_CANARY" \
  /home/mcomardo/.local/state/hermes-factory-calibration \
  "$PROFILE_DIR/logs"; then
  exit 1
fi
if journalctl --user \
  -u hermes-gateway-pipeline-factory.service \
  -u hermes-factory.service --no-pager -o cat | \
  rg -F "$PIPELINE_FACTORY_SECRET_CANARY"; then
  exit 1
fi
if git -C "$FACTORY_SOURCE_DIR" grep -F -- \
  "$PIPELINE_FACTORY_SECRET_CANARY"; then
  exit 1
fi
```

Also search the last Buzz thread through the pinned CLI. It must contain
`[REDACTED]` and no canary value. Then run
`unset PIPELINE_FACTORY_SECRET_CANARY`.

With the production config still disabled, a manual factory-unit start must
fail before a GitHub mutation:

```bash
systemctl --user start hermes-factory.service || true
systemctl --user status hermes-factory.service --no-pager
/usr/bin/node /home/mcomardo/.local/lib/hermes-factory/factory.mjs status \
  --config /home/mcomardo/.config/hermes-factory/config.json
systemctl --user reset-failed hermes-factory.service
```

Rehearse gateway stop and restart. Keep the factory disabled after any failed
or incomplete check.

## 9. Accept the live grant and bind the final candidate

For the first v1.33.0 admission, the control checkout must be clean at the
configured `bootstrap_base_git_sha`, and the configured `candidate_version`
must match the grant. The wrapper runs the issue train with the installed
production launcher. After the last merge, it fetches `origin/main`, verifies
that local `HEAD` equals the fetched remote, detaches at that commit, proves a
clean checkout, and records the commit in the journal. It then verifies the
grant target and FRG manifest before FRG starts.

Do not use `--engine-track candidate` as code identity. The absolute candidate
launcher, the detached commit, and the persisted journal identity select the
candidate code.

After all calibration checks pass, set `enabled` to `true`. This enables the
wrapper but does not start the release unit.

The operator sends the exact live grant as a root message in the private
channel and mentions Hermes. Hermes uses only inbound relay context. It writes
the envelope with mode `0600` under the configured inbox and runs `admit`:

```bash
/usr/bin/node /home/mcomardo/.local/lib/hermes-factory/factory.mjs admit \
  --config /home/mcomardo/.config/hermes-factory/config.json \
  --grant /home/mcomardo/.local/state/hermes-factory/inbox/REPLACE_EVENT_ID.json
```

Hermes must send an acknowledgment in the exact grant thread. It must include
the event ID, grant fingerprint, repository, base, release, ordered issues,
expiry, and allowed actions. It must not include raw JSON or a secret.

If no acknowledgment arrives, query the thread and wrapper status. Resend the
exact content and nonce in the same thread. Do not create a second scope. The
wrapper must reconcile duplicate event identities before it admits a new file.

After the exact acknowledgment arrives:

```bash
systemctl --user start hermes-factory.service
```

Do not enable this unit.

### Later release handoff

The v1.33.0 hybrid ends when v1.33.0 is installed. In v1.34.0, land #890 and
#891 before #908 and #909. Issue #908 must expose this exact command from the
integrated candidate checkout:

```text
pipeline factory-release prepare --request <absolute-request.json> --json
```

For v1.34.0 and each later release, the unchanged #898 wrapper must:

1. Verify that the installed launcher, external production pin, exact tag, and commit agree.
2. Fetch current `main` and derive the new starting frontier from the verified pin plus that fresh base state.
3. Bind the final integrated candidate after the granted issue train.
4. Write the versioned, secret-free candidate request under the active grant state directory and invoke the exact candidate command above without the FRG credential.
5. Require `awaiting_frg_attestation` with only the exact unsigned artifact identities, digests, and restart checkpoint. A repeat call before attestation must return the same state without another pack.
6. Submit only the closed data paths and digests to the fixed trusted attestor. Require the verified current production signer and stop on an unsupported schema or policy.
7. Invoke the same candidate command with the unchanged request. Require `complete` with one exact release pull request and head. A repeat call must return the same result without another branch or pull request.
8. Stop if either call or the attestation fails or returns mismatched evidence. Do not fall back to the v1.33.0 hybrid.
9. After publication, promote and install the exact release, pass doctor, and prove that the next grant uses the new engine.

Do not replace the wrapper or edit static bootstrap-base or candidate-version
config for these later releases. A two-release integration check must start
from the verified v1.33.0 pin, exercise both #908 calls and the intervening
production-owned attestation, install v1.34.0, and prove that the following
grant uses v1.34.0 and then-current `main`. It must also prove no automatic key
or key-path propagation through the candidate environment, inherited file
descriptors, candidate-action cgroup credential mount, request, or result; no
candidate import or execution by the attestor; request-selected import and
network denial; and secret redaction in errors, logs, and notices.

## 10. Monitor, stop, and restart

Buzz is the normal progress view. It shows redacted material events and bounded
heartbeats. A Buzz delivery failure does not change Pipeline state.

Use host evidence when Buzz is unavailable:

```bash
systemctl --user status hermes-gateway-pipeline-factory.service --no-pager
systemctl --user status hermes-factory.service --no-pager
systemctl --user list-units 'hermes-factory-*' --all
journalctl --user -u hermes-gateway-pipeline-factory.service -f -o cat
journalctl --user -u hermes-factory.service -f -o cat
journalctl --user -u 'hermes-factory-frg@*.service' -f -o cat
/usr/bin/node /home/mcomardo/.local/lib/hermes-factory/factory.mjs status \
  --config /home/mcomardo/.config/hermes-factory/config.json
AGENT_PIPELINE_PRODUCTION_PIN="$PRODUCTION_PIN" \
  /usr/bin/node /home/mcomardo/.codex/skills/pipeline/scripts/pipeline.mjs \
  factory-pin show
```

For a normal stop, send a stop or revoke event in the active Buzz thread. For
an emergency host stop:

```bash
systemctl --user stop hermes-factory.service
systemctl --user list-units 'hermes-factory-*' --state=running
systemctl --user stop REPLACE_WITH_EXACT_RECORDED_TRANSIENT_UNIT
```

Read the exact transient unit from the active journal. Verify that its grant
fingerprint and action ID match before you stop it. Do not stop an unverified
unit name. Prove that no matching action or scorer unit remains active.

A stop, revocation, or expiry blocks all new forward actions. If pin promotion
or installation already changed production state, the wrapper may complete only
the grant-scoped compensation that restores the stored prior pin and exact tag
and runs doctor. It must not merge, publish, or continue the release. It stops
after it proves rollback or reports that rollback could not be proved.

Before a restart, prove that the grant is unchanged and unexpired. Reconcile
the journal with Pipeline, Git, GitHub, publication, the external pin, and the
installed launcher. Then run:

```bash
systemctl --user reset-failed hermes-factory.service
systemctl --user start hermes-factory.service
```

## 11. Roll back

Rollback does not undo merged work. It does not rewrite a published tag or
GitHub Release.

1. Stop the factory.
2. Set the machine config to `enabled: false`.
3. Stop and disable the gateway if the access path is unsafe.
4. Revoke the factory Buzz identity when needed.
5. Restore the last verified value in the external production pin.
6. Fetch and verify the exact annotated tag in the install-artifact checkout.
7. Install that exact tag for each configured host.
8. Run doctor through the installed launcher with the same external pin.

Use only the external pin path:

```bash
systemctl --user stop hermes-factory.service
systemctl --user list-units 'hermes-factory-*' --state=running
# Stop the exact journal-bound action or scorer unit before rollback.
AGENT_PIPELINE_PRODUCTION_PIN="$PRODUCTION_PIN" \
  /usr/bin/node /home/mcomardo/.codex/skills/pipeline/scripts/pipeline.mjs \
  factory-pin rollback

RESTORED_TAG="$(jq -er '.pin.tag' "$PRODUCTION_PIN")"
RESTORED_SHA="$(jq -er '.pin.git_sha' "$PRODUCTION_PIN")"
git -C "$ARTIFACT_DIR" fetch origin "refs/tags/$RESTORED_TAG:refs/tags/$RESTORED_TAG"
test "$(git -C "$ARTIFACT_DIR" cat-file -t "refs/tags/$RESTORED_TAG")" = tag
test "$(git -C "$ARTIFACT_DIR" rev-parse "refs/tags/$RESTORED_TAG^{}")" = \
  "$RESTORED_SHA"
git -C "$ARTIFACT_DIR" checkout --detach "$RESTORED_SHA"
for host in claude codex grok; do
  AGENT_PIPELINE_PRODUCTION_PIN="$PRODUCTION_PIN" \
    /usr/bin/node "$ARTIFACT_DIR/scripts/install.mjs" install --host "$host"
done

AGENT_PIPELINE_PRODUCTION_PIN="$PRODUCTION_PIN" \
  /usr/bin/node /home/mcomardo/.codex/skills/pipeline/scripts/pipeline.mjs \
  doctor --json --harness-smoke --engine-track pinned \
  --repo-path "$CONTROL_DIR" --base main --profile codex
```

If rollback or doctor is not proved, keep both units stopped. Keep versioned
artifacts and journals for diagnosis.
