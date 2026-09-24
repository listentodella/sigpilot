//! Pins how the "Memory buffer size" setting maps onto the buffers the capture
//! actually holds.
//!
//! The setting is converted into a sample count via `unitsize`, so the *decoded*
//! buffer reaches the limit exactly. The *raw* buffer does not: it is
//! `enabled_channels / 8` bytes per sample, so it tops out at
//! `limit * enabled / (8 * unitsize)`. That gap is why the memory readout can
//! sit well below the configured limit even though the capture ran normally.
//!
//! This test guards the arithmetic. It does not exercise the transport, so it
//! cannot catch a readout that reports the wrong quantity — see the note in
//! `rusb_backend.rs` about reporting `len` rather than `capacity`.

use pxlogic_core::capture::{
    pxview_cross_raw_byte_count, sample_count_from_settings, unitsize_for_channel_count,
};
use pxlogic_core::{CaptureMode, CaptureSettings};

const MIB: u64 = 1024 * 1024;

fn stream_settings(buffer_size_mb: u64, channel_count: u8, enabled: u8) -> CaptureSettings {
    let mut settings = CaptureSettings {
        buffer_size_mb,
        channel_count,
        mode: CaptureMode::Stream,
        decode_cross: true,
        ..Default::default()
    };
    settings.enabled_channels = (0..enabled).collect();
    settings
}

#[test]
fn the_decoded_buffer_reaches_the_configured_limit() {
    // With cross-lane decoding the capture holds `unitsize` bytes per sample, so
    // the sample count the setting resolves to makes the buffer land exactly on
    // the limit — for every channel count and every subset of enabled channels.
    for buffer_size_mb in [512u64, 1024, 2048] {
        let limit = buffer_size_mb * MIB;
        for channel_count in [8u8, 16, 32] {
            for enabled in [1u8, 5, 8] {
                if enabled > channel_count {
                    continue;
                }
                let settings = stream_settings(buffer_size_mb, channel_count, enabled);
                let unitsize = unitsize_for_channel_count(channel_count).unwrap();
                let samples = sample_count_from_settings(&settings, unitsize).unwrap();
                let decoded_bytes = samples * u64::from(unitsize);

                assert_eq!(
                    decoded_bytes, limit,
                    "{enabled}ch of {channel_count} at {buffer_size_mb} MiB: decoded buffer \
                     should land on the limit"
                );
            }
        }
    }
}

#[test]
fn the_raw_buffer_falls_short_unless_every_channel_is_enabled() {
    // The raw lanes are `enabled / 8` bytes per sample, so the same sample count
    // fills a smaller buffer whenever only some channels are enabled. This is the
    // quantity the capture loop actually stops on.
    let buffer_size_mb = 2048u64;
    let limit = buffer_size_mb * MIB;

    for (channel_count, enabled, expected_ratio) in
        [(8u8, 5u8, 5.0 / 8.0), (16, 5, 5.0 / 16.0), (32, 5, 5.0 / 32.0)]
    {
        let settings = stream_settings(buffer_size_mb, channel_count, enabled);
        let unitsize = unitsize_for_channel_count(channel_count).unwrap();
        let samples = sample_count_from_settings(&settings, unitsize).unwrap();
        let raw_bytes = pxview_cross_raw_byte_count(samples, enabled).unwrap();

        let ratio = raw_bytes as f64 / limit as f64;
        assert!(
            (ratio - expected_ratio).abs() < 1e-9,
            "{enabled}ch of {channel_count}: raw/limit was {ratio}, expected {expected_ratio}"
        );
    }

    // When every channel is enabled the two representations agree, which is the
    // only configuration where the raw readout can reach the limit.
    let settings = stream_settings(buffer_size_mb, 16, 16);
    let unitsize = unitsize_for_channel_count(16).unwrap();
    let samples = sample_count_from_settings(&settings, unitsize).unwrap();
    assert_eq!(
        pxview_cross_raw_byte_count(samples, 16).unwrap(),
        limit,
        "all channels enabled should fill the raw buffer to the limit"
    );
}
