// Decisions artifact schema `decisions.v1` plus body embed/parse/render (#1072).
// Pure: no network, git, or subprocess.

import { canonicalJson, sha256Hex, sha256Prefixed, utf8ByteLength } from "./grill-hash.ts";
import {
  classifyAuthority,
  isNonAuthorityClass,
  isOperatorRequiredClass,
  NON_AUTHORITY_ELIGIBILITY_REASON,
  OPERATOR_REQUIRED_CLASSES,
} from "./grill-taxonomy.ts";
import type { GrillFingerprint } from "./grill-fingerprint.ts";
import { parseGrillFingerprint } from "./grill-fingerprint.ts";

export const DECISIONS_SCHEMA_VERSION = "decisions.v1" as const;
export const DECISIONS_FENCE_LANG = "pipeline-decisions-v1";
export const DECISIONS_COMMENT_PREFIX = "<!-- pipeline-decisions:v1 sha256=";

export const MAX_ARTIFACT_UTF8 = 256 * 1024;
export const MAX_NODES = 64;
export const MAX_NODE_TEXT = 2000;
export const MAX_CONTEXT_PROPOSAL_UTF8 = 16 * 1024;

export const DEPENDENCY_FACT_CODES = [
  "dependency.cycle",
  "dependency.missing",
  "dependency.inaccessible",
  "dependency.malformed",
  "dependency.closure_exhausted",
] as const;
export type DependencyFactCode = (typeof DEPENDENCY_FACT_CODES)[number];

export type NodeResolution = "unresolved" | "resolved";
export type ReviewerVerdictKind = "accept" | "challenge";
export type SettledBy = "none" | "reviewer-accept" | "handoff";

export interface DecisionProvenance {
  settled_by: SettledBy;
  reference: string | null;
  reviewer_verdict: ReviewerVerdictKind | null;
  reviewer_reason: string | null;
  eligibility_reason: string | null;
}

export interface DecisionNode {
  id: string;
  question: string;
  recommendation: string;
  class: string;
  resolution: NodeResolution;
  provenance: DecisionProvenance;
  input_digests: {
    question_sha256: string;
    recommendation_sha256: string;
  };
  term_id?: string;
  challenge_text?: string;
}

export interface TypedUnresolvedFact {
  code: DependencyFactCode;
  issue_ids: number[];
  edges: Array<{ from: number; to: number }>;
  message: string;
}

export interface RequiredContext {
  terms: string[];
  integration_base_sha: string | null;
  context_md_sha256: string | null;
}

export interface ContextProposal {
  term_id: string;
  definition: string;
  necessity: "required" | "advisory";
}

export interface DecisionsArtifact {
  schema_version: typeof DECISIONS_SCHEMA_VERSION;
  nodes: DecisionNode[];
  fingerprint: GrillFingerprint;
  required_context: RequiredContext;
  unresolved_facts: TypedUnresolvedFact[];
  context_proposals: ContextProposal[];
}

export interface ParseFailure {
  ok: false;
  reason: string;
  code:
    | "missing"
    | "duplicate_fence"
    | "delimiter_collision"
    | "digest_mismatch"
    | "unknown_schema"
    | "invalid_json"
    | "invalid_shape"
    | "render_divergence"
    | "oversize";
}

export type ParseSuccess = { ok: true; artifact: DecisionsArtifact; marker: string; fence: string };
export type ParseResult = ParseSuccess | ParseFailure;

const NODE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const FENCE_RE = /```pipeline-decisions-v1\r?\n([\s\S]*?)\r?\n```/;
const COMMENT_RE = /<!-- pipeline-decisions:v1 sha256=([0-9a-f]{64}) -->/;
const DECISIONS_HEADING_RE = /^## Decisions\s*$/m;

export function emptyProvenance(): DecisionProvenance {
  return {
    settled_by: "none",
    reference: null,
    reviewer_verdict: null,
    reviewer_reason: null,
    eligibility_reason: null,
  };
}

export function nodeInputDigests(question: string, recommendation: string): DecisionNode["input_digests"] {
  return {
    question_sha256: sha256Prefixed(question),
    recommendation_sha256: sha256Prefixed(recommendation),
  };
}

