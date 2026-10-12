import { X } from "lucide-react";
import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ThemeSettings } from "./ThemeSettings";
import type { UiPreferences } from "../lib/preferences";
import { CustomThemeEditor, type ThemePreview } from "./CustomThemeEditor";
import { createCustomTheme, customThemeDefinition, type ThemeChannelContext, type ThemeLibrary } from "../lib/customThemes";
import { getUiTheme } from "../lib/themes";

interface PreferencesDialogProps {
  onChange: (preferences: UiPreferences) => void;
  onClose: () => void;
  preferences: UiPreferences;
  themeLibrary: ThemeLibrary;
  channelContext: ThemeChannelContext | null;
  onSaveThemes: (library: ThemeLibrary, themeId: string) => void;
  onPreviewTheme: (preview: ThemePreview | null) => void;
}

export function PreferencesDialog({ onChange, onClose, preferences, themeLibrary, channelContext, onSaveThemes, onPreviewTheme }: PreferencesDialogProps) {
  const { t } = useTranslation("settings");
  const dialogRef = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  // A fixed, readable editor frame remains usable even for low-contrast drafts.
  const [editorStyle] = useState(() => customThemeDefinition(createCustomTheme(getUiTheme("saleae-dark"))).cssVars as CSSProperties);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Tab") {
        const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])
          .filter((node) => node.getClientRects().length > 0);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, []);

  function update(patch: Partial<UiPreferences>) {
    onChange({ ...preferences, ...patch });
  }

  return (
    <div
      className="preferencesBackdrop"
      data-testid="preferences-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        aria-labelledby="preferences-title"
        aria-modal="true"
        className="preferencesDialog"
        style={editorStyle}
        data-testid="preferences-dialog"
        role="dialog"
      >
        <header className="preferencesHeader">
          <h2 id="preferences-title">{t("dialogTitle")}</h2>
          <button aria-label={t("closeDialog")} onClick={onClose} title={t("close")} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>
        <div className="preferencesContent">
          <ThemeSettings
            themeId={preferences.themeId}
            onChange={(themeId) => update({ themeId })}
            disabled={editing}
          />
          <CustomThemeEditor
            key={preferences.themeId}
            themeId={preferences.themeId}
            library={themeLibrary}
            channelContext={channelContext}
            onSave={onSaveThemes}
            onPreview={onPreviewTheme}
            onEditingChange={setEditing}
          />

          <PreferenceSection title={t("sectionChannel")}>
            <PreferenceCheckbox
              checked={preferences.matchChannelColors}
              label={t("matchChannelColors")}
              onChange={(checked) => update({ matchChannelColors: checked })}
              tooltip={t("matchChannelColorsHint")}
            />
          </PreferenceSection>

          <PreferenceSection title={t("sectionCaptureEnd")}>
            <PreferenceCheckbox
              checked={preferences.panToTrigger}
              label={t("panToTrigger")}
              onChange={(checked) => update({ panToTrigger: checked })}
            />
          </PreferenceSection>

          <PreferenceSection title={t("sectionSave")}>
            <PreferenceCheckbox
              checked={preferences.renameTabToSavedCapture}
              label={t("renameTabToSavedCapture")}
              onChange={(checked) => update({ renameTabToSavedCapture: checked })}
            />
          </PreferenceSection>
        </div>
      </section>
    </div>
  );
}

function PreferenceSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="preferencesSection">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function PreferenceCheckbox({
  checked,
  label,
  onChange,
  tooltip,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  tooltip?: string;
}) {
  return (
    <label className="preferencesCheckbox" title={tooltip}>
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}
