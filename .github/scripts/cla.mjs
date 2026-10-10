// Purpose: check that every commit author of a pull request has signed the Plexito CLA, and
//          record a signature when an author posts the sign comment.
// Usage:   called by .github/workflows/cla.yml through actions/github-script:
//          const { run } = await import(`${dir}/cla.mjs`); await run({ github, context, core }, { allowlist })
//
// Signatures live in signatures/cla.json on the orphan branch `cla-signatures` of each repository.
// The check never checks out or runs code from the pull request.

export const PHRASE = "I have read the CLA Document and I hereby sign the CLA";
export const VERSION = "plexito-icla-1.0";
export const DOC = "https://github.com/Plexito-de/.github/blob/main/cla/INDIVIDUAL.md";
export const ENTITY_DOC = "https://github.com/Plexito-de/.github/blob/main/cla/ENTITY.md";
export const BRANCH = "cla-signatures";
export const FILE = "signatures/cla.json";
export const MARKER = "<!-- plexito-cla -->";

const normalize = (text) =>
  text.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "").toLowerCase();

export function isSignComment(body) {
  return normalize(body ?? "") === normalize(PHRASE);
}

export function isRecheck(body) {
  return normalize(body ?? "") === "recheck";
}

export function allowed(login, allowlist) {
  return allowlist.some((pattern) => {
    const re = new RegExp(
      "^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
      "i",
    );
    return re.test(login);
  });
}

// commits: the pulls.listCommits payload. author: the pull request author ({login, id, type}).
export function committers(commits, author) {
  const users = new Map();
  const unlinked = new Set();
  // Bots are not skipped by type: anyone can open a pull request through their own GitHub App.
  // Exempt named bots through the allowlist instead.
  const add = (u) => u && users.set(u.id, { login: u.login, id: u.id });
  add(author);
  for (const c of commits) {
    if (c.author) add(c.author);
    else unlinked.add(c.commit?.author?.name || c.commit?.author?.email || "unknown");
  }
  return { users: [...users.values()], unlinked: [...unlinked] };
}

export function evaluate({ users, unlinked }, signatures, allowlist) {
  const signedIds = new Set(signatures.map((s) => s.id));
  const missing = users.filter((u) => !signedIds.has(u.id) && !allowed(u.login, allowlist));
  return { missing, unlinked, ok: missing.length === 0 && unlinked.length === 0 };
}

