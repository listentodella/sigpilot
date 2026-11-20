import { Activity, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CaptureSettings } from "../lib/api";
import type { UiAnalyzerInstance } from "../lib/analyzers";
import { buildProtocolTrigger, protocolTriggerDecoder, ProtocolTriggerValidationError, type UiAnalyzerTriggerState } from "../lib/protocolTrigger";

export function ProtocolTriggerPanel({ state, onChange, analyzers, settings, disabled, desktop }: {
  state: UiAnalyzerTriggerState;
  onChange: (patch: Partial<UiAnalyzerTriggerState>) => void;
  analyzers: UiAnalyzerInstance[];
  settings: CaptureSettings;
  disabled: boolean;
  desktop: boolean;
}) {
  const { t } = useTranslation("analyzers");
  const available = analyzers.filter((analyzer) => protocolTriggerDecoder(analyzer) !== null);
  const selected = available.find((analyzer) => analyzer.id === state.analyzerId);
  const decoder = selected && protocolTriggerDecoder(selected);
  const locked = disabled || !desktop;
  let error = "";
  try { buildProtocolTrigger(state, analyzers, settings, desktop); }
  catch (value) { error = value instanceof ProtocolTriggerValidationError ? t(`protocolTriggerError.${value.code}`) : String(value); }

  return (
    <section className={`analyzerTriggerView ${state.expanded ? "expanded" : ""}`}>
      <div className="analyzerTriggerHeader">
        <button aria-expanded={state.expanded} className="analyzerTriggerExpandButton" type="button"
          onClick={() => onChange({ expanded: !state.expanded })}>
          <ChevronRight size={11} /><strong>{t("protocolTriggerTitle")}</strong><Activity size={11} />
        </button>
        <label className={`saleaeSwitch analyzerTriggerSwitch ${state.enabled ? "checked" : ""}`}>
          <input aria-label={t("enableAnalyzerTrigger")} type="checkbox" checked={state.enabled} disabled={locked}
            onChange={(event) => onChange({ enabled: event.target.checked, expanded: event.target.checked || state.expanded,
              analyzerId: selected?.id ?? available[0]?.id ?? "" })} />
          <span className="saleaeSwitchTrack"><span className="saleaeSwitchHandle" /></span>
        </label>
      </div>
      {state.expanded && <div className="analyzerTriggerBody">
        <p className="protocolTriggerHint">{t(desktop ? "protocolTriggerIntro" : "protocolTriggerError.desktopOnly")}</p>
        <label className="stack-field"><span>{t("analyzer")}</span>
          <select disabled={locked || available.length === 0} value={selected?.id ?? ""}
            onChange={(event) => onChange({ analyzerId: event.target.value })}>
            <option value="">{t("selectAnalyzer")}</option>
            {available.map((analyzer) => <option key={analyzer.id} value={analyzer.id}>{analyzer.name}</option>)}
          </select>
        </label>
        {available.length === 0 && <p className="protocolTriggerHint">{t("protocolTriggerAddAnalyzer")}</p>}
        {decoder?.protocol === "I2c" ? <>
          <div className="analyzerTriggerQueryGrid">
            <label className="stack-field"><span>{t("protocolTriggerAddress")}</span>
              <input disabled={locked} placeholder={t("protocolTriggerAny")} value={state.i2cAddress} maxLength={4}
                onChange={(event) => onChange({ i2cAddress: event.target.value })} />
            </label>
            <label className="stack-field"><span>{t("protocolTriggerEvent")}</span>
              <select disabled={locked} value={state.i2cEvent}
                onChange={(event) => onChange({ i2cEvent: event.target.value as UiAnalyzerTriggerState["i2cEvent"] })}>
                <option value="nack">NACK</option><option value="address">{t("protocolTriggerAddressEvent")}</option>
                <option value="data">{t("protocolTriggerDataEvent")}</option>
              </select>
            </label>
          </div>
          {state.i2cEvent !== "address" && <label className="stack-field"><span>{t("protocolTriggerData")}</span>
            <input disabled={locked} placeholder={t("protocolTriggerAny")} value={state.i2cData} maxLength={4}
              onChange={(event) => onChange({ i2cData: event.target.value })} />
          </label>}
          <p className="protocolTriggerHint">{t("protocolTriggerI2cHint")}</p>
        </> : decoder ? <>
          {decoder.protocol === "Spi" && <label className="stack-field"><span>{t("protocolTriggerLine")}</span>
            <select disabled={locked} value={state.spiLine}
              onChange={(event) => onChange({ spiLine: event.target.value as "mosi" | "miso" })}>
              <option value="mosi">MOSI</option><option value="miso">MISO</option>
            </select>
          </label>}
          <label className="stack-field"><span>{t("protocolTriggerSequence")}</span>
            <input disabled={locked} placeholder="AA 55 01" value={state.query} maxLength={704}
              onChange={(event) => onChange({ query: event.target.value })} />
          </label>
          <p className="protocolTriggerHint">{t("protocolTriggerSequenceHint")}</p>
        </> : null}
        <div className="analyzerTriggerQueryGrid">
          <label className="stack-field"><span>{t("protocolTriggerBefore")}</span>
            <input disabled={locked} type="number" min={0} max={60_000} step={1} value={state.preTriggerMs}
              onChange={(event) => onChange({ preTriggerMs: Number(event.target.value) })} />
          </label>
          <label className="stack-field"><span>{t("protocolTriggerAfter")}</span>
            <input disabled={locked} type="number" min={0} max={60_000} step={1} value={state.postTriggerMs}
              onChange={(event) => onChange({ postTriggerMs: Number(event.target.value) })} />
          </label>
        </div>
        <label className="stack-field"><span>{t("protocolTriggerWait")}</span>
          <input disabled={locked} type="number" min={1} max={3_600_000} step={1} value={state.maxWaitMs}
            onChange={(event) => onChange({ maxWaitMs: Number(event.target.value) })} />
        </label>
        <p className="protocolTriggerHint">{t("protocolTriggerBudgetHint")}</p>
        {error && <p className="protocolTriggerError" role="alert">{error}</p>}
      </div>}
    </section>
  );
}
