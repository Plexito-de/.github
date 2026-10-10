// Purpose: tests for cla.mjs, against an in-memory fake of the GitHub API.
// Usage:   node --test .github/scripts/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRANCH, FILE, PHRASE, allowed, committers, evaluate, isSignComment, run,
} from "./cla.mjs";

const alice = { login: "alice", id: 11, type: "User" };
const bob = { login: "bob", id: 22, type: "User" };
const bot = { login: "dependabot[bot]", id: 33, type: "Bot" };

function fakeGitHub({ commits, signatures = null, comments = [] }) {
  const state = { statuses: [], comments: [...comments], files: {}, refs: new Set() };
  if (signatures) {
    state.refs.add(BRANCH);
    state.files[FILE] = { text: JSON.stringify({ signatures }), sha: "s0" };
  }
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  const rest = {
    pulls: {
      listCommits: async () => ({ data: commits }),
      get: async ({ pull_number }) => ({ data: { number: pull_number, user: alice, head: { sha: "h1" } } }),
    },
    repos: {
      getContent: async ({ path }) => {
        const f = state.files[path];
        if (!f) throw notFound();
        return { data: { content: Buffer.from(f.text).toString("base64"), sha: f.sha } };
      },
      createOrUpdateFileContents: async ({ path, content }) => {
        state.files[path] = { text: Buffer.from(content, "base64").toString("utf8"), sha: "s1" };
      },
      createCommitStatus: async (s) => state.statuses.push(s),
    },
    git: {
      getRef: async () => { if (!state.refs.has(BRANCH)) throw notFound(); return {}; },
      createBlob: async ({ content }) => ({ data: { sha: "b", content } }),
      createTree: async () => ({ data: { sha: "t" } }),
      createCommit: async ({ parents }) => { assert.deepEqual(parents, []); return { data: { sha: "c" } }; },
      createRef: async () => {
        state.refs.add(BRANCH);
        state.files[FILE] = { text: JSON.stringify({ signatures: [] }), sha: "s0" };
      },
    },
    issues: {
      listComments: async () => ({ data: state.comments }),
      createComment: async ({ body }) => state.comments.push({ id: 1, body, user: { type: "Bot" } }),
      updateComment: async ({ comment_id, body }) => {
        state.comments.find((c) => c.id === comment_id).body = body;
      },
    },
  };
  const github = { rest, paginate: async (fn, args) => (await fn(args)).data };
  return { github, state };
}

const core = { info() {} };
const ctx = (payload) => ({ repo: { owner: "Plexito-de", repo: "wiretruth" }, payload });
const prPayload = { pull_request: { number: 7, user: alice, head: { sha: "h1" } } };
const signed = (state) => JSON.parse(state.files[FILE]?.text ?? '{"signatures":[]}').signatures;

test("sign comment matches with spacing, case and a final period", () => {
  assert.ok(isSignComment(`  ${PHRASE.toUpperCase()}. `));
  assert.ok(!isSignComment("I have read the CLA"));
});

test("allowlist supports a wildcard", () => {
  assert.ok(allowed("renovate[bot]", ["*[bot]"]));
  assert.ok(!allowed("alice", ["*[bot]", "chrikrah"]));
});

test("bots are skipped and unlinked commit authors are reported", () => {
  const who = committers(
    [{ author: bob }, { author: bot }, { author: null, commit: { author: { name: "Eve" } } }],
    alice,
  );
  assert.deepEqual(who.users.map((u) => u.login), ["alice", "bob"]);
  assert.deepEqual(who.unlinked, ["Eve"]);
  assert.equal(evaluate(who, [{ id: 11 }, { id: 22 }], []).ok, false);
});

test("unsigned author: failure status and one comment with the phrase", async () => {
  const { github, state } = fakeGitHub({ commits: [{ author: alice }] });
  await run({ github, context: ctx(prPayload), core });
  await run({ github, context: ctx(prPayload), core });
  assert.equal(state.statuses.at(-1).state, "failure");
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, new RegExp(PHRASE));
});

test("sign comment records the signature on an orphan branch and turns the status green", async () => {
  const { github, state } = fakeGitHub({ commits: [{ author: alice }] });
  await run({ github, context: ctx(prPayload), core });
  const payload = {
    issue: { number: 7, pull_request: {} },
    comment: { body: PHRASE, user: alice, created_at: "2026-10-10T00:00:00Z", html_url: "u" },
  };
  await run({ github, context: ctx(payload), core });
  assert.deepEqual(signed(state).map((s) => s.login), ["alice"]);
  assert.equal(state.statuses.at(-1).state, "success");
  assert.match(state.comments[0].body, /All commit authors have signed/);
});

test("a sign comment from someone who is not a commit author records nothing", async () => {
  const { github, state } = fakeGitHub({ commits: [{ author: alice }], signatures: [] });
  const payload = {
    issue: { number: 7, pull_request: {} },
    comment: { body: PHRASE, user: bob, created_at: "t", html_url: "u" },
  };
  await run({ github, context: ctx(payload), core });
  assert.deepEqual(signed(state), []);
  assert.equal(state.statuses.at(-1).state, "failure");
});

test("allowlisted author passes without a comment", async () => {
  const { github, state } = fakeGitHub({ commits: [{ author: alice }] });
  await run({ github, context: ctx(prPayload), core }, { allowlist: ["alice"] });
  assert.equal(state.statuses.at(-1).state, "success");
  assert.equal(state.comments.length, 0);
});

test("an unrelated issue comment does nothing", async () => {
  const { github, state } = fakeGitHub({ commits: [{ author: alice }] });
  const payload = { issue: { number: 7, pull_request: {} }, comment: { body: "nice", user: bob } };
  await run({ github, context: ctx(payload), core });
  assert.equal(state.statuses.length, 0);
});
