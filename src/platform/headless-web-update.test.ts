import { afterEach, expect, it, vi } from "vitest";
import { notifyInfo } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { watchWebUpdate, webUpdateSnapshot } from "./headless-web-update";

vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));
vi.mock("../telemetry/app-log-store", () => ({ dismissAppToastByDedupeKey: vi.fn() }));

const current = "a".repeat(24);
const changed = "b".repeat(24);
const stamp = (revision: string) => `<meta name="lattice-web-build" content="${revision}">`;
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  document.head.querySelector('meta[name="lattice-web-build"]')?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("offers an update once per deployed build, keeps offline/hidden tabs quiet and retracts a rollback", async () => {
  document.head.insertAdjacentHTML("beforeend", stamp(current));
  let html = "<title>Sign in</title>";
  const fetch = vi.fn(async () => new Response(html, { headers: { "Content-Type": "text/html" } }));
  vi.stubGlobal("fetch", fetch);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const reload = vi.fn(async () => true);
  stop = watchWebUpdate(reload);
  async function check() {
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await check();
  expect(notifyInfo).not.toHaveBeenCalled();
  html = stamp(changed);
  hidden.mockReturnValue(true);
  await check();
  expect(fetch).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);
  await check();
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
