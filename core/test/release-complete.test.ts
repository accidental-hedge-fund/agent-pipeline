import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertReleaseManagedMetadataPaths,
  classifyPublisherRuns,
  exactHeadCheckRunsState,
  metadataChecksState,
  parsePublisherRunRows,
  parsePublisherWorkflowRunPages,
  realCompleteReleaseDeps,
  releaseTagNotes,
  selectExactPublisherConclusion,
  runCompleteRelease,
  validateReleaseMilestone,
  type CompleteReleaseDeps,
  type CompleteReleaseMilestone,
  type ObservedMetadataRelease,
  type PublisherRecoveryEpisode,
} from "../scripts/stages/release-complete.ts";
import type { ExactCandidateFrgRecord } from "../scripts/exact-candidate-frg.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

function milestone(over: Partial<CompleteReleaseMilestone> = {}): CompleteReleaseMilestone {
  return {
    number: 9,
    title: "v1.2.3",
    issues: [{
      number: 11,
      state: "CLOSED",
      implementation_prs: [{ number: 21, state: "MERGED", base: "main", merge_commit_oid: A }],
    }],
    ...over,
  };
}

function fakeFrg(candidate = C): ExactCandidateFrgRecord {
  return { epoch_id: `frg-1.2.3-${candidate.slice(0, 12)}`, candidate: { sha: candidate } } as ExactCandidateFrgRecord;
}

function deps(over: Partial<CompleteReleaseDeps> = {}): CompleteReleaseDeps & { calls: string[] } {
  const calls: string[] = [];
  let metadata: ObservedMetadataRelease | null = null;
  let tagged = false;
  let published = false;
  const d: CompleteReleaseDeps = {
    log() {},
    withRunLock: async (key, fn) => { calls.push(`lock:${key}`); return fn(); },
    async resolveMilestones() { calls.push("milestone"); return [milestone()]; },
    async observeOriginHead() { calls.push("head"); return metadata?.state === "MERGED" ? C : B; },
    async commitContained() { calls.push("containment"); return true; },
    async versionsAt(commit) { calls.push(`versions:${commit}`); return { root: commit === C ? "1.2.3" : "1.2.2", core: commit === C ? "1.2.3" : "1.2.2" }; },
    async observeMetadata() { calls.push("observe-metadata"); return metadata; },
    async prepareMetadata() {
      calls.push("prepare-metadata");
      metadata = { pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null };
      return { schema_version: 1, kind: "release_prepare", version: "1.2.3", pr: 31, base: "main", head_oid: A };
    },
    async finishMetadata(release) { calls.push("finish-metadata"); metadata = { ...release, state: "MERGED", merge_commit_oid: C }; return metadata; },
    async observeExactFrg(_version, candidate) { calls.push(`observe-frg:${candidate}`); return fakeFrg(candidate); },
    async runExactFrg(_version, candidate) { calls.push(`frg:${candidate}`); return fakeFrg(candidate); },
    verifyExactFrg(record, candidate) { calls.push(`verify-frg:${candidate}`); assert.equal(record.candidate.sha, candidate); },
    async observeTag() { calls.push("observe-tag"); return tagged ? { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) } : null; },
    async createAnnotatedTag(_tag, candidate) { calls.push(`tag:${candidate}`); tagged = true; published = true; },
    async observePublication() { calls.push("publication"); return published ? { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" } : null; },
    async recoverPublication() { calls.push("recover-publication"); return true; },
    async wait() { calls.push("wait"); },
    publicationAttempts: 2,
    ...over,
  };
  return Object.assign(d, { calls });
}

const METADATA_PROVENANCE = "_Prepared by the bounded `pipeline release prepare` helper_";
const LEGACY_METADATA_PROVENANCE = "_Prepared by `pipeline release`_";

function metadataPrPayload(over: Record<string, unknown> = {}) {
  return {
    number: 31,
    title: "release: 1.2.3 — version metadata",
    body: `Version metadata only for v1.2.3.\n\n${METADATA_PROVENANCE}`,
    baseRefName: "main",
    headRefName: "release/v1.2.3",
    headRefOid: A,
    author: { login: "pipeline-bot", is_bot: true },
    state: "MERGED",
    isCrossRepository: false,
    headRepositoryOwner: { login: "o" },
    mergeCommit: { oid: C },
    ...over,
  };
}

function metadataObserverCommand(opts: {
  list: unknown;
  view: unknown;
  calls?: string[];
  checksHead?: string;
  actor?: string;
}) {
  return async (_cwd: string, file: string, args: string[]) => {
    const joined = args.join(" ");
    opts.calls?.push(`${file} ${joined}`);
    if (file === "gh" && args[0] === "api" && args[1] === "user") return opts.actor ?? "pipeline-bot";
    if (file === "gh" && args[0] === "pr" && args[1] === "list") {
      assert.ok(args.includes("--search"));
      assert.ok(!args.includes("--head"));
      const json = args[args.indexOf("--json") + 1] ?? "";
      assert.ok(json.includes("body"));
      assert.ok(json.includes("headRefName"));
      assert.ok(json.includes("author"));
      assert.ok(json.includes("isCrossRepository"));
      assert.ok(json.includes("headRepositoryOwner"));
      return JSON.stringify(opts.list);
    }
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      const json = args[args.indexOf("--json") + 1] ?? "";
      assert.ok(json.includes("body"));
      assert.ok(json.includes("headRefName"));
      assert.ok(json.includes("author"));
      assert.ok(json.includes("title"));
      return JSON.stringify(opts.view);
    }
    if (file === "gh" && args[0] === "api" && joined.includes("check-runs")) {
      return JSON.stringify([{
        check_runs: [{ name: "ci", head_sha: opts.checksHead ?? A, status: "completed", conclusion: "success" }],
      }]);
    }
    if (file === "gh" && args[0] === "api" && joined.includes("/pulls/") && joined.includes("/files")) {
      return JSON.stringify([[{ filename: "package.json" }, { filename: "core/package.json" }]]);
    }
    if (args[0] === "fetch" && joined.includes("release/v1.2.3")) throw new Error("branch deleted");
    if (args[0] === "fetch" && joined.includes("pull/31/head")) return "";
    if (args[0] === "rev-parse" && joined.includes("release-metadata")) return A;
    if (args[0] === "show" && joined.includes("package.json")) return JSON.stringify({ version: "1.2.3" });
    if (args[0] === "diff") return "";
    throw new Error(`unexpected ${file} ${joined}`);
  };
}

function managedPullFiles(): string {
  return JSON.stringify([[{ filename: "package.json" }, { filename: "core/package.json" }]]);
}

function finishMetadataCommand(opts: {
  calls?: string[];
  nextView: () => Record<string, unknown>;
  nextChecks: () => unknown;
}) {
  return async (_cwd: string, file: string, args: string[]) => {
    const joined = args.join(" ");
    opts.calls?.push(`${file} ${joined}`);
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse") return A;
    if (args[0] === "show") return JSON.stringify({ version: "1.2.3" });
    if (args[0] === "diff") {
      throw new Error("finishMetadata must not use origin/base...head after an external merge");
    }
    if (file === "gh" && args[0] === "api" && args[1] === "user") return "pipeline-bot";
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      return JSON.stringify(opts.nextView());
    }
    if (file === "gh" && args[0] === "api" && joined.includes("check-runs")) {
      return JSON.stringify(opts.nextChecks());
    }
    if (file === "gh" && args[0] === "api" && joined.includes("/pulls/") && joined.includes("/files")) {
      return managedPullFiles();
    }
    throw new Error(`unexpected ${file} ${joined}`);
  };
}

test("complete release orders metadata merge before C/FRG/tag/publication", async () => {
  const d = deps();
  const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.equal(result?.candidate_sha, C);
  assert.match(d.calls[0]!, /^lock:complete-release-[0-9a-f]{24}$/);
  assert.ok(!d.calls[0]!.includes("/"));
  assert.ok(d.calls.indexOf("finish-metadata") < d.calls.indexOf(`frg:${C}`));
  assert.ok(d.calls.indexOf(`verify-frg:${C}`) < d.calls.indexOf(`tag:${C}`));
  assert.ok(d.calls.indexOf(`tag:${C}`) < d.calls.lastIndexOf("publication"));
});

test("milestone must be exactly one nonempty match", async () => {
  await assert.rejects(() => validateReleaseMilestone("1.2.3", "main", [], async () => B, async () => true), /exactly one/);
  await assert.rejects(() => validateReleaseMilestone("1.2.3", "main", [milestone({ issues: [] })], async () => B, async () => true), /empty/);
});

test("milestone rejects open, missing merged PR, and non-contained merge", async () => {
  await assert.rejects(() => validateReleaseMilestone("1.2.3", "main", [milestone({ issues: [{ number: 11, state: "OPEN", implementation_prs: [] }] })], async () => B, async () => true), /still open/);
  const none = milestone();
  none.issues[0]!.implementation_prs = [];
  await assert.rejects(() => validateReleaseMilestone("1.2.3", "main", [none], async () => B, async () => true), /no merged/);
  await assert.rejects(() => validateReleaseMilestone("1.2.3", "main", [milestone()], async () => B, async () => false), /no merged implementation PR contained/);
});

