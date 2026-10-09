import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { buildAdvancedSections, type AdvancedControl, type AdvancedOptionsSource } from "../lib/advancedOptions";
import { HelpHint } from "./HelpHint";

/**
 * Renders the advanced surface from the descriptor registry. Generic on purpose:
 * the control kinds are the only thing it knows, so a new option is a registry
 * entry rather than a new branch here.
 *
 * Sections collapse so a long list stays manageable; every option carries a "?"
 * affordance because a bare label rarely explains what a knob does.
 */
export function AdvancedOptionsPanel({
  onChangePreferences,
  onReset,
  preferences,
}: AdvancedOptionsSource & { onReset: () => void }) {
  const { t } = useTranslation("advanced");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const sections = buildAdvancedSections({ onChangePreferences, preferences });

  return (
    <div className="advancedPanel">
      {sections.map((section) => {
        const isCollapsed = Boolean(collapsed[section.id]);
        return (
          <section className="advancedSection" key={section.id}>
            <button
              aria-expanded={!isCollapsed}
              className="advancedSectionTitle"
              onClick={() => setCollapsed((current) => ({ ...current, [section.id]: !isCollapsed }))}
              type="button"
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span>{t(section.labelKey)}</span>
            </button>
            {isCollapsed
              ? null
              : section.controls.map((control) => <AdvancedRow control={control} key={control.id} />)}
          </section>
        );
      })}
      <button className="advancedResetButton" onClick={onReset} type="button">
        {t("resetAll")}
      </button>
    </div>
  );
}

function AdvancedRow({ control }: { control: AdvancedControl }) {
  const { t } = useTranslation("advanced");
  const inputId = `advanced-${control.id}`;

  return (
    <div className="advancedRow">
      <label className="advancedRowLabel" htmlFor={inputId}>
        {t(control.labelKey)}
      </label>
      <span className="advancedRowEnd">
        <HelpHint text={t(control.hintKey)} />
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
      </span>
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
