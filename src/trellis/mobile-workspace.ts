import type { WorkspaceHandle } from "@danfessler/trellis";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { isHeadlessHosted } from "../platform/browser-runtime";
import { onWorkspacePresentationChange, workspacePresentation, type WorkspacePresentation } from "./mobile-viewport";
import { enterFocus, returnLayout, type ActiveFocus } from "./trellis-layout";
import type { TrellisController, TrellisSingleton } from "./trellis-controller";
import { PANEL_TITLES } from "./trellis-titles";

/** Frame the existing panels without replacing the document or its editor on fold and unfold. */
export function installMobileWorkspace(controller: TrellisController, ws: WorkspaceHandle): () => void {
  // React wraps the engine element in .lattice-trellis. The navigation must
  // share the outer workspace's flex column, rather than extend its canvas.
  const host = ws.element.closest<HTMLElement>(".lattice-trellis") ?? ws.element;
  const container = host.parentElement;
  let mode: WorkspacePresentation = "desktop";
  let projection: ActiveFocus | null = null;
  const remote = isHeadlessHosted();
  let previousFrame: string | null = null;
  let lastKey = "";
  let lastReveal = 0;
  let frame = 0;
  const nav = document.createElement("nav");
  nav.className = "mobile-workspace-nav";
  nav.setAttribute("aria-label", i18n._(msg`Workspace panels`));
  const button = (label: string, action: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.onclick = action;
    nav.append(element);
    return element;
  };
  const editorView = () => {
    const { activeKey } = controller.app.get();
    return ws.views({ type: "file" }).find((view) => view.params.key === activeKey);
  };
  const arrangeEditingPanels = () => {
    const state = controller.app.get();
    const layout = enterFocus(ws.getDocument(), projection, {
      activeKey: state.activeKey,
      openTabs: state.openTabs,
      isReading: (key) => controller.isReading(key),
    }, true);
    projection = layout.active;
    ws.setDocument(layout.document, { animate: false });
  };
  const showEditor = () => {
    let editing = editorView();
    let pdf = ws.view("pdf");
    if (mode === "spread") {
      // A panel can be closed or moved while the user is in another mobile tool.
      // Only rebuild the temporary layout when the existing pair cannot be shown.
      if (!pdf || pdf.placement !== "docked" || (editing && (editing.placement !== "docked" || editing.panelId === pdf.panelId))) {
        arrangeEditingPanels();
        editing = editorView();
        pdf = ws.view("pdf");
      }
      const lead = editing ?? ws.view("project");
      if (lead && pdf) {
        const pair = new Set([lead.panelId, pdf.panelId]);
        const otherPanels = new Set(ws.views().filter((view) => view.placement !== "hidden").map((view) => view.panelId));
        for (const panel of otherPanels) if (!pair.has(panel)) ws.hide(panel);
        ws.select(lead.id);
        ws.select(pdf.id);
        ws.navigation.frame([lead.panelId, pdf.panelId]);
        return;
      }
    }
    if (editing) {
      if (remote) ws.select(editing.id);
      else ws.focus(editing.id);
      ws.navigation.frame(editing.panelId);
    } else {
      showPanel("project");
    }
  };
  const showPanel = (kind: TrellisSingleton) => {
    controller.showPanel(kind);
    const view = ws.view(kind);
    if (!view) return;
    ws.focus(view.id);
    ws.navigation.frame(view.panelId);
  };
  button(i18n._(msg`Project`), () => showPanel("project"));
  const editor = button(i18n._(msg`Editor`), showEditor);
  button(i18n._(msg`PDF`), () => showPanel("pdf"));
  const more = document.createElement("select");
  more.setAttribute("aria-label", i18n._(msg`More panels`));
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = i18n._(msg`More`);
  more.append(placeholder);
  for (const kind of ["agent", "terminal", "papers", "git", "history", "overleaf", "literature", "todos", "checklist"] as const) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = i18n._(PANEL_TITLES[kind]);
    more.append(option);
  }
  more.onchange = () => {
    if (more.value) showPanel(more.value as TrellisSingleton);
    more.value = "";
  };
  nav.append(more);
  const save = button(i18n._(msg`Save`), () => { void controller.bridge?.save(); });
  button(i18n._(msg`Build`), () => {
    const key = controller.app.get().activeKey;
    void controller.bridge?.build(key);
  });
  const sync = () => {
    if (mode === "desktop") return;
    const state = controller.app.get();
    editor.disabled = !state.activeKey;
    save.disabled = !state.activeDirty;
    if (state.activeKey && (state.activeKey !== lastKey || state.revealRequest !== lastReveal)) {
      cancelAnimationFrame(frame);
      // Tab sync installs a newly opened view before this frame runs.
      frame = requestAnimationFrame(showEditor);
    }
    lastKey = state.activeKey;
    lastReveal = state.revealRequest;
  };
  const clearMobileUi = () => {
    cancelAnimationFrame(frame);
    nav.remove();
    container?.classList.remove("mobile-workspace");
  };
  const restoreDesktop = () => {
    clearMobileUi();
    if (projection) {
      ws.setDocument(returnLayout(projection.previous, ws.getDocument(), controller.app.get(), projection.supplied), { animate: false });
      projection = null;
      controller.resync();
    }
    ws.update({ navigation: "free" });
    ws.navigation.frame(previousFrame ?? "all");
  };
  const update = () => {
    const next = workspacePresentation();
    if (next === mode) return;
    const entering = mode === "desktop";
    mode = next;
    if (next === "desktop") {
      restoreDesktop();
      return;
    }
    if (entering) {
      previousFrame = ws.navigation.framed;
      container?.classList.add("mobile-workspace");
      host.after(nav);
      if (remote) arrangeEditingPanels();
      ws.update({ navigation: "focus" });
    }
    showEditor();
    sync();
  };
  const stop = onWorkspacePresentationChange(update);
  const unsubscribe = controller.app.subscribe(sync);
  update();
  return () => {
    stop();
    unsubscribe();
    if (mode !== "desktop" && controller.ws === ws) restoreDesktop();
    else clearMobileUi();
  };
}
