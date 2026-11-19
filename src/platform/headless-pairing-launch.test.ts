import { afterEach, expect, it, vi } from "vitest";
import { signInPairedDevice } from "./headless-login";
import { installSessionRecovery } from "./headless-session-recovery";

const session = { headless: true, authenticated: true, devicePairing: true, canManageDevices: false };
const invite = "a".repeat(64);
function setup(existing: boolean) {
  document.body.innerHTML = '<main id="root"><textarea>Editing</textarea></main>';
  let launch!: (parameters: { targetURL: string }) => void;
  vi.stubGlobal("launchQueue", { setConsumer: (consumer: typeof launch) => { launch = consumer; } });
  let authenticated = existing;
  const fetch = vi.fn(async (path: string) => {
    if (path === "/api/devices/resume") authenticated = true;
    return Response.json({ ...session, authenticated });
  });
  vi.stubGlobal("fetch", fetch);
  return { launch: (url: string) => launch({ targetURL: url }), fetch };
}
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("shows a captured invitation over an existing sign-in and waits for the user's submit", async () => {
  const { launch, fetch } = setup(false);
  const signIn = signInPairedDevice(null);
  launch(location.origin + "/");
  launch("https://other.example/#pair=" + invite);
  expect(document.querySelector('input[type="password"]')).toBeTruthy();
  launch(location.origin + "/#pair=" + invite);
  expect(document.querySelector("h1")?.textContent).toBe("Pair this device");
  expect(fetch).not.toHaveBeenCalled();
  document.querySelector("input")!.value = "Phone";
  document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await expect(signIn).resolves.toEqual(session);
});

it("recovers a revoked installed window through a captured invite with the editor mounted", async () => {
  const { launch, fetch } = setup(false);
  const restore = vi.fn(async () => {});
  const recovery = installSessionRecovery(session, vi.fn(), restore);
  const editor = document.querySelector("textarea");
  try {
    launch(location.origin + "/#pair=" + invite);
    await vi.waitFor(() => expect(document.querySelector(".headless-reconnect form")).toBeTruthy());
    expect(fetch.mock.calls.map(([path]) => path)).not.toContain("/api/devices/pair");
    expect(document.querySelector("textarea")).toBe(editor);
    document.querySelector("input")!.value = "Phone";
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(restore).toHaveBeenCalledWith(session));
    expect(document.querySelector(".headless-reconnect")).toBeNull();
    expect(document.querySelector("textarea")).toBe(editor);
    launch(location.origin + "/#pair=" + invite);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".headless-reconnect")).toBeNull();
  } finally { recovery.dispose(); }
});