test("milestone accepts multiple merged closers when a valid implementation merge is contained", async () => {
  const multi = milestone();
  multi.issues[0]!.implementation_prs.push({ number: 22, state: "MERGED", base: "main", merge_commit_oid: B });
  assert.equal(await validateReleaseMilestone("1.2.3", "main", [multi], async () => C, async (oid) => oid === B), C);
});

test("existing merged metadata is reused without duplicate bump", async () => {
  const merged: ObservedMetadataRelease = { pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "MERGED", merge_commit_oid: C };
  const d = deps({
    async observeOriginHead() { return C; },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async observeMetadata() { return merged; },
  });
  await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.ok(!d.calls.includes("prepare-metadata"));
  assert.ok(!d.calls.includes("finish-metadata"));
});

test("FRG failure creates no tag", async () => {
  const d = deps({ verifyExactFrg() { throw new Error("FRG failed"); } });
  await assert.rejects(() => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d), /FRG failed/);
  assert.ok(!d.calls.some((x) => x.startsWith("tag:")));
});

test("main movement after FRG fails stale C before tag", async () => {
  let observations = 0;
  const d = deps({
    async observeOriginHead() {
      observations++;
      if (observations >= 5) return A;
      return observations >= 3 ? C : B;
    },
  });
  await assert.rejects(() => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d), /moved from candidate/);
  assert.ok(!d.calls.some((x) => x.startsWith("tag:")));
});

test("milestone is freshly revalidated at frozen C before fixtures", async () => {
  let reads = 0;
  const reopened = milestone({ issues: [{ number: 11, state: "OPEN", implementation_prs: [] }] });
  const d = deps({ async resolveMilestones() { return [++reads === 1 ? milestone() : reopened]; } });
  await assert.rejects(() => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d), /still open/);
  assert.ok(!d.calls.some((call) => call.startsWith("frg:") || call.startsWith("tag:")));
});

test("milestone is revalidated again after FRG before irreversible tag creation", async () => {
  let reads = 0;
  const reopened = milestone({ issues: [{ number: 11, state: "OPEN", implementation_prs: [] }] });
  const d = deps({ async resolveMilestones() { return [++reads < 3 ? milestone() : reopened]; } });
  await assert.rejects(() => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d), /still open/);
  assert.ok(d.calls.some((call) => call.startsWith("frg:")));
  assert.ok(!d.calls.some((call) => call.startsWith("tag:")));
});

test("conflicting tag fails without FRG, retag, or force", async () => {
  const d = deps({
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async observeTag() { return { annotated: true, peeled_commit: A, annotation: releaseTagNotes("1.2.3", C) }; },
  });
  await assert.rejects(() => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d), /annotation does not match/);
  assert.ok(!d.calls.some((x) => x.startsWith("frg:")));
  assert.ok(!d.calls.some((x) => x.startsWith("tag:")));
});

test("same-target published tag makes repeat invocation a no-op", async () => {
  const d = deps({
    async observeOriginHead() { throw new Error("origin/main unavailable after completed release"); },
    async versionsAt(commit) { return commit === C ? { root: "1.2.3", core: "1.2.3" } : { root: "1.2.4", core: "1.2.4" }; },
    async observeMetadata() { return null; },
    async resolveMilestones() { throw new Error("completed release must not re-read mutable milestone"); },
    async observeTag() { return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }; },
    async observePublication() { return { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" }; },
  });
  const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.equal(result?.already_complete, true);
  assert.ok(!d.calls.some((x) => x.startsWith("frg:")));
  assert.ok(!d.calls.some((x) => x.startsWith("tag:")));
});

test("completed retry returns the same observer-reconciled identity without rerunning fixtures", async () => {
  const d = deps();
  const first = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  const firstFrgRuns = d.calls.filter((call) => call.startsWith("frg:")).length;
  const second = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.deepEqual(second, first);
  assert.equal(d.calls.filter((call) => call.startsWith("frg:")).length, firstFrgRuns);
  assert.ok(d.calls.includes(`observe-frg:${C}`), "retry verifies the durable exact-C FRG proof");
});

test("existing tag with interrupted publisher resumes without milestone or FRG while main equals C", async () => {
  let recovered = false;
  const d = deps({
    async observeOriginHead() { d.calls.push("head"); return C; },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async resolveMilestones() { throw new Error("must not re-read milestone"); },
    async observeTag() { return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }; },
    async observePublication() {
      return !recovered
        ? { tag: "v1.2.3", draft: true, published_at: null, workflow_conclusion: "failure" as const }
        : { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" };
    },
    async recoverPublication() { d.calls.push("recover-publication"); recovered = true; return true; },
  });
  const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.equal(result?.candidate_sha, C);
  assert.ok(d.calls.includes("recover-publication"));
  assert.ok(!d.calls.some((x) => x.startsWith("frg:") || x.startsWith("tag:")));
});

test("fresh tag recovers an exact failed publisher before completion", async () => {
  let recovered = false;
  const d = deps({
    async observePublication() {
      if (!d.calls.some((call) => call.startsWith("tag:"))) return null;
      return recovered
        ? { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" as const }
        : null;
    },
    async recoverPublication() { d.calls.push("recover-publication"); recovered = true; return true; },
  });
  const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.equal(result?.candidate_sha, C);
  assert.equal(d.calls.filter((call) => call === "recover-publication").length, 1);
});

test("draft publication is not completion", async () => {
  const d = deps({ async observePublication() { return { tag: "v1.2.3", draft: true, published_at: null, workflow_conclusion: "success" }; } });
  await assert.rejects(() => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d), /draft or unpublished/);
});

test("dry-run validates milestone but performs no release mutations", async () => {
  const d = deps();
  assert.equal(await runCompleteRelease("1.2.3", { dryRun: true }, { repo_dir: "/repo", repo: "o/r" }, d), null);
  for (const mutation of ["prepare-metadata", "finish-metadata"]) assert.ok(!d.calls.includes(mutation));
  assert.ok(!d.calls.some((x) => x.startsWith("frg:") || x.startsWith("tag:")));
});

test("publisher proof binds push or workflow_dispatch, tag branch, and exact C", () => {
  const base = { databaseId: 1, attempt: 1, status: "completed", conclusion: "success" };
  const rows = [
    { ...base, event: "workflow_dispatch", headBranch: "v1.2.3", headSha: C },
    { ...base, databaseId: 2, event: "push", headBranch: "main", headSha: C },
    { ...base, databaseId: 3, event: "push", headBranch: "v1.2.3", headSha: B },
  ];
  assert.equal(selectExactPublisherConclusion(rows, "v1.2.3", C), "success");
  assert.equal(classifyPublisherRuns(rows, "v1.2.3", C).class, "successful");
  const failedOnly = [
    { databaseId: 4, attempt: 1, event: "push", headBranch: "v1.2.3", headSha: C, status: "completed", conclusion: "failure" },
  ];
  assert.equal(selectExactPublisherConclusion(failedOnly, "v1.2.3", C), "failure");
  assert.equal(classifyPublisherRuns([], "v1.2.3", C).class, "absent");
  assert.equal(classifyPublisherRuns([
    { databaseId: 5, attempt: 1, event: "push", headBranch: "v1.2.3", headSha: C, status: "in_progress", conclusion: null },
  ], "v1.2.3", C).class, "pending");
});

test("publisher classification locates the exact run among at least 100 workflow rows", () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({
    databaseId: i + 1, attempt: 1, event: "push", headBranch: "v0.0.1", headSha: C,
    status: "completed", conclusion: "success",
  }));
  const exact = {
    databaseId: 101, attempt: 1, event: "push", headBranch: "v1.2.3", headSha: C,
    status: "completed", conclusion: "success",
  };
  assert.equal(classifyPublisherRuns([...filler, exact], "v1.2.3", C).class, "successful");
  assert.equal(classifyPublisherRuns([...filler.slice(0, 99), exact], "v1.2.3", C).class, "successful");
  assert.equal(classifyPublisherRuns(filler, "v1.2.3", C).class, "absent");
});

test("publisher workflow pages fail closed unless total_count matches the flattened exact-identity set", () => {
  const rest = (id: number, branch = "v0.0.1") => ({
    id, event: "push", head_branch: branch, head_sha: C,
    status: "completed", conclusion: "success", run_attempt: 1,
  });
  const filler = Array.from({ length: 100 }, (_, i) => rest(i + 1));
  const exact = rest(101, "v1.2.3");
  const parsed = parsePublisherWorkflowRunPages([
    { total_count: 101, workflow_runs: filler },
    { total_count: 101, workflow_runs: [exact] },
  ], "v1.2.3");
  assert.equal(classifyPublisherRuns(parsed, "v1.2.3", C).class, "successful");
  assert.throws(
    () => parsePublisherWorkflowRunPages([{ total_count: 101, workflow_runs: filler }], "v1.2.3"),
    /truncated/,
  );
  assert.throws(
    () => parsePublisherWorkflowRunPages([{ workflow_runs: [exact] }], "v1.2.3"),
    /unknown shape/,
  );
});

test("metadata adapter requires nonempty exact-head green checks", () => {
  assert.equal(metadataChecksState([]), "pending");
  assert.equal(metadataChecksState([{ name: "ci", bucket: "pending" }]), "pending");
  assert.equal(metadataChecksState([{ name: "ci", bucket: "pass" }]), "pass");
  assert.equal(metadataChecksState([{ name: "ci", bucket: "fail" }]), "fail");
  assert.throws(() => metadataChecksState([null]), /unknown shape/);
});

