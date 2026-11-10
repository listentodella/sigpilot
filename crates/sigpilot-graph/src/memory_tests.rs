use super::*;

fn frame() -> DecodedFrame {
    DecodedFrame {
        frame_id: 1,
        start_sample: 1,
        end_sample: 10,
        frame_type: "result".into(),
        label: "0x01".into(),
        value: 1,
        channel_values: vec![DecodedChannelValue {
            channel: 0,
            role: "MOSI".into(),
            label: "0x01".into(),
            texts: vec!["1".into(), "0x01".into()],
            value: 1,
        }],
        protocol_markers: vec![DecodedProtocolMarker {
            channel: Some(0),
            sample: 2,
            kind: "plugin-marker".into(),
        }],
    }
}

#[test]
fn compact_frames_preserve_bubble_text_and_marker_contents() {
    let mut frame = frame();
    frame.channel_values[0].texts = vec![frame.channel_values[0].label.clone()];
    let original = frame.clone();
    let before_bytes = frame.allocated_bytes();
    let bubble = |frame: &DecodedFrame| {
        analyzer_bubble_for_display_frame(
            display_frame_for_indexed_track(
                std::slice::from_ref(frame),
                AnalyzerTrackFrameIndex {
                    frame_index: 0,
                    value_index: 0,
                },
            )
            .unwrap(),
        )
    };
    let before_bubble = bubble(&frame);
    frame.compact_storage();
    let after_bubble = bubble(&frame);
    assert_eq!(before_bubble, after_bubble);
    assert_eq!(frame.protocol_markers, original.protocol_markers);
    assert_eq!(
        frame.channel_values[0].value,
        original.channel_values[0].value
    );
    assert!(frame.allocated_bytes() < before_bytes);
    frame.channel_values[0].texts = vec!["long label".into(), "short".into()];
    frame.compact_storage();
    assert_eq!(frame.channel_values[0].texts, ["long label", "short"]);
}

#[test]
fn memory_accounting_includes_texts_and_markers_without_counting_shared_frames_twice() {
    let session = GraphSession::default();
    let frames = Arc::new(vec![frame()]);
    let entry = analyzer_cache_entry(10, frames.clone());
    let expected = decoded_frames_allocated_bytes(&entry);
    assert!(expected > std::mem::size_of::<DecodedFrame>() as u64);
    session.analyzer_cache.lock().insert("test".into(), entry);
    session.native_background_cache.lock().insert(
        "test".into(),
        NativeBackgroundDecodeState {
            generation: 0,
            decoded_sample_count: 10,
            next_driver_edge: 1,
            total_driver_edges: 2,
            frames: frames.clone(),
            async_decode_id: "test".into(),
            async_started: false,
        },
    );
    assert_eq!(
        session.capture_memory_usage(0, None).analyzer_bytes,
        expected
    );
    let mut larger = frame();
    larger.channel_values[0].texts[0].reserve(1000);
    larger.protocol_markers.reserve(100);
    assert!(larger.allocated_bytes() >= frame().allocated_bytes() + 1000);
}

#[test]
fn completed_capture_releases_live_previews_and_decode_failures() {
    let capture = crate::tests::demo_capture(4, 4096);
    let session = GraphSession::default();
    session.begin_capture(capture.metadata.clone()).unwrap();
    session.append_samples(&capture.samples).unwrap();
    session.analyzer_cache.lock().insert(
        "live".into(),
        analyzer_cache_entry(4096, Arc::new(vec![frame()])),
    );
    session
        .native_decode_errors
        .lock()
        .insert("old".into(), "budget".into());
    session.finish_capture(capture).unwrap();
    assert!(session.analyzer_cache.lock().is_empty());
    assert!(session.native_decode_errors.lock().is_empty());
    assert_eq!(session.capture_memory_usage(0, None).analyzer_bytes, 0);
}

#[test]
fn searches_evict_old_queries_and_keep_results_correct() {
    let frames = Arc::new(
        (0..200)
            .map(|i| {
                let mut f = frame();
                f.frame_id = i;
                f.value = i;
                f
            })
            .collect(),
    );
    let entry = analyzer_cache_entry(1000, frames);
    for i in 0..40 {
        let query = i.to_string();
        let actual = analyzer_search_matches_for_entry(&entry, "hex", "spi", &query);
        let text = analyzer_frame_search_texts(&entry.frames, "hex");
        let expected = analyzer_frame_search_matches(&entry.frames, &text, "spi", "hex", &query);
        assert_eq!(*actual, expected);
        assert!(entry.table_search_matches.lock().len() <= MAX_ANALYZER_SEARCH_QUERIES);
    }
    for radix in ["hex", "dec", "bin", "ascii"] {
        analyzer_search_texts_for_entry(&entry, radix);
        assert!(entry.table_search_texts.lock().len() <= 1);
    }
}

#[test]
fn decode_budget_rejects_explicitly_and_a_failed_decode_does_not_restart() {
    assert!(ensure_native_result_budget(MAX_NATIVE_RESULT_BYTES).is_ok());
    let error = ensure_native_result_budget(MAX_NATIVE_RESULT_BYTES + 1).unwrap_err();
    assert!(error.to_string().contains("decode stopped"));
    let session = GraphSession::default();
    session
        .finish_capture(crate::tests::demo_capture(4, 4096))
        .unwrap();
    let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default());
    let key = native_full_analyzer_cache_key(DecoderBackendKind::SaleaeNative, &settings).unwrap();
    session
        .native_decode_errors
        .lock()
        .insert(key, error.to_string());
    for _ in 0..2 {
        let err = session
            .decode_frames_with_backend(&settings, DecoderBackendKind::SaleaeNative)
            .unwrap_err();
        assert!(err.to_string().contains("decode stopped"));
        let err = session
            .decode_saleae_native_background_step_batch(&[settings.clone()])
            .unwrap_err();
        assert!(err.to_string().contains("decode stopped"));
    }
}
