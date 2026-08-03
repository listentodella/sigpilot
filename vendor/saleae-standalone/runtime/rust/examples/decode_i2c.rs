use saleae_runtime::{decode_transitions, default_plugin, InputChannel};

fn main() -> Result<(), String> {
    // START, address 0x50 + write, ACK, data 0x3c, ACK, STOP.
    let (sda, scl) = i2c_write_edges();
    let channels = [
        InputChannel {
            setting_title: "SDA".to_owned(),
            channel_index: 0,
            initial_high: true,
            transitions: sda,
        },
        InputChannel {
            setting_title: "SCL".to_owned(),
            channel_index: 1,
            initial_high: true,
            transitions: scl,
        },
    ];
    let run = decode_transitions(&default_plugin("I2C")?, 10_000_000, &channels, &[])?;
    println!(
        "{}: {} FrameV2, {} legacy frames",
        run.analyzer,
        run.frames.len(),
        run.legacy_frames.len()
    );
    for frame in run.frames {
        println!(
            "{} [{}..={}]: {:?}",
            frame.frame_type, frame.start_sample, frame.end_sample, frame.fields
        );
    }
    Ok(())
}

fn i2c_write_edges() -> (Vec<u64>, Vec<u64>) {
    let mut sample = 10;
    let mut sda_high = true;
    let mut scl_high = true;
    let mut sda = Vec::new();
    let mut scl = Vec::new();
    set(&mut sda, &mut sda_high, sample, false);
    sample += 10;
    set(&mut scl, &mut scl_high, sample, false);
    for byte in [0xa0, 0x3c] {
        for bit in (0..8).rev() {
            sample += 5;
            set(&mut sda, &mut sda_high, sample, byte & (1 << bit) != 0);
            sample += 5;
            set(&mut scl, &mut scl_high, sample, true);
            sample += 10;
            set(&mut scl, &mut scl_high, sample, false);
        }
        sample += 5;
        set(&mut sda, &mut sda_high, sample, false);
        sample += 5;
        set(&mut scl, &mut scl_high, sample, true);
        sample += 10;
        set(&mut scl, &mut scl_high, sample, false);
    }
    sample += 5;
    set(&mut sda, &mut sda_high, sample, false);
    sample += 5;
    set(&mut scl, &mut scl_high, sample, true);
    sample += 5;
    set(&mut sda, &mut sda_high, sample, true);
    (sda, scl)
}

fn set(edges: &mut Vec<u64>, high: &mut bool, sample: u64, value: bool) {
    if *high != value {
        edges.push(sample);
        *high = value;
    }
}
