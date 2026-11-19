import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { notifyInfo } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { recoverHostedSettings, watchWebUpdate, webUpdateSnapshot } from "./headless-web-update";

vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));
vi.mock("../telemetry/app-log-store", () => ({ dismissAppToastByDedupeKey: vi.fn() }));

const current = "a".repeat(24);
const changed = "b".repeat(24);
const stamp = (revision: string) => `<meta name="lattice-web-build" content="${revision}">`;
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  document.head.querySelector('meta[name="lattice-web-build"]')?.remove();
  sessionStorage.clear();
  delete window.__LATTICE_HEADLESS_DEVICE_OWNER__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("offers an update once per deployed build, keeps offline/hidden tabs quiet and retracts a rollback", async () => {
  document.head.insertAdjacentHTML("beforeend", stamp(current));
  let html = "<title>Sign in</title>";
  const fetchBuild = vi.fn(async () => new Response(html, { headers: { "Content-Type": "text/html" } }));
  vi.stubGlobal("fetch", (url: string | URL) => String(url) === "/lattice-host-update.json"
    ? Promise.resolve(new Response(null, { status: 404 })) : fetchBuild());
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const reload = vi.fn(async () => true);
  stop = watchWebUpdate(reload);
  async function check() {
    window.dispatchEvent(new Event("online"));
    await webUpdateSnapshot()?.check();
  }
  await check();
  expect(notifyInfo).not.toHaveBeenCalled();
  html = stamp(changed);
  hidden.mockReturnValue(true);
  await check();
  expect(fetchBuild).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);
  window.dispatchEvent(new Event("lattice:workspace-reconnected"));
  window.dispatchEvent(new Event("lattice:workspace-reconnected"));
  expect(fetchBuild).toHaveBeenCalledTimes(2);
  await webUpdateSnapshot()?.check();
  expect(notifyInfo).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  await check();
  expect(notifyInfo).toHaveBeenCalledOnce();
  // Closing the toast leaves the same release and action available in Settings.
  expect(webUpdateSnapshot()?.served).toBe(changed);
  await webUpdateSnapshot()?.reload();
  expect(reload).toHaveBeenCalledOnce();
  html = stamp(current);
  await check();
  expect(dismissAppToastByDedupeKey).toHaveBeenCalledOnce();
  await expect(webUpdateSnapshot()?.reload()).resolves.toBe(false);
  expect(reload).toHaveBeenCalledOnce();
});

const newer = { schema: 1, installedVersion: "0.9.12", latestVersion: "0.10.0" };
function hostFixture(first: () => Response, build = current) {
  let response = first;
  const fetchStatus = vi.fn(async () => response());
  const fetch = vi.fn(async (url: string | URL) => String(url) === "/lattice-host-update.json"
    ? fetchStatus() : new Response(stamp(build), { headers: { "Content-Type": "text/html" } }));
  document.head.insertAdjacentHTML("beforeend", stamp(current));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("fetch", fetch);
  const reload = vi.fn(async () => true);
  stop = watchWebUpdate(reload);
  return { fetch, fetchStatus, reload, respond: (next: () => Response) => { response = next; } };
}

it("offers release notes and a served-build reload independently; reopening a tab's workspace does not repeat the host notice", async () => {
  const { reload, fetch } = hostFixture(() => Response.json(newer), changed);
  await webUpdateSnapshot()?.check();
  await vi.waitFor(() => expect(webUpdateSnapshot()?.release?.latestVersion).toBe("0.10.0"));
  expect(notifyInfo).toHaveBeenCalledTimes(2);
  const calls = vi.mocked(notifyInfo).mock.calls;
  const hostNotice = calls.find(([, , options]) => options?.dedupeKey === "headless-host-release");
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  hostNotice?.[2]?.primaryAction?.onClick();
  expect(open).toHaveBeenCalledWith("https://github.com/knightnemo/lattice-web-ui/releases/tag/v0.10.0", "_blank", "noopener,noreferrer");
  expect(reload).not.toHaveBeenCalled();
  expect(fetch.mock.calls.every(([url]) => String(url) === "/lattice-host-update.json" || new URL(url).origin === location.origin)).toBe(true);
  await expect(webUpdateSnapshot()?.reload()).resolves.toBe(true);
  stop?.();
  stop = watchWebUpdate(reload);
  await vi.waitFor(() => expect(webUpdateSnapshot()?.release?.latestVersion).toBe("0.10.0"));
  expect(notifyInfo).toHaveBeenCalledTimes(2);
});

