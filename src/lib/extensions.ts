export type UiExtensionSource = "BuiltIn" | "Local" | "Marketplace";
export type UiExtensionFeatureType = "HighLevelAnalyzer" | "DigitalMeasurement" | "AnalogMeasurement";

export interface UiExtensionFeature {
  entryPoint: string;
  metrics?: Record<string, { name: string; notation?: string; units?: string }>;
  type: UiExtensionFeatureType;
}

export interface UiExtensionManifest {
  apiVersion: string;
  author: string;
  description?: string;
  extensions: Record<string, UiExtensionFeature>;
  name: string;
  version: string;
}

export interface UiExtensionRecord {
  canUpdate: boolean;
  enabled: boolean;
  id: string;
  installed: boolean;
  localPath?: string;
  manifest: UiExtensionManifest;
  marketplaceId?: number;
  readme?: string;
  repository?: string;
  source: UiExtensionSource;
}

export interface UiExtensionTemplateRequest {
  author: string;
  description: string;
  name: string;
  path: string;
  type: UiExtensionFeatureType;
}

export interface UiExtensionPackage {
  manifest: UiExtensionManifest;
  path: string;
  readme?: string;
}

const EXTENSIONS_STORAGE_KEY = "pxlogic.extensions.v1";

const builtInExtensions: UiExtensionRecord[] = [
  {
    canUpdate: false,
    enabled: true,
    id: "builtin-clock-statistics",
    installed: true,
    manifest: {
      apiVersion: "1.0.0",
      author: "Saleae",
      description: "Measures frequency, period, duty cycle, and pulse widths for digital clocks.",
      extensions: {
        "Clock Statistics": {
          entryPoint: "ClockStatistics.ClockStatistics",
          type: "DigitalMeasurement",
        },
      },
      name: "Clock Statistics",
      version: "1.0.0",
    },
    readme:
      "# Clock Statistics\n\nBuilt-in digital measurements for clock frequency, period, duty cycle, and pulse width.",
    source: "BuiltIn",
  },
  {
    canUpdate: false,
    enabled: true,
    id: "builtin-voltage-statistics",
    installed: true,
    manifest: {
      apiVersion: "1.0.0",
      author: "Saleae",
      description: "Provides common voltage statistics for analog captures.",
      extensions: {
        "Voltage Statistics": {
          entryPoint: "VoltageStatistics.VoltageStatistics",
          type: "AnalogMeasurement",
        },
      },
      name: "Voltage Statistics",
      version: "1.0.0",
    },
    readme: "# Voltage Statistics\n\nBuilt-in analog measurements for minimum, maximum, average, and RMS voltage.",
    source: "BuiltIn",
  },
  {
    canUpdate: false,
    enabled: true,
    id: "marketplace-saleae-measurements-v2",
    installed: false,
    manifest: {
      apiVersion: "1.1.0",
      author: "shy coder",
      description: "Saleae built-in V2 Measurements",
      extensions: {},
      name: "Saleae Measurements V2",
      version: "0.0.3",
    },
    marketplaceId: 1000,
    readme:
      "# Saleae Measurements V2\n\nAn extension package for digital and analog measurements using the Logic 2 extension API.",
    repository: "https://github.com/saleae/saleae-measurements-v2",
    source: "Marketplace",
  },
];

export function defaultUiExtensions(): UiExtensionRecord[] {
  return builtInExtensions.map(cloneExtension);
}

export function loadUiExtensions(): UiExtensionRecord[] {
  if (typeof window === "undefined") return defaultUiExtensions();
  try {
    const stored = window.localStorage.getItem(EXTENSIONS_STORAGE_KEY);
    if (!stored) return defaultUiExtensions();
    const parsed = JSON.parse(stored) as UiExtensionRecord[];
    if (!Array.isArray(parsed)) return defaultUiExtensions();
    const records = parsed.filter(isUiExtensionRecord).map(cloneExtension);
    return records.length > 0 ? records : defaultUiExtensions();
  } catch {
    return defaultUiExtensions();
  }
}

export function saveUiExtensions(extensions: UiExtensionRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(EXTENSIONS_STORAGE_KEY, JSON.stringify(extensions));
}

export function extensionRecordFromPackage(extensionPackage: UiExtensionPackage): UiExtensionRecord {
  return {
    canUpdate: false,
    enabled: true,
    id: `local-${extensionPackage.path}`,
    installed: true,
    localPath: extensionPackage.path,
    manifest: extensionPackage.manifest,
    readme: extensionPackage.readme,
    source: "Local",
  };
}

export function sortUiExtensions(extensions: UiExtensionRecord[]) {
  const sourceOrder: Record<UiExtensionSource, number> = {
    Local: 0,
    BuiltIn: 1,
    Marketplace: 2,
  };
  return [...extensions].sort((left, right) => {
    const leftInstalled = left.source === "Marketplace" && left.installed ? 0 : 1;
    const rightInstalled = right.source === "Marketplace" && right.installed ? 0 : 1;
    return (
      sourceOrder[left.source] - sourceOrder[right.source] ||
      leftInstalled - rightInstalled ||
      left.manifest.name.localeCompare(right.manifest.name, undefined, { sensitivity: "base" })
    );
  });
}

export function extensionFeatureLabel(type: UiExtensionFeatureType) {
  if (type === "HighLevelAnalyzer") return "High Level Analyzer";
  if (type === "DigitalMeasurement") return "Digital Measurement";
  return "Analog Measurement";
}

function cloneExtension(extension: UiExtensionRecord): UiExtensionRecord {
  return {
    ...extension,
    manifest: {
      ...extension.manifest,
      extensions: Object.fromEntries(
        Object.entries(extension.manifest.extensions).map(([name, feature]) => [
          name,
          {
            ...feature,
            metrics: feature.metrics
              ? Object.fromEntries(Object.entries(feature.metrics).map(([key, metric]) => [key, { ...metric }]))
              : undefined,
          },
        ]),
      ),
    },
  };
}

function isUiExtensionRecord(value: unknown): value is UiExtensionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<UiExtensionRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.installed === "boolean" &&
    typeof record.enabled === "boolean" &&
    Boolean(record.manifest) &&
    typeof record.manifest?.name === "string" &&
    (record.source === "BuiltIn" || record.source === "Local" || record.source === "Marketplace")
  );
}
