import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../app-types";
import { requestProjectTreeRefresh } from "../project/project-files-changed";
import { useProjectState, useProjectTreeWatch } from "./use-project-state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

afterEach(cleanup);

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

it("replays queued tree changes when an active tab can read files but Git is unavailable", async () => {
  vi.mocked(invoke).mockClear();
  const snapshot = { root: "/workspace/paper", files: [] } as unknown as ProjectSnapshot;
  const updated = { ...snapshot, files: [{ path: "notes.md" }] } as ProjectSnapshot;
  let finish!: (snapshot: ProjectSnapshot) => void;
  const pending = new Promise<ProjectSnapshot>((resolve) => { finish = resolve; });
  let scans = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "git_status") throw new Error("Git is unavailable");
    if (command === "refresh_project") return ++scans === 1 ? pending : updated;
  });
  const { result } = renderHook(() => {
    const state = useProjectState();
    useProjectTreeWatch(state, true);
    return state;
  });
  await act(async () => { result.current.setProject(snapshot); });
  await act(async () => {
    requestProjectTreeRefresh();
    finish(snapshot);
  });
  expect(scans).toBe(2);
  expect(result.current.project?.files).toEqual(updated.files);
});
