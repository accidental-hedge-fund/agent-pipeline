// HMAC-signed canonical Decisions frontier (#1072).
// Host-local, Pipeline-produced. The editable issue body is not this record.

import * as path from "node:path";
import { artifactSubdir, GRILL_PROPOSALS_ARTIFACT } from "./artifact-ignore.ts";
import {
  nodeDefinitionDigest,
  type DecisionNode,
  type DecisionsArtifact,
} from "./grill-decisions.ts";
import {
  canonicalJson,
  hmacEqual,
  hmacSha256Hex,
  sha256Hex,
  sha256Prefixed,
} from "./grill-hash.ts";
import {
  defaultGrillProposalKeyDeps,
  type GrillProposalKeyDeps,
} from "./grill-proposal.ts";

export const GRILL_FRONTIER_SCHEMA = "grill-frontier.v1" as const;
export const GRILL_FRONTIER_KIND = "grill-frontier" as const;
export const GRILL_FRONTIER_MAC_PREFIX = "hmac-sha256:";

export interface GrillFrontierNode {
  id: string;
  class: string;
  definition_sha256: string;
}

export interface GrillFrontierBinding {
  repo: string;
  issue: number;
  body_sha256: string;
  nodes: GrillFrontierNode[];
}

export interface GrillFrontierRecord extends GrillFrontierBinding {
  schema_version: typeof GRILL_FRONTIER_SCHEMA;
  kind: typeof GRILL_FRONTIER_KIND;
  issued_at: string;
  mac: string;
}

function hexDigest(value: string): string {
  if (value.startsWith("sha256:") && /^[0-9a-f]{64}$/.test(value.slice(7))) return value.slice(7);
  if (/^[0-9a-f]{64}$/.test(value)) return value;
  return sha256Hex(value);
}

