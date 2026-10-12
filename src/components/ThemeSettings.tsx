import { useTranslation } from "react-i18next";
import { listUiThemes } from "../lib/themes";

export function ThemeSettings({
  themeId,
  onChange,
  disabled = false,
}: {
  themeId: string;
  onChange: (themeId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <section className="themeSettings" data-testid="theme-settings">
      <h3>{t("sectionTheme")}</h3>
      <label className="themeSettingsField">
        <span>{t("theme")}</span>
        <select
          aria-label={t("theme")}
          disabled={disabled}
          value={themeId}
          onChange={(event) => onChange(event.target.value)}
        >
          {listUiThemes().map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
