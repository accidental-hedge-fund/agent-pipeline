// #857 candidate-integrity: pure comparison, lifecycle, store, fixtures.
// Injected deps only — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  buildCandidateIntegrityEvent,
  buildManifestFromDeps,
  candidateSideMap,
  classifyTransition,
  COVERED_MUTATION_SITES,
  declaredScopeFromFindingPaths,
  dispositionForClassification,
  emptyDeclaredScope,
  freezeDeclaredScope,
  hydrateAndCompleteIncompleteMutation,
  integrityBlocksReadiness,
  integrityBlocksReviewReuse,
  loadInvalidationRecords,
  loadMutationRecord,
  memoryIntegrityStoreDeps,
  mutationRecordPath,
  OUT_OF_SCOPE_MUTATION_SITES,
  pathInScope,
  renameInScope,
  runCandidateMovingMutation,
  type AuthoritativeRefs,
  type CandidateIntegrityManifest,
  type CanonicalPatchRecord,
  type IntegritySubject,
  type ManifestCaptureDeps,
} from "../scripts/candidate-integrity.ts";
import { computeCandidateIntegrityMetrics } from "../scripts/scoreboard-stabilization.ts";
import {
  build793ShapedMonolithicReadme,
  checkReadmeLandingContract,
} from "../scripts/readme-landing-contract.ts";

const SUBJECT: IntegritySubject = {
  run_id: "857-test-run",
  issue: 857,
  pr: 900,
  domain: "agent-pipeline",
};

const BASE_A = "a".repeat(40);
const BASE_B = "b".repeat(40);
const HEAD_1 = "c".repeat(40);
const HEAD_2 = "d".repeat(40);
const BLOB_LEAN = "1".repeat(40);
const BLOB_MONOLITH = "2".repeat(40);
const BLOB_CORE = "3".repeat(40);
const BLOB_CORE2 = "4".repeat(40);
const BLOB_NEW = "5".repeat(40);

function entry(
  partial: Partial<CanonicalPatchRecord> & Pick<CanonicalPatchRecord, "path" | "status">,
): CanonicalPatchRecord {
  return {
    old_path: null,
    base_blob: null,
    candidate_blob: null,
    ...partial,
  };
}

