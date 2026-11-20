import type { AnalyzerDecodeSettings, CaptureSettings, CaptureSummary } from "./api.ts";
import { restoreSaleaeAnalyzer, type UiAnalyzerInstance } from "./analyzers.ts";

export interface McpCaptureStartedEvent {
  session_id: string;
  settings: CaptureSettings;
  analyzers: AnalyzerDecodeSettings[];
}
export interface McpCaptureFinishedEvent {
  session_id: string;
  summary: CaptureSummary | null;
  error: string | null;
}

/** Keep the agent's exact wire settings when opening its capture in the GUI. */
export function mcpCaptureAnalyzers(sessionId: string, settings: AnalyzerDecodeSettings[]): UiAnalyzerInstance[] {
  return settings.reduce<UiAnalyzerInstance[]>((analyzers, decoder, index) => {
    const type = decoder.protocol === "Uart" ? "Async Serial" : decoder.protocol === "I2c" ? "I2C" : decoder.protocol === "Spi" ? "SPI" : null;
    if (!type) return analyzers;
    const analyzer = restoreSaleaeAnalyzer({
      type, name: type, color: "", display_radix: "hexadecimal", show_in_data_table: true,
      stream_to_terminal: false, decoder_backend: "saleae_native", decode_settings: decoder,
      saleae_metadata: { uiAnalyzerId: `${sessionId}-analyzer-${index}` },
    }, analyzers);
    return [...analyzers, analyzer];
  }, []);
}
