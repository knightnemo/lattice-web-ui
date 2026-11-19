import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../app-types";
import { requestProjectTreeRefresh } from "../project/project-files-changed";
import { useProjectState, useProjectTreeWatch } from "./use-project-state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

it("waits for another event after cancellation instead of replaying a queued scan during reload", async () => {
  const snapshot = { root: "/workspace/paper", files: [] } as unknown as ProjectSnapshot;
  let fail!: (reason: Error) => void;
  const cancelled = new Promise<never>((_, reject) => { fail = reject; });
  let offline = true;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "watch_project") return;
    if (offline) return cancelled;
    return command === "refresh_project" ? snapshot : { repository: false, files: [] };
  });
  const { result } = renderHook(() => {
    const state = useProjectState();
    useProjectTreeWatch(state, true);
    return state;
  });
  await act(async () => { result.current.setProject(snapshot); });
  expect(invoke).toHaveBeenCalledTimes(3);
  await act(async () => {
    requestProjectTreeRefresh();
    fail(new Error("Load failed"));
  });
  expect(invoke).toHaveBeenCalledTimes(3);
  offline = false;
  await act(async () => { requestProjectTreeRefresh(); });
  expect(invoke).toHaveBeenCalledTimes(5);
});