function manifest(
  sha: string,
  baseSha: string,
  entries: CanonicalPatchRecord[],
): CandidateIntegrityManifest {
  return {
    schema_version: 1,
    run_id: SUBJECT.run_id,
    issue: SUBJECT.issue,
    pr: SUBJECT.pr ?? null,
    domain: SUBJECT.domain,
    base_ref: "main",
    base_sha: baseSha,
    candidate_sha: sha,
    entries,
    producer: { component: "candidate-integrity" },
    captured_at: "2026-08-05T12:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

test("pathInScope: exact paths and directory prefixes", () => {
  const scope = freezeDeclaredScope({
    paths: ["core/scripts/foo.ts"],
    directories: ["core/test/"],
  });
  assert.equal(pathInScope("core/scripts/foo.ts", scope), true);
  assert.equal(pathInScope("core/test/bar.test.ts", scope), true);
  assert.equal(pathInScope("README.md", scope), false);
  assert.equal(pathInScope("core/scripts/other.ts", scope), false);
});

test("renameInScope requires both sides", () => {
  const scope = freezeDeclaredScope({ paths: ["new.ts"], directories: [] });
  assert.equal(renameInScope("old.ts", "new.ts", scope), false);
  const both = freezeDeclaredScope({ paths: ["old.ts", "new.ts"] });
  assert.equal(renameInScope("old.ts", "new.ts", both), true);
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("clean rebase with base movement: equal candidate-side maps → semantically_equivalent", () => {
  const pre = manifest(HEAD_1, BASE_A, [
    entry({ path: "core/x.ts", status: "M", base_blob: "0".repeat(40), candidate_blob: BLOB_CORE }),
    entry({ path: "README.md", status: "M", base_blob: "9".repeat(40), candidate_blob: BLOB_LEAN }),
  ]);
  // Base moved; base_blob may differ; candidate blobs identical
  const post = manifest(HEAD_2, BASE_B, [
    entry({ path: "core/x.ts", status: "M", base_blob: "8".repeat(40), candidate_blob: BLOB_CORE }),
    entry({ path: "README.md", status: "M", base_blob: "7".repeat(40), candidate_blob: BLOB_LEAN }),
  ]);
  const result = classifyTransition(pre, post, emptyDeclaredScope(), "rebase");
  assert.equal(result.classification, "semantically_equivalent");
  const disp = dispositionForClassification(result.classification, {
    shaChanged: true,
    classificationReason: result.reason,
  });
  assert.equal(disp.invalidated_review, false);
  assert.equal(disp.invalidated_readiness, true); // must re-gate readiness
  assert.equal(disp.re_evaluate_gates, true);
  assert.equal(disp.human_authority_hold, false);
});

test("#793-class undeclared README append on restack → scope_expansion", () => {
  const pre = manifest(HEAD_1, BASE_A, [
    entry({ path: "README.md", status: "M", base_blob: "0".repeat(40), candidate_blob: BLOB_LEAN }),
    entry({ path: "core/x.ts", status: "A", candidate_blob: BLOB_CORE }),
  ]);
  const post = manifest(HEAD_2, BASE_B, [
    entry({
      path: "README.md",
      status: "M",
      base_blob: "0".repeat(40),
      candidate_blob: BLOB_MONOLITH,
    }),
    entry({ path: "core/x.ts", status: "A", candidate_blob: BLOB_CORE }),
  ]);
  const result = classifyTransition(pre, post, emptyDeclaredScope(), "restack");
  assert.equal(result.classification, "scope_expansion");
  assert.ok(result.differing_paths.includes("README.md"));
  const disp = dispositionForClassification(result.classification, {
    shaChanged: true,
    classificationReason: result.reason,
  });
  assert.equal(disp.invalidated_review, true);
  assert.equal(disp.invalidated_readiness, true);
  assert.equal(disp.merge_eligible, false);
  assert.equal(disp.human_authority_hold, false);
});

test("intended auto-fix within declared scope → expected_scoped_change", () => {
  const pre = manifest(HEAD_1, BASE_A, [
    entry({ path: "core/x.ts", status: "M", base_blob: "0".repeat(40), candidate_blob: BLOB_CORE }),
  ]);
  const post = manifest(HEAD_2, BASE_A, [
    entry({ path: "core/x.ts", status: "M", base_blob: "0".repeat(40), candidate_blob: BLOB_CORE2 }),
  ]);
  const scope = declaredScopeFromFindingPaths(["core/x.ts"]);
  const result = classifyTransition(pre, post, scope, "pre_merge_autofix");
  assert.equal(result.classification, "expected_scoped_change");
  const disp = dispositionForClassification(result.classification, {
    shaChanged: true,
    classificationReason: result.reason,
  });
  assert.equal(disp.requires_fresh_review, true);
  assert.equal(disp.invalidated_review, true);
});

test("large in-scope delta is not expansion solely due to size", () => {
  const pre = manifest(HEAD_1, BASE_A, [
    entry({ path: "core/big.ts", status: "M", base_blob: "0".repeat(40), candidate_blob: BLOB_CORE }),
  ]);
  const post = manifest(HEAD_2, BASE_A, [
    entry({
      path: "core/big.ts",
      status: "M",
      base_blob: "0".repeat(40),
      candidate_blob: BLOB_CORE2,
    }),
  ]);
  post.diff_size = { lines: 50_000, bytes: 2_000_000 };
  const scope = freezeDeclaredScope({ paths: ["core/big.ts"] });
  const result = classifyTransition(pre, post, scope, "pre_merge_autofix");
  assert.equal(result.classification, "expected_scoped_change");
});

test("add/delete/rename classification", () => {
  const pre = manifest(HEAD_1, BASE_A, [
    entry({ path: "keep.ts", status: "A", candidate_blob: BLOB_CORE }),
  ]);
  // add new path outside scope
  const postAdd = manifest(HEAD_2, BASE_A, [
    entry({ path: "keep.ts", status: "A", candidate_blob: BLOB_CORE }),
    entry({ path: "extra.ts", status: "A", candidate_blob: BLOB_NEW }),
  ]);
  assert.equal(
    classifyTransition(pre, postAdd, emptyDeclaredScope(), "recovery_repair").classification,
    "scope_expansion",
  );

  // delete
  const postDel = manifest(HEAD_2, BASE_A, [
    entry({ path: "keep.ts", status: "D", base_blob: BLOB_CORE, candidate_blob: null }),
  ]);
  assert.equal(
    classifyTransition(
      pre,
      postDel,
      freezeDeclaredScope({ paths: ["keep.ts"] }),
      "conflict_repair",
    ).classification,
    "expected_scoped_change",
  );

  // rename: both sides in scope
  const preR = manifest(HEAD_1, BASE_A, [
    entry({ path: "old.ts", status: "A", candidate_blob: BLOB_CORE }),
  ]);
  const postR = manifest(HEAD_2, BASE_A, [
    entry({
      path: "new.ts",
      status: "R",
      old_path: "old.ts",
      base_blob: BLOB_CORE,
      candidate_blob: BLOB_CORE,
    }),
  ]);
  const oneSide = freezeDeclaredScope({ paths: ["new.ts"] });
  assert.equal(
    classifyTransition(preR, postR, oneSide, "pre_merge_autofix").classification,
    "scope_expansion",
  );
  const both = freezeDeclaredScope({ paths: ["old.ts", "new.ts"] });
  assert.equal(
    classifyTransition(preR, postR, both, "pre_merge_autofix").classification,
    "expected_scoped_change",
  );
});

test("restack cannot declare scope to hide expansion", () => {
  const pre = manifest(HEAD_1, BASE_A, [
    entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
  ]);
  const post = manifest(HEAD_2, BASE_A, [
    entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE2 }),
  ]);
  const scope = freezeDeclaredScope({ paths: ["a.ts"] });
  // Even with scope, restack forces expansion on any delta
  const result = classifyTransition(pre, post, scope, "restack");
  assert.equal(result.classification, "scope_expansion");
});

test("missing pre-manifest / incomplete digests → unverified", () => {
  const post = manifest(HEAD_2, BASE_A, [
    entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
  ]);
  assert.equal(
    classifyTransition(null, post, emptyDeclaredScope(), "rebase").classification,
    "unverified",
  );

  const preInc = manifest(HEAD_1, BASE_A, [
    entry({ path: "bin.dat", status: "A", candidate_blob: null, incomplete: true }),
  ]);
  const postInc = manifest(HEAD_2, BASE_A, [
    entry({ path: "bin.dat", status: "A", candidate_blob: null, incomplete: true }),
  ]);
  assert.equal(
    classifyTransition(preInc, postInc, emptyDeclaredScope(), "rebase").classification,
    "unverified",
  );
});

test("candidateSideMap returns null when digests incomplete", () => {
  const m = manifest(HEAD_1, BASE_A, [
    entry({ path: "x", status: "M", base_blob: BLOB_CORE, candidate_blob: null }),
  ]);
  // status M with null candidate_blob → incomplete map
  assert.equal(candidateSideMap(m), null);
});

// ---------------------------------------------------------------------------
// Manifest capture via injected deps
// ---------------------------------------------------------------------------

test("buildManifestFromDeps uses injected list/blob (no real git)", async () => {
  const capture: ManifestCaptureDeps = {
    listChangedPaths: async () => [
      { status: "A", path: "core/x.ts" },
      { status: "M", path: "README.md" },
    ],
    blobOid: async (treeish, filePath) => {
      if (filePath === "core/x.ts" && treeish === HEAD_1) return BLOB_CORE;
      if (filePath === "README.md" && treeish === HEAD_1) return BLOB_LEAN;
      if (filePath === "README.md" && treeish === BASE_A) return "0".repeat(40);
      return null;
    },
  };
  const refs: AuthoritativeRefs = {
    base_ref: "main",
    base_sha: BASE_A,
    candidate_sha: HEAD_1,
  };
  const m = await buildManifestFromDeps(SUBJECT, refs, capture);
  assert.equal(m.entries.length, 2);
  assert.equal(m.candidate_sha, HEAD_1);
  const readme = m.entries.find((e) => e.path === "README.md");
  assert.equal(readme?.candidate_blob, BLOB_LEAN);
});

// ---------------------------------------------------------------------------
// Lifecycle wrapper
// ---------------------------------------------------------------------------

test("lifecycle: pre-persist failure aborts mutation", async () => {
  const files = new Map<string, string>();
  const deps = memoryIntegrityStoreDeps(files, {
    failWrite: (p) => p.endsWith("mut-test-1.json"),
  });
  let mutated = false;
  const result = await runCandidateMovingMutation({
    storeRoot: "/run",
    subject: SUBJECT,
    mutation_method: "rebase",
    storeDeps: deps,
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs) =>
      manifest(refs.candidate_sha, refs.base_sha, [
        entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
      ]),
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_A,
      candidate_sha: HEAD_1,
    }),
    mutate: async () => {
      mutated = true;
      return "did-mutate";
    },
  });
  assert.equal(result.aborted, true);
  assert.equal(mutated, false);
  assert.equal(result.classification, "unverified");
});

