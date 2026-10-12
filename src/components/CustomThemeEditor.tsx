import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SEMANTIC_COLOR_FIELDS, contrastRatio, createCustomTheme, customThemeDefinition,
  exportCustomTheme, importCustomTheme, isThemeHex, validateCustomTheme,
  type ChannelOverrides, type CustomTheme, type ThemeChannelContext, type ThemeLibrary,
} from "../lib/customThemes";
import { channelColorForTheme, getUiTheme, type UiThemeDefinition } from "../lib/themes";

export interface ThemePreview {
  theme: UiThemeDefinition;
  channelOverrides: ChannelOverrides;
}
interface Props {
  themeId: string;
  library: ThemeLibrary;
  channelContext: ThemeChannelContext | null;
  onSave: (library: ThemeLibrary, themeId: string) => void;
  onPreview: (preview: ThemePreview | null) => void;
  onEditingChange: (editing: boolean) => void;
}

export function CustomThemeEditor({ themeId, library, channelContext, onSave, onPreview, onEditingChange }: Props) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState<CustomTheme | null>(null);
  const [overrides, setOverrides] = useState<ChannelOverrides>(library.channelOverrides);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedCustom = library.themes.find((theme) => theme.id === themeId);
  const profile = channelContext?.profileId ?? "";
  const currentOverrides = overrides[profile] ?? {};
  const definition = draft ? customThemeDefinition(draft) : getUiTheme(themeId);

  useEffect(() => {
    onPreview(draft && previewEnabled ? { theme: customThemeDefinition(draft), channelOverrides: overrides } : null);
  }, [draft, overrides, previewEnabled, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);
  useEffect(() => { onEditingChange(!!draft); }, [draft, onEditingChange]);

  function begin(theme: CustomTheme) {
    setOverrides(library.channelOverrides);
    setDraft({ ...theme, colors: { ...theme.colors }, channelColors: [...theme.channelColors] });
    setError(""); setNotice("");
  }
  function cancel() {
    setDraft(null); setError(""); setNotice(""); onPreview(null);
  }
  function changeOverride(id: string, color: string | null) {
    const next = { ...currentOverrides };
    if (color === null) delete next[id]; else next[id] = color;
    setOverrides({ ...overrides, [profile]: next });
  }
  function apply() {
    if (!draft) return;
    try {
      const valid = validateCustomTheme(draft);
      onSave({ ...library, themes: [...library.themes.filter((theme) => theme.id !== draft.id), valid], channelOverrides: overrides }, valid.id);
      setDraft(null); onPreview(null); setError(""); setNotice(t("editor.saved"));
    } catch (reason) { setError(`${t("editor.saveFailed")} ${String(reason instanceof Error ? reason.message : reason)}`); }
  }
  function remove() {
    if (!selectedCustom || !window.confirm(t("editor.confirmDelete", { name: selectedCustom.label }))) return;
    try {
      onSave({ ...library, themes: library.themes.filter((theme) => theme.id !== selectedCustom.id) }, selectedCustom.baseThemeId);
      setNotice(t("editor.deleted")); setError("");
    } catch (reason) { setError(`${t("editor.saveFailed")} ${String(reason)}`); }
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 256_000) throw new Error(t("editor.fileTooLarge"));
      const imported = importCustomTheme(await file.text());
      const theme = imported.themes[0];
      // Import as a new draft; never overwrite an existing theme silently.
      const id = createCustomTheme(getUiTheme(theme.baseThemeId)).id;
      setDraft({ ...theme, id });
      setOverrides(Object.fromEntries([...new Set([...Object.keys(library.channelOverrides), ...Object.keys(imported.channelOverrides)])]
        .map((key) => [key, { ...library.channelOverrides[key], ...imported.channelOverrides[key] }])));
      setError(""); setNotice(t("editor.imported"));
    } catch (reason) { setError(`${t("editor.importFailed")} ${String(reason instanceof Error ? reason.message : reason)}`); }
  }
  function download() {
    try {
      const theme = draft ?? selectedCustom ?? createCustomTheme(getUiTheme(themeId));
      const payload = exportCustomTheme(theme, draft ? overrides : library.channelOverrides);
      const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `${theme.id}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(`${t("editor.exportFailed")} ${String(reason)}`); }
  }

  const channels = channelContext?.channels.filter((channel) =>
    `${channel.id} ${channel.label}`.toLowerCase().includes(query.toLowerCase()) &&
    (filter === "all" || (filter === "enabled" && channel.enabled) || (filter === "overrides" && currentOverrides[channel.id]) || channel.id.startsWith(filter)),
  ) ?? [];
  const warnings = draft ? [
    ...(contrastRatio(draft.colors.textPrimary, draft.colors.panel) < 4.5 ? [t("editor.textContrast")] : []),
    ...(draft.channelColors.some((color) => contrastRatio(color, draft.colors.waveBackground) < 3) ||
      Object.values(currentOverrides).some((color) => contrastRatio(color, draft.colors.waveBackground) < 3) ? [t("editor.waveContrast")] : []),
  ] : [];

  return (
    <section className="customThemeEditor" data-testid="custom-theme-editor">
      <div className="themeEditorActions">
        <button type="button" disabled={!!draft} onClick={() => {
          const copy = createCustomTheme(getUiTheme(themeId));
          begin(selectedCustom ? { ...selectedCustom, id: copy.id, label: copy.label, colors: { ...selectedCustom.colors }, channelColors: [...selectedCustom.channelColors] } : copy);
        }}>{t("editor.copy")}</button>
        {selectedCustom && <>
          <button type="button" disabled={!!draft} onClick={() => begin(selectedCustom)}>{t("editor.edit")}</button>
          <button type="button" disabled={!!draft} onClick={remove}>{t("editor.delete")}</button>
        </>}
        <button type="button" disabled={!!draft} onClick={() => fileRef.current?.click()}>{t("editor.import")}</button>
        <button type="button" onClick={download}>{t("editor.export")}</button>
        <input hidden type="file" accept=".json,application/json" ref={fileRef} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ""; void importFile(file);
        }} />
      </div>
      {error && <p role="alert" className="themeEditorError">{error}</p>}
      {notice && <p role="status" className="themeEditorHint">{notice}</p>}
      {!draft && <p className="themeEditorHint">{t("editor.startHint")}</p>}
      {draft && <>
        <div className="themeEditorIdentity">
          <label>{t("editor.name")}<input aria-label={t("editor.name")} maxLength={80} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
          <label className="preferencesCheckbox"><input type="checkbox" checked={previewEnabled} onChange={(event) => setPreviewEnabled(event.target.checked)} />{t("editor.livePreview")}</label>
        </div>
        <p className="themeEditorHint">{t("editor.draftHint")}</p>
        <div className="themePreview" style={{ background: draft.colors.waveBackground, color: draft.colors.waveText, borderColor: draft.colors.borderStrong }} aria-label={t("editor.preview")}>
          <div className="themePreviewToolbar" style={{ background: draft.colors.panel, color: draft.colors.textPrimary }}>
            <span>{draft.label || t("editor.name")}</span><span style={{ color: draft.colors.success }}>● {t("editor.ready")}</span>
          </div>
          {Array.from({ length: 3 }, (_, index) => {
            const color = currentOverrides[`D${index}`] ?? draft.channelColors[index];
            return <div className="themePreviewSignal" key={index} style={{ borderColor: draft.colors.separator }}>
              <span style={{ color }}>D{index}</span>
              <svg viewBox="0 0 300 30" aria-hidden="true">
                <path d="M0 15 H300" stroke={draft.colors.gridPrimary} />
                <path d="M0 24 H40 V6 H95 V24 H160 V6 H220 V24 H300" fill="none" stroke={color} strokeWidth="2" />
                <path d="M130 0 V30" stroke={draft.colors.cursor} strokeDasharray="3 3" />
              </svg>
            </div>;
          })}
          <div style={{ color: draft.colors.measurement }}>{t("editor.measurementPreview")}</div>
        </div>
        {warnings.length > 0 && <div role="status" className="themeEditorWarning">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
        {(["surfaces", "text", "accents", "states", "waveform"] as const).map((group) => <details key={group} open={group === "surfaces"}>
          <summary>{t(`editor.groups.${group}`)}</summary>
          <div className="themeColorGrid">{SEMANTIC_COLOR_FIELDS.filter((field) => field.group === group).map((field) =>
            <ColorField key={field.key} label={t(`editor.colors.${field.key}`)} value={draft.colors[field.key]}
              onChange={(color) => setDraft({ ...draft, colors: { ...draft.colors, [field.key]: color } })} />,
          )}</div>
        </details>)}
        <details open>
          <summary>{t("editor.palette")}</summary>
          <p className="themeEditorHint">{t("editor.paletteHint")}</p>
          <div className="themeColorGrid">{draft.channelColors.map((color, index) => <ColorField key={index}
            label={`D${index} / D${index + 8} / D${index + 16}…`} value={color}
            onChange={(next) => setDraft({ ...draft, channelColors: draft.channelColors.map((item, slot) => slot === index ? next : item) })} />)}</div>
        </details>
        <details>
          <summary>{t("editor.overrides")} ({Object.keys(currentOverrides).length})</summary>
          {!channelContext ? <p className="themeEditorHint">{t("editor.noDevice")}</p> : <>
            <p className="themeEditorHint">{channelContext.label} · {t("editor.overrideHint")}</p>
            <div className="themeEditorFilters">
              <input aria-label={t("editor.search")} placeholder={t("editor.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
              <select aria-label={t("editor.filter")} value={filter} onChange={(event) => setFilter(event.target.value)}>
                {["all", "enabled", "overrides", "D", "A"].map((value) => <option key={value} value={value}>{t(`editor.filters.${value}`)}</option>)}
              </select>
            </div>
            <div className="themeEditorActions">
              <button type="button" disabled={!Object.keys(currentOverrides).length} onClick={() => {
                if (window.confirm(t("editor.confirmClear"))) setOverrides({ ...overrides, [profile]: {} });
              }}>{t("editor.clearOverrides")}</button>
              <button type="button" disabled={!channels.length} onClick={() => {
                if (!window.confirm(t("editor.confirmExpand"))) return;
                setOverrides({ ...overrides, [profile]: { ...currentOverrides, ...Object.fromEntries(channels.map((channel) =>
                  [channel.id, currentOverrides[channel.id] ?? channelColorForTheme(definition, Number(channel.id.slice(1)))])) } });
              }}>{t("editor.expand")}</button>
            </div>
            <div className="themeChannelList">{channels.map((channel) => <div key={channel.id} className="themeChannelRow">
              <ColorField label={`${channel.id} ${channel.label === channel.id ? "" : channel.label}`} value={currentOverrides[channel.id] ?? channelColorForTheme(definition, Number(channel.id.slice(1)))}
                onChange={(color) => changeOverride(channel.id, color)} />
              <span className="themeEditorHint">{t(currentOverrides[channel.id] ? "editor.independent" : "editor.inherited")}{!channel.enabled ? ` · ${t("editor.disabled")}` : ""}</span>
              <button type="button" disabled={!currentOverrides[channel.id]} onClick={() => changeOverride(channel.id, null)}>{t("editor.inherit")}</button>
            </div>)}</div>
            {!channels.length && <p className="themeEditorHint">{t("editor.noResults")}</p>}
          </>}
        </details>
        <div className="themeEditorFooter">
          <button type="button" onClick={() => {
            if (window.confirm(t("editor.confirmReset"))) {
              const reset = createCustomTheme(getUiTheme(draft.baseThemeId), draft.id);
              setDraft({ ...reset, label: draft.label });
            }
          }}>{t("editor.reset")}</button>
          <button type="button" onClick={cancel}>{t("editor.cancel")}</button>
          <button className="themeEditorApply" type="button" disabled={!draft.label.trim()} onClick={apply}>{t("editor.apply")}</button>
        </div>
      </>}
    </section>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  const { t } = useTranslation("settings");
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = isThemeHex(text);
  return <div className="themeColorField">
    <span>{label}</span>
    <div>
      <input type="color" aria-label={label} value={value} onChange={(event) => { setText(event.target.value); onChange(event.target.value); }} />
      <input type="text" aria-label={`${label} HEX`} aria-invalid={!valid} title={!valid ? t("editor.invalidHex") : undefined} maxLength={7} value={text}
        onChange={(event) => { setText(event.target.value); if (isThemeHex(event.target.value)) onChange(event.target.value.toLowerCase()); }}
        onBlur={() => { if (!valid) setText(value); }} />
    </div>
  </div>;
}
