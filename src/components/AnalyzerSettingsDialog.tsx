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
      showInDataTable: true,
      streamToTerminal: false,
    }));
  }

  const readyChannels = Array.from({ length: channelCount }, (_, index) => index).filter(
    (index) => channelEnabled[index] ?? false,
  );
  const disabledChannels = Array.from({ length: channelCount }, (_, index) => index).filter(
    (index) => !(channelEnabled[index] ?? false),
  );

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
          <AnalyzerSettingRow label="Input Channel" required>
            <select
              autoFocus
              value={draft.channel}
              onChange={(event) => setDraft((current) => ({ ...current, channel: Number(event.target.value) }))}
            >
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
          </AnalyzerSettingRow>

          {draft.type === "Async Serial" && (
            <>
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

          {!supported && <div className="analyzerDialogWarning">Decoder backend unavailable</div>}

          <AnalyzerSettingRow>
            <label className="analyzerDialogCheckbox">
              <input
                checked={draft.showInDataTable}
                onChange={() => setDraft((current) => ({ ...current, showInDataTable: !current.showInDataTable }))}
                type="checkbox"
              />
              <span>Show in protocol results table</span>
            </label>
          </AnalyzerSettingRow>
          <AnalyzerSettingRow>
            <label className="analyzerDialogCheckbox">
              <input
                checked={draft.streamToTerminal}
                onChange={() => setDraft((current) => ({ ...current, streamToTerminal: !current.streamToTerminal }))}
                type="checkbox"
              />
              <span>Stream to terminal</span>
            </label>
          </AnalyzerSettingRow>
        </div>

        <footer className="analyzerDialogFooter">
          <button className="analyzerDialogButton" onClick={reset} type="button">Reset</button>
          <div>
            <button className="analyzerDialogButton transparent" onClick={onCancel} type="button">Cancel</button>
            <button
              className="analyzerDialogButton primary"
              disabled={!supported || draft.baudRate <= 0}
              onClick={() => onSave(draft)}
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