test("lifecycle: mutation error still re-reads and classifies", async () => {
  const deps = memoryIntegrityStoreDeps();
  let postReads = 0;
  const result = await runCandidateMovingMutation({
    storeRoot: "/run",
    subject: SUBJECT,
    mutation_method: "rebase",
    storeDeps: deps,
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs) =>
      manifest(refs.candidate_sha, refs.base_sha, [
        entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
      ]),
    reReadAuthoritative: async () => {
      postReads++;
      return {
        base_ref: "main",
        base_sha: BASE_B,
        candidate_sha: postReads > 1 ? HEAD_2 : HEAD_1,
      };
    },
    mutate: async () => {
      throw new Error("push failed");
    },
  });
  assert.equal(result.aborted, false);
  assert.ok(result.mutation_error?.includes("push failed"));
  assert.ok(postReads >= 1);
  // Surface preserved despite error → equivalent; still re-gate
  assert.equal(result.classification, "semantically_equivalent");
  const loaded = await loadMutationRecord("/run", result.mutation_id, deps);
  assert.equal(loaded?.lifecycle, "disposed");
});

test("lifecycle: clean rebase equivalent, readiness re-eval, event emitted", async () => {
  const deps = memoryIntegrityStoreDeps();
  const events: unknown[] = [];
  const result = await runCandidateMovingMutation({
    storeRoot: "/run",
    subject: SUBJECT,
    mutation_method: "restack",
    storeDeps: deps,
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs) =>
      manifest(refs.candidate_sha, refs.base_sha, [
        entry({
          path: "core/x.ts",
          status: "M",
          base_blob: "0".repeat(40),
          candidate_blob: BLOB_CORE,
        }),
      ]),
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_B,
      candidate_sha: HEAD_2,
    }),
    mutate: async () => ({ changed: true }),
    emitEvent: async (ev) => {
      events.push(ev);
    },
  });
  assert.equal(result.classification, "semantically_equivalent");
  assert.equal(result.disposition.re_evaluate_gates, true);
  assert.equal(result.disposition.invalidated_readiness, true);
  assert.equal(events.length, 1);
  const ev = events[0] as { type: string; classification: string; invalidated_review: boolean };
  assert.equal(ev.type, "candidate_integrity");
  assert.equal(ev.classification, "semantically_equivalent");
  assert.equal(ev.invalidated_review, false);
});

