import { CircleHelp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function CaptureNotesPanel({
  notes,
  onChange,
}: {
  notes: string;
  onChange: (notes: string) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const { t } = useTranslation("notes");

  return (
    <div className="captureNotesWrapper">
      <header className="captureNotesHeader">
        <strong>{t("title")}</strong>
        <button
          aria-label={t("about")}
          className={helpOpen ? "active" : ""}
          onClick={() => setHelpOpen((open) => !open)}
          type="button"
        >
          <CircleHelp size={15} />
        </button>
        {helpOpen && <div className="captureNotesHelp">{t("help")}</div>}
      </header>
      <textarea
        aria-label={t("fieldLabel")}
        className="captureNotesTextArea"
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t("placeholder")}
        value={notes}
      />
    </div>
  );
}
