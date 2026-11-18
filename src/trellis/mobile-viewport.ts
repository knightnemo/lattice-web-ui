import { isBrowserHosted, isHeadlessHosted } from "../platform/browser-runtime";

// Keep full-width Duo Safari viewports in the split layout (669px and 951px),
// and the outer screen in either orientation in the compact layout (up to 594px).
const COMPACT_REMOTE = "(max-width: 640px)";
const RESPONSIVE_REMOTE = "(max-width: 1024px)";
const COMPACT_BROWSER = "(max-width: 700px)";

export type WorkspacePresentation = "desktop" | "compact" | "spread";

export function workspacePresentation(): WorkspacePresentation {
  if (!isBrowserHosted()) return "desktop";
  if (!isHeadlessHosted()) return window.matchMedia(COMPACT_BROWSER).matches ? "compact" : "desktop";
  if (!window.matchMedia(RESPONSIVE_REMOTE).matches) return "desktop";
  return window.matchMedia(COMPACT_REMOTE).matches ? "compact" : "spread";
}

export function isMobileWorkspace(): boolean {
  return workspacePresentation() !== "desktop";
}

export function onWorkspacePresentationChange(update: () => void): () => void {
  const queries = (isHeadlessHosted() ? [COMPACT_REMOTE, RESPONSIVE_REMOTE] : [COMPACT_BROWSER])
    .map((query) => window.matchMedia(query));
  queries.forEach((query) => query.addEventListener("change", update));
  return () => queries.forEach((query) => query.removeEventListener("change", update));
}