test("#793 fixture via lifecycle: README expansion → scope_expansion + readiness denied", async () => {
  const deps = memoryIntegrityStoreDeps();
  let phase = 0;
  const result = await runCandidateMovingMutation({
    storeRoot: "/run",
    subject: SUBJECT,
    mutation_method: "restack",
    storeDeps: deps,
    mutation_id: "mut-793",
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs) => {
      phase++;
      if (phase === 1) {
        return manifest(refs.candidate_sha, refs.base_sha, [
          entry({
            path: "README.md",
            status: "M",
            base_blob: "0".repeat(40),
            candidate_blob: BLOB_LEAN,
          }),
        ]);
      }
      return manifest(refs.candidate_sha, refs.base_sha, [
        entry({
          path: "README.md",
          status: "M",
          base_blob: "0".repeat(40),
          candidate_blob: BLOB_MONOLITH,
        }),
      ]);
    },
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_B,
      candidate_sha: HEAD_2,
    }),
    mutate: async () => ({ restacked: true }),
  });
  assert.equal(result.classification, "scope_expansion");
  assert.equal(result.disposition.invalidated_readiness, true);
  assert.equal(result.disposition.merge_eligible, false);
  const block = await integrityBlocksReadiness("/run", HEAD_2, deps);
  assert.ok(block);
  assert.equal(block?.classification, "scope_expansion");
  const reviewBlock = await integrityBlocksReviewReuse("/run", HEAD_2, HEAD_1, deps);
  assert.ok(reviewBlock);
});

