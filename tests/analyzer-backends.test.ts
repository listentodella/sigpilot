import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYZER_CATALOG_GROUPS,
  analyzerBackendOptions,
  analyzerCanRunDecoder,
  analyzerChannelRoles,
  analyzerDecodeSettings,
  analyzerSupportsDecoding,
  createAnalyzerInstanceFromSigrokCatalog,
  createAnalyzerInstance,
  decoderBackendLabel,
  formatAnalyzerText,
  formatAnalyzerValue,
  normalizeAnalyzerDisplayRadix,
  restoreSaleaeAnalyzer,
  sigrokCatalogDetailName,
  sigrokCatalogDisplayName,
} from "../src/lib/analyzers.ts";

test("new analyzers are offered only through external decoder ecosystems", () => {
  assert.deepEqual(
    ANALYZER_CATALOG_GROUPS.map((group) => group.backend),
    ["saleae_native", "sigrok_native"],
  );
  assert.deepEqual(analyzerBackendOptions("Async Serial"), ["saleae_native", "sigrok_native"]);
  assert.deepEqual(analyzerBackendOptions("I2C"), ["saleae_native", "sigrok_native"]);
  assert.deepEqual(analyzerBackendOptions("SPI"), ["saleae_native", "sigrok_native"]);
  assert.deepEqual(analyzerBackendOptions("Simple Parallel"), ["saleae_native", "sigrok_native"]);
  assert.equal(
    ANALYZER_CATALOG_GROUPS.every((group) => group.analyzers.includes("Simple Parallel")),
    true,
  );
  assert.equal(
    ANALYZER_CATALOG_GROUPS.some((group) => group.analyzers.includes("Manchester")),
    false,
  );
});

test("generic sigrok C catalog analyzers keep schema and run through the sparse runner", () => {
  const qspi = createAnalyzerInstanceFromSigrokCatalog(
    {
      id: "qspi_c",
      name: "Smart QSPI(C)",
      longname: "Quad Serial Peripheral Interface (C)",
      desc: "Quad SPI decoder",
      license: "gplv2+",
      kind: "c",
      runner_status: "generic_sparse_c",
      inputs: ["logic"],
      outputs: ["spi"],
      tags: ["Embedded/industrial"],
      channels: [
        { id: "clk", name: "CLK", desc: "Clock", order: 0, type: 0, type_name: "clock" },
        { id: "io0", name: "IO0", desc: "Data i/o 0", order: 1, type: 1, type_name: "serial_data" },
      ],
      optional_channels: [
        { id: "io1", name: "IO1", desc: "Data i/o 1", order: 2, type: 1, type_name: "serial_data" },
        { id: "cs", name: "CS#", desc: "Chip-select", order: 3, type: -1, type_name: "common" },
      ],
      options: [
        { id: "cs_polarity", desc: "CS# polarity", value_type: "s", default: "active-low", values: ["active-low", "active-high"] },
        { id: "cpol", desc: "Clock polarity", value_type: "x", default: 0, values: [] },
      ],
    },
    [],
    4,
  );

  assert.equal(qspi.type, "Smart QSPI");
  assert.equal(qspi.decoderBackend, "sigrok_native");
  assert.equal(qspi.nativeDecoderId, "qspi_c");
  assert.deepEqual(qspi.nativeChannels, { clk: 4, io0: 5, io1: null, cs: null });
  assert.deepEqual(qspi.nativeOptions, { cs_polarity: "active-low", cpol: 0 });
  assert.equal(analyzerSupportsDecoding(qspi), true);
  assert.equal(analyzerCanRunDecoder(qspi), true);
  assert.deepEqual(analyzerChannelRoles(qspi).map((role) => [role.channel, role.title]), [
    [4, "CLK"],
    [5, "IO0"],
  ]);
  assert.deepEqual(analyzerDecodeSettings(qspi), {
    protocol: "Native",
    settings: {
      decoder_id: "qspi_c",
      protocol_name: "Smart QSPI",
      channels: { clk: 4, io0: 5, io1: null, cs: null },
      options: { cs_polarity: "active-low", cpol: 0 },
      primary_channel: 4,
    },
  });
});

