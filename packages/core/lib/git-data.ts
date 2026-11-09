/**
 * Land a staged change as ONE commit through GitHub's Git Data API:
 * blob → tree → commit → update-ref (never forced). The change is staged in
 * a local clone first (`git apply --index`), so a patch that doesn't apply
 * cleanly is rejected before anything is sent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./patch-pr.ts";

export interface ApiResponse {
  status: number;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export type GitApi = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => Promise<ApiResponse>;

/** The real API, with the token gh already holds (never logged). */
export function ghApi(run: Runner): GitApi {
  let token: string | undefined;
  return async (method, path, body) => {
    token ??= (await run(["gh", "auth", "token"])).trim();
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

/** Apply a patch to the index, or throw: a stale patch is never half-applied. */
export async function applyPatchStrict(dir: string, file: string, run: Runner): Promise<void> {
  try {
    await run(["git", "apply", "--check", "--binary", "--whitespace=nowarn", file], dir);
  } catch (e) {
    throw new Error(`the patch doesn't apply cleanly: ${e instanceof Error ? e.message : e}`);
  }
  await run(["git", "apply", "--index", "--binary", "--whitespace=nowarn", file], dir);
}

interface Entry {
  path: string;
  mode: string;
  type: "blob";
  sha: string | null;
}

const MAX_RETRIES = 3;

/** Commit what's staged in `dir` onto `branch` of `repo` via the API. Returns the new commit sha. */
export async function commitStagedViaApi(
  dir: string,
  repo: string,
  branch: string,
  message: string,
  api: GitApi,
  run: Runner
): Promise<string> {
  const ok = async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => {
    const r = await api(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`GitHub API ${method} ${path}: ${r.status}`);
    return r.data;
  };
  const base = `/repos/${repo}/git`;
  const changes = (await run(["git", "diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"], dir)).split("\0").filter(Boolean);
  const entries: Entry[] = [];
  for (let i = 0; i + 1 < changes.length; i += 2) {
    const [status, path] = [changes[i], changes[i + 1]];
    if (status.startsWith("D")) {
      entries.push({ path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const mode = (await run(["git", "ls-files", "-s", "--", path], dir)).split(/\s/)[0] || "100644";
    const content = readFileSync(join(dir, path)).toString("base64");
    const blob = await ok("POST", `${base}/blobs`, { content, encoding: "base64" });
    entries.push({ path, mode, type: "blob", sha: blob.sha });
  }
  if (!entries.length) throw new Error("the patch changes nothing");
  let parent = (await run(["git", "rev-parse", "HEAD"], dir)).trim();
  for (let attempt = 0; ; attempt++) {
    const parentCommit = await ok("GET", `${base}/commits/${parent}`);
    const tree = await ok("POST", `${base}/trees`, { base_tree: parentCommit.tree.sha, tree: entries });
    const commit = await ok("POST", `${base}/commits`, { message, tree: tree.sha, parents: [parent] });
    const r = await api("PATCH", `${base}/refs/heads/${branch}`, { sha: commit.sha, force: false });
    if (r.status >= 200 && r.status < 300) return commit.sha;
    if (r.status !== 422 || attempt >= MAX_RETRIES) throw new Error(`GitHub API PATCH refs/heads/${branch}: ${r.status}`);
    // The branch moved under us: rebuild on its new head (not a fast-forward otherwise).
    parent = (await ok("GET", `${base}/ref/heads/${branch}`)).object.sha;
  }
}