test("composition: #793-class content also fails readme-landing-contract (#855 helper)", () => {
  // Composition only — product contract owned by #855; do not fork it.
  const lean = [
    "# agent-pipeline",
    "",
    "See [CLI](docs/cli.md), [config](docs/config.md), [concepts](docs/concepts.md).",
    "",
  ].join("\n");
  assert.equal(checkReadmeLandingContract(lean).ok, true);
  const monolith = build793ShapedMonolithicReadme();
  const bad = checkReadmeLandingContract(monolith);
  assert.equal(bad.ok, false);
  assert.ok(
    bad.diagnostics.some(
      (d) => d.code === "line-budget" || d.code === "full-inventory-shape",
    ),
  );
});

test("intended autofix lifecycle forces fresh review", async () => {
  const deps = memoryIntegrityStoreDeps();
  let phase = 0;
  const result = await runCandidateMovingMutation({
    storeRoot: "/run",
    subject: SUBJECT,
    mutation_method: "pre_merge_autofix",
    declared_scope: declaredScopeFromFindingPaths(["core/x.ts"]),
    storeDeps: deps,
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs) => {
      phase++;
      const blob = phase === 1 ? BLOB_CORE : BLOB_CORE2;
      return manifest(refs.candidate_sha, refs.base_sha, [
        entry({
          path: "core/x.ts",
          status: "M",
          base_blob: "0".repeat(40),
          candidate_blob: blob,
        }),
      ]);
    },
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_A,
      candidate_sha: HEAD_2,
    }),
    mutate: async () => ({ fixed: true }),
  });
  assert.equal(result.classification, "expected_scoped_change");
  assert.equal(result.disposition.requires_fresh_review, true);
  assert.equal(result.disposition.invalidated_review, true);
});

test("restart hydration: pre_persisted incomplete does not reseed pre from post", async () => {
  const deps = memoryIntegrityStoreDeps();
  const preM = manifest(HEAD_1, BASE_A, [
    entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
  ]);
  // Manually write incomplete record
  const record = {
    schema_version: 1 as const,
    mutation_id: "mut-restart",
    lifecycle: "mutation_claimed" as const,
    mutation_method: "rebase" as const,
    subject: {
      run_id: SUBJECT.run_id,
      issue: SUBJECT.issue,
      pr: SUBJECT.pr ?? null,
      domain: SUBJECT.domain,
    },
    declared_scope: emptyDeclaredScope(),
    pre_manifest: preM,
    post_manifest: null,
    classification: null,
    disposition: null,
    before_sha: HEAD_1,
    after_sha: null,
    base_sha_before: BASE_A,
    base_sha_after: null,
    created_at: "2026-08-05T12:00:00.000Z",
    updated_at: "2026-08-05T12:00:00.000Z",
  };
  await deps.writeFileAtomic!(
    mutationRecordPath("/run", "mut-restart"),
    JSON.stringify(record),
  );
  await deps.writeFileAtomic!(
    path.join("/run", "candidate-integrity", "active.json"),
    JSON.stringify({ mutation_id: "mut-restart" }),
  );

  const result = await hydrateAndCompleteIncompleteMutation({
    storeRoot: "/run",
    storeDeps: deps,
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_B,
      candidate_sha: HEAD_2,
    }),
    captureManifest: async (refs) => {
      // Post has different surface (expansion)
      return manifest(refs.candidate_sha, refs.base_sha, [
        entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
        entry({ path: "README.md", status: "A", candidate_blob: BLOB_MONOLITH }),
      ]);
    },
  });
  assert.ok(result);
  assert.equal(result!.record.pre_manifest?.candidate_sha, HEAD_1);
  assert.notEqual(result!.record.pre_manifest?.candidate_sha, HEAD_2);
  assert.equal(result!.classification, "scope_expansion");
  // Stale review for HEAD_1 cannot authorize HEAD_2
  const block = await integrityBlocksReviewReuse("/run", HEAD_2, HEAD_1, deps);
  assert.ok(block);
});

