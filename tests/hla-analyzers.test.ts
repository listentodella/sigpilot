import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzerCatalogChoiceKey, analyzerChoiceForCommandKey, analyzerDecodeSettings, analyzerDecodeSignature,
  analyzerChannelRoles, analyzerCanRunDecoder, createAnalyzerInstance, hlaUpstreamAnalyzers,
  reconcileHlaAnalyzers, restoreSaleaeAnalyzer, saleaeAnalyzerMetadata, validateHlaAnalyzer,
} from "../src/lib/analyzers.ts";
import type { UiAnalyzerInstance } from "../src/lib/analyzers.ts";
import type { SigrokDecoderCatalogItem } from "../src/lib/api.ts";
import { inspectHlaExtension, cancelHlaDecodes, decodeAnalyzerFrames } from "../src/lib/api.ts";
import { extensionAnalyzerChoices, extensionRecordFromPackage } from "../src/lib/extensions.ts";

function fixture() {
  const source = { ...createAnalyzerInstance("Async Serial", [], 2, "saleae_native"), id: "uart-source" };
  const hla: UiAnalyzerInstance = {
    ...createAnalyzerInstance("Example HLA", [source], 2, "saleae_native"), id: "hla-result",
    hla: { manifestPath: "/extensions/example/extension.json", entryPoint: "HighLevelAnalyzer.Hla",
      upstreamId: source.id, settings: { prefix: "test", count: 2, mode: "a" }, settingMetadata: [
        { id: "prefix", kind: "string", default: "" },
        { id: "count", kind: "number", default: 2, min: 1, max: 10 },
        { id: "mode", kind: "choices", default: "a", choices: ["a", "b"] },
      ] },
  };
  return { source, hla, analyzers: [source, hla] };
}

test("HLA resolves current Saleae input configuration using the existing tagged protocol", () => {
  const { source, hla, analyzers } = fixture();
  assert.equal(analyzerCanRunDecoder(hla), true);
  const settings = analyzerDecodeSettings(hla, analyzers);
  assert.equal(settings?.protocol, "Hla");
  if (settings?.protocol !== "Hla") return;
  assert.equal(settings.settings.manifest_path, hla.hla!.manifestPath);
  assert.equal(settings.settings.entry_point, hla.hla!.entryPoint);
  assert.deepEqual(settings.settings.upstream, analyzerDecodeSettings(source));
  assert.equal(settings.settings.upstream_id, source.id);
  assert.equal("time_origin" in settings.settings, false);
  assert.deepEqual(analyzerChannelRoles(hla), [{ channel: 2, title: "HLA", hasBubbles: true, hasMarkers: false }]);
});

test("HLA rejects missing, invalid, wrong backend and cyclic inputs", () => {
  const { source, hla } = fixture();
  for (const sources of [[], [{ ...source, decoderBackend: "sigrok_native" as const }],
    [{ ...source, configurationValid: false }], [{ ...source, baudRate: 0 }],
    [{ ...source, type: "I2C", i2cSdaChannel: 0, i2cSclChannel: 0 }],
    [{ ...source, type: "SPI" }], [{ ...source, hla: hla.hla }]]) {
    assert.equal(analyzerDecodeSettings(hla, [...sources, hla]), null);
    assert.match(validateHlaAnalyzer(hla, [...sources, hla])!, /valid Saleae Native/);
  }
  assert.equal(analyzerDecodeSettings({ ...hla, hla: { ...hla.hla!, upstreamId: hla.id } }, [hla]), null);
  assert.deepEqual(hlaUpstreamAnalyzers([source, hla]), [source]);
});

test("metadata settings enforce types, finite numbers, bounds and choices", () => {
  const { hla, analyzers } = fixture();
  for (const settings of [{ prefix: 1, count: 2, mode: "a" }, { prefix: "", count: NaN, mode: "a" },
    { prefix: "", count: 11, mode: "a" }, { prefix: "", count: 2, mode: "wrong" }]) {
    assert.notEqual(validateHlaAnalyzer({ ...hla, hla: { ...hla.hla!, settings } }, analyzers), null);
  }
  assert.equal(validateHlaAnalyzer(hla, analyzers), null);
});

test("input edits invalidate HLA signatures and drop stale decoded/rendered state", () => {
  const { source, hla, analyzers } = fixture();
  const dirty = { ...hla, decodedFrameCount: 12, decodedFramesComplete: true, decodedDecodeSignature: "old", renderedDecodeSignature: "old" };
  const edited = { ...source, baudRate: 9600, channel: 3 };
  const next = [edited, dirty];
  assert.notEqual(analyzerDecodeSignature(hla, analyzers), analyzerDecodeSignature(hla, next));
  const result = reconcileHlaAnalyzers(analyzers, next)[1];
  assert.equal(result.channel, 3);
  assert.equal(result.decodedFrameCount, 0);
  assert.equal(result.decodedDecodeSignature, null);
  assert.equal(result.renderedDecodeSignature, null);
  assert.deepEqual(result.hla, hla.hla);
  assert.equal(reconcileHlaAnalyzers(analyzers, analyzers)[1], hla);
  assert.equal(reconcileHlaAnalyzers(analyzers, [dirty])[0].decodedFrameCount, 0);
});

