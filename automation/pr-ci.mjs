import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseCompanionPin } from "./companion-source.mjs";
import { currentPull, githubApi, parsePullRequest, pullFiles } from "./pr-github.mjs";

export const checkName = "Lattice CI passed";
const trustedRepository = "lattice-writer/lattice-web-ui";
const trustedBranch = "main";
const trustedRef = `refs/heads/${trustedBranch}`;
const packagePaths = /^(?:plugin\/|scripts\/|account-gateway\/|device-pairing\/|tailscale-owner\/|automation\/|test\/|\.github\/|companion(?:\/|\.)|docs\/assets\/|docs\/releases\.md$|README\.md$)/;

export function needsPackaging(files, labels, complete) {
  return !complete || labels.some(({ name }) => name === "full-ci") ||
    files.some(({ filename, previous_filename }) => [filename, previous_filename].some((path) =>
      typeof path === "string" && packagePaths.test(path)));
}

async function isCurrentMain(api, env) {
  if (env.GITHUB_REPOSITORY !== trustedRepository || env.GITHUB_REF !== trustedRef ||
      !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "")) {
    throw new Error("Verification requires the trusted main workflow.");
  }
  const ref = await api(`/git/ref/heads/${trustedBranch}`);
  if (ref.object?.type !== "commit" || !/^[0-9a-f]{40}$/.test(ref.object.sha)) {
    throw new Error("Cannot resolve the trusted main branch.");
  }
  return ref.object.sha === env.GITHUB_SHA;
}

async function currentGatePull(api, request) {
  const pull = await currentPull(api, request, trustedBranch);
  return pull?.base.repo?.full_name === trustedRepository ? pull : null;
}

async function companionSnapshot(api, head) {
  const file = await api(`/contents/automation/release-source.json?ref=${head}`);
  if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" ||
      !Number.isInteger(file.size) || file.size < 1 || file.size > 4096) {
    throw new Error("The PR must provide a small companion pin JSON file.");
  }
  const pin = parseCompanionPin(Buffer.from(file.content, "base64").toString("utf8"));
  const ref = await api(`/git/ref/tags/${pin.snapshotTag}`, { allowMissing: true });
  if (ref?.object?.type !== "commit" || ref.object.sha !== pin.snapshotCommit) {
    throw new Error("Companion tag is missing or does not point directly to the pinned commit.");
  }
  const commit = await api(`/git/commits/${pin.snapshotCommit}`);
  if (commit.tree?.sha !== pin.tree) {
    throw new Error("Companion commit has the wrong tree.");
  }
  return pin.snapshotCommit;
}

export async function plan(api, request, env) {
  if (!await isCurrentMain(api, env)) return;
  const pull = await currentGatePull(api, request);
  if (!pull) throw new Error("PR is closed, has changed head, or targets another branch.");
  const { files, complete } = await pullFiles(api, request.number, pull.changed_files);
  if (!(await currentGatePull(api, request))) {
    throw new Error("PR changed while planning.");
  }
  const packaging = needsPackaging(files, pull.labels, complete);
  const companionSha = packaging ? await companionSnapshot(api, request.head) : "";

  await appendFile(env.GITHUB_OUTPUT, [
    `head=${request.head}`,
    `number=${request.number}`,
    `packaging=${packaging}`,
    `companion_sha=${companionSha}`,
    "",
  ].join("\n"));
  const summary = packaging
    ? `Plugin archive and full source-kit packaging selected. Companion \`${companionSha}\`.`
    : "Fast verification selected. No release inputs changed.";
  await appendFile(env.GITHUB_STEP_SUMMARY, `### Test plan\n\n${summary}\n`);
}

export async function publish(api, request, env) {
  const currentMain = await isCurrentMain(api, env);
  if (!(await currentGatePull(api, request))) {
    console.log("PR changed or closed. The dispatch result was not published.");
    return;
  }
  if (!currentMain) {
    await appendFile(env.GITHUB_OUTPUT, "requeue=true\n");
    console.log("Main changed. Queue verification of the current PR head from the new main.");
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
