import {
  ANIMATION_SCALE_MAX,
  ANIMATION_SCALE_MIN,
  type UiPreferences,
} from "./preferences";

// The advanced surface is DATA, not bespoke JSX: one descriptor per control, so
// adding an option is one entry and the renderer never changes. This follows the
// shape of the homage project's hidden developer panel, which drives a whole
// surface from a small `Tool = Button | Switch | Number | Dropdown` union.
//
// Values are read and written through `get`/`set` closures over the preferences
// state, so the panel stays presentational and every control applies live.
//
// Only options that actually exist are listed. Options that would need a feature
// built first (grid-line toggle, waveform line width, backend log level) are
// deliberately absent -- see the P1.5 list rather than adding dead controls.
export type AdvancedControl =
  | {
      kind: "toggle";
      id: string;
      labelKey: string;
      hintKey: string;
      get: () => boolean;
      set: (value: boolean) => void;
    }
  | {
      kind: "number";
      id: string;
      labelKey: string;
      hintKey: string;
      get: () => number;
      set: (value: number) => void;
      min: number;
      max: number;
      step: number;
    };

export interface AdvancedSection {
  id: string;
  labelKey: string;
  controls: AdvancedControl[];
}

export interface AdvancedOptionsSource {
  preferences: UiPreferences;
  onChangePreferences: (updater: (current: UiPreferences) => UiPreferences) => void;
}

export function buildAdvancedSections({
  preferences,
  onChangePreferences,
}: AdvancedOptionsSource): AdvancedSection[] {
  const setPreference = <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) =>
    onChangePreferences((current) => ({ ...current, [key]: value }));

  return [
    {
      id: "display",
      labelKey: "sectionDisplay",
      controls: [
        {
          kind: "toggle",
          id: "showGridLines",
          labelKey: "gridLines",
          hintKey: "gridLinesHint",
          get: () => preferences.showGridLines,
          set: (value) => setPreference("showGridLines", value),
        },
        {
          kind: "toggle",
          id: "matchChannelColors",
          labelKey: "matchChannelColors",
          hintKey: "matchChannelColorsHint",
          get: () => preferences.matchChannelColors,
          set: (value) => setPreference("matchChannelColors", value),
        },
      ],
    },
    {
      id: "behavior",
      labelKey: "sectionBehavior",
      controls: [
        {
          kind: "toggle",
          id: "panToTrigger",
          labelKey: "panToTrigger",
          hintKey: "panToTriggerHint",
          get: () => preferences.panToTrigger,
          set: (value) => setPreference("panToTrigger", value),
        },
        {
          kind: "toggle",
          id: "renameTabToSavedCapture",
          labelKey: "renameTabToSavedCapture",
          hintKey: "renameTabToSavedCaptureHint",
          get: () => preferences.renameTabToSavedCapture,
          set: (value) => setPreference("renameTabToSavedCapture", value),
        },
      ],
    },
    {
      id: "performance",
      labelKey: "sectionPerformance",
      controls: [
        {
          kind: "number",
          id: "animationScale",
          labelKey: "animationScale",
          hintKey: "animationScaleHint",
          get: () => preferences.animationScale,
          set: (value) => setPreference("animationScale", value),
          min: ANIMATION_SCALE_MIN,
          max: ANIMATION_SCALE_MAX,
          step: 0.1,
        },
      ],
    },
  ];
}
