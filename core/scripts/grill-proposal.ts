// Signed `grill-proposal.v1` envelope (#1072). HMAC-SHA256, 24h TTL, 1 MiB bound.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  artifactSubdir,
  GRILL_PROPOSAL_KEY_ARTIFACT,
  GRILL_PROPOSALS_ARTIFACT,
} from "./artifact-ignore.ts";
import type { ContextProposal, DecisionsArtifact, ReviewerVerdictKind } from "./grill-decisions.ts";
import type { GrillFingerprint } from "./grill-fingerprint.ts";
import { canonicalJson, hmacEqual, hmacSha256Hex, utf8ByteLength } from "./grill-hash.ts";

export const GRILL_PROPOSAL_KIND = "grill-proposal" as const;
export const GRILL_PROPOSAL_SCHEMA = "1" as const;
export const GRILL_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
export const GRILL_PROPOSAL_MAX_UTF8 = 1024 * 1024;
export const GRILL_PROPOSAL_MAC_PREFIX = "hmac-sha256:";

export interface GrillProposalInput {
  title: string;
  body: string;
  title_sha256: string;
  body_sha256: string;
  fingerprint: GrillFingerprint;
}

export interface GrillProposalVerdict {
  node_id: string;
  verdict: ReviewerVerdictKind;
  reason: string;
}

export interface GrillProposalBody {
  body: string;
  artifact: DecisionsArtifact;
  verdicts: GrillProposalVerdict[];
  advisory_title: string;
  advisory_milestone: string | null;
  context_proposals: ContextProposal[];
}

export interface GrillProposalEnvelope {
  schema_version: typeof GRILL_PROPOSAL_SCHEMA;
  kind: typeof GRILL_PROPOSAL_KIND;
  issued_at: string;
  expires_at: string;
  nonce: string;
  repo: string;
  issue: number;
  input: GrillProposalInput;
  proposal: GrillProposalBody;
  mac: string;
}

export interface GrillProposalKeyDeps {
  env: NodeJS.Dict<string>;
  readFile(p: string): string;
  writeFile(p: string, data: string, mode?: number): void;
  mkdir(p: string): void;
  exists(p: string): boolean;
}

export const defaultGrillProposalKeyDeps: GrillProposalKeyDeps = {
  env: process.env,
  readFile: (p) => fs.readFileSync(p, "utf8"),
  writeFile: (p, data, mode) => fs.writeFileSync(p, data, { encoding: "utf8", mode: mode ?? 0o600 }),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  exists: (p) => fs.existsSync(p),
};

export function grillProposalKeyPath(repoDir: string): string {
  return artifactSubdir(repoDir, GRILL_PROPOSAL_KEY_ARTIFACT);
}

export function consumedNoncePath(repoDir: string): string {
  return path.join(artifactSubdir(repoDir, GRILL_PROPOSALS_ARTIFACT), "consumed.json");
}

export function resolveGrillProposalKey(
  repoDir: string,
  deps: GrillProposalKeyDeps = defaultGrillProposalKeyDeps,
  opts: { createIfMissing: boolean } = { createIfMissing: true },
): string {
  const fromEnv = deps.env.PIPELINE_GRILL_PROPOSAL_KEY;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const fromFileEnv = deps.env.PIPELINE_GRILL_PROPOSAL_KEY_FILE;
  if (typeof fromFileEnv === "string" && fromFileEnv.length > 0) {
    return deps.readFile(fromFileEnv).trim();
  }
  const keyPath = grillProposalKeyPath(repoDir);
  if (deps.exists(keyPath)) return deps.readFile(keyPath).trim();
  if (!opts.createIfMissing) {
    throw new Error("grill proposal key is missing");
  }
  const key = randomBytes(32).toString("hex");
  deps.mkdir(path.dirname(keyPath));
  deps.writeFile(keyPath, `${key}\n`, 0o600);
  return key;
}

export function signGrillProposal(
  unsigned: Omit<GrillProposalEnvelope, "mac">,
  key: string,
): GrillProposalEnvelope {
  const mac = `${GRILL_PROPOSAL_MAC_PREFIX}${hmacSha256Hex(key, canonicalJson(unsigned))}`;
  return { ...unsigned, mac };
}

export function issueGrillProposal(input: {
  now: Date;
  nonce?: string;
  repo: string;
  issue: number;
  input: GrillProposalInput;
  proposal: GrillProposalBody;
  key: string;
}): { ok: true; envelope: GrillProposalEnvelope } | { ok: false; reason: string; code: "oversize" } {
  const issuedAt = input.now.toISOString().replace(/\.\d+Z$/, "Z");
  const expires = new Date(input.now.getTime() + GRILL_PROPOSAL_TTL_MS)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const unsigned: Omit<GrillProposalEnvelope, "mac"> = {
    schema_version: GRILL_PROPOSAL_SCHEMA,
    kind: GRILL_PROPOSAL_KIND,
    issued_at: issuedAt,
    expires_at: expires,
    nonce: input.nonce ?? randomBytes(16).toString("hex"),
    repo: input.repo,
    issue: input.issue,
    input: input.input,
    proposal: input.proposal,
  };
  const envelope = signGrillProposal(unsigned, input.key);
  const encoded = `${JSON.stringify(envelope)}\n`;
  if (utf8ByteLength(encoded) > GRILL_PROPOSAL_MAX_UTF8) {
    return { ok: false, reason: "grill proposal exceeds 1 MiB UTF-8 bound", code: "oversize" };
  }
  return { ok: true, envelope };
}

