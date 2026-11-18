/**
 * Every host message the interface translates, loaded beside a non-English
 * catalog by `activateAppLocale` (see `host-error-text.ts`).
 */
import { GOOGLE_HOST_ERRORS } from "./host-errors-google";
import type { HostErrorEntry } from "./host-error-text";
import { DESKTOP_PET_HOST_ERRORS } from "./host-errors-desktop-pet";
import { OVERLEAF_HOST_ERRORS } from "./host-errors-overleaf";
import { PAPERS_HOST_ERRORS } from "./host-errors-papers";
import { PROJECT_HOST_ERRORS } from "./host-errors-project";
import { SETUP_HOST_ERRORS } from "./host-errors-setup";
import { WORKSPACE_HOST_ERRORS } from "./host-errors-workspace";
import { WEB_BROWSER_HOST_ERRORS } from "./host-errors-web-browser";

export const HOST_ERRORS: readonly HostErrorEntry[] = [
  ...DESKTOP_PET_HOST_ERRORS,
  ...GOOGLE_HOST_ERRORS,
  ...PROJECT_HOST_ERRORS,
  ...WORKSPACE_HOST_ERRORS,
  ...WEB_BROWSER_HOST_ERRORS,
  ...OVERLEAF_HOST_ERRORS,
  ...PAPERS_HOST_ERRORS,
  ...SETUP_HOST_ERRORS,
];