test("metadata adapter rejects unrelated reusable-PR paths", () => {
  assert.doesNotThrow(() => assertReleaseManagedMetadataPaths(["package.json", "core/package.json", "hosts/codex/SKILL.md"]));
  assert.throws(() => assertReleaseManagedMetadataPaths([]), /non-release-managed/);
  assert.throws(() => assertReleaseManagedMetadataPaths(["package.json", ".github/pipeline.yml"]), /non-release-managed/);
});

test("production tag observer binds one fetched non-tag snapshot", async () => {
  const calls: string[][] = [];
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const deps = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    calls.push([file, ...args]);
    const joined = args.join(" ");
    if (joined.startsWith("ls-remote")) return `${A}\trefs/tags/${tag}\n${C}\trefs/tags/${tag}^{}`;
    if (args[0] === "fetch") return "";
    if (joined === `rev-parse refs/pipeline/release-observe/${tag}`) return A;
    if (joined === `cat-file -t refs/pipeline/release-observe/${tag}`) return "tag";
    if (joined === `rev-parse refs/pipeline/release-observe/${tag}^{}`) return C;
    if (args[0] === "for-each-ref") return notes;
    throw new Error(`unexpected ${file} ${joined}`);
  } });
  assert.deepEqual(await deps.observeTag(tag), { annotated: true, peeled_commit: C, annotation: notes });
  const fetch = calls.find((call) => call[1] === "fetch")!;
  assert.ok(fetch.some((arg) => arg === `refs/tags/${tag}:refs/pipeline/release-observe/${tag}`));
  assert.ok(!fetch.some((arg) => arg.includes(`:refs/tags/${tag}-release-observe`)));
});

test("production tag creator retries a correct local tag and reconciles a correct push race", async () => {
  const notes = releaseTagNotes("1.2.3", C);
  let mode: "local" | "race" = "local";
  let pushes = 0;
  let tags = 0;
  const deps = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, _file, args) => {
    const joined = args.join(" ");
    if (joined.startsWith("rev-parse --verify")) {
      if (mode === "local") return A;
      throw new Error("missing local tag");
    }
    if (joined.startsWith("cat-file -t refs/tags/")) return "tag";
    if (joined.startsWith("rev-parse refs/tags/") && joined.endsWith("^{}")) return C;
    if (args[0] === "for-each-ref") return notes;
    if (args[0] === "tag") { tags++; return ""; }
    if (args[0] === "push") { pushes++; if (mode === "race") throw new Error("remote race"); return ""; }
    if (args[0] === "ls-remote") return `${A}\trefs/tags/v1.2.3\n${C}\trefs/tags/v1.2.3^{}`;
    if (args[0] === "fetch") return "";
    if (joined === "rev-parse refs/pipeline/release-observe/v1.2.3") return A;
    if (joined === "cat-file -t refs/pipeline/release-observe/v1.2.3") return "tag";
    if (joined === "rev-parse refs/pipeline/release-observe/v1.2.3^{}") return C;
    throw new Error(`unexpected git ${joined}`);
  } });
  await deps.createAnnotatedTag("v1.2.3", C, notes);
  assert.equal(tags, 0);
  mode = "race";
  await deps.createAnnotatedTag("v1.2.3", C, notes);
  assert.equal(tags, 1);
  assert.equal(pushes, 2);
});

test("production tag creator fails closed when a push race installs the wrong tag", async () => {
  const notes = releaseTagNotes("1.2.3", C);
  const deps = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, _file, args) => {
    const joined = args.join(" ");
    if (joined.startsWith("rev-parse --verify")) throw new Error("missing");
    if (args[0] === "tag") return "";
    if (args[0] === "push") throw new Error("remote race");
    if (args[0] === "ls-remote") return `${A}\trefs/tags/v1.2.3\n${D}\trefs/tags/v1.2.3^{}`;
    if (args[0] === "fetch") return "";
    if (joined === "rev-parse refs/pipeline/release-observe/v1.2.3") return A;
    if (joined === "cat-file -t refs/pipeline/release-observe/v1.2.3") return "tag";
    if (joined === "rev-parse refs/pipeline/release-observe/v1.2.3^{}") return D;
    if (args[0] === "for-each-ref") return notes;
    throw new Error(`unexpected git ${joined}`);
  } });
  await assert.rejects(() => deps.createAnnotatedTag("v1.2.3", C, notes), /remote race/);
});

test("production publication observer does not misclassify downstream 404 as release absence", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const deps = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    const joined = args.join(" ");
    if (file === "gh" && args[0] === "api" && joined.includes("releases/tags/")) return JSON.stringify({
      tag_name: tag, draft: false, prerelease: false, published_at: "2026-09-10T00:00:00Z",
      body: notes, name: tag, html_url: "https://github.test/o/r/releases/tag/v1.2.3",
    });
    if (file === "gh" && args[0] === "api" && joined.includes("actions/workflows/release.yml/runs")) {
      throw new Error("HTTP 404 from workflow runs API");
    }
    if (args[0] === "ls-remote") return `${A}\trefs/tags/${tag}\n${C}\trefs/tags/${tag}^{}`;
    if (args[0] === "fetch") return "";
    if (joined === `rev-parse refs/pipeline/release-observe/${tag}`) return A;
    if (joined === `cat-file -t refs/pipeline/release-observe/${tag}`) return "tag";
    if (joined === `rev-parse refs/pipeline/release-observe/${tag}^{}`) return C;
    if (args[0] === "for-each-ref") return notes;
    throw new Error(`unexpected ${file} ${joined}`);
  } });
  await assert.rejects(() => deps.observePublication(tag), /HTTP 404 from workflow runs API/);
});

test("version on main without metadata PR proof fails closed", async () => {
  const d = deps({
    async observeOriginHead() { return C; },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async observeMetadata() { return null; },
  });
  await assert.rejects(
    () => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d),
    /without a validated release-managed metadata PR/,
  );
  assert.ok(!d.calls.includes("prepare-metadata"));
  assert.ok(!d.calls.some((x) => x.startsWith("frg:") || x.startsWith("tag:")));
});

test("tagged-stale-C stays incomplete without retag when main moved", async () => {
  const d = deps({
    async observeOriginHead() { return D; },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async resolveMilestones() { throw new Error("must not re-read milestone"); },
    async observeTag() { return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }; },
    async observePublication() {
      return { tag: "v1.2.3", draft: true, published_at: null, workflow_conclusion: "pending" };
    },
    async recoverPublication() { throw new Error("must not recover after stale-C"); },
  });
  await assert.rejects(() => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d), /tagged-stale-C/);
  assert.ok(!d.calls.some((x) => x.startsWith("frg:") || x.startsWith("tag:")));
});

test("completed tag plus later docs refresh does not report tagged-stale-C", async () => {
  const d = deps({
    async observeOriginHead() { throw new Error("completed release must not consult later main"); },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async resolveMilestones() { throw new Error("completed release must not re-read mutable milestone"); },
    async observeTag() { return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }; },
    async observePublication() {
      return { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" };
    },
  });
  const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.equal(result?.already_complete, true);
  assert.equal(result?.candidate_sha, C);
});

test("exact-head check-runs require nonempty green results at the immutable head", () => {
  assert.equal(exactHeadCheckRunsState({ check_runs: [] }, C), "pending");
  assert.equal(exactHeadCheckRunsState({
    check_runs: [{ name: "ci", head_sha: B, status: "completed", conclusion: "success" }],
  }, C), "pending");
  assert.equal(exactHeadCheckRunsState({
    check_runs: [{ name: "ci", head_sha: C, status: "completed", conclusion: "success" }],
  }, C), "pass");
  assert.equal(exactHeadCheckRunsState({
    check_runs: [{ name: "ci", head_sha: C, status: "completed", conclusion: "failure" }],
  }, C), "fail");
  assert.equal(exactHeadCheckRunsState({
    check_runs: [{ name: "ci", head_sha: C, status: "in_progress", conclusion: null }],
  }, C), "pending");
});

test("production metadata observer discovers by title and fetches a deleted head", async () => {
  const calls: string[] = [];
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    const joined = args.join(" ");
    calls.push(`${file} ${joined}`);
    if (file === "gh" && args[0] === "pr" && args[1] === "list") {
      assert.ok(args.includes("--search"));
      assert.ok(!args.includes("--head"));
      return JSON.stringify([metadataPrPayload()]);
    }
    if (file === "gh" && args[0] === "api" && args[1] === "user") return "pipeline-bot";
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      return JSON.stringify(metadataPrPayload());
    }
    if (file === "gh" && args[0] === "api" && joined.includes("check-runs")) {
      return JSON.stringify([{ check_runs: [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }] }]);
    }
    if (file === "gh" && args[0] === "api" && joined.includes("/pulls/") && joined.includes("/files")) {
      return JSON.stringify([[{ filename: "package.json" }, { filename: "core/package.json" }]]);
    }
    if (args[0] === "fetch" && joined.includes("release/v1.2.3")) throw new Error("branch deleted");
    if (args[0] === "fetch" && joined.includes("pull/31/head")) return "";
    if (args[0] === "rev-parse" && joined.includes("release-metadata")) return A;
    if (args[0] === "show" && joined.includes("package.json")) {
      return JSON.stringify({ version: "1.2.3" });
    }
    if (args[0] === "diff") return "";
    throw new Error(`unexpected ${file} ${joined}`);
  } });
  const observed = await adapter.observeMetadata("1.2.3", "main");
  assert.equal(observed?.pr, 31);
  assert.equal(observed?.state, "MERGED");
  assert.equal(observed?.head_oid, A);
  assert.ok(calls.some((call) => call.includes("pull/31/head")));
  assert.ok(calls.some((call) => call.includes("/pulls/31/files")));
  assert.ok(!calls.some((call) => call.includes("diff --name-only")));
});

