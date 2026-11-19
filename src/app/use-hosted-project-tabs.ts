import { useEffect, useReducer } from "react";

export type ProjectTab = { root: string; name: string };
type TabAction = { type: "open"; tab: ProjectTab } | { type: "close"; root: string };

const STORAGE_KEY = "lattice.hosted-project-tabs.v1";

function loadTabs(enabled: boolean): ProjectTab[] {
  if (!enabled) return [];
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(data)
      ? data.filter((tab) => typeof tab?.root === "string" && typeof tab.name === "string")
      : [];
  } catch {
    return [];
  }
}

function updateTabs(tabs: ProjectTab[], action: TabAction): ProjectTab[] {
  if (action.type === "close") return tabs.filter(({ root }) => root !== action.root);
  const previous = tabs.find(({ root }) => root === action.tab.root);
  if (!previous) return [...tabs, action.tab];
  if (previous.name === action.tab.name) return tabs;
  return tabs.map((tab) => tab === previous ? action.tab : tab);
}

export function useHostedProjectTabs(enabled: boolean) {
  const [tabs, dispatch] = useReducer(updateTabs, enabled, loadTabs);
  useEffect(() => {
    if (!enabled) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // Project tabs can still be used until this page is reloaded.
    }
  }, [enabled, tabs]);
  return { tabs, dispatch };
}