// A commit author name is free text, so it may not carry markdown, a mention or a line break.
export const plain = (name) =>
  String(name).replace(/[`\r\n@<>\[\]()*_|\\]/g, "").slice(0, 60) || "unknown";

export function commentBody({ missing, unlinked, ok }) {
  if (ok) {
    return `${MARKER}\nAll commit authors have signed the [Contributor License Agreement](${DOC}). Thank you.`;
  }
  const lines = [
    MARKER,
    "Thank you for your contribution. Before we can merge it, each commit author needs to sign the",
    `[Plexito Contributor License Agreement](${DOC}). It is a license, not a transfer: you keep the`,
    "copyright in your work.",
    "",
    "To sign, post a comment on this pull request with exactly this text:",
    "",
    "```",
    PHRASE,
    "```",
    "",
  ];
  if (missing.length) {
    lines.push(`Still to sign: ${missing.map((u) => `@${u.login}`).join(", ")}`);
  }
  if (unlinked.length) {
    lines.push(
      `Commits by ${unlinked.map((n) => `\`${plain(n)}\``).join(", ")} are not linked to a GitHub ` +
        "account. Add the commit email to your GitHub account, or amend the commits, then comment `recheck`.",
    );
  }
  lines.push(
    "",
    `Contributing for your employer? Your employer signs the [Entity Agreement](${ENTITY_DOC}) first.`,
  );
  return lines.join("\n");
}

async function readSignatures(github, repo) {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path: FILE, ref: BRANCH });
    const text = Buffer.from(data.content, "base64").toString("utf8");
    return { signatures: JSON.parse(text).signatures, sha: data.sha };
  } catch (error) {
    if (error.status === 404) return { signatures: [], sha: null };
    throw error;
  }
}

async function ensureBranch(github, repo) {
  try {
    await github.rest.git.getRef({ ...repo, ref: `heads/${BRANCH}` });
    return;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  // An orphan branch: it holds the signature record and nothing else.
  const content = JSON.stringify({ signatures: [] }, null, 2) + "\n";
  const blob = await github.rest.git.createBlob({ ...repo, content, encoding: "utf-8" });
  const tree = await github.rest.git.createTree({
    ...repo,
    tree: [{ path: FILE, mode: "100644", type: "blob", sha: blob.data.sha }],
  });
  const commit = await github.rest.git.createCommit({
    ...repo,
    message: "chore(cla): start the signature record",
    tree: tree.data.sha,
    parents: [],
  });
  try {
    await github.rest.git.createRef({ ...repo, ref: `refs/heads/${BRANCH}`, sha: commit.data.sha });
  } catch (error) {
    // Two first signers at once: the other run created the branch. Use it.
    if (error.status !== 422) throw error;
  }
}

async function recordSignature(github, repo, signature) {
  await ensureBranch(github, repo);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { signatures, sha } = await readSignatures(github, repo);
    if (signatures.some((s) => s.id === signature.id)) return;
    const content = JSON.stringify({ signatures: [...signatures, signature] }, null, 2) + "\n";
    try {
      await github.rest.repos.createOrUpdateFileContents({
        ...repo,
        path: FILE,
        branch: BRANCH,
        message: `chore(cla): @${signature.login} signs ${VERSION}`,
        content: Buffer.from(content).toString("base64"),
        ...(sha ? { sha } : {}),
      });
      return;
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
}

async function upsertComment(github, repo, number, body, ok) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: number,
    per_page: 100,
  });
  const mine = comments.find(
    (c) => c.user?.login === "github-actions[bot]" && c.body?.includes(MARKER),
  );
  if (mine) {
    if (mine.body !== body) {
      await github.rest.issues.updateComment({ ...repo, comment_id: mine.id, body });
    }
  } else if (!ok) {
    await github.rest.issues.createComment({ ...repo, issue_number: number, body });
  }
}

export async function run({ github, context, core }, { allowlist = [] } = {}) {
  const repo = context.repo;
  const payload = context.payload;
  let pr = payload.pull_request;
  if (!pr) {
    if (!payload.issue?.pull_request) return;
    const body = payload.comment?.body;
    if (!isSignComment(body) && !isRecheck(body)) return;
    pr = (await github.rest.pulls.get({ ...repo, pull_number: payload.issue.number })).data;
  }
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    ...repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const who = committers(commits, pr.user);
  let { signatures } = await readSignatures(github, repo);
  const commenter = payload.comment?.user;
  if (commenter && isSignComment(payload.comment.body)) {
    const before = evaluate(who, signatures, allowlist);
    if (before.missing.some((u) => u.id === commenter.id)) {
      const signature = {
        login: commenter.login,
        id: commenter.id,
        version: VERSION,
        signed_at: payload.comment.created_at,
        repository: `${repo.owner}/${repo.repo}`,
        pull_request: pr.number,
        comment_url: payload.comment.html_url,
      };
      await recordSignature(github, repo, signature);
      signatures = [...signatures, signature];
      core.info(`recorded the signature of @${commenter.login}`);
    }
  }
  const result = evaluate(who, signatures, allowlist);
  await github.rest.repos.createCommitStatus({
    ...repo,
    sha: pr.head.sha,
    state: result.ok ? "success" : "failure",
    context: "cla",
    description: result.ok
      ? "All commit authors have signed the CLA"
      : `Waiting for ${result.missing.length + result.unlinked.length} signature(s)`,
    target_url: DOC,
  });
  await upsertComment(github, repo, pr.number, commentBody(result), result.ok);
  core.info(result.ok ? "CLA: all signed" : `CLA: missing ${result.missing.map((u) => u.login)}`);
}