export function makeNode(input: {
  id: string;
  question: string;
  recommendation: string;
  class: string;
  term_id?: string;
}): DecisionNode {
  return {
    id: input.id,
    question: input.question,
    recommendation: input.recommendation,
    class: input.class,
    resolution: "unresolved",
    provenance: emptyProvenance(),
    input_digests: nodeInputDigests(input.question, input.recommendation),
    ...(input.term_id ? { term_id: input.term_id } : {}),
  };
}

/** Canonical unresolved operator-required nodes for a thin issue. */
export function canonicalThinIssueNodes(): DecisionNode[] {
  const questions: Record<(typeof OPERATOR_REQUIRED_CLASSES)[number], string> = {
    scope: "What is in scope, and what is out of scope, for this issue?",
    security: "Does this change require a security decision or threat-model attestation?",
    "irreversible-operations": "Does this change perform an irreversible or destructive operation?",
    "merge-release": "Who may authorize merge or release for this change?",
    "human-attestation": "What human attestation is required before this work may proceed?",
  };
  return OPERATOR_REQUIRED_CLASSES.map((cls) =>
    makeNode({
      id: cls,
      question: questions[cls],
      recommendation: "",
      class: cls,
    }),
  );
}

export function implementerSelfAccepted(nodes: readonly DecisionNode[]): boolean {
  for (const node of nodes) {
    if (node.resolution === "resolved") return true;
    if (node.provenance.settled_by !== "none") return true;
    if (node.provenance.reviewer_verdict === "accept") return true;
  }
  return false;
}

export function applyReviewerVerdicts(
  nodes: DecisionNode[],
  verdicts: ReadonlyArray<{ node_id: string; verdict: ReviewerVerdictKind; reason: string }>,
): { ok: true; nodes: DecisionNode[]; challenges: boolean } | { ok: false; reason: string } {
  const byId = new Map<string, (typeof verdicts)[number]>();
  for (const v of verdicts) {
    if (byId.has(v.node_id)) {
      return { ok: false, reason: `duplicate reviewer verdict for node ${v.node_id}` };
    }
    byId.set(v.node_id, v);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const id of byId.keys()) {
    if (!nodeIds.has(id)) {
      return { ok: false, reason: `reviewer verdict for unknown node ${id}` };
    }
  }
  const next: DecisionNode[] = [];
  let challenges = false;
  for (const node of nodes) {
    const v = byId.get(node.id);
    if (!v) {
      return { ok: false, reason: `reviewer omitted verdict for node ${node.id}` };
    }
    const classified = classifyAuthority(node.class);
    const reason = (v.reason ?? "").trim();
    if (v.verdict === "challenge") {
      challenges = true;
      next.push({
        ...node,
        resolution: "unresolved",
        challenge_text: reason,
        provenance: {
          ...node.provenance,
          settled_by: "none",
          reviewer_verdict: "challenge",
          reviewer_reason: reason,
          eligibility_reason: classified.mayAutoDefault ? NON_AUTHORITY_ELIGIBILITY_REASON : null,
        },
      });
      continue;
    }
    if (classified.mayAutoDefault) {
      next.push({
        ...node,
        resolution: "resolved",
        provenance: {
          settled_by: "reviewer-accept",
          reference: null,
          reviewer_verdict: "accept",
          reviewer_reason: reason,
          eligibility_reason: NON_AUTHORITY_ELIGIBILITY_REASON,
        },
      });
      continue;
    }
    next.push({
      ...node,
      resolution: "unresolved",
      provenance: {
        settled_by: "none",
        reference: null,
        reviewer_verdict: "accept",
        reviewer_reason: reason,
        eligibility_reason: null,
      },
    });
  }
  return { ok: true, nodes: next, challenges };
}

export function hasReviewerChallenge(nodes: readonly DecisionNode[]): boolean {
  return nodes.some((n) => n.provenance.reviewer_verdict === "challenge");
}

export function unresolvedAuthorityNodes(nodes: readonly DecisionNode[]): DecisionNode[] {
  return nodes.filter((n) => {
    const classified = classifyAuthority(n.class);
    if (!classified.operatorRequired) return false;
    if (n.resolution !== "resolved") return true;
    if (n.provenance.settled_by !== "handoff") return true;
    if (!n.provenance.reference || !n.provenance.reference.startsWith("handoff:")) return true;
    return false;
  });
}

