import assert from "node:assert/strict";
import test from "node:test";
import { deviceCapabilities } from "../src/lib/api.ts";
import type { HardwareCaptureCapabilities } from "../src/lib/api.ts";
import { maxDigitalChannelsForCapabilities } from "../src/lib/deviceCapabilities.ts";
import { analogChannelsForCapabilities, analogSampleRateOptionsForCapabilities } from "../src/lib/analogChannels.ts";

function digitalDevice(maximum: number): HardwareCaptureCapabilities {
  return {
    device_id: "test:device", max_channels: maximum, max_analog_channels: 0, analog_sample_rates: [],
    default_channel_count: 8, default_sample_rate_hz: 1_000_000,
    sample_rates: [1_000_000], threshold_volts: [3.3], channel_modes: [],
  };
}

test("PXLogic and LA2016 expose 32/16 digital inputs and no analog controls", () => {
  for (const maximum of [32, 16]) {
    const caps = digitalDevice(maximum);
    for (const mode of ["Stream", "Buffer"] as const) {
      assert.equal(maxDigitalChannelsForCapabilities(caps, mode), maximum);
    }
    assert.deepEqual(analogChannelsForCapabilities(caps), []);
    assert.deepEqual(analogSampleRateOptionsForCapabilities(caps), []);
  }
});

test("digital inputs respect both physical and mode limits", () => {
  const caps = digitalDevice(16);
  caps.channel_modes = [8, 32].map((channels, i) => ({
    id: `mode-${i}`, channels, stream: i === 0, default_sample_rate_hz: 1_000_000,
    default_sample_limit: 1000, min_sample_rate_hz: 1_000_000, max_sample_rate_hz: 1_000_000,
    sample_rates: [1_000_000], description: "test",
  }));
  assert.equal(maxDigitalChannelsForCapabilities(caps, "Stream"), 8);
  assert.equal(maxDigitalChannelsForCapabilities(caps, "Buffer"), 16);
  assert.equal(maxDigitalChannelsForCapabilities(null, "Buffer"), 0);
  assert.equal(maxDigitalChannelsForCapabilities(undefined, "Stream"), 0);
});

test("browser Demo explicitly advertises analog capabilities, other IDs do not", async () => {
  const demo = await deviceCapabilities("fake:demo");
  assert.equal(demo.max_analog_channels, 16);
  assert.equal(analogChannelsForCapabilities(demo, [], 4).length, 16);
  assert.ok(analogSampleRateOptionsForCapabilities(demo).includes(6_250_000));
  const hardware = await deviceCapabilities("usb:test");
  assert.equal(hardware.max_analog_channels, 0);
  assert.deepEqual(hardware.analog_sample_rates, []);
});