test("multi-item isolation: item A disposition intact after item B mutation", async () => {
  const deps = memoryIntegrityStoreDeps();
  // Item A clean restack
  const a = await runCandidateMovingMutation({
    storeRoot: "/run-a",
    subject: { ...SUBJECT, issue: 100, pr: 200 },
    mutation_method: "restack",
    storeDeps: deps,
    mutation_id: "mut-a",
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs) =>
      manifest(refs.candidate_sha, refs.base_sha, [
        entry({ path: "a-only.ts", status: "A", candidate_blob: BLOB_CORE }),
      ]),
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_B,
      candidate_sha: HEAD_2,
    }),
    mutate: async () => null,
  });
  assert.equal(a.classification, "semantically_equivalent");

  // Item B expands
  const b = await runCandidateMovingMutation({
    storeRoot: "/run-b",
    subject: { ...SUBJECT, issue: 101, pr: 201 },
    mutation_method: "restack",
    storeDeps: deps,
    mutation_id: "mut-b",
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs, phase) => {
      if (phase === "pre") {
        return manifest(refs.candidate_sha, refs.base_sha, [
          entry({ path: "b.ts", status: "A", candidate_blob: BLOB_CORE }),
        ]);
      }
      return manifest(refs.candidate_sha, refs.base_sha, [
        entry({ path: "b.ts", status: "A", candidate_blob: BLOB_CORE }),
        entry({ path: "evil.md", status: "A", candidate_blob: BLOB_MONOLITH }),
      ]);
    },
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_B,
      candidate_sha: HEAD_2,
    }),
    mutate: async () => null,
  });
  assert.equal(b.classification, "scope_expansion");

  // A still equivalent; no invalidation of review for A's store
  const aBlock = await integrityBlocksReadiness("/run-a", HEAD_2, deps);
  // A only invalidated readiness for re-gate (semantically_equivalent + sha change)
  assert.ok(aBlock); // readiness re-eval flag
  assert.equal(aBlock?.classification, "semantically_equivalent");
  const aReview = await integrityBlocksReviewReuse("/run-a", HEAD_2, HEAD_1, deps);
  // semantic equivalence does not invalidate review
  assert.equal(aReview, null);
});

test("no-op autofix (SHA unchanged, same surface) does not invent expansion", async () => {
  const deps = memoryIntegrityStoreDeps();
  const result = await runCandidateMovingMutation({
    storeRoot: "/run",
    subject: SUBJECT,
    mutation_method: "pre_merge_autofix",
    declared_scope: declaredScopeFromFindingPaths(["core/x.ts"]),
    storeDeps: deps,
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs) =>
      manifest(refs.candidate_sha, refs.base_sha, [
        entry({
          path: "core/x.ts",
          status: "M",
          base_blob: "0".repeat(40),
          candidate_blob: BLOB_CORE,
        }),
      ]),
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_A,
      candidate_sha: HEAD_1, // unchanged
    }),
    mutate: async () => ({ status: "noop-clean" }),
  });
  assert.equal(result.classification, "semantically_equivalent");
  assert.equal(result.disposition.requires_fresh_review, false);
});

test("event shape moves computeCandidateIntegrityMetrics counters", () => {
  const disp = dispositionForClassification("scope_expansion", {
    shaChanged: true,
    classificationReason: "scope_expansion: undeclared path README.md",
  });
  const event = buildCandidateIntegrityEvent({
    mutation_id: "m1",
    mutation_method: "restack",
    classification: "scope_expansion",
    before_sha: HEAD_1,
    after_sha: HEAD_2,
    base_sha_before: BASE_A,
    base_sha_after: BASE_B,
    changed_path_summary: ["README.md"],
    disposition: disp,
    path_class: "docs-landing",
    engine_version: "1.32.0",
  });
  const { metrics } = computeCandidateIntegrityMetrics([
    {
      runId: "r",
      dir: "/r",
      runJson: { engine: { version: "1.32.0" } },
      events: [event as unknown as Record<string, unknown>],
      summary: null,
      startAt: "2026-08-05T00:00:00Z",
      issue: 857,
      pr: 900,
      finalState: "pre-merge",
    },
  ]);
  assert.equal(metrics.total_events, 1);
  assert.equal(metrics.scope_expansion_invalidations, 1);
  assert.equal(metrics.review_invalidations, 1);
  assert.equal(metrics.readiness_invalidations, 1);
  assert.equal(metrics.candidate_moving_restacks, 1);
  assert.equal(metrics.by_mutation_method.restack, 1);
  assert.equal(metrics.by_path_class["docs-landing"], 1);
});