test("session metadata preserves extension identity, settings and upstream IDs across reload", () => {
  const { source, hla, analyzers } = fixture();
  const saved = analyzers.map((item) => saleaeAnalyzerMetadata(item, analyzers));
  const loaded = JSON.parse(JSON.stringify(saved)).reduce((items: UiAnalyzerInstance[], metadata: typeof saved[number]) =>
    [...items, restoreSaleaeAnalyzer(metadata, items)], [] as UiAnalyzerInstance[]);
  assert.equal(loaded[0].id, source.id);
  assert.equal(loaded[1].id, hla.id);
  assert.deepEqual(loaded[1].hla, hla.hla);
  assert.deepEqual(analyzerDecodeSettings(loaded[1], loaded), analyzerDecodeSettings(hla, analyzers));
  // Even an unresolved input is persisted so the user can repair it on reload.
  const unresolved = restoreSaleaeAnalyzer(saleaeAnalyzerMetadata(hla), []);
  assert.deepEqual(unresolved.hla, hla.hla);
});

test("same-name extensions remain distinct menu choices", () => {
  const choice = { name: "Example", backend: "saleae_native" as const,
    hla: { manifestPath: "/one/extension.json", entryPoint: "One.Hla" } };
  assert.notEqual(analyzerCatalogChoiceKey(choice), analyzerCatalogChoiceKey({ ...choice,
    hla: { manifestPath: "/two/extension.json", entryPoint: "One.Hla" } }));
});

test("browser preview explicitly rejects HLA inspection and execution", async () => {
  const { hla, analyzers } = fixture();
  await assert.rejects(inspectHlaExtension(hla.hla!.manifestPath, hla.hla!.entryPoint), /desktop runtime/);
  await assert.rejects(cancelHlaDecodes(), /desktop runtime/);
  await assert.rejects(async () => decodeAnalyzerFrames("preview", analyzerDecodeSettings(hla, analyzers)!, "saleae_native"), /desktop runtime/);
});

test("installed enabled HLA packages appear in the real analyzer menu with their entry points", () => {
  const extension = extensionRecordFromPackage({ path: "/extensions/example/custom.json", manifest: {
    name: "Example", apiVersion: "1.0.0", author: "Example", version: "1.0.0", extensions: {
      "Example HLA": { type: "HighLevelAnalyzer", entryPoint: "Example.Hla" },
      "Measurement": { type: "DigitalMeasurement", entryPoint: "Example.Measurement" },
    },
  } });
  const choices = extensionAnalyzerChoices([extension]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].backend, "saleae_native");
  assert.deepEqual(choices[0].hla, { manifestPath: extension.localPath, entryPoint: "Example.Hla" });
  assert.deepEqual(extensionAnalyzerChoices([{ ...extension, enabled: false }]), []);
  assert.deepEqual(extensionAnalyzerChoices([{ ...extension, installed: false }]), []);
  assert.deepEqual(extensionAnalyzerChoices([{ ...extension, localPath: undefined }]), []);
});

test("the toolbar command path restores the full choice, HLA metadata included", () => {
  const extension = extensionRecordFromPackage({ path: "/extensions/qst/extension.json", manifest: {
    name: "QST Sensor Decoders", apiVersion: "1.0.0", author: "Qst", version: "0.5.0", extensions: {
      QMI8660: { type: "HighLevelAnalyzer", entryPoint: "HighLevelAnalyzer.Qmi8660Hla" },
      QMI8658: { type: "HighLevelAnalyzer", entryPoint: "HighLevelAnalyzer.Qmi8658Hla" },
    },
  } });
  const choices = [
    ...extensionAnalyzerChoices([extension]),
    { backend: "sigrok_native" as const, name: "PWM", source: "Sigrok C Decoders" },
  ];
  const qmi8660 = choices[0];
  // The toolbar sends only this key; the handler must find the same object back.
  const key = analyzerCatalogChoiceKey(qmi8660);
  assert.equal(analyzerChoiceForCommandKey(choices, key), qmi8660);
  assert.deepEqual(analyzerChoiceForCommandKey(choices, key)?.hla, qmi8660.hla);
  assert.notEqual(analyzerChoiceForCommandKey(choices, key), choices[1]);
  // A stale key resolves to nothing so the caller can fall back explicitly.
  assert.equal(analyzerChoiceForCommandKey(choices, undefined), undefined);
  assert.equal(analyzerChoiceForCommandKey(choices, "sigrok_native::PWM::"), undefined);
  const catalogChoice = { backend: "saleae_native" as const, name: "MDIO",
    catalogItem: { id: "mdio", name: "MDIO", kind: "c" } as SigrokDecoderCatalogItem,
    source: "Saleae Native" };
  assert.equal(
    analyzerChoiceForCommandKey([catalogChoice], analyzerCatalogChoiceKey(catalogChoice)),
    catalogChoice,
  );
});