test("already-merged metadata reuse proves files after merge-commit squash and rebase", async () => {
  for (const strategy of ["merge-commit", "squash", "rebase"] as const) {
    const calls: string[] = [];
    const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
      command: async (_cwd, file, args) => {
        const joined = args.join(" ");
        calls.push(`${file} ${joined}`);
        if (file === "gh" && args[0] === "pr" && args[1] === "list") {
          return JSON.stringify([metadataPrPayload()]);
        }
        if (file === "gh" && args[0] === "api" && args[1] === "user") return "pipeline-bot";
        if (file === "gh" && args[0] === "pr" && args[1] === "view") {
          return JSON.stringify(metadataPrPayload());
        }
        if (file === "gh" && args[0] === "api" && joined.includes("/pulls/") && joined.includes("/files")) {
          return JSON.stringify([[{ filename: "package.json" }, { filename: "core/package.json" }]]);
        }
        if (file === "gh" && args[0] === "api" && joined.includes("check-runs")) {
          return JSON.stringify([{ check_runs: [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }] }]);
        }
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse") return A;
        if (args[0] === "show") return JSON.stringify({ version: "1.2.3" });
        if (args[0] === "diff") {
          throw new Error(`${strategy}: triple-dot against current main is empty after merge`);
        }
        throw new Error(`unexpected ${file} ${joined}`);
      },
    });
    const observed = await adapter.observeMetadata("1.2.3", "main");
    assert.equal(observed?.pr, 31, strategy);
    assert.equal(observed?.state, "MERGED", strategy);
    assert.ok(calls.some((call) => call.includes("/pulls/31/files")), strategy);
    assert.ok(!calls.some((call) => /\bdiff\b/.test(call)), strategy);
  }
});

test("production metadata observer fails closed on empty or wrong-head CI", async () => {
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    const joined = args.join(" ");
    if (file === "gh" && args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([metadataPrPayload()]);
    }
    if (file === "gh" && args[0] === "api" && args[1] === "user") return "pipeline-bot";
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      return JSON.stringify(metadataPrPayload());
    }
    if (file === "gh" && args[0] === "api" && joined.includes("check-runs")) {
      return JSON.stringify([{ check_runs: [{ name: "ci", head_sha: B, status: "completed", conclusion: "success" }] }]);
    }
    if (file === "gh" && args[0] === "api" && joined.includes("/pulls/") && joined.includes("/files")) {
      return JSON.stringify([[{ filename: "package.json" }, { filename: "core/package.json" }]]);
    }
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse") return A;
    if (args[0] === "show") return JSON.stringify({ version: "1.2.3" });
    if (args[0] === "diff") return "";
    throw new Error(`unexpected ${file} ${joined}`);
  } });
  await assert.rejects(() => adapter.observeMetadata("1.2.3", "main"), /no nonempty green exact-head CI/);
});

test("production Release lookup treats only non-auth HTTP 404 as absence", async () => {
  const tag = "v1.2.3";
  const absent = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    if (file === "gh" && args[0] === "api") throw new Error("HTTP 404: Not Found");
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  } });
  assert.equal(await absent.observePublication(tag), null);

  const auth = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    if (file === "gh" && args[0] === "api") throw new Error("HTTP 403: Resource not accessible by integration");
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  } });
  await assert.rejects(() => auth.observePublication(tag), /observation is unknown/);

  const network = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    if (file === "gh" && args[0] === "api") throw new Error("connection reset");
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  } });
  await assert.rejects(() => network.observePublication(tag), /observation is unknown/);

  const prose = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    if (file === "gh" && args[0] === "api") throw new Error("release not found");
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  } });
  await assert.rejects(() => prose.observePublication(tag), /observation is unknown/);
});

function isPublisherRunList(args: string[]): boolean {
  return args[0] === "api" && args.includes("--paginate") && args.includes("--slurp") &&
    args.some((arg) => arg.includes("actions/workflows/release.yml/runs") && arg.includes(`head_sha=${C}`));
}

function restPublisherPages(rows: unknown[]): string {
  const workflow_runs = rows.map((value) => {
    const row = value as Record<string, unknown>;
    if ("head_sha" in row) return row;
    return {
      id: row.databaseId,
      event: row.event,
      head_branch: row.headBranch,
      head_sha: row.headSha,
      status: row.status,
      conclusion: row.conclusion,
      run_attempt: row.attempt,
    };
  });
  return JSON.stringify([{ total_count: workflow_runs.length, workflow_runs }]);
}

function memoryPublisherRecovery() {
  const records = new Map<string, PublisherRecoveryEpisode>();
  const keyOf = (tag: string, candidate: string) => `release.yml\0${tag}\0${candidate.toLowerCase()}`;
  return {
    async loadPublisherRecoveryEpisode(key: { workflow: "release.yml"; tag: string; candidate: string }) {
      return records.get(keyOf(key.tag, key.candidate)) ?? null;
    },
    async persistPublisherRecoveryEpisode(episode: PublisherRecoveryEpisode) {
      records.set(keyOf(episode.tag, episode.candidate), { ...episode });
    },
  };
}

function publisherCommand(tag: string, notes: string, state: { runs: unknown[]; ghCalls: string[] }) {
  return async (_cwd: string, file: string, args: string[]) => {
    const joined = args.join(" ");
    if (file === "gh") state.ghCalls.push(joined);
    if (file === "gh" && isPublisherRunList(args)) return restPublisherPages(state.runs);
    if (file === "gh" && args[0] === "workflow") return "";
    if (file === "gh" && args[0] === "run" && args[1] === "rerun") return "";
    if (args[0] === "fetch" && args.includes("origin") && args.includes("main")) return "";
    if (joined === "rev-parse origin/main") return C;
    if (args[0] === "ls-remote") return `${A}\trefs/tags/${tag}\n${C}\trefs/tags/${tag}^{}`;
    if (args[0] === "fetch") return "";
    if (joined === `rev-parse refs/pipeline/release-observe/${tag}`) return A;
    if (joined === `cat-file -t refs/pipeline/release-observe/${tag}`) return "tag";
    if (joined === `rev-parse refs/pipeline/release-observe/${tag}^{}`) return C;
    if (args[0] === "for-each-ref") return notes;
    throw new Error(`unexpected ${file} ${joined}`);
  };
}

test("publisher recovery dispatches once when remote runs are absent and reruns a failed attempt 1", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const state = { runs: [] as unknown[], ghCalls: [] as string[] };
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    dispatchObserveAttempts: 2,
    ...memoryPublisherRecovery(),
    command: async (cwd, file, args) => {
      const result = await publisherCommand(tag, notes, state)(cwd, file, args);
      if (file === "gh" && args[0] === "workflow") {
        state.runs = [{
          databaseId: 8, event: "workflow_dispatch", headBranch: tag, headSha: C,
          status: "queued", conclusion: null, attempt: 1,
        }];
      }
      return result;
    },
  });
  assert.equal(await adapter.recoverPublication(tag, C), true);
  assert.ok(state.ghCalls.some((call) => call.includes("workflow run release.yml") && call.includes(`--ref ${tag}`) && call.includes(`tag=${tag}`) && call.includes(`candidate=${C}`)));

  state.ghCalls.length = 0;
  state.runs = [{
    databaseId: 9, event: "workflow_dispatch", headBranch: tag, headSha: C,
    status: "completed", conclusion: "failure", attempt: 1,
  }];
  assert.equal(await adapter.recoverPublication(tag, C), true);
  assert.ok(state.ghCalls.some((call) => call.startsWith("run rerun 9")));
  assert.ok(!state.ghCalls.some((call) => call.includes("workflow run")));

  state.runs = [{
    databaseId: 9, event: "workflow_dispatch", headBranch: tag, headSha: C,
    status: "completed", conclusion: "failure", attempt: 2,
  }];
  await assert.rejects(() => adapter.recoverPublication(tag, C), /already reran/);
});

test("publisher recovery waits for delayed attempt visibility and does not rerun twice", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const store = memoryPublisherRecovery();
  const ghCalls: string[] = [];
  let reruns = 0;
  const command = async (cwd: string, file: string, args: string[]) => {
    if (file === "gh") ghCalls.push(args.join(" "));
    if (file === "gh" && args[0] === "run" && args[1] === "rerun") {
      reruns++;
      return "";
    }
    return publisherCommand(tag, notes, {
      runs: [{
        databaseId: 9, event: "workflow_dispatch", headBranch: tag, headSha: C,
        status: "completed", conclusion: "failure", attempt: 1,
      }],
      ghCalls: [],
    })(cwd, file, args);
  };
  const first = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    ...store,
    command,
  });
  assert.equal(await first.recoverPublication(tag, C), true);
  assert.equal(reruns, 1);

  const second = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    ...store,
    command,
  });
  assert.equal(await second.recoverPublication(tag, C), true);
  assert.equal(reruns, 1);
  assert.equal(ghCalls.filter((call) => call.startsWith("run rerun")).length, 1);
});

