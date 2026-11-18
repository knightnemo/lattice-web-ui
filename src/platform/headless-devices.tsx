import { useCallback, useEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { ModalDialog } from "../components/ui/modal-dialog";
import { serverRequest } from "./headless-runtime";

interface Device {
  id: string;
  label: string;
}

interface Invite {
  url: string;
  qr: string[];
  expiresIn: number;
}

interface View {
  devices: Device[] | null;
  invite: Invite | null;
  busy: boolean;
  status: string;
}

function PairingCode({ rows, label }: { rows: string[]; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pixels = (rows.length + 8) * 5;
  useEffect(() => {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- canvas context type
    const canvas = ref.current?.getContext("2d");
    if (!canvas) return;
    canvas.fillStyle = "#fff";
    canvas.fillRect(0, 0, pixels, pixels);
    canvas.fillStyle = "#111";
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "1") canvas.fillRect((x + 4) * 5, (y + 4) * 5, 5, 5);
      }
    });
  }, [rows, pixels]);
  return <canvas ref={ref} width={pixels} height={pixels} role="img" aria-label={label} />;
}

function DeviceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const [view, update] = useReducer(
    (current: View, change: Partial<View>): View => ({ ...current, ...change }),
    { devices: null, invite: null, busy: false, status: "" },
  );
  const loadError = t`Could not load paired devices.`;
  const refresh = useCallback(async () => {
    try {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- server route
      const result = await serverRequest<{ devices: Device[] }>("/api/devices");
      update({ devices: result.devices });
    } catch {
      update({ status: loadError });
    }
  }, [loadError]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!view.invite) return;
    const timeout = window.setTimeout(() => update({ invite: null }), view.invite.expiresIn * 1000);
    return () => window.clearTimeout(timeout);
  }, [view.invite]);

  const createInvite = async () => {
    update({ busy: true, status: "", invite: null });
    try {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- server route
      update({ invite: await serverRequest<Invite>("/api/devices/invites", {}) });
    } catch {
      update({ status: t`Could not create a pairing code.` });
    } finally {
      update({ busy: false });
    }
  };
  const revoke = async (id: string) => {
    update({ busy: true, status: "" });
    try {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- server route
      await serverRequest(`/api/devices/${encodeURIComponent(id)}/revoke`, {});
      await refresh();
    } catch {
      update({ status: t`Could not revoke this device.` });
    } finally {
      update({ busy: false });
    }
  };

  return (
    <ModalDialog label={t`Remote devices`} onClose={onClose} closeDisabled={view.busy}>
      <div className="modal headless-devices-dialog">
        <h2>{t`Remote devices`}</h2>
        {view.invite && (
          <div className="headless-device-code">
            <PairingCode rows={view.invite.qr} label={t`Device pairing QR code`} />
            <p>{t`Scan this code on your other device. It can be used once and expires in two minutes.`}</p>
            <Button onClick={async () => {
              try {
                await navigator.clipboard.writeText(view.invite!.url);
                update({ status: t`Pairing link copied.` });
              } catch {
                update({ status: t`Could not copy the pairing link.` });
              }
            }}>{t`Copy pairing link`}</Button>
          </div>
        )}
        {!!view.devices?.length && (
          <ul className="headless-device-list">
            {view.devices.map((device) => (
              <li key={device.id}>
                <span>{device.label}</span>
                <Button size="compact" variant="danger" disabled={view.busy} onClick={() => void revoke(device.id)}>
                  {t`Revoke`}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {view.status && <p role="status">{view.status}</p>}
        <div className="modal-actions">
          <Button variant="ghost" onClick={() => void refresh()}>{t`Refresh devices`}</Button>
          <Button variant="primary" disabled={view.busy} onClick={() => void createInvite()}>{t`Pair a device`}</Button>
        </div>
      </div>
    </ModalDialog>
  );
}

export default function HeadlessDevices() {
  const { t } = useLingui();
  const [open, setOpen] = useReducer((_: boolean, value: boolean) => value, false);
  return (
    <>
      <Button size="compact" variant="ghost" onClick={() => setOpen(true)}>{t`Devices`}</Button>
      {open && <DeviceDialog onClose={() => setOpen(false)} />}
    </>
  );
}
