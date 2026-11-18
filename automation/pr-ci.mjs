import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { currentPull, githubApi, parsePullRequest, pullFiles } from "./pr-github.mjs";

export const checkName = "Lattice CI passed";
const trustedRepository = "knightnemo/lattice-web-ui";
const trustedBranch = "main";
const trustedRef = `refs/heads/${trustedBranch}`;
const packagePaths = /^(?:plugin\/|scripts\/|account-gateway\/|device-pairing\/|automation\/|test\/|\.github\/|companion(?:\/|\.)|README\.md$)/;

export function needsPackaging(files, labels, complete) {
  return !complete || labels.some(({ name }) => name === "full-ci") ||
    files.some(({ filename, previous_filename }) => [filename, previous_filename].some((path) =>
      typeof path === "string" && packagePaths.test(path)));
}

async function requireCurrentMain(api, env) {
  if (env.GITHUB_REPOSITORY !== trustedRepository || env.GITHUB_REF !== trustedRef ||
      !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "")) {
    throw new Error("Verification requires the trusted main workflow.");
  }
  const ref = await api(`/git/ref/heads/${trustedBranch}`);
  if (ref.object?.type !== "commit" || ref.object.sha !== env.GITHUB_SHA) {
    throw new Error("Main changed since dispatch. Retry verification from current main.");
  }
}

async function currentGatePull(api, request) {
  const pull = await currentPull(api, request, trustedBranch);
  return pull?.base.repo?.full_name === trustedRepository ? pull : null;
}

async function plan(api, request, env) {
  await requireCurrentMain(api, env);
  const pull = await currentGatePull(api, request);
  if (!pull) throw new Error("PR is closed, has changed head, or targets another branch.");
  const { files, complete } = await pullFiles(api, request.number, pull.changed_files);
  if (!(await currentGatePull(api, request))) {
    throw new Error("PR changed while planning.");
  }
  const packaging = needsPackaging(files, pull.labels, complete);
  const branch = env.COMPANION_REF || "companion/0.4.0";
  if (!/^companion\/\d+\.\d+\.\d+$/.test(branch)) throw new Error("Invalid companion ref.");
  const companion = packaging
    ? await api(`/git/ref/heads/${branch}`, { allowMissing: true })
    : undefined;
  const companionSha = companion?.object?.sha ?? "";
  if (companion && (!/^[0-9a-f]{40}$/.test(companionSha) || companion.object.type !== "commit")) {
    throw new Error("Companion reference is not a valid commit.");
  }

  await appendFile(env.GITHUB_OUTPUT, [
    `head=${request.head}`,
    `number=${request.number}`,
    `packaging=${packaging}`,
    `companion_sha=${companionSha}`,
    "",
  ].join("\n"));
  const summary = packaging
    ? companionSha
      ? `Plugin archive and full source-kit packaging selected. Companion \`${companionSha}\`.`
      : "Plugin archive selected. The full source kit requires a published companion ref."
    : "Fast verification selected. No release inputs changed.";
  await appendFile(env.GITHUB_STEP_SUMMARY, `### Test plan\n\n${summary}\n`);
}

export async function publish(api, request, env) {
  await requireCurrentMain(api, env);
  if (!(await currentGatePull(api, request))) {
    console.log("PR changed or closed. The dispatch result was not published.");
    return;
  }
  const conclusion = ["success", "failure", "cancelled", "skipped"].includes(env.VERIFY_RESULT)
    ? env.VERIFY_RESULT
    : "failure";
  await api("/check-runs", {
    method: "POST",
    body: {
      name: checkName,
      head_sha: request.head,
      status: "completed",
      conclusion: conclusion === "skipped" ? "failure" : conclusion,
      details_url: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      external_id: `lattice-pr-${request.number}-${env.GITHUB_RUN_ID}`,
      output: {
        title: "Lattice-web-ui PR verification",
        summary: `Deterministic verification: ${conclusion}. See the Actions run for test and packaging evidence.`,
      },
    },
  });
}

async function main() {
  const env = process.env;
  const request = parsePullRequest(env.PR_NUMBER, env.PR_HEAD_SHA);
  const api = githubApi({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY });
  if (process.argv[2] === "plan") await plan(api, request, env);
  else if (process.argv[2] === "publish") await publish(api, request, env);
  else throw new Error("Expected plan or publish.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
