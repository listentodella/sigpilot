import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { inspectHlaExtension, cancelHlaDecodes } from "../lib/api";
import { hlaUpstreamAnalyzers, validateHlaAnalyzer } from "../lib/analyzers";
import type { UiAnalyzerInstance } from "../lib/analyzers";

export function HlaSettingsDialog({ analyzer, analyzers, onCancel, onSave }: {
  analyzer: UiAnalyzerInstance;
  analyzers: UiAnalyzerInstance[];
  onCancel: () => void;
  onSave: (analyzer: UiAnalyzerInstance) => void;
}) {
  const [draft, setDraft] = useState(analyzer);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState(0);
  const hla = draft.hla!;
  const sources = hlaUpstreamAnalyzers(analyzers, draft.id);
  const validation = validateHlaAnalyzer(draft, analyzers);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    inspectHlaExtension(analyzer.hla!.manifestPath, analyzer.hla!.entryPoint).then((metadata) => {
      if (disposed) return;
      setDraft((current) => ({ ...current, hla: {
        ...current.hla!,
        settingMetadata: metadata.settings,
        settings: Object.fromEntries(metadata.settings.map((field) => [field.id,
          current.hla!.settings[field.id] ?? field.default])),
      } }));
      setLoading(false);
    }).catch((reason) => {
      if (disposed) return;
      setError(String(reason));
      setLoading(false);
    });
    return () => { disposed = true; };
  }, [analyzer, inspection]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [onCancel]);

  function updateSetting(id: string, value: unknown) {
    setDraft((current) => ({ ...current, hla: { ...current.hla!, settings: { ...current.hla!.settings, [id]: value } } }));
  }

  return <div className="analyzerDialogLayer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
    <section className="analyzerSettingsDialog" role="dialog" aria-modal="true" aria-labelledby="hla-dialog-title">
      <header className="analyzerDialogHeader">
        <div><h2 id="hla-dialog-title">{draft.name}</h2><p>High Level Analyzer</p></div>
        <button aria-label="Close" type="button" onClick={onCancel}><X size={16} /></button>
      </header>
      <div className="analyzerDialogContent">
        <p className="analyzerDialogNote">{hla.manifestPath} · {hla.entryPoint}</p>
        <label className="analyzerSettingRow"><span className="analyzerSettingLabel">Input Analyzer *</span>
          <span className="analyzerSettingControl"><select value={hla.upstreamId} onChange={(event) => {
            const source = sources.find((item) => item.id === event.target.value);
            setDraft((current) => ({ ...current, channel: source?.channel ?? current.channel,
              hla: { ...current.hla!, upstreamId: event.target.value } }));
          }}>
            <option value="">Select Saleae Native UART / I2C / SPI</option>
            {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select></span>
        </label>
        {loading && <p role="status">Loading extension settings…</p>}
        {error && <><p role="alert">{error}</p><button type="button" onClick={() => setInspection((value) => value + 1)}>Retry inspection</button></>}
        {!loading && !error && hla.settingMetadata?.map((field) => <label className="analyzerSettingRow" key={field.id}>
          <span className="analyzerSettingLabel" title={field.id}>{field.id}</span><span className="analyzerSettingControl">
          {field.kind === "choices" ? <select value={JSON.stringify(hla.settings[field.id])}
            onChange={(event) => updateSetting(field.id, JSON.parse(event.target.value))}>
            {field.choices?.map((choice) => <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>{String(choice)}</option>)}
          </select> : <input type={field.kind === "number" ? "number" : "text"}
            min={field.min} max={field.max} step="any" value={String(hla.settings[field.id] ?? "")}
            onChange={(event) => updateSetting(field.id, field.kind === "number"
              ? (event.target.value === "" ? "" : Number(event.target.value)) : event.target.value)} />}
        </span></label>)}
        {validation && <p role="alert">{validation}</p>}
        <p className="analyzerDialogNote">The input is decoded over the full capture so state is preserved while browsing. Local Python extensions execute with your user permissions; only install extensions you trust. Browser preview cannot execute Python.</p>
      </div>
      <footer className="analyzerDialogFooter">
        <button className="analyzerDialogButton" type="button" onClick={() => void cancelHlaDecodes().catch((reason) => setError(String(reason)))}>Stop HLA</button>
        <div><button className="analyzerDialogButton" type="button" onClick={onCancel}>Cancel</button>
        <button className="analyzerDialogButton primary" type="button" disabled={loading || Boolean(error) || Boolean(validation)} onClick={() => {
          const source = sources.find((item) => item.id === hla.upstreamId)!;
          onSave({ ...draft, channel: source.channel, configurationValid: true });
        }}>Save</button></div>
      </footer>
    </section>
  </div>;
}