it.each([
  ["no release", () => Response.json({ ...newer, latestVersion: null })],
  ["older", () => Response.json({ ...newer, latestVersion: "0.8.100" })],
  ["equal", () => Response.json({ ...newer, latestVersion: newer.installedVersion })],
  ["prerelease", () => Response.json({ ...newer, latestVersion: "1.0.0-beta.2" })],
  ["URL injection", () => Response.json({ ...newer, latestVersion: "1.0.0/path" })],
  ["leading zero", () => Response.json({ ...newer, installedVersion: "0.09.12" })],
  ["end whitespace", () => Response.json({ ...newer, latestVersion: "1.0.0\n" })],
  ["wrong schema", () => Response.json({ ...newer, schema: "1" })],
  ["extra fields", () => Response.json({ ...newer, releaseUrl: "https://example.org/" })],
  ["malformed JSON", () => new Response("{", { headers: { "Content-Type": "application/json" } })],
  ["HTML fallback", () => new Response("<title>Sign in</title>", { headers: { "Content-Type": "text/html" } })],
  ["missing file", () => new Response(null, { status: 404 })],
] as const)("clears an obsolete offer for %s without a guest notification or reload", async (_label, response) => {
  window.__LATTICE_HEADLESS_DEVICE_OWNER__ = false;
  const { respond, reload } = hostFixture(() => Response.json(newer));
  await vi.waitFor(() => expect(webUpdateSnapshot()?.release?.installedVersion).toBe("0.9.12"));
  respond(response);
  await webUpdateSnapshot()?.check();
  await vi.waitFor(() => expect(webUpdateSnapshot()?.release).toBeNull());
  await expect(webUpdateSnapshot()?.reload()).resolves.toBe(false);
  expect(notifyInfo).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("backs off for hosts without a timer and finds a newly enabled timer on a manual check", async () => {
  window.__LATTICE_HEADLESS_DEVICE_OWNER__ = true;
  const { fetchStatus, respond } = hostFixture(() => new Response(null, { status: 404 }));
  await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledOnce());
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  respond(() => Response.json(newer));
  window.dispatchEvent(new Event("online"));
  expect(fetchStatus).toHaveBeenCalledOnce();
  await webUpdateSnapshot()?.check();
  await vi.waitFor(() => expect(webUpdateSnapshot()?.release?.latestVersion).toBe("0.10.0"));
  expect(fetchStatus).toHaveBeenCalledTimes(2);
  expect(notifyInfo).toHaveBeenCalledOnce();
});

it("reoffers a dismissed deployment from an unavailable Settings chunk without touching the draft", async () => {
  const { reload } = hostFixture(() => new Response(null, { status: 404 }), changed);
  await webUpdateSnapshot()?.check();
  expect(notifyInfo).toHaveBeenCalledOnce();
  vi.mocked(notifyInfo).mockClear();
  const fallback = await recoverHostedSettings(new Error("Missing Settings chunk"));
  const onClose = vi.fn();
  const panel = render(createElement(fallback.default, { onClose }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(notifyInfo).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  await expect(webUpdateSnapshot()?.reload()).resolves.toBe(true);
  expect(reload).toHaveBeenCalledOnce();
  panel.unmount();
});

it("preserves ordinary Settings failures when the host is still serving this build", async () => {
  hostFixture(() => new Response(null, { status: 404 }));
  const failure = new Error("Unexpected Settings failure");
  await expect(recoverHostedSettings(failure)).rejects.toBe(failure);
  expect(notifyInfo).not.toHaveBeenCalled();
});
