import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UiAnalyzerInstance } from "../lib/analyzers";
import {
  analyzerBackendOptions,
  analyzerSupportsDecoding,
  createAnalyzerInstance,
  decoderBackendLabel,
} from "../lib/analyzers";
import { saleaeLegacyChannelColor } from "../lib/saleaeChannelColors";
import { SaleaeIcon } from "./SaleaeIcon";

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
    setDraft((current) => {
      const defaults = createAnalyzerInstance(current.type, [], 0, current.decoderBackend);
      return {
        ...current,
        channel: 0,
        baudRate: 115_200,
        inverted: false,
        uartDataBits: 8,
        uartStopBits: 1,
        uartParity: "none",
        uartMsbFirst: false,
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
        nativeDecoderId: defaults.nativeDecoderId,
        nativeProtocolName: defaults.nativeProtocolName,
        nativePrimaryChannel: defaults.nativePrimaryChannel,
        nativeChannels: defaults.nativeChannels,
        nativeOptions: defaults.nativeOptions,
        showInDataTable: true,
        streamToTerminal: false,
      };
    });
  }

  function save() {
    if (!supported || validationError) return;
    onSave({
      ...draft,
      configurationValid: true,
      channel:
        draft.type === "I2C"
          ? draft.i2cSdaChannel
          : draft.type === "SPI"
            ? draft.spiMosiChannel ?? draft.spiMisoChannel ?? draft.spiClockChannel
            : draft.type === "I2S"
              ? draft.nativeChannels.sd ?? draft.nativePrimaryChannel
              : draft.type === "LIN"
                ? draft.nativeChannels.rx ?? draft.nativePrimaryChannel
                : draft.type === "CAN" || draft.type === "CAN-FD"
                ? draft.nativeChannels.can_rx ?? draft.nativePrimaryChannel
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
              <AnalyzerSettingRow label="Bits per Frame" required>
                <input
                  max={9}
                  min={5}
                  step={1}
                  type="number"
                  value={draft.uartDataBits}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, uartDataBits: Number(event.target.value) }))
                  }
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Stop Bits">
                <select
                  value={draft.uartStopBits}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, uartStopBits: Number(event.target.value) }))
                  }
                >
                  <option value={1}>1 Stop Bit</option>
                  <option value={1.5}>1.5 Stop Bits</option>
                  <option value={2}>2 Stop Bits</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Parity Bit">
                <select
                  value={draft.uartParity}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      uartParity: event.target.value as typeof current.uartParity,
                    }))
                  }
                >
                  <option value="none">No Parity</option>
                  <option value="even">Even Parity</option>
                  <option value="odd">Odd Parity</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Significant Bit">
                <select
                  value={draft.uartMsbFirst ? "msb" : "lsb"}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, uartMsbFirst: event.target.value === "msb" }))
                  }
                >
                  <option value="lsb">Least Significant Bit First</option>
                  <option value="msb">Most Significant Bit First</option>
                </select>
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

          {draft.type === "I2S" && (
            <>
              <AnalyzerSettingRow label="CLOCK channel" required>
                <ChannelSelect
                  {...channelSelectProps}
                  autoFocus
                  onChange={(channel) =>
                    setDraft((current) => ({
                      ...current,
                      nativePrimaryChannel: channel ?? 0,
                      nativeChannels: { ...current.nativeChannels, sck: channel ?? 0 },
                    }))
                  }
                  value={draft.nativeChannels.sck ?? 0}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="FRAME" required>
                <ChannelSelect
                  {...channelSelectProps}
                  onChange={(channel) =>
                    setDraft((current) => ({
                      ...current,
                      nativeChannels: { ...current.nativeChannels, ws: channel ?? 0 },
                    }))
                  }
                  value={draft.nativeChannels.ws ?? 0}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="DATA" required>
                <ChannelSelect
                  {...channelSelectProps}
                  onChange={(channel) =>
                    setDraft((current) => ({
                      ...current,
                      nativeChannels: { ...current.nativeChannels, sd: channel ?? 0 },
                    }))
                  }
                  value={draft.nativeChannels.sd ?? 0}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="DATA Significant Bit">
                <select
                  value={String(draft.nativeOptions.bit_order)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, bit_order: event.target.value },
                    }))
                  }
                >
                  <option value="msb-first">Most Significant Bit Sent First</option>
                  <option value="lsb-first">Least Significant Bit Sent First</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="CLOCK State">
                <select
                  value={String(draft.nativeOptions.clk_edge)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, clk_edge: event.target.value },
                    }))
                  }
                >
                  <option value="falling-edge">Falling edge</option>
                  <option value="rising-edge">Rising edge</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Audio Bit Depth (bits/sample)" required>
                <input
                  max={draft.decoderBackend === "saleae_native" ? 64 : 32}
                  min={2}
                  step={1}
                  type="number"
                  value={Number(draft.nativeOptions.word_size)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, word_size: Number(event.target.value) },
                    }))
                  }
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="FRAME Signal Transitions">
                <select
                  value={String(draft.nativeOptions.frame_transitions)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, frame_transitions: event.target.value },
                    }))
                  }
                >
                  <option value="twice-each-word">Twice each word</option>
                  <option value="once-each-word">Once each word (I2S, PCM standard)</option>
                  <option value="twice-every-4-words">Twice every 4 words</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="DATA Bits Alignment">
                <select
                  value={String(draft.nativeOptions.bit_align)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, bit_align: event.target.value },
                    }))
                  }
                >
                  <option value="left-aligned">Left aligned</option>
                  <option value="right-aligned">Right aligned</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="DATA Bits Shift">
                <select
                  value={String(draft.nativeOptions.bit_shift)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, bit_shift: event.target.value },
                    }))
                  }
                >
                  <option value="right-shifted by one">Right-shifted by one (I2S typical)</option>
                  <option value="none">No shift (PCM standard)</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Signed/Unsigned">
                <select
                  value={draft.nativeOptions.signed === true ? "signed" : "unsigned"}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, signed: event.target.value === "signed" },
                    }))
                  }
                >
                  <option value="unsigned">Unsigned</option>
                  <option value="signed">Signed (two&apos;s complement)</option>
                </select>
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Word Select High">
                <select
                  value={String(draft.nativeOptions.ws_polarity)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, ws_polarity: event.target.value },
                    }))
                  }
                >
                  <option value="right-high">Channel 2 (right - I2S typical)</option>
                  <option value="left-high">Channel 1 (left - inverted)</option>
                </select>
              </AnalyzerSettingRow>
            </>
          )}

          {draft.type === "LIN" && (
            <>
              <AnalyzerSettingRow label="Serial" required>
                <ChannelSelect
                  {...channelSelectProps}
                  autoFocus
                  onChange={(channel) =>
                    setDraft((current) => ({
                      ...current,
                      nativePrimaryChannel: channel ?? 0,
                      nativeChannels: { ...current.nativeChannels, rx: channel ?? 0 },
                    }))
                  }
                  value={draft.nativeChannels.rx ?? 0}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="Bit Rate (Bits/s)" required>
                <input
                  min={1}
                  step={1}
                  type="number"
                  value={Number(draft.nativeOptions.baudrate)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, baudrate: Number(event.target.value) },
                    }))
                  }
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow label="LIN Version" required>
                <select
                  value={Number(draft.nativeOptions.version)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, version: Number(event.target.value) },
                    }))
                  }
                >
                  <option value={1}>Version 1.x</option>
                  <option value={2}>Version 2.x</option>
                </select>
              </AnalyzerSettingRow>
            </>
          )}

          {(draft.type === "CAN" || draft.type === "CAN-FD") && (
            <>
              <AnalyzerSettingRow label={draft.type === "CAN" ? "CAN" : "CAN FD"} required>
                <ChannelSelect
                  {...channelSelectProps}
                  autoFocus
                  onChange={(channel) =>
                    setDraft((current) => ({
                      ...current,
                      nativePrimaryChannel: channel ?? 0,
                      nativeChannels: { ...current.nativeChannels, can_rx: channel ?? 0 },
                    }))
                  }
                  value={draft.nativeChannels.can_rx ?? 0}
                />
              </AnalyzerSettingRow>
              <AnalyzerSettingRow
                label={draft.type === "CAN" ? "Bit Rate (Bits/s)" : "Nominal Bit Rate (Bits/s)"}
                required
              >
                <input
                  min={10_000}
                  step={1}
                  type="number"
                  value={Number(
                    draft.nativeOptions[draft.type === "CAN" ? "bitrate" : "nominal_bitrate"],
                  )}
                  onChange={(event) => {
                    const key = draft.type === "CAN" ? "bitrate" : "nominal_bitrate";
                    setDraft((current) => ({
                      ...current,
                      nativeOptions: { ...current.nativeOptions, [key]: Number(event.target.value) },
                    }));
                  }}
                />
              </AnalyzerSettingRow>
              {draft.type === "CAN-FD" && (
                <AnalyzerSettingRow label="Fast Bit Rate (Bits/s)" required>
                  <input
                    min={10_000}
                    step={1}
                    type="number"
                    value={Number(draft.nativeOptions.fast_bitrate)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        nativeOptions: { ...current.nativeOptions, fast_bitrate: Number(event.target.value) },
                      }))
                    }
                  />
                </AnalyzerSettingRow>
              )}
              {draft.decoderBackend === "sigrok_native" && (
                <AnalyzerSettingRow label="Sample Point (%)" required>
                  <input
                    max={99}
                    min={1}
                    step={1}
                    type="number"
                    value={Number(draft.nativeOptions.sample_point)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        nativeOptions: { ...current.nativeOptions, sample_point: Number(event.target.value) },
                      }))
                    }
                  />
                </AnalyzerSettingRow>
              )}
              {draft.type === "CAN" && (
                <AnalyzerSettingRow>
                  <label className="analyzerDialogCheckbox">
                    <input
                      checked={draft.nativeOptions.inverted === true}
                      onChange={() =>
                        setDraft((current) => ({
                          ...current,
                          nativeOptions: {
                            ...current.nativeOptions,
                            inverted: current.nativeOptions.inverted !== true,
                          },
                        }))
                      }
                      type="checkbox"
                    />
                    <span>Inverted (CAN High)</span>
                  </label>
                </AnalyzerSettingRow>
              )}
            </>
          )}

          <AnalyzerSettingRow label="Decoder Library">
            <select
              value={draft.decoderBackend}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  decoderBackend: event.target.value as typeof current.decoderBackend,
                }))
              }
            >
              {draft.decoderBackend === "legacy_rust" && (
                <option disabled value="legacy_rust">
                  {decoderBackendLabel("legacy_rust")}
                </option>
              )}
              {analyzerBackendOptions(draft.type).map((backend) => (
                <option key={backend} value={backend}>
                  {decoderBackendLabel(backend)}
                </option>
              ))}
            </select>
          </AnalyzerSettingRow>

          {!supported && <div className="analyzerDialogWarning">Decoder backend unavailable</div>}
          {validationError && <div className="analyzerDialogWarning">{validationError}</div>}

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
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const readyChannels = useMemo(
    () =>
      Array.from({ length: channelCount }, (_, index) => index).filter(
        (index) => channelEnabled[index] ?? false,
      ),
    [channelCount, channelEnabled],
  );
  const disabledChannels = useMemo(
    () =>
      Array.from({ length: channelCount }, (_, index) => index).filter(
        (index) => !(channelEnabled[index] ?? false),
      ),
    [channelCount, channelEnabled],
  );

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => buttonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function choose(channel: number | null) {
    onChange(channel);
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  return (
    <div className="analyzerChannelDropdown">
      <button
        aria-expanded={open}
        className={`analyzerChannelDropdownButton ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={buttonRef}
        type="button"
      >
        {value === null ? (
          <span className="analyzerChannelOptionText">None</span>
        ) : (
          <ChannelOptionContent
            capturedChannelCount={capturedChannelCount}
            channel={value}
            channelLabels={channelLabels}
          />
        )}
        <SaleaeIcon className="analyzerChannelDropdownCaret" name="arrowHead" />
      </button>
      {open && (
        <div className="analyzerChannelDropdownMenu" ref={menuRef} role="listbox">
          {optional && (
            <ChannelOptionButton
              label="None"
              onClick={() => choose(null)}
              selected={value === null}
            />
          )}
          {readyChannels.map((channel) => (
            <ChannelOptionButton
              capturedChannelCount={capturedChannelCount}
              channel={channel}
              channelLabels={channelLabels}
              key={channel}
              onClick={() => choose(channel)}
              selected={value === channel}
            />
          ))}
          {disabledChannels.length > 0 && (
            <>
              <div className="analyzerChannelDropdownGroup">Disabled Channels</div>
              {disabledChannels.map((channel) => (
                <ChannelOptionButton
                  channel={channel}
                  channelLabels={channelLabels}
                  key={channel}
                  onClick={() => choose(channel)}
                  selected={value === channel}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelOptionButton({
  capturedChannelCount = 0,
  channel,
  channelLabels = [],
  label,
  onClick,
  selected,
}: {
  capturedChannelCount?: number;
  channel?: number;
  channelLabels?: string[];
  label?: string;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-selected={selected}
      className={`analyzerChannelDropdownOption ${selected ? "selected" : ""}`}
      onClick={onClick}
      role="option"
      type="button"
    >
      {channel === undefined ? (
        <span className="analyzerChannelOptionText">{label}</span>
      ) : (
        <ChannelOptionContent
          capturedChannelCount={capturedChannelCount}
          channel={channel}
          channelLabels={channelLabels}
        />
      )}
      {selected && <SaleaeIcon className="analyzerChannelDropdownCheck" name="checkmark" />}
    </button>
  );
}

function ChannelOptionContent({
  capturedChannelCount,
  channel,
  channelLabels,
}: {
  capturedChannelCount: number;
  channel: number;
  channelLabels: string[];
}) {
  const name = channelLabels[channel] ?? `D${channel}`;
  const suffix = capturedChannelCount > 0 && channel >= capturedChannelCount ? " (empty)" : "";
  return (
    <span className="analyzerChannelOptionContent">
      <span
        className="analyzerChannelOptionSwatch"
        style={{ background: saleaeLegacyChannelColor(channel) }}
      />
      <span className="analyzerChannelOptionText">{name}{suffix}</span>
    </span>
  );
}

function validateAnalyzer(analyzer: UiAnalyzerInstance) {
  if (analyzer.type === "Async Serial") {
    if (analyzer.baudRate <= 0) return "Bit rate must be greater than zero.";
    if (analyzer.uartDataBits < 5 || analyzer.uartDataBits > 9) {
      return "Sigrok Native supports 5 to 9 data bits.";
    }
    if (![1, 1.5, 2].includes(analyzer.uartStopBits)) return "Select a supported stop-bit value.";
  }
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
  if (analyzer.type === "I2S") {
    const assigned = [
      analyzer.nativeChannels.sck,
      analyzer.nativeChannels.ws,
      analyzer.nativeChannels.sd,
    ].filter((channel): channel is number => channel !== null && channel !== undefined);
    if (assigned.length !== 3 || new Set(assigned).size !== assigned.length) {
      return "CLOCK, FRAME, and DATA must use different channels.";
    }
    const wordSize = Number(analyzer.nativeOptions.word_size);
    const maximumWordSize = analyzer.decoderBackend === "saleae_native" ? 64 : 32;
    if (!Number.isInteger(wordSize) || wordSize < 2 || wordSize > maximumWordSize) {
      return `Audio bit depth must be between 2 and ${maximumWordSize} bits.`;
    }
  }
  if (analyzer.type === "LIN") {
    if (typeof analyzer.nativeChannels.rx !== "number") return "Select a LIN serial channel.";
    const bitRate = Number(analyzer.nativeOptions.baudrate);
    if (!Number.isInteger(bitRate) || bitRate <= 0) return "Bit rate must be greater than zero.";
    const version = Number(analyzer.nativeOptions.version);
    if (version !== 1 && version !== 2) return "Select LIN Version 1.x or 2.x.";
  }
  if (analyzer.type === "CAN" || analyzer.type === "CAN-FD") {
    if (typeof analyzer.nativeChannels.can_rx !== "number") return "Select a CAN input channel.";
    const nominal = Number(
      analyzer.nativeOptions[analyzer.type === "CAN" ? "bitrate" : "nominal_bitrate"],
    );
    if (!Number.isInteger(nominal) || nominal < 10_000) return "Bit rate must be at least 10,000 bits/s.";
    if (analyzer.type === "CAN" && analyzer.decoderBackend === "saleae_native" && nominal > 25_000_000) {
      return "Saleae CAN bit rate must not exceed 25,000,000 bits/s.";
    }
    if (analyzer.type === "CAN-FD") {
      const fast = Number(analyzer.nativeOptions.fast_bitrate);
      if (!Number.isInteger(fast) || fast < 10_000) return "Fast bit rate must be at least 10,000 bits/s.";
    }
    if (analyzer.decoderBackend === "sigrok_native") {
      const samplePoint = Number(analyzer.nativeOptions.sample_point);
      if (!Number.isFinite(samplePoint) || samplePoint <= 0 || samplePoint >= 100) {
        return "Sample point must be between 0 and 100 percent.";
      }
    }
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