test("direct-input sigrok Python analyzers use the sparse Python runner", () => {
  const pwm = createAnalyzerInstanceFromSigrokCatalog(
    {
      id: "pwm",
      name: "PWM",
      longname: "Pulse-width modulation",
      desc: "Analog level encoded in duty cycle percentage.",
      license: "gplv2+",
      kind: "python",
      runner_status: "generic_sparse_python",
      inputs: ["logic"],
      outputs: [],
      tags: ["Encoding"],
      channels: [
        { id: "data", name: "Data", desc: "Data line", order: 0, type: -1, type_name: "common" },
      ],
      optional_channels: [],
      options: [
        {
          id: "polarity",
          desc: "Polarity",
          value_type: "s",
          default: "active-high",
          values: ["active-low", "active-high"],
        },
      ],
    },
    [],
    3,
  );

  assert.equal(pwm.type, "PWM");
  assert.equal(pwm.nativeDecoderId, "python:pwm");
  assert.equal(pwm.nativeProtocolName, "PWM");
  assert.equal(analyzerCanRunDecoder(pwm), true);
  assert.deepEqual(analyzerDecodeSettings(pwm), {
    protocol: "Native",
    settings: {
      decoder_id: "python:pwm",
      protocol_name: "PWM",
      channels: { data: 3 },
      options: { polarity: "active-high" },
      primary_channel: 3,
    },
  });
});

test("sigrok catalog display names prefer readable short protocol labels", () => {
  const qspiCatalog = {
    id: "qspi_c",
    name: "Smart QSPI(C)",
    longname: "Quad Serial Peripheral Interface (C)",
    desc: "Quad SPI decoder",
    license: "gplv2+",
    kind: "c",
    runner_status: "catalog_only",
    inputs: ["logic"],
    outputs: ["spi"],
    tags: [],
    channels: [],
    optional_channels: [],
    options: [],
  };

  assert.equal(sigrokCatalogDisplayName(qspiCatalog), "Smart QSPI");
  assert.equal(sigrokCatalogDetailName(qspiCatalog), "Quad Serial Peripheral Interface");
  assert.equal(
    sigrokCatalogDisplayName({
      ...qspiCatalog,
      id: "usb_power_delivery",
      name: null,
      longname: null,
    }),
    "usb power delivery",
  );
});

test("analyzer display radix formats decoded text without losing protocol context", () => {
  assert.equal(formatAnalyzerText("Data 0x5A ACK", "Decimal"), "Data 90 ACK");
  assert.equal(formatAnalyzerText("Setup Write to [0x50] + ACK", "Binary"), "Setup Write to [0b01010000] + ACK");
  assert.equal(formatAnalyzerText("MOSI 0xA5 / MISO 0x3C", "Ascii"), "MOSI 0xA5 / MISO '<'");
  assert.equal(formatAnalyzerValue(0x2a, "Hexadecimal"), "0x2A");
  assert.equal(normalizeAnalyzerDisplayRadix("Octal"), "Hexadecimal");
});

test("verified sigrok catalog entries still map to existing runnable analyzer defaults", () => {
  const spi = createAnalyzerInstanceFromSigrokCatalog(
    {
      id: "spi_c",
      name: "SPI(C)",
      longname: "Serial Peripheral Interface (C)",
      desc: "SPI protocol decoder",
      license: "gplv2+",
      kind: "c",
      runner_status: "verified_sparse_c",
      inputs: ["logic"],
      outputs: ["spi"],
      tags: ["Embedded/industrial"],
      channels: [],
      optional_channels: [],
      options: [],
    },
    [],
    1,
  );

  assert.equal(spi.type, "SPI");
  assert.equal(spi.nativeRunnerStatus, "verified_sparse_c");
  assert.equal(analyzerCanRunDecoder(spi), true);
  assert.equal(analyzerDecodeSettings(spi), null);

  spi.spiMosiChannel = 1;
  spi.spiClockChannel = 2;
  assert.equal(analyzerDecodeSettings(spi)?.protocol, "Spi");
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

test("native analyzer definitions drive defaults, roles, and backend choices", () => {
  const i2s = createAnalyzerInstance("I2S", [], 4, "saleae_native");
  assert.deepEqual(analyzerBackendOptions("I2S"), ["saleae_native", "sigrok_native"]);
  assert.deepEqual(analyzerChannelRoles(i2s).map((role) => [role.channel, role.title]), [
    [6, "DATA"],
    [4, "CLOCK"],
    [5, "FRAME"],
  ]);
  assert.deepEqual(analyzerDecodeSettings(i2s), {
    protocol: "Native",
    settings: {
      decoder_id: "i2s",
      protocol_name: "I2S",
      channels: { sck: 4, ws: 5, sd: 6 },
      options: {
        bit_order: "msb-first",
        clk_edge: "falling-edge",
        word_size: 16,
        frame_transitions: "once-each-word",
        bit_align: "left-aligned",
        bit_shift: "right-shifted by one",
        signed: false,
        ws_polarity: "right-high",
      },
      primary_channel: 4,
    },
  });

  const canFd = createAnalyzerInstance("CAN-FD", [], 2, "sigrok_native");
  assert.deepEqual(analyzerBackendOptions("CAN-FD"), ["sigrok_native"]);
  assert.deepEqual(analyzerChannelRoles(canFd), [
    { channel: 2, hasBubbles: true, hasMarkers: true, title: "CAN-FD" },
  ]);
});
