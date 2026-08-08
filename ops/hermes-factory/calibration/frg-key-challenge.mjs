#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const challenge = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(challenge ?? "")) {
  throw new Error("the challenge must be 32 random bytes in lowercase hexadecimal form");
}

let key = process.env.PIPELINE_FRG_ATTESTATION_KEY;
if (!key && process.env.PIPELINE_FRG_ATTESTATION_KEY_FILE) {
  key = await readFile(process.env.PIPELINE_FRG_ATTESTATION_KEY_FILE, "utf8");
}
key = key?.trim();
if (!key || Buffer.byteLength(key, "utf8") < 32) {
  throw new Error("the FRG attestation key must contain at least 32 bytes");
}

const proof = createHmac("sha256", key)
  .update("agent-pipeline-frg-key-proof-v1\0", "utf8")
  .update(challenge, "ascii")
  .digest("hex");

process.stdout.write(`${JSON.stringify({ schema_version: 1, challenge, hmac_sha256: proof })}\n`);