test("publisher recovery does not dispatch when an exact-identity run already exists", async () => {
  const tag = "v1.2.3";
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    if (file === "gh" && isPublisherRunList(args)) {
      return restPublisherPages([{
        databaseId: 11, event: "push", headBranch: tag, headSha: C,
        status: "in_progress", conclusion: null, attempt: 1,
      }]);
    }
    if (file === "gh" && args[0] === "workflow") throw new Error("must not dispatch");
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  } });
  assert.equal(await adapter.recoverPublication(tag, C), false);
});

test("publisher recovery classifies the exact run after paginating past 100 workflow rows", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const filler = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1, event: "push", head_branch: "v0.0.1", head_sha: C,
    status: "completed", conclusion: "success", run_attempt: 1,
  }));
  const exact = {
    id: 101, event: "push", head_branch: tag, head_sha: C,
    status: "completed", conclusion: "failure", run_attempt: 1,
  };
  const ghCalls: string[] = [];
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    ...memoryPublisherRecovery(),
    command: async (cwd, file, args) => {
      if (file === "gh") ghCalls.push(args.join(" "));
      if (file === "gh" && isPublisherRunList(args)) {
        return JSON.stringify([
          { total_count: 101, workflow_runs: filler },
          { total_count: 101, workflow_runs: [exact] },
        ]);
      }
      if (file === "gh" && args[0] === "workflow") throw new Error("must not dispatch");
      return publisherCommand(tag, notes, { runs: [], ghCalls: [] })(cwd, file, args);
    },
  });
  assert.equal(await adapter.recoverPublication(tag, C), true);
  assert.ok(ghCalls.some((call) => call.startsWith("run rerun 101")));
  assert.ok(!ghCalls.some((call) => call.includes("workflow run")));
});

test("production publication observer paginates exact-identity runs past 100 rows", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const filler = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1, event: "push", head_branch: "v0.0.1", head_sha: C,
    status: "completed", conclusion: "success", run_attempt: 1,
  }));
  const exact = {
    id: 101, event: "push", head_branch: tag, head_sha: C,
    status: "completed", conclusion: "success", run_attempt: 1,
  };
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command: async (_cwd, file, args) => {
    const joined = args.join(" ");
    if (file === "gh" && args[0] === "api" && joined.includes("releases/tags/")) {
      return JSON.stringify({
        tag_name: tag, draft: false, prerelease: false, published_at: "2026-09-10T00:00:00Z",
        body: notes, name: tag, html_url: "https://github.test/o/r/releases/tag/v1.2.3",
      });
    }
    if (file === "gh" && isPublisherRunList(args)) {
      return JSON.stringify([
        { total_count: 101, workflow_runs: filler },
        { total_count: 101, workflow_runs: [exact] },
      ]);
    }
    if (args[0] === "ls-remote") return `${A}\trefs/tags/${tag}\n${C}\trefs/tags/${tag}^{}`;
    if (args[0] === "fetch") return "";
    if (joined === `rev-parse refs/pipeline/release-observe/${tag}`) return A;
    if (joined === `cat-file -t refs/pipeline/release-observe/${tag}`) return "tag";
    if (joined === `rev-parse refs/pipeline/release-observe/${tag}^{}`) return C;
    if (args[0] === "for-each-ref") return notes;
    throw new Error(`unexpected ${file} ${joined}`);
  } });
  const observed = await adapter.observePublication(tag);
  assert.equal(observed?.workflow_conclusion, "success");
  assert.equal(observed?.draft, false);
});

test("publisher recovery waits for delayed run visibility and does not dispatch twice", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const ghCalls: string[] = [];
  let dispatches = 0;
  let listsAfterDispatch = 0;
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    dispatchObserveAttempts: 4,
    ...memoryPublisherRecovery(),
    command: async (_cwd, file, args) => {
      const joined = args.join(" ");
      if (file === "gh") ghCalls.push(joined);
      if (file === "gh" && isPublisherRunList(args)) {
        if (dispatches === 0) return restPublisherPages([]);
        listsAfterDispatch++;
        if (listsAfterDispatch < 3) return restPublisherPages([]);
        return restPublisherPages([{
          databaseId: 12, event: "workflow_dispatch", headBranch: tag, headSha: C,
          status: "in_progress", conclusion: null, attempt: 1,
        }]);
      }
      if (file === "gh" && args[0] === "workflow") {
        dispatches++;
        return "";
      }
      if (args[0] === "fetch" && args.includes("origin") && args.includes("main")) return "";
      if (joined === "rev-parse origin/main") return C;
      if (args[0] === "ls-remote") return `${A}\trefs/tags/${tag}\n${C}\trefs/tags/${tag}^{}`;
      if (args[0] === "fetch") return "";
      if (joined === `rev-parse refs/pipeline/release-observe/${tag}`) return A;
      if (joined === `cat-file -t refs/pipeline/release-observe/${tag}`) return "tag";
      if (joined === `rev-parse refs/pipeline/release-observe/${tag}^{}`) return C;
      if (args[0] === "for-each-ref") return notes;
      throw new Error(`unexpected ${file} ${joined}`);
    },
  });
  assert.equal(await adapter.recoverPublication(tag, C), true);
  assert.equal(dispatches, 1);
  assert.equal(ghCalls.filter((call) => call.includes("workflow run")).length, 1);
});

test("publisher recovery fails closed when a dispatch never becomes observable", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  let dispatches = 0;
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    dispatchObserveAttempts: 2,
    ...memoryPublisherRecovery(),
    command: async (cwd, file, args) => {
      if (file === "gh" && args[0] === "workflow") dispatches++;
      return publisherCommand(tag, notes, { runs: [], ghCalls: [] })(cwd, file, args);
    },
  });
  await assert.rejects(() => adapter.recoverPublication(tag, C), /did not become an observable exact-identity/);
  assert.equal(dispatches, 1);
});

test("publisher recovery does not re-dispatch on a fresh invocation after an unobserved dispatch", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const store = memoryPublisherRecovery();
  let dispatches = 0;
  const command = async (cwd: string, file: string, args: string[]) => {
    if (file === "gh" && args[0] === "workflow") dispatches++;
    return publisherCommand(tag, notes, { runs: [], ghCalls: [] })(cwd, file, args);
  };
  const first = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    dispatchObserveAttempts: 2,
    ...store,
    command,
  });
  await assert.rejects(() => first.recoverPublication(tag, C), /did not become an observable exact-identity/);
  assert.equal(dispatches, 1);

  const second = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    dispatchObserveAttempts: 2,
    ...store,
    command,
  });
  await assert.rejects(() => second.recoverPublication(tag, C), /did not become an observable exact-identity/);
  assert.equal(dispatches, 1);
});

test("publisher recovery persists rerun_requested before gh run rerun and never reruns when persist or read-back fails", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const failedRun = [{
    databaseId: 9, event: "workflow_dispatch", headBranch: tag, headSha: C,
    status: "completed", conclusion: "failure", attempt: 1,
  }];
  const failedCommand = (ghCalls: string[]) => async (cwd: string, file: string, args: string[]) => {
    if (file === "gh") ghCalls.push(args.join(" "));
    return publisherCommand(tag, notes, { runs: failedRun, ghCalls: [] })(cwd, file, args);
  };

  const persistCalls: string[] = [];
  const persistFails = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    async loadPublisherRecoveryEpisode() { return null; },
    async persistPublisherRecoveryEpisode() {
      persistCalls.push("persist");
      throw new Error("pipeline release: publisher recovery episode disk full");
    },
    command: failedCommand(persistCalls),
  });
  await assert.rejects(() => persistFails.recoverPublication(tag, C), /disk full/);
  assert.ok(persistCalls.includes("persist"));
  assert.equal(persistCalls.filter((call) => call.startsWith("run rerun")).length, 0);

  const readBackCalls: string[] = [];
  const readBackFails = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    async loadPublisherRecoveryEpisode() { return null; },
    async persistPublisherRecoveryEpisode() { readBackCalls.push("persist"); },
    command: failedCommand(readBackCalls),
  });
  await assert.rejects(() => readBackFails.recoverPublication(tag, C), /failed read-back/);
  assert.ok(readBackCalls.includes("persist"));
  assert.equal(readBackCalls.filter((call) => call.startsWith("run rerun")).length, 0);
});

test("publisher recovery persists the episode before dispatch and does not dispatch when persist fails", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  let dispatches = 0;
  let persisted = false;
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    dispatchObserveAttempts: 2,
    async loadPublisherRecoveryEpisode() { return null; },
    async persistPublisherRecoveryEpisode() {
      persisted = true;
      throw new Error("pipeline release: publisher recovery episode disk full");
    },
    command: async (cwd, file, args) => {
      if (file === "gh" && args[0] === "workflow") dispatches++;
      return publisherCommand(tag, notes, { runs: [], ghCalls: [] })(cwd, file, args);
    },
  });
  await assert.rejects(() => adapter.recoverPublication(tag, C), /disk full/);
  assert.equal(persisted, true);
  assert.equal(dispatches, 0);
});

