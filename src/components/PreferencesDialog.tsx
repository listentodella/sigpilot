import { X } from "lucide-react";
import { ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { UiPreferences } from "../lib/preferences";

interface PreferencesDialogProps {
  onChange: (preferences: UiPreferences) => void;
  onClose: () => void;
  preferences: UiPreferences;
}

export function PreferencesDialog({ onChange, onClose, preferences }: PreferencesDialogProps) {
  const { t } = useTranslation("settings");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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
        aria-labelledby="preferences-title"
        aria-modal="true"
        className="preferencesDialog"
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
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}
