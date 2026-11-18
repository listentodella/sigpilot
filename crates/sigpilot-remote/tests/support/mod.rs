use sigpilot_core::{
    device::DeviceDriver,
    fake::{FakeBackend, FakeDriver},
    transport::CaptureBackend,
    AnalyzerDecodeSettings, CaptureMode, CaptureSettings, DecoderBackendKind, DemoAnalyzerSettings,
};
use sigpilot_remote::{events::Events, Asset, Assets, CaptureController, CaptureFuture};
use sigpilot_workbench::WorkbenchService;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Clone)]
pub struct Demo {
    pub workbench: Arc<WorkbenchService>,
    pub events: Arc<Events>,
    active: Arc<Mutex<Option<(String, Arc<AtomicBool>)>>>,
}
impl Demo {
    pub fn new() -> Arc<Self> {
        let workbench = Arc::new(WorkbenchService::default());
        let events = Arc::new(Events::default());
        let rx = workbench.subscribe().unwrap();
        let events_copy = events.clone();
        std::thread::spawn(move || {
            while let Ok(event) = rx.recv() {
                events_copy
                    .publish(serde_json::json!({"kind":"workbench_event","event":event.as_ref()}));
            }
        });
        Arc::new(Self {
            workbench,
            events,
            active: Arc::default(),
        })
    }
    pub fn settings() -> CaptureSettings {
        CaptureSettings {
            sample_rate_hz: 1_000_000,
            channel_count: 4,
            enabled_channels: vec![0, 1, 2, 3],
            duration_ms: 10,
            mode: CaptureMode::Buffer,
            ..Default::default()
        }
    }
    pub fn uart() -> AnalyzerDecodeSettings {
        AnalyzerDecodeSettings::Uart(sigpilot_core::UartDecodeSettings {
            baud_rate: 115200,
            ..Default::default()
        })
    }
    pub fn record(
        &self,
        id: &str,
        settings: &CaptureSettings,
        analyzers: &[AnalyzerDecodeSettings],
        cancel: &AtomicBool,
    ) -> Result<serde_json::Value, String> {
        let session = self.workbench.session(id).map_err(|e| e.to_string())?;
        let settings_analyzers = analyzers
            .iter()
            .cloned()
            .map(|settings| DemoAnalyzerSettings {
                backend: DecoderBackendKind::Auto,
                settings,
            })
            .collect::<Vec<_>>();
        let mut streamed = 0;
        let capture = FakeBackend
            .capture_streaming_with_analyzers(
                settings,
                &settings_analyzers,
                cancel,
                &mut |p| {
                    self.events.publish(
                        serde_json::json!({"kind":"capture_progress","session_id":id,"progress":p}),
                    )
                },
                &mut |m| session.graph.begin_capture(m.clone()).unwrap(),
                &mut |bytes| {
                    streamed += bytes.len();
                    session.graph.append_samples(bytes).unwrap();
                },
            )
            .map_err(|e| e.to_string())?;
        assert_eq!(streamed, capture.samples.len());
        assert_eq!(capture.metadata.source_device, FakeBackend::DEVICE_ID);
        let summary =
            serde_json::json!({"metadata":capture.metadata,"bytes":capture.samples.len()});
        session
            .graph
            .finish_capture(capture)
            .map_err(|e| e.to_string())?;
        self.events
            .publish(serde_json::json!({"kind":"capture_updated","session_id":id}));
        Ok(summary)
    }
}
impl CaptureController for Demo {
    fn devices(&self) -> Result<Vec<sigpilot_core::DeviceInfo>, String> {
        FakeBackend.list_devices().map_err(|e| e.to_string())
    }
    fn capabilities(&self, id: &str) -> Result<sigpilot_core::HardwareCaptureCapabilities, String> {
        FakeDriver::new()
            .capabilities(id)
            .map_err(|e| e.to_string())
    }
    fn start(
        &self,
        id: String,
        settings: CaptureSettings,
        analyzers: Vec<AnalyzerDecodeSettings>,
    ) -> CaptureFuture {
        let demo = self.clone();
        Box::pin(async move {
            let cancel = Arc::new(AtomicBool::new(false));
            {
                let mut active = demo.active.lock().unwrap();
                if active.is_some() {
                    return Err("Another acquisition is active".into());
                }
                *active = Some((id.clone(), cancel.clone()));
            }
            let work = demo.clone();
            let result = tokio::task::spawn_blocking(move || {
                // Exercise queued cancellation and browser disconnection while
                // the controller still owns a real backend acquisition.
                std::thread::sleep(std::time::Duration::from_millis(80));
                work.record(&id, &settings, &analyzers, &cancel)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|v| v);
            *demo.active.lock().unwrap() = None;
            result
        })
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self.active.lock().unwrap();
        let Some((session, cancel)) = active.as_ref() else {
            return Err("Not active".into());
        };
        if session != id {
            return Err("Not owned".into());
        }
        cancel.store(true, Ordering::Release);
        Ok(())
    }
}
#[allow(dead_code)] // Used by the browser fixture, while API tests supply minimal assets.
pub fn assets(root: PathBuf) -> Assets {
    Arc::new(move |path: &str| {
        let bytes = std::fs::read(root.join(path.trim_start_matches('/'))).ok()?;
        let mime = if path.ends_with(".html") {
            "text/html"
        } else if path.ends_with(".js") {
            "text/javascript"
        } else if path.ends_with(".css") {
            "text/css"
        } else if path.ends_with(".ttf") {
            "font/ttf"
        } else if path.ends_with(".svg") {
            "image/svg+xml"
        } else {
            "application/octet-stream"
        };
        Some(Asset {
            bytes,
            mime: mime.into(),
        })
    })
}