test("retry budget exhausts without human-authority hold", async () => {
  const deps = memoryIntegrityStoreDeps(new Map(), {
    randomId: (() => {
      let n = 0;
      return () => `mut-budget-${++n}`;
    })(),
  });
  const runOnce = () =>
    runCandidateMovingMutation({
      storeRoot: "/run",
      subject: SUBJECT,
      mutation_method: "restack",
      storeDeps: deps,
      preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
      captureManifest: async (refs, phase) => {
        if (phase === "pre") {
          return manifest(refs.candidate_sha, refs.base_sha, [
            entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
          ]);
        }
        return manifest(refs.candidate_sha, refs.base_sha, [
          entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
          entry({ path: "evil.md", status: "A", candidate_blob: BLOB_MONOLITH }),
        ]);
      },
      reReadAuthoritative: async () => ({
        base_ref: "main",
        base_sha: BASE_B,
        candidate_sha: HEAD_2,
      }),
      mutate: async () => null,
      retryBudget: 2,
    });

  // first failure + 2 extras allowed (retryBudget=2) → 3 expansion results, then abort
  for (let i = 0; i < 3; i++) {
    const r = await runOnce();
    assert.equal(r.classification, "scope_expansion");
    assert.equal(r.disposition.human_authority_hold, false);
    assert.equal(r.aborted, false);
  }
  // failure_count is now 3 >= 1+2 → further automatic mutations abort
  const r4 = await runOnce();
  assert.equal(r4.aborted, true);
  assert.ok(r4.abort_reason?.includes("budget"));
  assert.equal(r4.disposition.human_authority_hold, false);
});

test("contract: Covered sites inventory is frozen and non-empty", () => {
  assert.ok(COVERED_MUTATION_SITES.length >= 6);
  assert.ok(OUT_OF_SCOPE_MUTATION_SITES.length >= 4);
  assert.ok(
    COVERED_MUTATION_SITES.some((s) => s.includes("runDeterministicConflictRebase")),
  );
  assert.ok(COVERED_MUTATION_SITES.some((s) => s.includes("performPreMergeAutoFix")));
  assert.ok(COVERED_MUTATION_SITES.some((s) => s.includes("repair-pipeline-item")));
});

test("invalidation records survive optional event append failure", async () => {
  const deps = memoryIntegrityStoreDeps();
  const result = await runCandidateMovingMutation({
    storeRoot: "/run",
    subject: SUBJECT,
    mutation_method: "restack",
    storeDeps: deps,
    preRefs: { base_ref: "main", base_sha: BASE_A, candidate_sha: HEAD_1 },
    captureManifest: async (refs, phase) => {
      if (phase === "pre") {
        return manifest(refs.candidate_sha, refs.base_sha, [
          entry({ path: "a.ts", status: "A", candidate_blob: BLOB_CORE }),
        ]);
      }
      return manifest(refs.candidate_sha, refs.base_sha, [
        entry({ path: "evil.md", status: "A", candidate_blob: BLOB_MONOLITH }),
      ]);
    },
    reReadAuthoritative: async () => ({
      base_ref: "main",
      base_sha: BASE_B,
      candidate_sha: HEAD_2,
    }),
    mutate: async () => null,
    emitEvent: async () => {
      throw new Error("ledger append failed");
    },
  });
  assert.equal(result.classification, "scope_expansion");
  const inv = await loadInvalidationRecords("/run", deps);
  assert.ok(inv.length >= 1);
  assert.equal(inv[0]!.invalidated_readiness, true);
});