test("publication loop does not re-dispatch while the recovery run remains unlisted", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  let dispatches = 0;
  let listsAfterDispatch = 0;
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    dispatchObserveAttempts: 4,
    ...memoryPublisherRecovery(),
    command: async (_cwd, file, args) => {
      const joined = args.join(" ");
      if (file === "gh" && isPublisherRunList(args)) {
        if (dispatches === 0) return restPublisherPages([]);
        listsAfterDispatch++;
        if (listsAfterDispatch < 3) return restPublisherPages([]);
        return restPublisherPages([{
          databaseId: 13, event: "workflow_dispatch", headBranch: tag, headSha: C,
          status: "in_progress", conclusion: null, attempt: 1,
        }]);
      }
      if (file === "gh" && args[0] === "workflow") { dispatches++; return ""; }
      if (args[0] === "fetch" && args.includes("origin") && args.includes("main")) return "";
      if (joined === "rev-parse origin/main") return C;
      if (args[0] === "ls-remote") return `${A}\trefs/tags/${tag}\n${C}\trefs/tags/${tag}^{}`;
      if (args[0] === "fetch") return "";
      if (joined === `rev-parse refs/pipeline/release-observe/${tag}`) return A;
      if (joined === `cat-file -t refs/pipeline/release-observe/${tag}`) return "tag";
      if (joined === `rev-parse refs/pipeline/release-observe/${tag}^{}`) return C;
      if (args[0] === "for-each-ref") return notes;
      throw new Error(`unexpected ${file} ${joined}`);
    },
  });
  let published = false;
  const d = deps({
    async observeOriginHead() { return C; },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async resolveMilestones() { throw new Error("must not re-read milestone"); },
    async observeTag() { return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }; },
    async observePublication() {
      return published
        ? { tag, draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" as const }
        : { tag, draft: true, published_at: null, workflow_conclusion: "pending" as const };
    },
    async recoverPublication(nextTag, candidate) {
      const recovered = await adapter.recoverPublication(nextTag, candidate);
      published = true;
      return recovered;
    },
    async wait() {},
    publicationAttempts: 3,
  });
  const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.equal(result?.candidate_sha, C);
  assert.equal(dispatches, 1);
});

test("finishMetadata requires nonempty green exact-head CI when the PR merges during wait", async () => {
  let views = 0;
  let finishCalls = 0;
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    publicationAttempts: 3,
    finishReleasePr: async () => { finishCalls++; return { mergeCommitOid: C }; },
    command: finishMetadataCommand({
      nextView: () => {
        views++;
        return metadataPrPayload({
          state: views === 1 ? "OPEN" : "MERGED",
          mergeCommit: views === 1 ? null : { oid: C },
        });
      },
      nextChecks: () => [{ check_runs: views === 1
        ? [{ name: "ci", head_sha: A, status: "in_progress", conclusion: null }]
        : [{ name: "ci", head_sha: B, status: "completed", conclusion: "success" }] }],
    }),
  });
  await assert.rejects(
    () => adapter.finishMetadata({ pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null }),
    /no nonempty green exact-head CI/,
  );
  assert.equal(finishCalls, 0);

  views = 0;
  const green = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    publicationAttempts: 3,
    finishReleasePr: async () => { finishCalls++; return { mergeCommitOid: C }; },
    command: finishMetadataCommand({
      nextView: () => {
        views++;
        return metadataPrPayload({
          state: views === 1 ? "OPEN" : "MERGED",
          mergeCommit: views === 1 ? null : { oid: C },
        });
      },
      nextChecks: () => [{ check_runs: views === 1
        ? [{ name: "ci", head_sha: A, status: "in_progress", conclusion: null }]
        : [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }] }],
    }),
  });
  const finished = await green.finishMetadata({
    pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null,
  });
  assert.equal(finished.state, "MERGED");
  assert.equal(finished.merge_commit_oid, C);
  assert.equal(finishCalls, 0);
});

test("finishMetadata reloads exact-head CI when merge lands after a green snapshot", async () => {
  let views = 0;
  let checkReads = 0;
  let finishCalls = 0;
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    publicationAttempts: 3,
    finishReleasePr: async () => { finishCalls++; return { mergeCommitOid: C }; },
    command: finishMetadataCommand({
      nextView: () => {
        views++;
        return metadataPrPayload({
          state: views === 1 ? "OPEN" : "MERGED",
          mergeCommit: views === 1 ? null : { oid: C },
        });
      },
      nextChecks: () => {
        checkReads++;
        return [{
          check_runs: checkReads === 1
            ? [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }]
            : [{ name: "ci", head_sha: A, status: "in_progress", conclusion: null }],
        }];
      },
    }),
  });
  await assert.rejects(
    () => adapter.finishMetadata({ pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null }),
    /no nonempty green exact-head CI/,
  );
  assert.equal(finishCalls, 0);
  assert.equal(checkReads, 2);

  views = 0;
  checkReads = 0;
  const failing = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    publicationAttempts: 3,
    finishReleasePr: async () => { finishCalls++; return { mergeCommitOid: C }; },
    command: finishMetadataCommand({
      nextView: () => {
        views++;
        return metadataPrPayload({
          state: views === 1 ? "OPEN" : "MERGED",
          mergeCommit: views === 1 ? null : { oid: C },
        });
      },
      nextChecks: () => {
        checkReads++;
        return [{
          check_runs: checkReads === 1
            ? [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }]
            : [{ name: "ci", head_sha: A, status: "completed", conclusion: "failure" }],
        }];
      },
    }),
  });
  await assert.rejects(
    () => failing.finishMetadata({ pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null }),
    /no nonempty green exact-head CI/,
  );
  assert.equal(finishCalls, 0);
});

test("finishMetadata proves OPEN-to-MERGED files from pull-files after merge-commit squash and rebase", async () => {
  for (const strategy of ["merge-commit", "squash", "rebase"] as const) {
    let views = 0;
    let finishCalls = 0;
    const calls: string[] = [];
    const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
      wait: async () => {},
      publicationAttempts: 3,
      finishReleasePr: async () => { finishCalls++; return { mergeCommitOid: C }; },
      command: finishMetadataCommand({
        calls,
        nextView: () => {
          views++;
          return metadataPrPayload({
            state: views === 1 ? "OPEN" : "MERGED",
            mergeCommit: views === 1 ? null : { oid: C },
          });
        },
        nextChecks: () => [{
          check_runs: [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }],
        }],
      }),
    });
    const finished = await adapter.finishMetadata({
      pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null,
    });
    assert.equal(finished.state, "MERGED", strategy);
    assert.equal(finished.merge_commit_oid, C, strategy);
    assert.equal(finishCalls, 0, strategy);
    assert.ok(calls.some((call) => call.includes("/pulls/31/files")), strategy);
    assert.ok(!calls.some((call) => /\bdiff\b/.test(call)), strategy);
  }
});

test("finishMetadata fails closed when finishPr reconciles a merge and post-finish exact-head CI is pending or failing", async () => {
  for (const post of ["pending", "fail"] as const) {
    let views = 0;
    let checkReads = 0;
    let finishCalls = 0;
    const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
      wait: async () => {},
      publicationAttempts: 3,
      finishReleasePr: async () => {
        finishCalls++;
        return { mergeCommitOid: C };
      },
      command: finishMetadataCommand({
        nextView: () => {
          views++;
          return metadataPrPayload({
            state: views < 3 ? "OPEN" : "MERGED",
            mergeCommit: views < 3 ? null : { oid: C },
          });
        },
        nextChecks: () => {
          checkReads++;
          if (checkReads === 1) {
            return [{ check_runs: [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }] }];
          }
          return [{
            check_runs: post === "pending"
              ? [{ name: "ci", head_sha: A, status: "in_progress", conclusion: null }]
              : [{ name: "ci", head_sha: A, status: "completed", conclusion: "failure" }],
          }];
        },
      }),
    });
    await assert.rejects(
      () => adapter.finishMetadata({ pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null }),
      /no nonempty green exact-head CI/,
      post,
    );
    assert.equal(finishCalls, 1, post);
    assert.equal(views, 3, post);
    assert.equal(checkReads, 2, post);
  }
});

test("resumed publication loop completes after recovery advances main C to D", async () => {
  let recovered = false;
  let head = C;
  const d = deps({
    async observeOriginHead() { d.calls.push("head"); return head; },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async resolveMilestones() { throw new Error("must not re-read milestone"); },
    async observeTag() { return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }; },
    async observePublication() {
      d.calls.push("publication");
      if (!recovered) {
        return { tag: "v1.2.3", draft: true, published_at: null, workflow_conclusion: "failure" as const };
      }
      return { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" as const };
    },
    async recoverPublication() {
      d.calls.push("recover-publication");
      recovered = true;
      head = D;
      return true;
    },
    publicationAttempts: 3,
  });
  const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.equal(result?.candidate_sha, C);
  assert.equal(result?.already_complete, true);
  assert.equal(d.calls.filter((call) => call === "recover-publication").length, 1);
  assert.ok(!d.calls.some((call) => call.startsWith("tag:") || call.startsWith("frg:")));
});

