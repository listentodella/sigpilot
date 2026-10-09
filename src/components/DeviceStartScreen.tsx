import type { TFunction } from "i18next";
import { Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import devicePattern from "../assets/start-screen/device-pattern.png";
import { DeviceInfo } from "../lib/api";
import { UsbSpeedIcon, usbSpeedFromLinkSpeed, usbSpeedLabel } from "./UsbSpeedIcon";

interface DeviceStartScreenProps {
  busy: boolean;
  devices: DeviceInfo[];
  selectedDevice: string;
  onOpenCapture: () => void;
  onRefreshDevices: () => void;
  onCreateSessionWithDevice: (deviceId: string) => void;
  onSelectDevice: (deviceId: string) => void;
}

export function DeviceStartScreen({
  busy,
  devices,
  selectedDevice,
  onOpenCapture,
  onRefreshDevices,
  onCreateSessionWithDevice,
  onSelectDevice,
}: DeviceStartScreenProps) {
  const { t } = useTranslation("start");
  const physicalDevices = devices.filter((device) => device.kind === "Usb");
  const demoDevices = devices.filter((device) => device.kind === "Fake");
  const selectedDemo = demoDevices.find((device) => device.id === selectedDevice) ?? demoDevices[0];

  return (
    <div className="sessionPlaceholder">
      <div className="devicePrompts single">
        <DevicePromptCard imageSrc={devicePattern}>
          <DeviceList
            busy={busy}
            devices={physicalDevices}
            emptyLabel={t("noDeviceDetected")}
            onRefreshDevices={onRefreshDevices}
            onCreateSessionWithDevice={onCreateSessionWithDevice}
            onSelectDevice={onSelectDevice}
            selectedDevice={selectedDevice}
          />
          {selectedDemo && (
            <button
              className="saleaeSecondaryButton demoDeviceButton"
              disabled={busy}
              onClick={() => {
                onSelectDevice(selectedDemo.id);
                onCreateSessionWithDevice(selectedDemo.id);
              }}
              type="button"
            >
              {t("tryDemoDevice")}
            </button>
          )}
        </DevicePromptCard>
      </div>

      <div className="loadCaptureFile">
        <div className="loadCaptureTitle">{t("loadCaptureFile")}</div>
        <div className="fileChooser">
          <div className="dragDrop">
            <Download size={16} />
            {t("dragDropHere")}
          </div>
          <button className="saleaePrimaryButton" onClick={onOpenCapture} type="button">
            {t("chooseFile")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DevicePromptCardProps {
  children: React.ReactNode;
  imageSrc: string;
}

function DevicePromptCard({ children, imageSrc }: DevicePromptCardProps) {
  return (
    <section className="devicePrompt">
      <img alt="" src={imageSrc} />
      <div className="devicePromptContent">{children}</div>
    </section>
  );
}

interface DeviceListProps {
  busy: boolean;
  devices: DeviceInfo[];
  emptyLabel: string;
  selectedDevice: string;
  onRefreshDevices: () => void;
  onCreateSessionWithDevice: (deviceId: string) => void;
  onSelectDevice: (deviceId: string) => void;
}

/**
 * Bus, address and serial number are how you tell two identical instruments
 * apart, but they made every row unreadable when they were part of the label.
 * Keep them reachable on hover instead.
 */
function deviceLocation(device: DeviceInfo, t: TFunction): string {
  const parts = [device.label];
  if (device.bus != null && device.address != null) {
    parts.push(t("usbBusAddress", { address: device.address, bus: device.bus }));
  }
  if (device.serial_number) {
    parts.push(t("serialNumber", { serial: device.serial_number }));
  }
  return parts.join(" · ");
}

function DeviceList({
  busy,
  devices,
  emptyLabel,
  selectedDevice,
  onRefreshDevices,
  onCreateSessionWithDevice,
  onSelectDevice,
}: DeviceListProps) {
  const { t } = useTranslation("start");

  if (devices.length === 0) {
    return (
      <div className="devicePromptEmpty">
        <span>{emptyLabel}</span>
        <button className="saleaeSecondaryButton compact" disabled={busy} onClick={onRefreshDevices} type="button">
          <RefreshCw size={14} />
          {t("refresh")}
        </button>
      </div>
    );
  }

  return (
    <div className="realDeviceList">
      {devices.map((device) => {
        const isSelected = device.id === selectedDevice;
        const usbSpeed = usbSpeedFromLinkSpeed(device.usb_speed);
        return (
          <button
            className={`realDeviceOption ${isSelected ? "selected" : ""}`}
            disabled={busy}
            key={device.id}
            onClick={() => {
              onSelectDevice(device.id);
              onCreateSessionWithDevice(device.id);
            }}
            title={deviceLocation(device, t)}
            type="button"
          >
            <UsbSpeedIcon speed={usbSpeed} title={usbSpeedLabel(usbSpeed)} />
            <span>{device.label}</span>
            <small>{device.ready ? t("deviceReady") : t("deviceFound")}</small>
          </button>
        );
      })}
    </div>
  );
}
