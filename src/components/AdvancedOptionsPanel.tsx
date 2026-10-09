import { useState } from "react";
import { useTranslation } from "react-i18next";

import { buildAdvancedSections, type AdvancedControl, type AdvancedOptionsSource } from "../lib/advancedOptions";

/**
 * Renders the advanced surface from the descriptor registry. Generic on purpose:
 * the control kinds are the only thing it knows, so a new option is a registry
 * entry rather than a new branch here.
 */
export function AdvancedOptionsPanel({
  onChangePreferences,
  onReset,
  preferences,
}: AdvancedOptionsSource & { onReset: () => void }) {
  const { t } = useTranslation("advanced");
  const sections = buildAdvancedSections({ onChangePreferences, preferences });

  return (
    <div className="advancedPanel">
      {sections.map((section) => (
        <section className="advancedSection" key={section.id}>
          <div className="advancedSectionTitle">{t(section.labelKey)}</div>
          {section.controls.map((control) => (
            <AdvancedRow control={control} key={control.id} />
          ))}
        </section>
      ))}
      <button className="advancedResetButton" onClick={onReset} type="button">
        {t("resetAll")}
      </button>
    </div>
  );
}

function AdvancedRow({ control }: { control: AdvancedControl }) {
  const { t } = useTranslation("advanced");
  const inputId = `advanced-${control.id}`;
  const label = t(control.labelKey);
  const hint = t(control.hintKey);

  return (
    <div className="advancedRow">
      <label className="advancedRowLabel" htmlFor={inputId} title={hint}>
        {label}
      </label>
      {control.kind === "toggle" ? (
        <input
          checked={control.get()}
          id={inputId}
          type="checkbox"
          onChange={(event) => control.set(event.target.checked)}
        />
      ) : (
        <NumberInput control={control} inputId={inputId} />
      )}
    </div>
  );
}

/**
 * Number fields keep a local draft while typing: applying an out-of-range value
 * mid-keystroke would fight the user (typing "20" would clamp to 3 before they
 * finish), so only in-range values apply live and the field snaps back on blur.
 */
function NumberInput({
  control,
  inputId,
}: {
  control: Extract<AdvancedControl, { kind: "number" }>;
  inputId: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const stored = control.get();

  return (
    <input
      id={inputId}
      max={control.max}
      min={control.min}
      step={control.step}
      type="number"
      value={draft ?? String(stored)}
      onBlur={() => setDraft(null)}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = Number(event.target.value);
        if (Number.isFinite(next) && next >= control.min && next <= control.max) {
          control.set(next);
        }
      }}
    />
  );
}