test("fresh-tag publication loop completes after recovery advances main C to D", async () => {
  let recovered = false;
  let afterRecovery = false;
  const d = deps({
    async observeOriginHead() {
      d.calls.push("head");
      if (afterRecovery) return D;
      return d.calls.includes("finish-metadata") ? C : B;
    },
    async observeTag() {
      d.calls.push("observe-tag");
      return d.calls.some((call) => call.startsWith("tag:"))
        ? { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }
        : null;
    },
    async createAnnotatedTag(_tag, candidate) { d.calls.push(`tag:${candidate}`); },
    async observePublication() {
      d.calls.push("publication");
      if (!d.calls.some((call) => call.startsWith("tag:"))) return null;
      if (!recovered) return null;
      return { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" as const };
    },
    async recoverPublication() {
      d.calls.push("recover-publication");
      recovered = true;
      afterRecovery = true;
      return true;
    },
    publicationAttempts: 3,
  });
  const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.equal(result?.candidate_sha, C);
  assert.equal(d.calls.filter((call) => call === "recover-publication").length, 1);
  assert.equal(d.calls.filter((call) => call.startsWith("tag:")).length, 1);
});

test("main movement during post-FRG containment never reaches tag mutation", async () => {
  let moved = false;
  const d = deps({
    async observeOriginHead() {
      d.calls.push("head");
      if (moved) return D;
      return d.calls.includes("finish-metadata") ? C : B;
    },
    async commitContained() {
      d.calls.push("containment");
      if (d.calls.some((call) => call.startsWith("frg:"))) moved = true;
      return true;
    },
  });
  await assert.rejects(
    () => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d),
    /moved from candidate/,
  );
  assert.ok(!d.calls.some((call) => call.startsWith("tag:")));
});

const DOCUMENTED_WORKFLOW_CONCLUSIONS = [
  "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out",
] as const;
const RETRYABLE_WORKFLOW_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

test("publisher classification allows only explicit status/conclusion combinations", () => {
  const row = (over: Record<string, unknown>) => ({
    databaseId: 1, attempt: 1, event: "push", headBranch: "v1.2.3", headSha: C,
    status: "completed", conclusion: "success", ...over,
  });
  for (const conclusion of DOCUMENTED_WORKFLOW_CONCLUSIONS) {
    const classified = classifyPublisherRuns([row({ conclusion })], "v1.2.3", C);
    if (conclusion === "success") assert.equal(classified.class, "successful", conclusion);
    else if (RETRYABLE_WORKFLOW_CONCLUSIONS.has(conclusion)) assert.equal(classified.class, "failed", conclusion);
    else assert.equal(classified.class, "unknown", conclusion);
  }
  assert.equal(classifyPublisherRuns([row({ conclusion: "mystery" })], "v1.2.3", C).class, "unknown");
  assert.equal(classifyPublisherRuns([row({ conclusion: null })], "v1.2.3", C).class, "unknown");
  assert.equal(classifyPublisherRuns([row({ status: "in_progress", conclusion: "failure" })], "v1.2.3", C).class, "unknown");
  assert.equal(classifyPublisherRuns([row({ status: "queued", conclusion: null })], "v1.2.3", C).class, "pending");
  assert.equal(classifyPublisherRuns([row({ status: "waiting", conclusion: null })], "v1.2.3", C).class, "pending");
});

test("unknown publisher conclusion mystery never reruns or dispatches", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  for (const conclusion of ["mystery", "cancelled", "neutral", null] as const) {
    const state = {
      runs: [{
        databaseId: 9, event: "workflow_dispatch", headBranch: tag, headSha: C,
        status: "completed", conclusion, attempt: 1,
      }] as unknown[],
      ghCalls: [] as string[],
    };
    const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
      wait: async () => {},
      dispatchObserveAttempts: 2,
      ...memoryPublisherRecovery(),
      command: publisherCommand(tag, notes, state),
    });
    await assert.rejects(() => adapter.recoverPublication(tag, C), /unknown/);
    assert.equal(
      state.ghCalls.filter((call) => call.startsWith("run rerun") || call.includes("workflow run")).length,
      0,
      String(conclusion),
    );
  }
});

test("publisher workflow total_count must be a JSON number and duplicate run IDs fail closed", () => {
  const run = {
    id: 1, event: "push", head_branch: "v1.2.3", head_sha: C,
    status: "completed", conclusion: "success", run_attempt: 1,
  };
  for (const total_count of [null, false, "1", "", "0", Number.NaN]) {
    assert.throws(
      () => parsePublisherWorkflowRunPages([{ total_count, workflow_runs: total_count === "1" ? [run] : [] }], "v1.2.3"),
      /unknown shape/,
      String(total_count),
    );
  }
  assert.throws(
    () => parsePublisherWorkflowRunPages([{ total_count: 1, workflow_runs: [run, run] }], "v1.2.3"),
    /duplicate/,
  );
  assert.throws(
    () => parsePublisherWorkflowRunPages([
      { total_count: 1, workflow_runs: [run] },
      { total_count: 1, workflow_runs: [run] },
    ], "v1.2.3"),
    /duplicate/,
  );
});

test("coerced total_count and duplicate page IDs never dispatch or rerun", async () => {
  const tag = "v1.2.3";
  const notes = releaseTagNotes("1.2.3", C);
  const run = {
    id: 1, event: "push", head_branch: "v0.0.1", head_sha: C,
    status: "completed", conclusion: "success", run_attempt: 1,
  };
  const payloads = [
    [{ total_count: null, workflow_runs: [] }],
    [{ total_count: false, workflow_runs: [] }],
    [{ total_count: "0", workflow_runs: [] }],
    [{ total_count: 2, workflow_runs: [run, run] }],
    [
      { total_count: 1, workflow_runs: [run] },
      { total_count: 1, workflow_runs: [run] },
    ],
  ];
  for (const pages of payloads) {
    const ghCalls: string[] = [];
    const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
      wait: async () => {},
      dispatchObserveAttempts: 2,
      ...memoryPublisherRecovery(),
      command: async (cwd, file, args) => {
        if (file === "gh") ghCalls.push(args.join(" "));
        if (file === "gh" && isPublisherRunList(args)) return JSON.stringify(pages);
        return publisherCommand(tag, notes, { runs: [], ghCalls: [] })(cwd, file, args);
      },
    });
    await assert.rejects(() => adapter.recoverPublication(tag, C));
    assert.equal(
      ghCalls.filter((call) => call.startsWith("run rerun") || call.includes("workflow run")).length,
      0,
      JSON.stringify(pages[0]),
    );
  }
});

test("metadata reuse rejects attacker title match with wrong branch body author or owner", async () => {
  const attackers = [
    metadataPrPayload({ headRefName: "attacker/release" }),
    metadataPrPayload({ body: "looks like a release" }),
    metadataPrPayload({ author: { login: "", is_bot: false } }),
    metadataPrPayload({ isCrossRepository: true, headRepositoryOwner: { login: "attacker" } }),
    metadataPrPayload({ headRepositoryOwner: { login: "attacker" } }),
  ];
  for (const view of attackers) {
    const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
      command: metadataObserverCommand({ list: [metadataPrPayload()], view }),
    });
    await assert.rejects(() => adapter.observeMetadata("1.2.3", "main"), /metadata PR/);
  }
  const ambiguous = [
    { title: "release: 1.2.3 extra — version metadata" },
    { title: "release: 1.2.30 — version metadata" },
    { title: "release: 1.2.3 — version metadata\nextra" },
    { title: "release: 1.2.3 — " },
    { title: "release: 1.2.3 — Factory — extra dash" },
  ];
  for (const over of ambiguous) {
    const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
      command: metadataObserverCommand({
        list: [metadataPrPayload(over)],
        view: metadataPrPayload(over),
      }),
    });
    assert.equal(await adapter.observeMetadata("1.2.3", "main"), null, String(over.title));
  }
});

test("actual historical PR 1347 is accepted despite deleted source branch", async () => {
  const view = {
    number: 1347,
    title: "release: 1.40.0 — v1.40.0",
    body: [
      "## Release: v1.40.0 — v1.40.0",
      "",
      "**This PR changes version metadata only.** Merging it must not create a tag or GitHub Release.",
      "",
      LEGACY_METADATA_PROVENANCE,
    ].join("\n"),
    baseRefName: "main",
    headRefName: "release/v1.40.0",
    headRefOid: A,
    author: { login: "comamitc", is_bot: false },
    state: "MERGED",
    isCrossRepository: false,
    headRepositoryOwner: { login: "accidental-hedge-fund" },
    mergeCommit: { oid: C },
  };
  const calls: string[] = [];
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "accidental-hedge-fund/agent-pipeline" }, {
    command: async (_cwd, file, args) => {
      const joined = args.join(" ");
      if (file === "gh" && args[0] === "api" && args[1] === "user") return "comamitc";
      if (file === "gh" && args[0] === "pr" && args[1] === "list") {
        calls.push(`${file} ${joined}`);
        return JSON.stringify([view]);
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "view") {
        calls.push(`${file} ${joined}`);
        assert.equal(String(args[2]), "1347");
        const json = args[args.indexOf("--json") + 1] ?? "";
        assert.equal(json, "number,title,body,baseRefName,headRefName,headRefOid,author,state,isCrossRepository,headRepositoryOwner,mergeCommit");
        return JSON.stringify(view);
      }
      if (file === "gh" && args[0] === "api" && joined.includes("check-runs")) {
        return JSON.stringify([{ check_runs: [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }] }]);
      }
      if (file === "gh" && args[0] === "api" && joined.includes("/pulls/") && joined.includes("/files")) {
        return JSON.stringify([[{ filename: "package.json" }, { filename: "core/package.json" }]]);
      }
      if (args[0] === "fetch" && joined.includes("release/v1.40.0")) throw new Error("branch deleted");
      if (args[0] === "fetch" && joined.includes("pull/1347/head")) return "";
      if (args[0] === "rev-parse" && joined.includes("release-metadata")) return A;
      if (args[0] === "show") return JSON.stringify({ version: "1.40.0" });
      if (args[0] === "diff") return "";
      throw new Error(`unexpected ${file} ${joined}`);
    },
  });
  const observed = await adapter.observeMetadata("1.40.0", "main");
  assert.equal(observed?.pr, 1347);
  assert.equal(observed?.state, "MERGED");
  assert.equal(observed?.head_oid, A);
  assert.ok(calls.some((call) => call.includes("pr view 1347")));

  const mismatchedView = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    command: metadataObserverCommand({
      list: [metadataPrPayload()],
      view: metadataPrPayload({ headRefName: "attacker/from-view" }),
    }),
  });
  await assert.rejects(() => mismatchedView.observeMetadata("1.2.3", "main"), /metadata PR/);
});