export function renderDecisionsSection(artifact: DecisionsArtifact): string {
  const lines: string[] = ["## Decisions", ""];
  if (artifact.nodes.length === 0) {
    lines.push("_No decision nodes._", "");
    return lines.join("\n");
  }
  const sorted = [...artifact.nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const node of sorted) {
    lines.push(`### ${node.id}`);
    lines.push("");
    lines.push(`- **Question:** ${escapeMd(node.question)}`);
    lines.push(`- **Recommendation:** ${escapeMd(node.recommendation)}`);
    lines.push(`- **Class:** ${escapeMd(node.class)}`);
    lines.push(`- **Resolution:** ${node.resolution}`);
    lines.push(`- **Provenance:** ${formatProvenance(node.provenance)}`);
    if (node.provenance.reviewer_verdict) {
      lines.push(
        `- **Reviewer:** ${node.provenance.reviewer_verdict} — ${escapeMd(node.provenance.reviewer_reason ?? "")}`,
      );
    }
    if (node.provenance.eligibility_reason) {
      lines.push(`- **Eligibility:** ${escapeMd(node.provenance.eligibility_reason)}`);
    }
    if (node.challenge_text) {
      lines.push(`- **Challenge:** ${escapeMd(node.challenge_text)}`);
    }
    if (node.term_id) {
      lines.push(`- **Term:** ${escapeMd(node.term_id)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatProvenance(p: DecisionProvenance): string {
  if (p.settled_by === "none") return "none";
  if (p.settled_by === "reviewer-accept") return "settled-by: reviewer-accept";
  if (p.reference) return `settled-by: handoff (${p.reference})`;
  return "settled-by: handoff";
}

function escapeMd(text: string): string {
  return text.replace(/\r?\n/g, " ").trim();
}

export function artifactCanonicalJson(artifact: DecisionsArtifact): string {
  return canonicalJson(artifact);
}

export function embedDecisionsInBody(specBody: string, artifact: DecisionsArtifact): string {
  const core = extractSpecCore(specBody).trimEnd();
  const payload = artifactCanonicalJson(artifact);
  const digest = sha256Hex(payload);
  const comment = `${DECISIONS_COMMENT_PREFIX}${digest} -->`;
  const fence = `\`\`\`${DECISIONS_FENCE_LANG}\n${payload}\n\`\`\``;
  const section = renderDecisionsSection(artifact).trimEnd();
  const parts = [core, "", comment, fence, "", section, ""];
  return parts.join("\n").replace(/^\n+/, "");
}

export function extractSpecCore(body: string): string {
  let rest = body;
  rest = rest.replace(COMMENT_RE, "");
  rest = rest.replace(new RegExp("```" + DECISIONS_FENCE_LANG + "\\r?\\n[\\s\\S]*?\\r?\\n```", "g"), "");
  const heading = rest.search(DECISIONS_HEADING_RE);
  if (heading >= 0) {
    const after = rest.slice(heading + "## Decisions".length);
    const nextH2 = after.search(/\n## [^#]/);
    rest = rest.slice(0, heading) + (nextH2 >= 0 ? after.slice(nextH2) : "");
  }
  return rest.replace(/\n{3,}/g, "\n\n").trim();
}

export function parseDecisionsFromBody(body: string): ParseResult {
  const fenceMatches = [...body.matchAll(new RegExp("```" + DECISIONS_FENCE_LANG + "\\r?\\n", "g"))];
  if (fenceMatches.length === 0) {
    return { ok: false, reason: "Decisions artifact fence is missing", code: "missing" };
  }
  if (fenceMatches.length > 1) {
    return { ok: false, reason: "multiple pipeline-decisions-v1 fences", code: "duplicate_fence" };
  }
  const commentMatches = [...body.matchAll(new RegExp(COMMENT_RE.source, "g"))];
  if (commentMatches.length !== 1) {
    return {
      ok: false,
      reason: commentMatches.length === 0 ? "Decisions HTML comment is missing" : "duplicate Decisions HTML comments",
      code: commentMatches.length === 0 ? "missing" : "duplicate_fence",
    };
  }
  const fenceMatch = FENCE_RE.exec(body);
  if (!fenceMatch) {
    return { ok: false, reason: "Decisions fence payload is malformed", code: "invalid_json" };
  }
  const payload = fenceMatch[1]!;
  if (payload.includes("-->") || payload.includes("```")) {
    return { ok: false, reason: "Decisions payload collides with body delimiters", code: "delimiter_collision" };
  }
  if (utf8ByteLength(payload) > MAX_ARTIFACT_UTF8) {
    return { ok: false, reason: "Decisions artifact exceeds 256 KiB", code: "oversize" };
  }
  const commentMatch = commentMatches[0]!;
  const between = body.slice((commentMatch.index ?? 0) + commentMatch[0].length, fenceMatch.index);
  if (between.trim() !== "") {
    return { ok: false, reason: "Decisions HTML comment must immediately precede the fence", code: "delimiter_collision" };
  }
  const expected = commentMatch[1]!;
  const actual = sha256Hex(payload);
  if (actual !== expected) {
    return { ok: false, reason: "Decisions comment digest does not match fence payload", code: "digest_mismatch" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, reason: "Decisions fence is not JSON", code: "invalid_json" };
  }
  const shape = parseDecisionsArtifact(parsed);
  if (!shape.ok) return shape;
  const rendered = renderDecisionsSection(shape.artifact).trim();
  const liveSection = extractDecisionsSection(body)?.trim();
  if (liveSection !== rendered) {
    return { ok: false, reason: "## Decisions section diverges from the artifact", code: "render_divergence" };
  }
  return {
    ok: true,
    artifact: shape.artifact,
    marker: commentMatches[0]![0]!,
    fence: fenceMatch[0]!,
  };
}

export function extractDecisionsSection(body: string): string | null {
  const match = DECISIONS_HEADING_RE.exec(body);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const after = body.slice(start + match[0].length);
  const nextH2 = after.search(/\n## [^#]/);
  const end = nextH2 >= 0 ? start + match[0].length + nextH2 : body.length;
  return body.slice(start, end).replace(/\s+$/, "") + "\n";
}

export function parseDecisionsArtifact(raw: unknown): ParseSuccess | ParseFailure {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "artifact is not an object", code: "invalid_shape" };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== DECISIONS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unknown Decisions schema_version: ${String(o.schema_version)}`,
      code: "unknown_schema",
    };
  }
  if (!Array.isArray(o.nodes)) {
    return { ok: false, reason: "artifact.nodes must be an array", code: "invalid_shape" };
  }
  if (o.nodes.length > MAX_NODES) {
    return { ok: false, reason: `artifact exceeds ${MAX_NODES} nodes`, code: "oversize" };
  }
  const nodes: DecisionNode[] = [];
  const seen = new Set<string>();
  for (const item of o.nodes) {
    const node = parseNode(item);
    if (!node.ok) return node;
    if (seen.has(node.node.id)) {
      return { ok: false, reason: `duplicate node id ${node.node.id}`, code: "invalid_shape" };
    }
    seen.add(node.node.id);
    nodes.push(node.node);
  }
  const fp = parseGrillFingerprint(o.fingerprint);
  if (!fp.ok) return { ok: false, reason: fp.reason, code: "invalid_shape" };
  const required = parseRequiredContext(o.required_context);
  if (!required.ok) return required;
  const facts = parseFacts(o.unresolved_facts);
  if (!facts.ok) return facts;
  const proposals = parseContextProposals(o.context_proposals ?? []);
  if (!proposals.ok) return proposals;
  const artifact: DecisionsArtifact = {
    schema_version: DECISIONS_SCHEMA_VERSION,
    nodes,
    fingerprint: fp.fingerprint,
    required_context: required.required_context,
    unresolved_facts: facts.facts,
    context_proposals: proposals.proposals,
  };
  const json = artifactCanonicalJson(artifact);
  if (utf8ByteLength(json) > MAX_ARTIFACT_UTF8) {
    return { ok: false, reason: "Decisions artifact exceeds 256 KiB", code: "oversize" };
  }
  return { ok: true, artifact, marker: "", fence: "" };
}

function parseNode(
  raw: unknown,
): { ok: true; node: DecisionNode } | ParseFailure {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "node is not an object", code: "invalid_shape" };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !NODE_ID_RE.test(o.id)) {
    return { ok: false, reason: "node.id is missing or malformed", code: "invalid_shape" };
  }
  if (typeof o.question !== "string" || o.question.length > MAX_NODE_TEXT) {
    return { ok: false, reason: `node ${o.id} question is missing or too long`, code: "invalid_shape" };
  }
  if (typeof o.recommendation !== "string" || o.recommendation.length > MAX_NODE_TEXT) {
    return { ok: false, reason: `node ${o.id} recommendation is missing or too long`, code: "invalid_shape" };
  }
  if (typeof o.class !== "string" || o.class.length === 0) {
    return { ok: false, reason: `node ${o.id} class is missing`, code: "invalid_shape" };
  }
  if (o.resolution !== "unresolved" && o.resolution !== "resolved") {
    return { ok: false, reason: `node ${o.id} resolution is invalid`, code: "invalid_shape" };
  }
  const provenance = parseProvenance(o.provenance, o.id);
  if (!provenance.ok) return provenance;
  const digests = o.input_digests;
  if (digests === null || typeof digests !== "object" || Array.isArray(digests)) {
    return { ok: false, reason: `node ${o.id} input_digests missing`, code: "invalid_shape" };
  }
  const d = digests as Record<string, unknown>;
  if (typeof d.question_sha256 !== "string" || typeof d.recommendation_sha256 !== "string") {
    return { ok: false, reason: `node ${o.id} input_digests malformed`, code: "invalid_shape" };
  }
  const node: DecisionNode = {
    id: o.id,
    question: o.question,
    recommendation: o.recommendation,
    class: o.class,
    resolution: o.resolution,
    provenance: provenance.provenance,
    input_digests: {
      question_sha256: d.question_sha256,
      recommendation_sha256: d.recommendation_sha256,
    },
  };
  if (typeof o.term_id === "string" && o.term_id.length > 0) node.term_id = o.term_id;
  if (typeof o.challenge_text === "string" && o.challenge_text.length > 0) {
    node.challenge_text = o.challenge_text;
  }
  if (node.provenance.settled_by === "reviewer-accept") {
    if (!isNonAuthorityClass(node.class)) {
      return {
        ok: false,
        reason: `node ${node.id} cannot record settled-by: reviewer-accept`,
        code: "invalid_shape",
      };
    }
  }
  if (node.resolution === "resolved" && isNonAuthorityClass(node.class)) {
    if (node.provenance.settled_by !== "reviewer-accept") {
      return {
        ok: false,
        reason: `node ${node.id} non-authority resolution requires reviewer-accept provenance`,
        code: "invalid_shape",
      };
    }
    if (node.provenance.eligibility_reason !== NON_AUTHORITY_ELIGIBILITY_REASON) {
      return {
        ok: false,
        reason: `node ${node.id} missing taxonomy eligibility reason`,
        code: "invalid_shape",
      };
    }
  }
  if (node.resolution === "resolved" && isOperatorRequiredClass(node.class)) {
    if (node.provenance.settled_by !== "handoff") {
      return {
        ok: false,
        reason: `node ${node.id} operator-required resolution requires handoff provenance`,
        code: "invalid_shape",
      };
    }
  }
  return { ok: true, node };
}

function parseProvenance(
  raw: unknown,
  nodeId: string,
): { ok: true; provenance: DecisionProvenance } | ParseFailure {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: `node ${nodeId} provenance missing`, code: "invalid_shape" };
  }
  const o = raw as Record<string, unknown>;
  const settled = o.settled_by;
  if (settled !== "none" && settled !== "reviewer-accept" && settled !== "handoff") {
    return { ok: false, reason: `node ${nodeId} settled_by is invalid`, code: "invalid_shape" };
  }
  const verdict = o.reviewer_verdict;
  if (verdict !== null && verdict !== undefined && verdict !== "accept" && verdict !== "challenge") {
    return { ok: false, reason: `node ${nodeId} reviewer_verdict is invalid`, code: "invalid_shape" };
  }
  return {
    ok: true,
    provenance: {
      settled_by: settled,
      reference: typeof o.reference === "string" ? o.reference : null,
      reviewer_verdict: verdict === "accept" || verdict === "challenge" ? verdict : null,
      reviewer_reason: typeof o.reviewer_reason === "string" ? o.reviewer_reason : null,
      eligibility_reason: typeof o.eligibility_reason === "string" ? o.eligibility_reason : null,
    },
  };
}

function parseRequiredContext(
  raw: unknown,
): { ok: true; required_context: RequiredContext } | ParseFailure {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "required_context missing", code: "invalid_shape" };
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.terms) || o.terms.some((t) => typeof t !== "string")) {
    return { ok: false, reason: "required_context.terms malformed", code: "invalid_shape" };
  }
  return {
    ok: true,
    required_context: {
      terms: o.terms as string[],
      integration_base_sha: typeof o.integration_base_sha === "string" ? o.integration_base_sha : null,
      context_md_sha256: typeof o.context_md_sha256 === "string" ? o.context_md_sha256 : null,
    },
  };
}

function parseFacts(
  raw: unknown,
): { ok: true; facts: TypedUnresolvedFact[] } | ParseFailure {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "unresolved_facts must be an array", code: "invalid_shape" };
  }
  const facts: TypedUnresolvedFact[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: "unresolved fact is not an object", code: "invalid_shape" };
    }
    const o = item as Record<string, unknown>;
    if (!(DEPENDENCY_FACT_CODES as readonly string[]).includes(String(o.code))) {
      return { ok: false, reason: `unknown fact code ${String(o.code)}`, code: "invalid_shape" };
    }
    if (!Array.isArray(o.issue_ids) || o.issue_ids.some((n) => typeof n !== "number")) {
      return { ok: false, reason: "fact issue_ids malformed", code: "invalid_shape" };
    }
    if (!Array.isArray(o.edges)) {
      return { ok: false, reason: "fact edges malformed", code: "invalid_shape" };
    }
    const edges: Array<{ from: number; to: number }> = [];
    for (const e of o.edges) {
      if (e === null || typeof e !== "object") {
        return { ok: false, reason: "fact edge malformed", code: "invalid_shape" };
      }
      const edge = e as Record<string, unknown>;
      if (typeof edge.from !== "number" || typeof edge.to !== "number") {
        return { ok: false, reason: "fact edge malformed", code: "invalid_shape" };
      }
      edges.push({ from: edge.from, to: edge.to });
    }
    facts.push({
      code: o.code as DependencyFactCode,
      issue_ids: o.issue_ids as number[],
      edges,
      message: typeof o.message === "string" ? o.message : "",
    });
  }
  return { ok: true, facts };
}

function parseContextProposals(
  raw: unknown,
): { ok: true; proposals: ContextProposal[] } | ParseFailure {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "context_proposals must be an array", code: "invalid_shape" };
  }
  const proposals: ContextProposal[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: "context proposal is not an object", code: "invalid_shape" };
    }
    const o = item as Record<string, unknown>;
    if (typeof o.term_id !== "string" || o.term_id.length === 0) {
      return { ok: false, reason: "context proposal term_id missing", code: "invalid_shape" };
    }
    if (typeof o.definition !== "string") {
      return { ok: false, reason: "context proposal definition missing", code: "invalid_shape" };
    }
    if (o.necessity !== "required" && o.necessity !== "advisory") {
      return { ok: false, reason: "context proposal necessity invalid", code: "invalid_shape" };
    }
    const encoded = canonicalJson(o);
    if (utf8ByteLength(encoded) > MAX_CONTEXT_PROPOSAL_UTF8) {
      return { ok: false, reason: "CONTEXT proposal exceeds 16 KiB", code: "oversize" };
    }
    proposals.push({
      term_id: o.term_id,
      definition: o.definition,
      necessity: o.necessity,
    });
  }
  return { ok: true, proposals };
}

export function specCoreSha256(body: string): string {
  return sha256Prefixed(extractSpecCore(body));
}

export function patchNodeInArtifact(
  artifact: DecisionsArtifact,
  nodeId: string,
  patch: Partial<Pick<DecisionNode, "resolution" | "provenance" | "challenge_text">>,
): DecisionsArtifact {
  const nodes = artifact.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
  return { ...artifact, nodes };
}
