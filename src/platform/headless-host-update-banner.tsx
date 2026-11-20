import { useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { Download } from "lucide-react";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { canRequestHostUpdate, subscribeWebUpdate, webUpdateSnapshot } from "./headless-web-update";
import "./headless-host-update-banner.css";

export default function HeadlessHostUpdateBanner() {
  const { t } = useLingui();
  const update = useSyncExternalStore(subscribeWebUpdate, webUpdateSnapshot);
  const release = update?.release;
  if (!update || !release || window.__LATTICE_HEADLESS_DEVICE_OWNER__ === false) return null;

  const { installedVersion, latestVersion, notesUrl, phase } = release;
  const status = {
    available: t`Lattice-web-ui ${latestVersion} is available.`,
    preparing: t`Preparing Lattice-web-ui ${latestVersion} in the background…`,
    ready: t`Lattice-web-ui ${latestVersion} is ready to install.`,
    waiting: t`Waiting for open Agent sessions, terminals, and syncs to finish…`,
    switching: t`Restarting the host for Lattice-web-ui ${latestVersion}…`,
    rolled_back: t`Update failed. The host is back on ${installedVersion}.`,
    failed: t`The host couldn’t install Lattice-web-ui ${latestVersion}.`,
  }[phase ?? "available"];
  const disabled = update.requesting || !canRequestHostUpdate(phase);
  return (
    <section className="host-update-banner" aria-label={t`Host update`}>
      <div className="host-update-message" role="status">
        <Download size={16} aria-hidden="true" />
        <span>{update.requestFailed ? t`Couldn’t request the host update. Try again.` : status}</span>
      </div>
      <div className="host-update-actions">
        <a className={buttonClassName({ variant: "ghost", size: "compact" })} href={notesUrl} target="_blank" rel="noopener noreferrer">
          {t`View release notes`}
        </a>
        {phase !== null && (
          <Button variant="primary" size="compact" aria-disabled={disabled}
            onClick={() => { if (!disabled) void update.requestHost(); }}>
            {t`Update host`}
          </Button>
        )}
      </div>
    </section>
  );
}
