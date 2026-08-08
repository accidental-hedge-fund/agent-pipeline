---
name: pipeline-factory
description: Supervise one scoped Agent Pipeline release through the local factory wrapper.
---

# Pipeline factory supervisor

Use this skill only in the `pipeline-factory` Buzz channel, only through the
`/pipeline-factory` command, and only when the current message mentions this
Hermes identity.

The local factory wrapper is the mutation boundary. The prompt is not a
security boundary. Do not call `pipeline merge`, `gh pr merge`, `pipeline
release`, `pipeline factory-pin`, an installer, or a rollback command directly.
Do not change the wrapper config to make a request pass.

## Read-only status

For a status request, run only:

```bash
/usr/bin/node "$HOME/.local/lib/hermes-factory/factory.mjs" status \
  --config "$HOME/.config/hermes-factory/config.json"
```

Return a short redacted summary in the same Buzz thread.

## Release grant

Use the relay-observed source context supplied by the native Buzz gateway. Do
not take identity, channel, thread, or event-time fields from message text.

For the pinned adapter:

- `sender_pubkey` comes from `user_id` and is lowercase 64-character hex.
- `channel` comes from `chat_id` and is the private Buzz channel UUID.
- `event_id` comes from `message_id` and is lowercase 64-character hex.
- For the root grant event, `thread_id` is the same value as `event_id`.
- `created_at` is the inbound event time in Unix seconds.

Write the envelope only under the configured inbox directory. Set mode `0600`.
The envelope has this shape:

```json
{
  "auth": {
    "adapter": "hermes-native-buzz",
    "chat_id": "Buzz channel UUID",
    "user_id": "64-hex operator pubkey",
    "message_id": "64-hex event id",
    "thread_id": "64-hex root event id",
    "created_at": 0
  },
  "grant": {
    "schema_version": 1,
    "kind": "release_grant",
    "nonce": "operator nonce",
    "repository": "owner/repository",
    "base_branch": "main",
    "release_version": "X.Y.Z",
    "milestone": "vX.Y.Z",
    "ordered_issues": [905, 874, 870],
    "actions": [
      "issue_advance",
      "issue_pr_merge",
      "frg",
      "release_prepare",
      "release_pr_merge",
      "release_verify",
      "pin_promote",
      "install",
      "rollback"
    ],
    "model": "grok-4.5",
    "issue_limit": 3,
    "issued_at": "REPLACE_WITH_CANONICAL_UTC_TIME",
    "expires_at": "REPLACE_WITH_CANONICAL_UTC_TIME"
  }
}
```

The wrapper does not independently verify a Nostr signature. The private Buzz
relay, native gateway, exact sender allowlist, exact channel allowlist, and
mention gate supply the accepted pilot context. Hermes and the wrapper run as
the same operating-system user. State this limit when the operator asks about
the trust boundary.

Admit the relay-context envelope before start. `admit` validates the closed
scope and replay state. It then writes the normalized active grant atomically:

```bash
/usr/bin/node "$HOME/.local/lib/hermes-factory/factory.mjs" admit \
  --config "$HOME/.config/hermes-factory/config.json" \
  --grant "$HOME/.local/state/hermes-factory/inbox/REPLACE_WITH_EVENT_ID.json"
```

If admission passes, send one reply in the exact grant thread. Include the
fingerprint printed by `admit`, repository, base, release, ordered issues,
expiry, and allowed actions. Do not include a secret or raw grant file. If the
operator does not receive this acknowledgment, the operator must resend the
same content and nonce in the same thread. Reconcile the observed event before
you admit a replacement. A replay must resume the same scope. It must not
create a wider scope.

Start the reviewed unit only after the acknowledgment:

```bash
systemctl --user start hermes-factory.service
```

## Stop and failure

A relay-observed stop or revoke event must use the wrapper control path. The
wrapper does not verify the Nostr signature again. Do not invent a plain
wrapper stop command. `systemctl --user stop
hermes-factory.service` is an emergency host stop only.

Take the auth fields from the new inbound event. Keep `thread_id` equal to the
active grant thread. Write this mode `0600` envelope under the configured inbox:

```json
{
  "auth": {
    "adapter": "hermes-native-buzz",
    "chat_id": "Buzz channel UUID",
    "user_id": "64-hex operator pubkey",
    "message_id": "64-hex control event id",
    "thread_id": "64-hex active grant root event id",
    "created_at": 0
  },
  "control": {
    "schema_version": 1,
    "kind": "stop",
    "grant_fingerprint": "active grant fingerprint",
    "issued_at": "REPLACE_WITH_CANONICAL_UTC_TIME",
    "reason": "operator reason"
  }
}
```

Use `kind: revoke` only when the operator requested revocation. Admit the
control event with the exact active grant:

```bash
/usr/bin/node "$HOME/.local/lib/hermes-factory/factory.mjs" control \
  --config "$HOME/.config/hermes-factory/config.json" \
  --grant "$HOME/.local/state/hermes-factory/active-grant.json" \
  --event "$HOME/.local/state/hermes-factory/inbox/REPLACE_CONTROL_EVENT_ID.json"
```

Reply in the same thread with the control kind and grant fingerprint. If no
acknowledgment arrives, the operator resends the same content in the same
thread. Reconcile the first event before you accept a replacement.

Stop before the next mutation when the wrapper reports a scope mismatch,
expiry, replay mismatch, `pipeline:needs-human`, model drift, failed check,
failed FRG, changed head, ambiguous result, publication mismatch, failed
doctor result, or failed rollback.

Report only the redacted material event. Never send prompts, model output,
environment values, credentials, or raw tool output to Buzz.
