// Generated FRG fixture contracts: admission/planning lifecycle boundaries (#1479).
// Uses the real fixed pack renderer and production prompt/readiness helpers with
// injected admission I/O. No network, git, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRG_HYBRID_V2_MANIFEST_SHA256,
  FRG_HYBRID_V2_POLICY_ID,
  FRG_HYBRID_V2_PRE_FIXTURE_CONTRACT_MANIFEST_SHA256,
  expectedHybridManifestSha256,
  hybridManifestSha256Accepted,
  loadFrgPack,
  renderFrgPackIssues,
} from "../scripts/frg-pack-observations.ts";
import { evaluateIssueReadiness, type IssueReadinessDeps } from "../scripts/issue-readiness.ts";
import {
  buildPlanningOpenspecPrompt,
  buildPlanReviewPrompt,
} from "../scripts/prompts/index.ts";
import { openSpecTaskReadiness } from "../scripts/stages/pre_merge.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const RELEASE = "1.40.1";
const PACK_RUN = "pack-1401-contract-regression";

function cfg(): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    repo: "acme/agent-pipeline",
    repo_dir: "/repo",
    domain: "agent-pipeline",
    issue_readiness: { enabled: true, timeout: 60 },
    harnesses: {
      implementer: "codex",
      reviewer: "codex",
      implementerSource: "repo-config",
      reviewerSource: "repo-config",
    },
    models: { ...DEFAULT_CONFIG.models, planning: "gpt-5.6-sol" },
    effort: { ...DEFAULT_CONFIG.effort, planning: "medium" },
  } as PipelineConfig;
}

function admissionDeps(input: {
  title: string;
  body: string;
  inspectPrompt: (prompt: string) => "ready" | "needs_spec";
}): IssueReadinessDeps & { invokeCount: number } {
  const deps: IssueReadinessDeps & { invokeCount: number } = {
    invokeCount: 0,
    fetchIssue: async () => ({
      title: input.title,
      body: input.body,
      labels: ["factory-gate", "pipeline:ready"],
    }),
    listComments: async () => [],
    getPipelineActor: async () => "pipeline-bot",
    createComment: async () => {},
    updateComment: async () => {},
    deleteComment: async () => {},
    addLabel: async () => {},
    removeLabel: async () => {},
    invokeImplementer: async ({ prompt }) => {
      deps.invokeCount += 1;
      const verdict = input.inspectPrompt(prompt);
      return {
        success: true,
        stdout: verdict === "ready"
          ? JSON.stringify({ verdict: "ready", deficiencies: [], proposed_body: "" })
          : JSON.stringify({
              verdict: "needs_spec",
              deficiencies: ["missing class-level/shared-controller repair explanation"],
              proposed_body: [
                "## Summary", "Specify the production repair class.",
                "## User story", "As an operator, I need a reusable repair.",
                "## Acceptance criteria", "- [ ] Name the shared controller behavior.",
                "## Out of scope", "- Site-only repair.",
                "## Open questions", "None.",
              ].join("\n"),
            }),
        stderr: "",
        timed_out: false,
      };
    },
    now: () => new Date("2026-09-07T18:00:00Z"),
  };
  return deps;
}

