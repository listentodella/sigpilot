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
    session: {
      name: 'Analyzer round trip',
      notes: 'Analyzer settings survive the archive',
      analyzers: [
        {
          type: 'SPI',
          name: 'SPI [imported]',
          color: '#7ACB8C',
          display_radix: 'Hexadecimal',
          show_in_data_table: true,
          stream_to_terminal: false,
          decoder_backend: 'saleae_native',
          decode_settings: {
            protocol: 'Spi',
            settings: {
              mosi_channel: 0,
              miso_channel: 2,
              clock_channel: 4,
              enable_channel: 6,
              enable_active_low: true,
              clock_polarity: true,
              clock_phase: false,
              bits_per_transfer: 8,
              msb_first: true,
            },
          },
          saleae_metadata: nil,
        },
        {
          type: 'I2C',
          name: 'I2C [imported]',
          color: '#75CACA',
          display_radix: 'Hexadecimal',
          show_in_data_table: false,
          stream_to_terminal: true,
          decoder_backend: 'sigrok_native',
          decode_settings: {
            protocol: 'I2c',
            settings: {
              sda_channel: 1,
              scl_channel: 3,
            },
          },
          saleae_metadata: nil,
        },
        {
          type: 'Async Serial',
          name: 'Async Serial [imported]',
          color: '#D881F7',
          display_radix: 'ASCII',
          show_in_data_table: true,
          stream_to_terminal: false,
          decoder_backend: 'sigrok_native',
          decode_settings: {
            protocol: 'Uart',
            settings: {
              channel: 5,
              baud_rate: 230400,
              inverted: true,
              data_bits: 7,
              stop_bits: 1.5,
              parity: 'odd',
              msb_first: true,
            },
          },
          saleae_metadata: nil,
        },
        {
          type: 'LIN',
          name: 'LIN [body bus]',
          color: '#D881F7',
          display_radix: 'Hexadecimal',
          show_in_data_table: true,
          stream_to_terminal: false,
          decoder_backend: 'saleae_native',
          decode_settings: {
            protocol: 'Native',
            settings: {
              decoder_id: 'lin',
              protocol_name: 'LIN',
              channels: {
                rx: 7,
              },
              options: {
                baudrate: 19200,
                version: 1,
              },
              primary_channel: 7,
            },
          },
          saleae_metadata: nil,
        },
      ],
    },
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
session = channels_manifest.fetch('session')
raise 'session name changed' unless session.fetch('name') == 'Analyzer round trip'
raise 'session notes changed' unless session.fetch('notes') == 'Analyzer settings survive the archive'
analyzers = session.fetch('analyzers').to_h { |analyzer| [analyzer.fetch('type'), analyzer] }

spi = analyzers.fetch('SPI')
raise 'SPI analyzer name changed' unless spi.fetch('name') == 'SPI [imported]'
raise 'SPI analyzer color changed' unless spi.fetch('color') == '#7ACB8C'
spi_settings = spi.fetch('settings').to_h { |setting| [setting.fetch('title'), setting.fetch('setting')['value']] }
expected_spi_settings = {
  'MOSI' => 0,
  'MISO' => 2,
  'Clock' => 4,
  'Enable' => 6,
  'Significant Bit' => 0,
  'Bits per Transfer' => 8,
  'Clock State' => 1,
  'Clock Phase' => 0,
  'Enable Line' => 0,
}
raise "SPI analyzer settings changed: #{spi_settings.inspect}" unless spi_settings == expected_spi_settings

i2c = analyzers.fetch('I2C')
raise 'I2C analyzer name changed' unless i2c.fetch('name') == 'I2C [imported]'
raise 'I2C analyzer table visibility changed' unless i2c.fetch('showInDataTable') == false
raise 'I2C terminal visibility changed' unless i2c.fetch('streamToTerminal') == true
i2c_settings = i2c.fetch('settings').to_h { |setting| [setting.fetch('title'), setting.fetch('setting')['value']] }
expected_i2c_settings = {
  'Serial Data Line' => 1,
  'Serial Clock Line' => 3,
}
raise "I2C analyzer settings changed: #{i2c_settings.inspect}" unless i2c_settings == expected_i2c_settings

uart = analyzers.fetch('Async Serial')
raise 'UART analyzer name changed' unless uart.fetch('name') == 'Async Serial [imported]'
raise 'UART display radix changed' unless uart.fetch('displayRadix') == 'ASCII'
uart_settings = uart.fetch('settings').to_h { |setting| [setting.fetch('title'), setting.fetch('setting')['value']] }
expected_uart_settings = {
  'Input Channel' => 5,
  'Bit Rate (Bits/s)' => 230400,
  'Use Autobaud' => false,
  'Bits per Frame' => 7,
  'Stop Bits' => 1.5,
  'Parity Bit' => 2,
  'Significant Bit' => 1,
  'Signal inversion' => 1,
  'Mode' => 0,
}
raise "UART analyzer settings changed: #{uart_settings.inspect}" unless uart_settings == expected_uart_settings

lin = analyzers.fetch('LIN')
raise 'LIN analyzer name changed' unless lin.fetch('name') == 'LIN [body bus]'
raise 'LIN analyzer color changed' unless lin.fetch('color') == '#D881F7'
lin_settings = lin.fetch('settings').to_h { |setting| [setting.fetch('title'), setting.fetch('setting')['value']] }
expected_lin_settings = {
  'Serial' => 7,
  'LIN Version' => 1,
  'Bit Rate (Bits/s)' => 19200,
}
raise "LIN analyzer settings changed: #{lin_settings.inspect}" unless lin_settings == expected_lin_settings
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

printf 'Saleae .sal round trips verified (SPI/I2C/UART/LIN metadata, 32 channels, and 49-billion-sample sparse capture).\n'
printf 'Artifacts: %s\n' "$WORK_DIR"
