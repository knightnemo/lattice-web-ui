export function parsePullRequest(number, head) {
  if (!/^[1-9]\d{0,8}$/.test(number ?? "")) throw new Error("Invalid pull request number.");
  if (!/^[0-9a-f]{40}$/.test(head ?? "")) throw new Error("Invalid pull request head.");
  return { number: Number(number), head };
}

export function githubApi({ token, repository, fetcher = fetch }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) {
    throw new Error("Missing GitHub authentication or repository.");
  }
  return async (endpoint, { method = "GET", body, allowMissing = false } = {}) => {
    const result = await fetcher(`https://api.github.com/repos/${repository}${endpoint}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (allowMissing && result.status === 404) return undefined;
    if (!result.ok) throw new Error(`GitHub API returned HTTP ${result.status}.`);
    return result.json();
  };
}

export async function currentPull(api, { number, head }, defaultBranch) {
  const pull = await api(`/pulls/${number}`);
  if (pull.state !== "open" || pull.head.sha !== head || pull.base.ref !== defaultBranch) return null;
  return pull;
}

export async function pullFiles(api, number, changedFiles, maximumPages = 4) {
  const files = [];
  for (let page = 1; page <= maximumPages; page++) {
    const items = await api(`/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...items);
    if (items.length < 100 || files.length >= changedFiles) break;
  }
  return { files, complete: changedFiles === files.length };
}
