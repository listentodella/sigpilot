import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { UiAnalyzerInstance } from "../lib/analyzers";
import { analyzerSupportsDecoding } from "../lib/analyzers";

interface AnalyzerSettingsDialogProps {
  analyzer: UiAnalyzerInstance;
  capturedChannelCount: number;
  channelEnabled: boolean[];
  channelLabels: string[];
  onCancel: () => void;
  onSave: (analyzer: UiAnalyzerInstance) => void;
}

export function AnalyzerSettingsDialog({
  analyzer,
  capturedChannelCount,
  channelEnabled,
  channelLabels,
  onCancel,
  onSave,
}: AnalyzerSettingsDialogProps) {
  const [draft, setDraft] = useState(analyzer);
  const supported = analyzerSupportsDecoding(draft);
  const channelCount = Math.max(1, channelLabels.length, channelEnabled.length);
  const validationError = validateAnalyzer(draft);

  useEffect(() => setDraft(analyzer), [analyzer]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  function reset() {
    setDraft((current) => ({
      ...current,
      channel: 0,
      baudRate: 115_200,
      inverted: false,
      i2cSdaChannel: 1,
      i2cSclChannel: 2,
      spiMosiChannel: 3,
      spiMisoChannel: 4,
      spiClockChannel: 5,
      spiEnableChannel: 6,
      spiEnableActiveLow: true,
      spiClockPolarity: false,
      spiClockPhase: false,
      spiBitsPerTransfer: 8,
      spiMsbFirst: true,
      showInDataTable: true,
      streamToTerminal: false,
    }));
  }

  function save() {
    if (!supported || validationError) return;
    onSave({
      ...draft,
      channel:
        draft.type === "I2C"
          ? draft.i2cSdaChannel
          : draft.type === "SPI"
            ? draft.spiMosiChannel ?? draft.spiMisoChannel ?? draft.spiClockChannel
            : draft.channel,
    });
  }

  const channelSelectProps = { capturedChannelCount, channelCount, channelEnabled, channelLabels };

  return (
    <div className="analyzerDialogLayer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="analyzerSettingsDialog" role="dialog" aria-modal="true" aria-labelledby="analyzer-dialog-title">
        <header className="analyzerDialogHeader">
          <div>
            <h2 id="analyzer-dialog-title">{draft.name}</h2>
            <p>{draft.type}</p>
          </div>
          <button aria-label="Close" onClick={onCancel} title="Close" type="button">
            <X size={16} />
          </button>
        </header>

        <div className="analyzerDialogContent">
          {draft.type === "Async Serial" && (
            <>
              <AnalyzerSettingRow label="Input Channel" required>
                <ChannelSelect
                  {...channelSelectProps}
                  autoFocus
                  onChange={(channel) => setDraft((current) => ({ ...current, channel: channel ?? 0 }))}
                  value={draft.channel}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Bit Rate (Bits/s)" required>
                <input
                  min={1}
                  step={1}
                  type="number"
                  value={draft.baudRate}
                  onChange={(event) => setDraft((current) => ({ ...current, baudRate: Number(event.target.value) }))}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Signal inversion">
                <select
                  value={draft.inverted ? "inverted" : "standard"}
                  onChange={(event) => setDraft((current) => ({ ...current, inverted: event.target.value === "inverted" }))}
                >
                  <option value="standard">Non Inverted</option>
                  <option value="inverted">Inverted</option>
                </select>
              </AnalyzerSettingRow>
            </>
          )}

          {draft.type === "I2C" && (
            <>
              <AnalyzerSettingRow label="SDA" required>
                <ChannelSelect
                  {...channelSelectProps}
                  autoFocus
                  onChange={(channel) => setDraft((current) => ({ ...current, i2cSdaChannel: channel ?? 0 }))}
                  value={draft.i2cSdaChannel}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="SCL" required>
                <ChannelSelect
                  {...channelSelectProps}
                  onChange={(channel) => setDraft((current) => ({ ...current, i2cSclChannel: channel ?? 0 }))}
                  value={draft.i2cSclChannel}
                />
              </AnalyzerSettingRow>
              <div className="analyzerDialogNote">
                I2C addresses are displayed as 7-bit numbers.
              </div>
            </>
          )}

          {draft.type === "SPI" && (
            <>
              <AnalyzerSettingRow label="MOSI">
                <ChannelSelect
                  {...channelSelectProps}
                  autoFocus
                  optional
                  onChange={(channel) => setDraft((current) => ({ ...current, spiMosiChannel: channel }))}
                  value={draft.spiMosiChannel}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="MISO">
                <ChannelSelect
                  {...channelSelectProps}
                  optional
                  onChange={(channel) => setDraft((current) => ({ ...current, spiMisoChannel: channel }))}
                  value={draft.spiMisoChannel}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Clock" required>
                <ChannelSelect
                  {...channelSelectProps}
                  onChange={(channel) => setDraft((current) => ({ ...current, spiClockChannel: channel ?? 0 }))}
                  value={draft.spiClockChannel}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Enable">
                <ChannelSelect
                  {...channelSelectProps}
                  optional
                  onChange={(channel) => setDraft((current) => ({ ...current, spiEnableChannel: channel }))}
                  value={draft.spiEnableChannel}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Enable Line">
                <select
                  value={draft.spiEnableActiveLow ? "low" : "high"}
                  onChange={(event) => setDraft((current) => ({ ...current, spiEnableActiveLow: event.target.value === "low" }))}
                >
                  <option value="low">Active Low</option>
                  <option value="high">Active High</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Clock State">
                <select
                  value={draft.spiClockPolarity ? "high" : "low"}
                  onChange={(event) => setDraft((current) => ({ ...current, spiClockPolarity: event.target.value === "high" }))}
                >
                  <option value="low">Idle Low (CPOL = 0)</option>
                  <option value="high">Idle High (CPOL = 1)</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Clock Phase">
                <select
                  value={draft.spiClockPhase ? "trailing" : "leading"}
                  onChange={(event) => setDraft((current) => ({ ...current, spiClockPhase: event.target.value === "trailing" }))}
                >
                  <option value="leading">Leading Edge (CPHA = 0)</option>
                  <option value="trailing">Trailing Edge (CPHA = 1)</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Bits per Transfer" required>
                <input
                  max={64}
                  min={1}
                  step={1}
                  type="number"
                  value={draft.spiBitsPerTransfer}
                  onChange={(event) => setDraft((current) => ({ ...current, spiBitsPerTransfer: Number(event.target.value) }))}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Significant Bit">
                <select
                  value={draft.spiMsbFirst ? "msb" : "lsb"}
                  onChange={(event) => setDraft((current) => ({ ...current, spiMsbFirst: event.target.value === "msb" }))}
                >
                  <option value="msb">Most Significant Bit First</option>
                  <option value="lsb">Least Significant Bit First</option>
                </select>
              </AnalyzerSettingRow>
            </>
          )}

          {!supported && <div className="analyzerDialogWarning">Decoder backend unavailable</div>}
          {validationError && <div className="analyzerDialogWarning">{validationError}</div>}

          <AnalyzerSettingRow>
            <label className="analyzerDialogCheckbox">
              <input
                checked={draft.showInDataTable}
                onChange={() => setDraft((current) => ({ ...current, showInDataTable: !current.showInDataTable }))}
                type="checkbox"
              />
              <span>Show in Data Table</span>
            </label>
          </AnalyzerSettingRow>
          <AnalyzerSettingRow>
            <label className="analyzerDialogCheckbox">
              <input
                checked={draft.streamToTerminal}
                onChange={() => setDraft((current) => ({ ...current, streamToTerminal: !current.streamToTerminal }))}
                type="checkbox"
              />
              <span>Stream to Terminal</span>
            </label>
          </AnalyzerSettingRow>
        </div>

        <footer className="analyzerDialogFooter">
          <button className="analyzerDialogButton" onClick={reset} type="button">Reset</button>
          <div>
            <button className="analyzerDialogButton transparent" onClick={onCancel} type="button">Cancel</button>
            <button
              className="analyzerDialogButton primary"
              disabled={!supported || Boolean(validationError)}
              onClick={save}
              type="button"
            >
              Save
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ChannelSelect({
  autoFocus = false,
  capturedChannelCount,
  channelCount,
  channelEnabled,
  channelLabels,
  onChange,
  optional = false,
  value,
}: {
  autoFocus?: boolean;
  capturedChannelCount: number;
  channelCount: number;
  channelEnabled: boolean[];
  channelLabels: string[];
  onChange: (channel: number | null) => void;
  optional?: boolean;
  value: number | null;
}) {
  const readyChannels = Array.from({ length: channelCount }, (_, index) => index).filter(
    (index) => channelEnabled[index] ?? false,
  );
  const disabledChannels = Array.from({ length: channelCount }, (_, index) => index).filter(
    (index) => !(channelEnabled[index] ?? false),
  );
  return (
    <select
      autoFocus={autoFocus}
      value={value === null ? "none" : value}
      onChange={(event) => onChange(event.target.value === "none" ? null : Number(event.target.value))}
    >
      {optional && <option value="none">None</option>}
      {readyChannels.map((channel) => (
        <option key={channel} value={channel}>
          {channelLabels[channel] ?? `D${channel}`}{capturedChannelCount > 0 && channel >= capturedChannelCount ? " (empty)" : ""}
        </option>
      ))}
      {disabledChannels.length > 0 && (
        <optgroup label="Disabled Channels">
          {disabledChannels.map((channel) => (
            <option key={channel} value={channel}>
              {channelLabels[channel] ?? `D${channel}`}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function validateAnalyzer(analyzer: UiAnalyzerInstance) {
  if (analyzer.type === "Async Serial" && analyzer.baudRate <= 0) return "Bit rate must be greater than zero.";
  if (analyzer.type === "I2C" && analyzer.i2cSdaChannel === analyzer.i2cSclChannel) {
    return "SDA and SCL must use different channels.";
  }
  if (analyzer.type === "SPI") {
    if (analyzer.spiMosiChannel === null && analyzer.spiMisoChannel === null) {
      return "Select at least one data channel (MOSI or MISO).";
    }
    if (analyzer.spiBitsPerTransfer < 1 || analyzer.spiBitsPerTransfer > 64) {
      return "Bits per transfer must be between 1 and 64.";
    }
    const assigned = [
      analyzer.spiMosiChannel,
      analyzer.spiMisoChannel,
      analyzer.spiClockChannel,
      analyzer.spiEnableChannel,
    ].filter((channel): channel is number => channel !== null);
    if (new Set(assigned).size !== assigned.length) return "SPI inputs must use different channels.";
  }
  return "";
}

function AnalyzerSettingRow({
  children,
  label,
  required = false,
}: {
  children: React.ReactNode;
  label?: string;
  required?: boolean;
}) {
  return (
    <div className="analyzerSettingRow">
      <span className="analyzerSettingLabel">{label ? `${label}${required ? " *" : ""}` : ""}</span>
      <span className="analyzerSettingControl">{children}</span>
    </div>
  );
}
