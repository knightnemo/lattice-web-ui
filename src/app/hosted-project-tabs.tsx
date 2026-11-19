import { useLingui } from "@lingui/react/macro";
import { Folder, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ProjectTab } from "./use-hosted-project-tabs";

export default function HostedProjectTabs({ tabs, activeRoot, busy, onOpen, onClose }: {
  tabs: readonly ProjectTab[];
  activeRoot: string;
  busy: boolean;
  onOpen: (root: string) => void;
  onClose: (root: string) => void;
}) {
  const { t } = useLingui();
  const activeTab = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeTab.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeRoot, tabs.length]);
  return (
    <nav className="hosted-project-tabs" aria-label={t`Open projects`}>
      {tabs.map(({ root, name }) => (
        <div key={root} ref={root === activeRoot ? activeTab : undefined}
          className="hosted-project-tab" data-active={root === activeRoot}>
          <button type="button" disabled={busy} aria-current={root === activeRoot ? "page" : undefined}
            title={root} onClick={() => onOpen(root)}>
            <Folder size={14} aria-hidden="true" />
            <span>{name}</span>
          </button>
          <button type="button" disabled={busy} aria-label={t`Close project ${name}`} onClick={() => onClose(root)}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </nav>
  );
}