export type EnvelopeVerifyFailure = {
  ok: false;
  reason: string;
  code:
    | "invalid_json"
    | "unknown_schema"
    | "mac"
    | "expired"
    | "issue_mismatch"
    | "repo_mismatch"
    | "oversize"
    | "replay"
    | "challenge";
};

export function parseEnvelopeBytes(
  raw: string,
): { ok: true; envelope: GrillProposalEnvelope } | EnvelopeVerifyFailure {
  if (utf8ByteLength(raw) > GRILL_PROPOSAL_MAX_UTF8) {
    return { ok: false, reason: "proposal input exceeds 1 MiB", code: "oversize" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "proposal is not JSON", code: "invalid_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "proposal is not an object", code: "invalid_json" };
  }
  const o = parsed as Record<string, unknown>;
  if (o.schema_version !== GRILL_PROPOSAL_SCHEMA || o.kind !== GRILL_PROPOSAL_KIND) {
    return { ok: false, reason: "unknown grill-proposal schema", code: "unknown_schema" };
  }
  if (typeof o.mac !== "string" || !o.mac.startsWith(GRILL_PROPOSAL_MAC_PREFIX)) {
    return { ok: false, reason: "proposal mac is missing", code: "mac" };
  }
  if (typeof o.repo !== "string" || typeof o.issue !== "number" || !Number.isInteger(o.issue)) {
    return { ok: false, reason: "proposal repo/issue malformed", code: "invalid_json" };
  }
  if (typeof o.issued_at !== "string" || typeof o.expires_at !== "string" || typeof o.nonce !== "string") {
    return { ok: false, reason: "proposal timestamps/nonce malformed", code: "invalid_json" };
  }
  if (!o.input || typeof o.input !== "object" || !o.proposal || typeof o.proposal !== "object") {
    return { ok: false, reason: "proposal input/proposal missing", code: "invalid_json" };
  }
  return { ok: true, envelope: o as unknown as GrillProposalEnvelope };
}

export function verifyGrillProposal(
  envelope: GrillProposalEnvelope,
  key: string,
  now: Date,
  expected: { repo: string; issue: number },
): { ok: true } | EnvelopeVerifyFailure {
  const { mac, ...unsigned } = envelope;
  const expectedMac = hmacSha256Hex(key, canonicalJson(unsigned));
  const actualMac = mac.startsWith(GRILL_PROPOSAL_MAC_PREFIX)
    ? mac.slice(GRILL_PROPOSAL_MAC_PREFIX.length)
    : "";
  if (!hmacEqual(expectedMac, actualMac)) {
    return { ok: false, reason: "proposal MAC verification failed", code: "mac" };
  }
  if (envelope.schema_version !== GRILL_PROPOSAL_SCHEMA || envelope.kind !== GRILL_PROPOSAL_KIND) {
    return { ok: false, reason: "unknown grill-proposal schema", code: "unknown_schema" };
  }
  if (Date.parse(envelope.expires_at) <= now.getTime()) {
    return { ok: false, reason: "proposal envelope expired", code: "expired" };
  }
  if (envelope.issue !== expected.issue) {
    return { ok: false, reason: "proposal issue does not match --issue", code: "issue_mismatch" };
  }
  if (envelope.repo !== expected.repo) {
    return { ok: false, reason: "proposal repo does not match", code: "repo_mismatch" };
  }
  if (envelope.proposal.verdicts.some((v) => v.verdict === "challenge")) {
    return { ok: false, reason: "proposal contains a reviewer challenge", code: "challenge" };
  }
  if (envelope.proposal.artifact.nodes.some((n) => n.provenance.reviewer_verdict === "challenge")) {
    return { ok: false, reason: "proposal contains a reviewer challenge", code: "challenge" };
  }
  return { ok: true };
}

export interface ConsumedNonceStore {
  isConsumed(nonce: string): boolean;
  consume(nonce: string): void;
}

export function fileConsumedNonceStore(
  repoDir: string,
  deps: GrillProposalKeyDeps = defaultGrillProposalKeyDeps,
): ConsumedNonceStore {
  const file = consumedNoncePath(repoDir);
  const load = (): string[] => {
    if (!deps.exists(file)) return [];
    try {
      const raw = JSON.parse(deps.readFile(file)) as { nonces?: unknown };
      return Array.isArray(raw.nonces) ? raw.nonces.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    isConsumed(nonce) {
      return load().includes(nonce);
    },
    consume(nonce) {
      const nonces = load();
      if (nonces.includes(nonce)) return;
      nonces.push(nonce);
      deps.mkdir(path.dirname(file));
      deps.writeFile(file, `${JSON.stringify({ schema_version: 1, nonces }, null, 2)}\n`);
    },
  };
}
