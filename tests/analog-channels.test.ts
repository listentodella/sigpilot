import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALOG_CHANNEL_COUNT,
  ANALOG_SAMPLE_RATE_OPTIONS,
  analogChannelCountForCapabilities,
  analogSampleRateOptionsForCapabilities,
  analogChannelsForCapabilities,
  cloneAnalogChannels,
  enabledAnalogChannels,
} from "../src/lib/analogChannels.ts";

const demo = { max_analog_channels: ANALOG_CHANNEL_COUNT, analog_sample_rates: [...ANALOG_SAMPLE_RATE_OPTIONS] };

test("analog channel count uses only explicit valid device capabilities", () => {
  for (const count of [0, 4, 16, 32]) {
    assert.equal(analogChannelCountForCapabilities({ max_analog_channels: count }), count);
  }
  for (const missing of [undefined, null, {}, { max_analog_channels: null }]) {
    assert.equal(analogChannelCountForCapabilities(missing), 0);
  }
  for (const bad of [NaN, Infinity, -1, 1.5, 256]) {
    assert.equal(analogChannelCountForCapabilities({ max_analog_channels: bad }), 0);
  }
});

test("analog rates are declared, positive, unique and sorted; never Demo fallbacks", () => {
  assert.deepEqual(analogSampleRateOptionsForCapabilities(demo), [...ANALOG_SAMPLE_RATE_OPTIONS]);
  assert.deepEqual(analogSampleRateOptionsForCapabilities({
    max_analog_channels: 4, analog_sample_rates: [2_000_000, 1_000_000, 2_000_000, 0, -1, NaN, Infinity, 0.5],
  }), [1_000_000, 2_000_000]);
  for (const caps of [undefined, null, {}, { max_analog_channels: 4 },
    { max_analog_channels: 4, analog_sample_rates: [] },
    { max_analog_channels: 4, analog_sample_rates: null },
    { max_analog_channels: 0, analog_sample_rates: [1_000_000] }]) {
    assert.deepEqual(analogSampleRateOptionsForCapabilities(caps), []);
  }
});

test("Demo to digital-only or unknown devices removes all analog settings and rows", () => {
  const channels = analogChannelsForCapabilities(demo, [], 4);
  assert.equal(channels.length, 16);
  assert.equal(enabledAnalogChannels(channels).length, 4);
  for (const caps of [{ max_analog_channels: 0 }, null, {}]) {
    const next = analogChannelsForCapabilities(caps, channels);
    assert.deepEqual(next, []);
    assert.deepEqual(enabledAnalogChannels(next), []);
    assert.deepEqual(cloneAnalogChannels(next), []);
  }
});

test("capability resizing preserves valid customization without inventing channels", () => {
  const channels = analogChannelsForCapabilities(demo, [], 4);
  channels[0].label = "Voltage";
  channels[1].enabled = false;
  const smaller = analogChannelsForCapabilities({ max_analog_channels: 2 }, channels);
  assert.equal(smaller.length, 2);
  assert.equal(smaller[0].label, "Voltage");
  assert.equal(smaller[1].enabled, false);
  const copy = cloneAnalogChannels(smaller);
  assert.deepEqual(copy, smaller);
  assert.notEqual(copy[0], smaller[0]);
  assert.deepEqual(cloneAnalogChannels(undefined), []);
  const expanded = analogChannelsForCapabilities({ max_analog_channels: 4 }, smaller);
  assert.equal(expanded.length, 4);
  assert.equal(expanded[2].enabled, false);
});
