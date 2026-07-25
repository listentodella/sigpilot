import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYZER_CATALOG_GROUPS,
  analyzerBackendOptions,
  decoderBackendLabel,
  restoreSaleaeAnalyzer,
} from "../src/lib/analyzers.ts";

test("new analyzers are offered only through external decoder ecosystems", () => {
  assert.deepEqual(
    ANALYZER_CATALOG_GROUPS.map((group) => group.backend),
    ["saleae_native", "sigrok_native"],
  );
  assert.deepEqual(analyzerBackendOptions("Async Serial"), ["saleae_native", "sigrok_native"]);
  assert.deepEqual(analyzerBackendOptions("I2C"), ["saleae_native", "sigrok_native"]);
  assert.deepEqual(analyzerBackendOptions("SPI"), ["saleae_native", "sigrok_native"]);
  assert.equal(
    ANALYZER_CATALOG_GROUPS.some((group) => group.analyzers.includes("Manchester")),
    false,
  );
});

test("legacy Rust metadata remains readable without becoming a creation option", () => {
  const restored = restoreSaleaeAnalyzer(
    {
      type: "Serial",
      name: "Imported UART",
      color: "#7EA0F8",
      display_radix: "Hexadecimal",
      show_in_data_table: true,
      stream_to_terminal: false,
      decoder_backend: "legacy_rust",
      decode_settings: {
        protocol: "Uart",
        settings: {
          channel: 2,
          baud_rate: 115_200,
          inverted: false,
          data_bits: 8,
          stop_bits: 1,
          parity: "none",
          msb_first: false,
        },
      },
    },
    [],
  );

  assert.equal(restored.decoderBackend, "legacy_rust");
  assert.equal(restored.channel, 2);
  assert.equal(analyzerBackendOptions(restored.type).includes("legacy_rust"), false);
  assert.equal(decoderBackendLabel("legacy_rust"), "Legacy Rust (compatibility only)");
});
