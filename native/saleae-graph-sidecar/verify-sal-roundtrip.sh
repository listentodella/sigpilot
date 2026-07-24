#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ROOT="${PXLOGIC_SALEAE_RUNTIME_ROOT:-/Volumes/tp7100s/Downloads/Saleae Logic.app/Contents/Resources/macos-arm64}"
SIDECAR="$($ROOT_DIR/native/saleae-graph-sidecar/build.sh)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pxlogic-sal-roundtrip.XXXXXX")"

/usr/bin/ruby -rjson - "$WORK_DIR" <<'RUBY'
root = ARGV.fetch(0)

channels_dir = File.join(root, 'channels-32')
Dir.mkdir(channels_dir)
channels = (0...32).map do |channel|
  file = "transitions-#{channel}.u64"
  transitions = channel.even? ? [100 + channel, 500 + channel] : []
  File.binwrite(File.join(channels_dir, file), transitions.pack('Q<*'))
  {
    channel: channel,
    label: "D#{channel}",
    initial_high: channel.odd?,
    transitions_file: file,
  }
end
File.write(
  File.join(channels_dir, 'manifest.json'),
  JSON.pretty_generate(
    format: 'pxlogic.saleae-export.v1',
    name: 'PXLogic 32 Channel Round Trip',
    source_device: 'PXLogic',
    sample_rate_hz: 1_000_000,
    channel_count: 32,
    sample_count: 10_000,
    captured_at_unix_milliseconds: 0,
    channels: channels,
  ),
)

long_dir = File.join(root, 'long-capture')
Dir.mkdir(long_dir)
File.binwrite(File.join(long_dir, 'transitions-0.u64'), [100, 4_294_967_300, 49_000_000_000].pack('Q<*'))
File.write(
  File.join(long_dir, 'manifest.json'),
  JSON.pretty_generate(
    format: 'pxlogic.saleae-export.v1',
    name: 'PXLogic Long Round Trip',
    source_device: 'PXLogic',
    sample_rate_hz: 1_000_000,
    channel_count: 1,
    sample_count: 49_000_000_001,
    captured_at_unix_milliseconds: 0,
    channels: [
      {
        channel: 0,
        label: 'D0',
        initial_high: false,
        transitions_file: 'transitions-0.u64',
      },
    ],
  ),
)
RUBY

for fixture in channels-32 long-capture; do
  fixture_dir="$WORK_DIR/$fixture"
  "$SIDECAR" --runtime-root "$RUNTIME_ROOT" \
    --create-sal "$fixture_dir/manifest.json" "$fixture_dir/capture.sal" \
    >"$fixture_dir/create.log" 2>&1
  "$SIDECAR" --runtime-root "$RUNTIME_ROOT" \
    --convert-sal "$fixture_dir/capture.sal" "$fixture_dir/reimport" \
    >"$fixture_dir/reimport.log" 2>&1
done

/usr/bin/ruby -rjson - "$WORK_DIR" <<'RUBY'
root = ARGV.fetch(0)

def read_public_binary(path, sample_rate)
  data = File.binread(path)
  raise "invalid public Saleae binary: #{path}" unless data.start_with?('<SALEAE>') && data.bytesize >= 44

  initial_high = data.byteslice(16, 4).unpack1('L<') != 0
  transitions = data.byteslice(44..).to_s.unpack('E*').map { |time| (time * sample_rate).round }
  [initial_high, transitions]
end

channels_dir = File.join(root, 'channels-32', 'reimport')
channels_manifest = JSON.parse(File.read(File.join(channels_dir, 'manifest.json')))
raise '32-channel manifest count changed' unless channels_manifest.fetch('channel_count') == 32
raise '32-channel sample count changed' unless channels_manifest.fetch('sample_count') == 10_000
(0...32).each do |channel|
  initial_high, transitions = read_public_binary(File.join(channels_dir, "digital_#{channel}.bin"), 1_000_000)
  expected = channel.even? ? [100 + channel, 500 + channel] : []
  raise "D#{channel} initial level changed" unless initial_high == channel.odd?
  raise "D#{channel} transitions changed: #{transitions.inspect}" unless transitions == expected
end

long_dir = File.join(root, 'long-capture', 'reimport')
long_manifest = JSON.parse(File.read(File.join(long_dir, 'manifest.json')))
raise 'long capture sample count changed' unless long_manifest.fetch('sample_count') == 49_000_000_001
initial_high, transitions = read_public_binary(File.join(long_dir, 'digital_0.bin'), 1_000_000)
raise 'long capture initial level changed' if initial_high
expected = [100, 4_294_967_300, 49_000_000_000]
raise "long capture transitions changed: #{transitions.inspect}" unless transitions == expected
RUBY

printf 'Saleae .sal round trips verified (32 channels and 49-billion-sample sparse capture).\n'
printf 'Artifacts: %s\n' "$WORK_DIR"