test("nonempty wrong metadata author is rejected against the current actor", async () => {
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    command: metadataObserverCommand({
      list: [metadataPrPayload({ author: { login: "attacker", is_bot: false } })],
      view: metadataPrPayload({ author: { login: "attacker", is_bot: false } }),
      actor: "pipeline-bot",
    }),
  });
  await assert.rejects(() => adapter.observeMetadata("1.2.3", "main"), /metadata PR/);
});

test("provenance marker embedded before an attacker suffix is rejected", async () => {
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    command: metadataObserverCommand({
      list: [metadataPrPayload()],
      view: metadataPrPayload({
        body: `Version metadata only for v1.2.3.\n\n${METADATA_PROVENANCE}\nattacker-owned footer`,
      }),
    }),
  });
  await assert.rejects(() => adapter.observeMetadata("1.2.3", "main"), /metadata PR/);
});

test("ordinary themed metadata PR is rediscovered after interruption with zero second gh pr create", async () => {
  const themed = metadataPrPayload({
    title: "release: 1.2.3 — Factory reliability",
    state: "OPEN",
    mergeCommit: null,
  });
  const calls: string[] = [];
  const command = metadataObserverCommand({ list: [themed], view: themed, calls });
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, { command });
  const first = await adapter.observeMetadata("1.2.3", "main");
  const second = await adapter.observeMetadata("1.2.3", "main");
  assert.equal(first?.pr, 31);
  assert.deepEqual(second, first);
  assert.equal(calls.filter((call) => call.includes("pr create")).length, 0);

  const d = deps({
    async observeMetadata() { d.calls.push("observe-metadata"); return { pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null }; },
    async prepareMetadata() { throw new Error("must not create a second metadata PR"); },
  });
  await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
  assert.ok(!d.calls.includes("prepare-metadata"));
  assert.ok(d.calls.includes("finish-metadata"));
});

test("finishMetadata rejects provenance change before merge and never calls finishPr", async () => {
  let views = 0;
  let finishCalls = 0;
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    publicationAttempts: 3,
    finishReleasePr: async () => { finishCalls++; return { mergeCommitOid: C }; },
    command: finishMetadataCommand({
      nextView: () => {
        views++;
        return metadataPrPayload({
          state: "OPEN",
          mergeCommit: null,
          body: views === 1
            ? `Version metadata only for v1.2.3.\n\n${METADATA_PROVENANCE}`
            : `Version metadata only for v1.2.3.\n\n${METADATA_PROVENANCE}\nattacker-owned footer`,
        });
      },
      nextChecks: () => [{
        check_runs: [{ name: "ci", head_sha: A, status: "completed", conclusion: "success" }],
      }],
    }),
  });
  await assert.rejects(
    () => adapter.finishMetadata({ pr: 31, version: "1.2.3", base: "main", head_oid: A, state: "OPEN", merge_commit_oid: null }),
    /metadata PR/,
  );
  assert.equal(finishCalls, 0);
  assert.equal(views, 2);
});

test("published pending Release waits through main C to D without recovery on both paths", async () => {
  const timeline = [
    { draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "pending" as const, head: C },
    { draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "pending" as const, head: D },
    { draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" as const, head: D },
  ];
  for (const path of ["existing-tag", "fresh-tag"] as const) {
    let step = 0;
    const d = deps({
      async observeOriginHead() {
        d.calls.push("head");
        if (path === "fresh-tag" && !d.calls.some((call) => call.startsWith("tag:"))) {
          return d.calls.includes("finish-metadata") ? C : B;
        }
        return timeline[Math.min(step, timeline.length - 1)]!.head;
      },
      async versionsAt(commit) {
        return commit === B ? { root: "1.2.2", core: "1.2.2" } : { root: "1.2.3", core: "1.2.3" };
      },
      async resolveMilestones() {
        if (path === "existing-tag") throw new Error("must not re-read milestone");
        return [milestone()];
      },
      async observeTag() {
        if (path === "existing-tag") return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) };
        return d.calls.some((call) => call.startsWith("tag:"))
          ? { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }
          : null;
      },
      async createAnnotatedTag(_tag, candidate) { d.calls.push(`tag:${candidate}`); },
      async observePublication() {
        d.calls.push("publication");
        if (path === "fresh-tag" && !d.calls.some((call) => call.startsWith("tag:"))) return null;
        const row = timeline[Math.min(step, timeline.length - 1)]!;
        return { tag: "v1.2.3", draft: row.draft, published_at: row.published_at, workflow_conclusion: row.workflow_conclusion };
      },
      async recoverPublication() { throw new Error("must not recover published pending"); },
      async wait() { d.calls.push("wait"); step++; },
      publicationAttempts: 4,
    });
    const result = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, d);
    assert.equal(result?.candidate_sha, C, path);
    assert.equal(result?.already_complete, true, path);
    assert.equal(d.calls.filter((call) => call === "recover-publication").length, 0, path);
    assert.ok(step >= 2, path);
    if (path === "existing-tag") {
      assert.ok(!d.calls.some((call) => call.startsWith("frg:") || call.startsWith("tag:")), path);
    } else {
      assert.equal(d.calls.filter((call) => call.startsWith("tag:")).length, 1, path);
      assert.equal(d.calls.filter((call) => call.startsWith("frg:")).length, 1, path);
    }
  }
});

test("publication then head race re-observes before tagged-stale-C", async () => {
  let pubs = 0;
  const success = deps({
    async observeOriginHead() { return D; },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async resolveMilestones() { throw new Error("must not re-read milestone"); },
    async observeTag() { return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }; },
    async observePublication() {
      pubs++;
      if (pubs < 3) {
        return { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "pending" as const };
      }
      return { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "success" as const };
    },
    async recoverPublication() { throw new Error("must not recover"); },
  });
  const completed = await runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, success);
  assert.equal(completed?.already_complete, true);
  assert.ok(pubs >= 3);

  pubs = 0;
  const stale = deps({
    async observeOriginHead() { return D; },
    async versionsAt() { return { root: "1.2.3", core: "1.2.3" }; },
    async resolveMilestones() { throw new Error("must not re-read milestone"); },
    async observeTag() { return { annotated: true, peeled_commit: C, annotation: releaseTagNotes("1.2.3", C) }; },
    async observePublication() {
      pubs++;
      if (pubs < 3) {
        return { tag: "v1.2.3", draft: false, published_at: "2026-09-10T00:00:00Z", workflow_conclusion: "pending" as const };
      }
      return { tag: "v1.2.3", draft: true, published_at: null, workflow_conclusion: "pending" as const };
    },
    async recoverPublication() { throw new Error("must not recover after unpublished main movement"); },
  });
  await assert.rejects(() => runCompleteRelease("1.2.3", {}, { repo_dir: "/repo", repo: "o/r" }, stale), /tagged-stale-C/);
  assert.ok(!stale.calls.some((call) => call.startsWith("frg:") || call.startsWith("tag:") || call === "recover-publication"));
});

test("numeric string workflow-run ids fail closed before success or rerun", async () => {
  const tag = "v1.2.3";
  assert.throws(
    () => parsePublisherRunRows([{
      databaseId: "11", attempt: 1, event: "push", headBranch: tag, headSha: C,
      status: "completed", conclusion: "success",
    }], tag),
    /malformed/,
  );
  assert.throws(
    () => parsePublisherWorkflowRunPages([{
      total_count: 1,
      workflow_runs: [{
        id: "11", event: "push", head_branch: tag, head_sha: C,
        status: "completed", conclusion: "success", run_attempt: 1,
      }],
    }], tag),
    /malformed/,
  );
  const notes = releaseTagNotes("1.2.3", C);
  const ghCalls: string[] = [];
  const adapter = realCompleteReleaseDeps({ repo_dir: "/repo", repo: "o/r" }, {
    wait: async () => {},
    dispatchObserveAttempts: 2,
    ...memoryPublisherRecovery(),
    command: async (cwd, file, args) => {
      if (file === "gh") ghCalls.push(args.join(" "));
      if (file === "gh" && isPublisherRunList(args)) {
        return JSON.stringify([{
          total_count: 1,
          workflow_runs: [{
            id: "11", event: "push", head_branch: tag, head_sha: C,
            status: "completed", conclusion: "failure", run_attempt: "1",
          }],
        }]);
      }
      return publisherCommand(tag, notes, { runs: [], ghCalls: [] })(cwd, file, args);
    },
  });
  await assert.rejects(() => adapter.recoverPublication(tag, C), /malformed/);
  assert.equal(ghCalls.filter((call) => call.startsWith("run rerun") || call.includes("workflow run")).length, 0);
});
