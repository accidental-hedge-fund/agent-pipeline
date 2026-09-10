import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertReleaseManagedMetadataPaths,
  metadataChecksState,
  realCompleteReleaseDeps,
  releaseTagNotes,
  selectExactPublisherConclusion,
  runCompleteRelease,
  validateReleaseMilestone,
  type CompleteReleaseDeps,
  type CompleteReleaseMilestone,
  type ObservedMetadataRelease,
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

test("existing tag with interrupted publisher resumes without main, milestone, or FRG", async () => {
  let recovered = false;
  const d = deps({
    async observeOriginHead() { throw new Error("main moved/unavailable"); },
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

test("publisher proof binds push event, tag branch, and exact C", () => {
  const rows = [
    { event: "workflow_dispatch", headBranch: "v1.2.3", headSha: C, status: "completed", conclusion: "success" },
    { event: "push", headBranch: "main", headSha: C, status: "completed", conclusion: "success" },
    { event: "push", headBranch: "v1.2.3", headSha: B, status: "completed", conclusion: "success" },
  ];
  assert.equal(selectExactPublisherConclusion(rows, "v1.2.3", C), "pending");
  rows.push({ event: "push", headBranch: "v1.2.3", headSha: C, status: "completed", conclusion: "failure" });
  assert.equal(selectExactPublisherConclusion(rows, "v1.2.3", C), "failure");
  rows.push({ event: "push", headBranch: "v1.2.3", headSha: C, status: "completed", conclusion: "success" });
  assert.equal(selectExactPublisherConclusion(rows, "v1.2.3", C), "success");
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
    if (file === "gh" && args[0] === "release") return JSON.stringify({
      tagName: tag, isDraft: false, isPrerelease: false, publishedAt: "2026-09-10T00:00:00Z",
      body: notes, name: tag, url: "https://github.test/o/r/releases/tag/v1.2.3",
    });
    if (file === "gh" && args[0] === "run") throw new Error("HTTP 404 from workflow runs API");
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
