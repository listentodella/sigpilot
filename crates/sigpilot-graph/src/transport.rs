//! Shared binary waveform transport for desktop IPC and remote HTTP.
use crate::GraphFrameResponse;
use serde::Serialize;

#[derive(Serialize)]
struct PackedBinRange {
    offset: usize,
    length: usize,
}

#[derive(Serialize)]
struct BinaryChannelTile<'a> {
    channel: u8,
    label: &'a str,
    bins: &'a [sigpilot_waveform::WaveformBin],
    #[serde(skip_serializing_if = "Option::is_none")]
    packed_bins: Option<PackedBinRange>,
    segments: &'a [sigpilot_waveform::DigitalSegment],
    rising_edges: &'a [u64],
    falling_edges: &'a [u64],
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_transition: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_transition: Option<u64>,
}

#[derive(Serialize)]
struct BinaryWaveformTile<'a> {
    start_sample: u64,
    sample_count: u64,
    pixels: u32,
    samples_per_pixel: f64,
    channels: Vec<BinaryChannelTile<'a>>,
}

#[derive(Serialize)]
struct BinaryGraphFrameResponse<'a> {
    frame_id: u64,
    revision: u64,
    sample_count: u64,
    /// The frontend's frame loop discards a frame that has no viewport, because
    /// drawing against `undefined` would take the canvas tree down with it. The
    /// binary transport has to carry both viewports exactly as the JSON
    /// response does; leaving them out makes every frame unusable.
    view: &'a crate::SessionView,
    data_view: &'a crate::SessionView,
    tile: BinaryWaveformTile<'a>,
    analyzers: &'a [crate::AnalyzerRenderResult],
}

pub fn encode_graph_frame(mut frame: GraphFrameResponse) -> Result<Vec<u8>, serde_json::Error> {
    let mut binary = Vec::new();
    let packed_ranges = frame
        .tile
        .channels
        .iter_mut()
        .map(|channel| {
            channel.packed_bins.take().map(|packed| {
                let offset = binary.len();
                let length = packed.len();
                binary.extend_from_slice(&packed);
                PackedBinRange { offset, length }
            })
        })
        .collect::<Vec<_>>();
    let channels = frame
        .tile
        .channels
        .iter()
        .zip(packed_ranges)
        .map(|(channel, packed_bins)| BinaryChannelTile {
            channel: channel.channel,
            label: &channel.label,
            bins: &channel.bins,
            packed_bins,
            segments: &channel.segments,
            rising_edges: &channel.rising_edges,
            falling_edges: &channel.falling_edges,
            previous_transition: channel.previous_transition,
            next_transition: channel.next_transition,
        })
        .collect();
    let response = BinaryGraphFrameResponse {
        frame_id: frame.frame_id,
        revision: frame.revision,
        sample_count: frame.sample_count,
        view: &frame.view,
        data_view: &frame.data_view,
        tile: BinaryWaveformTile {
            start_sample: frame.tile.start_sample,
            sample_count: frame.tile.sample_count,
            pixels: frame.tile.pixels,
            samples_per_pixel: frame.tile.samples_per_pixel,
            channels,
        },
        analyzers: &frame.analyzers,
    };
    let header = serde_json::to_vec(&response)?;
    let mut output = Vec::with_capacity(13 + header.len() + binary.len());
    output.extend_from_slice(b"PXGF1");
    output.extend_from_slice(&(header.len() as u64).to_le_bytes());
    output.extend_from_slice(&header);
    output.extend_from_slice(&binary);
    Ok(output)
}