export function frontierNodesFromArtifact(artifact: DecisionsArtifact): GrillFrontierNode[] {
  return [...artifact.nodes]
    .map((n) => ({
      class: n.class,
      definition_sha256: nodeDefinitionDigest(n),
      id: n.id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function grillFrontierPath(repoDir: string, issueNumber: number): string {
  return path.join(
    artifactSubdir(repoDir, GRILL_PROPOSALS_ARTIFACT),
    `frontier-issue-${issueNumber}.json`,
  );
}

export function issueGrillFrontier(input: {
  repo: string;
  issue: number;
  body: string;
  artifact: DecisionsArtifact;
  now: Date;
  key: string;
}): GrillFrontierRecord {
  const issuedAt = input.now.toISOString().replace(/\.\d+Z$/, "Z");
  const unsigned: Omit<GrillFrontierRecord, "mac"> = {
    schema_version: GRILL_FRONTIER_SCHEMA,
    kind: GRILL_FRONTIER_KIND,
    issued_at: issuedAt,
    repo: input.repo,
    issue: input.issue,
    body_sha256: sha256Prefixed(input.body),
    nodes: frontierNodesFromArtifact(input.artifact),
  };
  const mac = `${GRILL_FRONTIER_MAC_PREFIX}${hmacSha256Hex(input.key, canonicalJson(unsigned))}`;
  return { ...unsigned, mac };
}

export function verifyGrillFrontier(
  record: GrillFrontierRecord,
  key: string,
  expected: { repo: string; issue: number },
): { ok: true; binding: GrillFrontierBinding } | { ok: false; reason: string } {
  if (record.schema_version !== GRILL_FRONTIER_SCHEMA || record.kind !== GRILL_FRONTIER_KIND) {
    return { ok: false, reason: "unknown grill-frontier schema" };
  }
  if (record.issue !== expected.issue) {
    return { ok: false, reason: "grill-frontier issue does not match" };
  }
  if (record.repo !== expected.repo) {
    return { ok: false, reason: "grill-frontier repo does not match" };
  }
  const { mac, ...unsigned } = record;
  const expectedMac = hmacSha256Hex(key, canonicalJson(unsigned));
  const actualMac = typeof mac === "string" && mac.startsWith(GRILL_FRONTIER_MAC_PREFIX)
    ? mac.slice(GRILL_FRONTIER_MAC_PREFIX.length)
    : "";
  if (!hmacEqual(expectedMac, actualMac)) {
    return { ok: false, reason: "grill-frontier MAC verification failed" };
  }
  if (!Array.isArray(record.nodes)) {
    return { ok: false, reason: "grill-frontier nodes malformed" };
  }
  return {
    ok: true,
    binding: {
      repo: record.repo,
      issue: record.issue,
      body_sha256: record.body_sha256,
      nodes: record.nodes,
    },
  };
}

export function persistGrillFrontier(
  repoDir: string,
  record: GrillFrontierRecord,
  deps: GrillProposalKeyDeps = defaultGrillProposalKeyDeps,
): void {
  const file = grillFrontierPath(repoDir, record.issue);
  deps.mkdir(path.dirname(file));
  deps.writeFile(file, `${JSON.stringify(record)}\n`);
}

export function loadGrillFrontier(
  repoDir: string,
  issueNumber: number,
  deps: GrillProposalKeyDeps = defaultGrillProposalKeyDeps,
): GrillFrontierRecord | null {
  const file = grillFrontierPath(repoDir, issueNumber);
  if (!deps.exists(file)) return null;
  try {
    const parsed: unknown = JSON.parse(deps.readFile(file));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (o.schema_version !== GRILL_FRONTIER_SCHEMA || o.kind !== GRILL_FRONTIER_KIND) return null;
    if (typeof o.mac !== "string" || typeof o.repo !== "string" || typeof o.issue !== "number") {
      return null;
    }
    if (typeof o.body_sha256 !== "string" || typeof o.issued_at !== "string" || !Array.isArray(o.nodes)) {
      return null;
    }
    return o as unknown as GrillFrontierRecord;
  } catch {
    return null;
  }
}

export function loadVerifiedGrillFrontier(
  repoDir: string,
  issueNumber: number,
  key: string,
  expectedRepo: string,
  deps: GrillProposalKeyDeps = defaultGrillProposalKeyDeps,
): GrillFrontierBinding | null {
  const raw = loadGrillFrontier(repoDir, issueNumber, deps);
  if (!raw) return null;
  const verified = verifyGrillFrontier(raw, key, { repo: expectedRepo, issue: issueNumber });
  return verified.ok ? verified.binding : null;
}

export function liveMatchesGrillFrontier(
  liveBody: string,
  nodes: readonly DecisionNode[],
  frontier: GrillFrontierBinding,
): { ok: true } | { ok: false; reason: string } {
  const liveById = new Map(nodes.map((n) => [n.id, n]));
  if (liveById.size !== frontier.nodes.length) {
    return {
      ok: false,
      reason: "live Decisions node set does not match the authenticated frontier",
    };
  }
  const seen = new Set<string>();
  for (const bound of frontier.nodes) {
    if (seen.has(bound.id)) {
      return { ok: false, reason: `authenticated frontier has duplicate node ${bound.id}` };
    }
    seen.add(bound.id);
    const live = liveById.get(bound.id);
    if (!live) {
      return {
        ok: false,
        reason: `authenticated frontier node ${bound.id} is missing from the live artifact`,
      };
    }
    if (live.class !== bound.class) {
      return {
        ok: false,
        reason: `node ${bound.id} class does not match the authenticated frontier`,
      };
    }
    if (hexDigest(nodeDefinitionDigest(live)) !== hexDigest(bound.definition_sha256)) {
      return {
        ok: false,
        reason: `node ${bound.id} definition does not match the authenticated frontier`,
      };
    }
  }
  for (const id of liveById.keys()) {
    if (!seen.has(id)) {
      return { ok: false, reason: `live node ${id} is not in the authenticated frontier` };
    }
  }
  if (hexDigest(sha256Prefixed(liveBody)) !== hexDigest(frontier.body_sha256)) {
    return { ok: false, reason: "live issue body does not match the authenticated frontier" };
  }
  return { ok: true };
}
