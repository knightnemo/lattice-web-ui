import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { notifyInfo } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { recoverHostedSettings, watchWebUpdate, webUpdateSnapshot } from "./headless-web-update";
import HeadlessHostUpdateBanner from "./headless-host-update-banner";

vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));
vi.mock("../telemetry/app-log-store", () => ({ dismissAppToastByDedupeKey: vi.fn() }));

const current = "a".repeat(24);
const changed = "b".repeat(24);
const stamp = (revision: string) => `<meta name="lattice-web-build" content="${revision}">`;
let stop: (() => void) | undefined;

afterEach(() => {
  cleanup();
  stop?.();
  document.head.querySelector('meta[name="lattice-web-build"]')?.remove();
  delete window.__LATTICE_HEADLESS_DEVICE_OWNER__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("offers an update once per deployed build, keeps offline/hidden tabs quiet and retracts a rollback", async () => {
  document.head.insertAdjacentHTML("beforeend", stamp(current));
  let html = "<title>Sign in</title>";
  const fetchBuild = vi.fn(async () => new Response(html, { headers: { "Content-Type": "text/html" } }));
  vi.stubGlobal("fetch", (url: string | URL) => String(url).startsWith("/")
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
function hostFixture(first: () => Response, build = current, readManaged = () => new Response(null, { status: 404 }),
  post = () => new Response(null, { status: 404 })) {
  let response = first;
  const fetchStatus = vi.fn(async () => response());
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === "/api/host-update") return init?.method === "POST" ? post() : readManaged();
    return String(url) === "/lattice-host-update.json"
      ? fetchStatus() : new Response(stamp(build), { headers: { "Content-Type": "text/html" } });
  });
  document.head.insertAdjacentHTML("beforeend", stamp(current));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("fetch", fetch);
  const reload = vi.fn(async () => true);
  stop = watchWebUpdate(reload);
  return { fetch, fetchStatus, reload, respond: (next: () => Response) => { response = next; } };
}

it("keeps a notes-only notice for an unmanaged host beside a separate served-build reload", async () => {
  const { reload, fetch } = hostFixture(() => Response.json(newer), changed);
  render(createElement(HeadlessHostUpdateBanner));
  await webUpdateSnapshot()?.check();
  expect(await screen.findByRole("link", { name: "View release notes" })).toHaveAttribute(
    "href", "https://github.com/lattice-writer/lattice-web-ui/releases/tag/v0.10.0",
  );
  expect(screen.queryByRole("button", { name: "Update host" })).not.toBeInTheDocument();
  expect(notifyInfo).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  expect(fetch.mock.calls.every(([url]) => new URL(url, location.href).origin === location.origin)).toBe(true);
  await expect(webUpdateSnapshot()?.reload()).resolves.toBe(true);
  expect(screen.getByRole("region", { name: "Host update" })).toBeInTheDocument();
});

it("queues one managed update, follows it and leaves the host notice available on rollback", async () => {
  let phase = "ready";
  const { fetch, reload } = hostFixture(
    () => new Response(null, { status: 404 }),
    current,
    () => Response.json({ ...newer, phase }),
    () => { phase = "waiting"; return new Response(null, { status: 202 }); },
  );
  render(createElement(HeadlessHostUpdateBanner));
  const update = await screen.findByRole("button", { name: "Update host" });
  expect(screen.getByRole("status")).toHaveTextContent("Lattice-web-ui 0.10.0 is ready to install.");
  fireEvent.click(update);
  fireEvent.click(update);
  expect(await screen.findByText(/Waiting for open Agent sessions/)).toBeInTheDocument();
  expect(update).toHaveAttribute("aria-disabled", "true");
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([[
    "/api/host-update",
    expect.objectContaining({ credentials: "same-origin", body: '{"version":"0.10.0"}' }),
  ]]);
  phase = "switching";
  await webUpdateSnapshot()?.check();
  expect(await screen.findByText("Restarting the host for Lattice-web-ui 0.10.0…")).toBeInTheDocument();
  phase = "rolled_back";
  await webUpdateSnapshot()?.check();
  expect(await screen.findByText("Update failed. The host is back on 0.9.12.")).toBeInTheDocument();
  expect(update).toHaveAttribute("aria-disabled", "false");
  expect(reload).not.toHaveBeenCalled();
});

it("keeps a version actionable after a rejected update request", async () => {
  hostFixture(
    () => new Response(null, { status: 404 }),
    current,
    () => Response.json({ ...newer, phase: "available" }),
    () => new Response(null, { status: 409 }),
  );
  render(createElement(HeadlessHostUpdateBanner));
  const update = await screen.findByRole("button", { name: "Update host" });
  fireEvent.click(update);
  expect(await screen.findByText("Couldn’t request the host update. Try again.")).toBeInTheDocument();
  expect(update).toHaveAttribute("aria-disabled", "false");
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
  const { fetch, respond, reload } = hostFixture(() => Response.json(newer));
  render(createElement(HeadlessHostUpdateBanner));
  await vi.waitFor(() => expect(webUpdateSnapshot()?.release?.installedVersion).toBe("0.9.12"));
  expect(screen.queryByRole("region", { name: "Host update" })).not.toBeInTheDocument();
  expect(fetch.mock.calls.every(([path]) => path !== "/api/host-update")).toBe(true);
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
  expect(notifyInfo).not.toHaveBeenCalled();
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
