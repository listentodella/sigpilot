export type SidebarPanel =
  | "devices"
  | "recordingSettings"
  | "analyzers"
  | "cursors"
  | "measurements"
  | "timingMarkers"
  | "extensions"
  | "notes";

export const SIDEBAR_PANELS: SidebarPanel[] = [
  "devices",
  "recordingSettings",
  "analyzers",
  "cursors",
  "measurements",
  "timingMarkers",
  "extensions",
  "notes",
];

export const SidebarCommands = {
  OpenAnalyzers: "sidebar:open:analyzers",
  OpenCursors: "sidebar:open:cursors",
  OpenDeviceSettings: "sidebar:open:device-settings",
  OpenExtensions: "sidebar:open:extensions",
  OpenMeasurements: "sidebar:open:measurements",
  OpenNotes: "sidebar:open:notes",
  OpenTimingMarkers: "sidebar:open:timing-markers",
  CloseSidebar: "sidebar:close",
} as const;

export const MeasurementCommands = {
  AddRange: "advancedMeasurements:add-range",
} as const;

export const MarkerCommands = {
  AddMarker: "markers:add-marker",
  AddPair: "markers:add-pair",
} as const;

export const AnalyzerCommands = {
  AddAnalyzer: "analyzers:add-analyzer",
} as const;

export type UiCommand =
  | (typeof SidebarCommands)[keyof typeof SidebarCommands]
  | (typeof MeasurementCommands)[keyof typeof MeasurementCommands]
  | (typeof MarkerCommands)[keyof typeof MarkerCommands]
  | (typeof AnalyzerCommands)[keyof typeof AnalyzerCommands];

export interface CommandPayload {
  analyzerName?: string;
}

export const SIDEBAR_COMMAND_TO_PANEL: Partial<Record<UiCommand, SidebarPanel>> = {
  [SidebarCommands.OpenAnalyzers]: "analyzers",
  [SidebarCommands.OpenCursors]: "cursors",
  [SidebarCommands.OpenDeviceSettings]: "devices",
  [SidebarCommands.OpenExtensions]: "extensions",
  [SidebarCommands.OpenMeasurements]: "measurements",
  [SidebarCommands.OpenNotes]: "notes",
  [SidebarCommands.OpenTimingMarkers]: "timingMarkers",
};

export const SIDEBAR_PANEL_SHORTCUTS: Record<SidebarPanel, string> = {
  devices: "N D",
  recordingSettings: "",
  analyzers: "N A",
  cursors: "N C",
  measurements: "N M",
  timingMarkers: "N T",
  extensions: "N E",
  notes: "N N",
};

export const SIDEBAR_SHORTCUT_TO_COMMAND: Record<string, UiCommand> = {
  a: SidebarCommands.OpenAnalyzers,
  c: SidebarCommands.OpenCursors,
  d: SidebarCommands.OpenDeviceSettings,
  e: SidebarCommands.OpenExtensions,
  m: SidebarCommands.OpenMeasurements,
  n: SidebarCommands.OpenNotes,
  q: SidebarCommands.CloseSidebar,
  t: SidebarCommands.OpenTimingMarkers,
};
