import { Download, RefreshCw, Usb } from "lucide-react";
import logicDarkTheme from "../assets/saleae/logicDarkTheme.png";
import logicMsoDarkTheme from "../assets/saleae/logicMsoDarkTheme.png";
import { DeviceInfo } from "../lib/api";

interface DeviceStartScreenProps {
  busy: boolean;
  devices: DeviceInfo[];
  selectedDevice: string;
  onOpenCapture: () => void;
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onStartWithDevice: (deviceId: string) => void;
}

export function DeviceStartScreen({
  busy,
  devices,
  selectedDevice,
  onOpenCapture,
  onRefreshDevices,
  onSelectDevice,
  onStartWithDevice,
}: DeviceStartScreenProps) {
  const physicalDevices = devices.filter((device) => device.kind === "Usb");
  const demoDevices = devices.filter((device) => device.kind === "Fake");
  const selectedDemo = demoDevices.find((device) => device.id === selectedDevice) ?? demoDevices[0];

  return (
    <div className="sessionPlaceholder">
      <div className="devicePrompts">
        <DevicePromptCard deviceName="Logic MSO" imageSrc={logicMsoDarkTheme}>
          <DeviceList
            busy={busy}
            devices={physicalDevices}
            emptyLabel="No Logic MSO detected"
            onRefreshDevices={onRefreshDevices}
            onSelectDevice={onSelectDevice}
            onStartWithDevice={onStartWithDevice}
            selectedDevice={selectedDevice}
          />
        </DevicePromptCard>

        <DevicePromptCard deviceName="Logic" imageSrc={logicDarkTheme}>
          <DeviceList
            busy={busy}
            devices={physicalDevices}
            emptyLabel="No Logic device detected"
            onRefreshDevices={onRefreshDevices}
            onSelectDevice={onSelectDevice}
            onStartWithDevice={onStartWithDevice}
            selectedDevice={selectedDevice}
          />
          {selectedDemo && (
            <button
              className="saleaeSecondaryButton demoDeviceButton"
              disabled={busy}
              onClick={() => onStartWithDevice(selectedDemo.id)}
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
  deviceName: string;
  imageSrc: string;
}

function DevicePromptCard({ children, deviceName, imageSrc }: DevicePromptCardProps) {
  return (
    <section className="devicePrompt connect">
      <img alt="" src={imageSrc} />
      <div className="devicePromptTitle">Connect {deviceName}</div>
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
  onSelectDevice: (deviceId: string) => void;
  onStartWithDevice: (deviceId: string) => void;
}

function DeviceList({
  busy,
  devices,
  emptyLabel,
  selectedDevice,
  onRefreshDevices,
  onSelectDevice,
  onStartWithDevice,
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
        return (
          <button
            className={`realDeviceOption ${isSelected ? "selected" : ""}`}
            disabled={busy}
            key={device.id}
            onClick={() => {
              onSelectDevice(device.id);
              onStartWithDevice(device.id);
            }}
            type="button"
          >
            <Usb size={14} />
            <span>{device.label}</span>
            <small>{device.ready ? "Ready" : "Found"}</small>
          </button>
        );
      })}
    </div>
  );
}
