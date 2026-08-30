// CONTEXT.md proposal classification for grill-then-ready (#1072).
// Pipeline-owned: model necessity prose does not survive classification.

import { sha256Prefixed } from "./grill-hash.ts";
import { classifyAuthority } from "./grill-taxonomy.ts";
import type { ContextProposal, DecisionNode, RequiredContext } from "./grill-decisions.ts";

/** ATX glossary entries matching root CONTEXT.md: `**Term**:`. */
const GLOSSARY_TERM_RE = /^\*\*([^*]+)\*\*:/gm;

export function glossaryTermIds(contextMd: string): Set<string> {
  const terms = new Set<string>();
  GLOSSARY_TERM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GLOSSARY_TERM_RE.exec(contextMd)) !== null) {
    const term = match[1]!.trim();
    if (term) terms.add(term);
  }
  return terms;
}

export function classifyContextProposals(
  proposals: readonly ContextProposal[],
  nodes: readonly DecisionNode[],
  contextMd: string,
): { proposals: ContextProposal[]; required_context: RequiredContext } {
  const present = glossaryTermIds(contextMd);
  const referencedMissing = new Set<string>();
  for (const node of nodes) {
    if (!node.term_id) continue;
    const classified = classifyAuthority(node.class);
    if (!classified.operatorRequired) continue;
    if (!present.has(node.term_id)) referencedMissing.add(node.term_id);
  }
  const classifiedProposals = proposals.map((p) => ({
    ...p,
    necessity: referencedMissing.has(p.term_id) ? ("required" as const) : ("advisory" as const),
  }));
  const terms = [...referencedMissing].sort();
  return {
    proposals: classifiedProposals,
    required_context: {
      terms,
      integration_base_sha: null,
      context_md_sha256: null,
    },
  };
}

/**
 * Record reviewed-base hashes only when the trusted-base blob contains every
 * required term. Model prose cannot set or clear these hashes.
 */
export function recordRequiredContextHashes(
  required: RequiredContext,
  integrationBaseSha: string,
  contextMd: string,
): RequiredContext {
  const present = glossaryTermIds(contextMd);
  const missing = required.terms.filter((t) => !present.has(t));
  if (missing.length > 0) {
    return { terms: required.terms, integration_base_sha: null, context_md_sha256: null };
  }
  if (required.terms.length === 0) {
    return { terms: [], integration_base_sha: null, context_md_sha256: null };
  }
  return {
    terms: required.terms,
    integration_base_sha: integrationBaseSha,
    context_md_sha256: sha256Prefixed(contextMd),
  };
}

export function requiredContextSatisfied(
  required: RequiredContext,
  integrationBaseSha: string,
  contextMd: string,
): boolean {
  if (required.terms.length === 0) return true;
  const present = glossaryTermIds(contextMd);
  if (required.terms.some((t) => !present.has(t))) return false;
  if (required.integration_base_sha !== integrationBaseSha) return false;
  if (required.context_md_sha256 !== sha256Prefixed(contextMd)) return false;
  return true;
}