test("real FRG fixture render separates pre-archive work from controller lifecycle evidence", async () => {
  const pack = await loadFrgPack();
  const rendered = renderFrgPackIssues(pack, {
    release_version: RELEASE,
    pack_run_id: PACK_RUN,
  });

  assert.equal(rendered.length, 2);
  for (const issue of rendered) {
    assert.match(issue.body, /synthetic clean-path conformance fixture/i);
    assert.match(issue.body, /does not change production\s+behavior/i);
    assert.match(issue.body, /## Implementer-owned work and verification/);
    assert.match(issue.body, /## Controller-owned lifecycle evidence/);
    assert.match(issue.body, /must not be copied into `tasks\.md`/i);
    assert.match(issue.body, /normal issue-readiness admission, planning, plan review,\s+implementation, and review/i);
    assert.match(issue.body, new RegExp(`core/test/fixtures/frg/${PACK_RUN}/${issue.provenance.template_id}\\.json`));
    assert.match(issue.body, new RegExp(`core/test/frg-${PACK_RUN}-${issue.provenance.template_id}\\.test\\.ts`));
  }

  const openspec = rendered.find((issue) => issue.provenance.template_id === "clean-openspec")!;
  assert.match(openspec.body, /Pre-merge archives this issue's OpenSpec change/);
  assert.match(openspec.body, /reaches `pipeline:ready-to-deploy`/);
  assert.match(openspec.body, /closes the pull request and\s+issue without merge/);
});

test("rendered fixtures traverse ordinary admission and carry the lifecycle partition into planning review", async () => {
  const pack = await loadFrgPack();
  const [issue] = renderFrgPackIssues(pack, {
    release_version: RELEASE,
    pack_run_id: PACK_RUN,
  });
  assert.ok(issue);

  const deps = admissionDeps({
    title: issue.title,
    body: issue.body,
    inspectPrompt: (prompt) => {
      assert.ok(prompt.includes(issue.body), "ordinary admission receives the complete rendered body");
      assert.match(prompt, /synthetic clean-path conformance fixture/i);
      assert.match(prompt, /shared classifier,[\s\S]*recovery recipe, gate, or[\s\S]*controller/i);
      return "ready";
    },
  });
  const admitted = await evaluateIssueReadiness(cfg(), 1479, { deps, dryRun: true });
  assert.equal(admitted.kind, "ready", JSON.stringify(admitted));
  assert.equal(deps.invokeCount, 1, "factory-gate labels do not bypass ordinary admission");

  const planning = buildPlanningOpenspecPrompt({
    cfg: cfg(),
    issueNumber: 1479,
    title: issue.title,
    body: issue.body,
    pipelineRunId: "run-contract",
  });
  assert.match(planning, /## Controller-owned lifecycle evidence/);
  assert.match(planning, /must not be copied into `tasks\.md`/i);

  const review = buildPlanReviewPrompt({
    cfg: cfg(),
    issueNumber: 1479,
    title: issue.title,
    body: issue.body,
    plan: "Implement only the declared run-scoped fixture and test.",
    reviewer: "codex",
    implementer: "codex",
  });
  assert.match(review, /## Controller-owned lifecycle evidence/);
  assert.match(review, /must not be copied into `tasks\.md`/i);
});

test("factory labels do not admit an incomplete production self-host repair", async () => {
  const body = "Repair the Pipeline self-host failure at this one call site.";
  const deps = admissionDeps({
    title: "fix: self-host failure",
    body,
    inspectPrompt: (prompt) => {
      assert.ok(prompt.includes(body));
      assert.match(prompt, /Engine-dogfood plan\/intake bar/);
      return "needs_spec";
    },
  });
  const result = await evaluateIssueReadiness(cfg(), 1480, { deps, dryRun: true });
  assert.equal(result.kind, "needs_spec");
  assert.equal(deps.invokeCount, 1);
});

test("genuine unchecked implementation tasks still block pre-merge archive", () => {
  const readiness = openSpecTaskReadiness([
    "- [x] Add the run-scoped fixture.",
    "- [ ] Add the executable regression test.",
    "- [ ] Run the full CI gate.",
  ].join("\n"));
  assert.deepEqual(readiness, {
    complete: false,
    incompleteCount: 2,
    reason: "2 unchecked task(s) remain in tasks.md",
  });
});

test("manifest evolution keeps pre-fix hybrid-v2 evidence version-bound", async () => {
  const pack = await loadFrgPack();
  assert.equal(pack.manifest_sha256, FRG_HYBRID_V2_MANIFEST_SHA256);
  assert.notEqual(
    FRG_HYBRID_V2_MANIFEST_SHA256,
    FRG_HYBRID_V2_PRE_FIXTURE_CONTRACT_MANIFEST_SHA256,
  );
  assert.equal(
    expectedHybridManifestSha256(FRG_HYBRID_V2_POLICY_ID, "1.40.0"),
    FRG_HYBRID_V2_PRE_FIXTURE_CONTRACT_MANIFEST_SHA256,
  );
  assert.equal(
    expectedHybridManifestSha256(FRG_HYBRID_V2_POLICY_ID, RELEASE),
    FRG_HYBRID_V2_MANIFEST_SHA256,
  );
  assert.equal(
    hybridManifestSha256Accepted(
      FRG_HYBRID_V2_POLICY_ID,
      "1.40.0",
      FRG_HYBRID_V2_PRE_FIXTURE_CONTRACT_MANIFEST_SHA256,
    ),
    true,
  );
  assert.equal(
    hybridManifestSha256Accepted(
      FRG_HYBRID_V2_POLICY_ID,
      RELEASE,
      FRG_HYBRID_V2_PRE_FIXTURE_CONTRACT_MANIFEST_SHA256,
    ),
    false,
  );
});
