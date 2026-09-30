import { Download, RefreshCw } from "lucide-react";
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
            emptyLabel="No Logic device detected"
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
              Try a demo Logic device
            </button>
          )}
        </DevicePromptCard>
      </div>

      <div className="loadCaptureFile">
        <div className="loadCaptureTitle">Load a Capture File</div>
        <div className="fileChooser">
          <div className="dragDrop">
            <Download size={16} />
            Drag and drop a file here or
          </div>
          <button className="saleaePrimaryButton" onClick={onOpenCapture} type="button">
            Choose a file from your computer
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
function deviceLocation(device: DeviceInfo): string {
  const parts = [device.label];
  if (device.bus != null && device.address != null) {
    parts.push(`USB bus ${device.bus}, address ${device.address}`);
  }
  if (device.serial_number) {
    parts.push(`S/N ${device.serial_number}`);
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
  if (devices.length === 0) {
    return (
      <div className="devicePromptEmpty">
        <span>{emptyLabel}</span>
        <button className="saleaeSecondaryButton compact" disabled={busy} onClick={onRefreshDevices} type="button">
          <RefreshCw size={14} />
          Refresh
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
            title={deviceLocation(device)}
            type="button"
          >
            <UsbSpeedIcon speed={usbSpeed} title={usbSpeedLabel(usbSpeed)} />
            <span>{device.label}</span>
            <small>{device.ready ? "Ready" : "Found"}</small>
          </button>
        );
      })}
    </div>
  );
}
