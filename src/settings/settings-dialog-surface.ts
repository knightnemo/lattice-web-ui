import { lazy, type ComponentType } from "react";
import type { SettingsDialogProps } from "./settings-dialog";
import { isHeadlessHosted, loadWebUpdate } from "../platform/browser-runtime";

export const SettingsDialogSurface = lazy<ComponentType<SettingsDialogProps>>(() =>
  import("./settings-dialog").then((module) => ({ default: module.SettingsDialog })).catch(async (error) => {
    if (!isHeadlessHosted()) throw error;
    // The hosted watcher is already loaded before the editor enters its project.
    return (await loadWebUpdate()).recoverHostedSettings(error);
  }),
);
