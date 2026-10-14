//! Independent CPython HLA host. This is process isolation, not a security sandbox.
use crate::{
    AnalyzerDecodeSettings, CaptureData, CoreError, DecoderBackendKind, DecoderDiagnostic,
    DecoderField, DecoderFieldValue, DecoderOutput, DecoderOutputFrame, Result,
    SaleaeNativeDecoder, SparseCaptureView,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RationalTime {
    pub numerator: i64,
    pub denominator: u64,
}
impl Default for RationalTime {
    fn default() -> Self {
        Self {
            numerator: 0,
            denominator: 1,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HlaDecodeSettings {
    pub manifest_path: String,
    pub entry_point: String,
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    pub upstream_id: String,
    pub upstream: Box<AnalyzerDecodeSettings>,
    #[serde(default)]
    pub time_origin: RationalTime,
}
impl HlaDecodeSettings {
    pub fn validate(&self) -> Result<()> {
        if self.manifest_path.is_empty()
            || self.entry_point.is_empty()
            || self.upstream_id.is_empty()
        {
            return Err(CoreError::Decode(
                "HLA requires an extension entry point and upstream analyzer".into(),
            ));
        }
        if !matches!(
            self.upstream.as_ref(),
            AnalyzerDecodeSettings::Uart(_)
                | AnalyzerDecodeSettings::I2c(_)
                | AnalyzerDecodeSettings::Spi(_)
        ) {
            return Err(CoreError::Decode(
                "HLA v1 supports only Saleae UART, I2C or SPI upstreams (no HLA chains)".into(),
            ));
        }
        if self.time_origin.denominator == 0 {
            return Err(CoreError::Decode(
                "HLA time origin denominator must be positive".into(),
            ));
        }
        Ok(())
    }
}
/// Lossless transport separate from display-only DecoderFieldValue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum HlaValue {
    Text(String),
    Signed(i64),
    Unsigned(u64),
    Float(f64),
    Boolean(bool),
    Bytes(Vec<u8>),
    Null(()),
    List(Vec<HlaValue>),
    Map(BTreeMap<String, HlaValue>),
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HlaInputFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub start_sample: u64,
    pub end_sample: u64,
    pub data: BTreeMap<String, HlaValue>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HlaOutputFrame {
    #[serde(flatten)]
    pub frame: HlaInputFrame,
    pub text: String,
}

static CHILDREN: OnceLock<Mutex<HashMap<u64, Arc<Mutex<Child>>>>> = OnceLock::new();
static NEXT_CHILD: AtomicU64 = AtomicU64::new(1);
const TIMEOUT: Duration = Duration::from_secs(120);
static CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);
fn registry() -> &'static Mutex<HashMap<u64, Arc<Mutex<Child>>>> {
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}
fn decode_error(message: impl Into<String>) -> CoreError {
    CoreError::Decode(message.into())
}

struct HostProcess {
    id: u64,
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    responses: mpsc::Receiver<std::io::Result<String>>,
    stderr: Arc<Mutex<Vec<u8>>>,
}
impl HostProcess {
    fn spawn(mut command: Command) -> Result<Self> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| decode_error("host stdout unavailable"))?;
        let mut err = child
            .stderr
            .take()
            .ok_or_else(|| decode_error("host stderr unavailable"))?;
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = sender.send(Err(e));
                        break;
                    }
                }
            }
        });
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let tail = stderr.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(size) = err.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                let mut bytes = tail.lock().unwrap_or_else(|e| e.into_inner());
                bytes.extend_from_slice(&buffer[..size]);
                if bytes.len() > 16_384 {
                    let drop_count = bytes.len() - 16_384;
                    bytes.drain(..drop_count);
                }
            }
        });
        let id = NEXT_CHILD.fetch_add(1, Ordering::Relaxed);
        let child = Arc::new(Mutex::new(child));
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, child.clone());
        Ok(Self {
            id,
            child,
            stdin,
            responses,
            stderr,
        })
    }
    fn error(&self, message: &str) -> CoreError {
        let tail = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        decode_error(format!("{message}: {}", String::from_utf8_lossy(&tail)))
    }
    fn send(&mut self, request: &Value) -> Result<()> {
        let mut input = self
            .stdin
            .take()
            .ok_or_else(|| decode_error("host input closed"))?;
        let mut bytes = serde_json::to_vec(request).map_err(|e| decode_error(e.to_string()))?;
        bytes.push(b'\n');
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let result = input.write_all(&bytes).and_then(|_| input.flush());
            let _ = tx.send((input, result));
        });
        let (input, result) = rx
            .recv_timeout(TIMEOUT)
            .map_err(|_| self.error("host input timed out or decode cancelled"))?;
        self.stdin = Some(input);
        result?;
        Ok(())
    }
    fn response(&self) -> Result<Value> {
        let started = Instant::now();
        loop {
            match self.responses.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    let value: Value = serde_json::from_str(&line?)
                        .map_err(|e| self.error(&format!("invalid host response: {e}")))?;
                    if let Some(message) = value.get("error").and_then(Value::as_str) {
                        return Err(self.error(message));
                    }
                    return Ok(value);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(self.error("host exited or decode cancelled"))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if started.elapsed() >= TIMEOUT {
                        return Err(self.error("HLA host timed out"));
                    }
                }
            }
        }
    }
    fn transact(&mut self, request: &Value) -> Result<Value> {
        self.send(request)?;
        self.response()
    }
    fn finish(&mut self) -> Result<()> {
        self.stdin.take();
        let started = Instant::now();
        loop {
            if let Some(status) = self
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .try_wait()?
            {
                return if status.success() {
                    Ok(())
                } else {
                    Err(self.error("host failed on exit"))
                };
            }
            if started.elapsed() >= Duration::from_secs(5) {
                return Err(self.error("host did not exit"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for HostProcess {
    fn drop(&mut self) {
        self.stdin.take();
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
        let _ = child.wait();
        drop(child);
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

/// Native one-shot raw decode is supervised by the same cancel registry as Python.
pub(crate) fn native_raw_decode(
    path: &Path,
    root: &Path,
    request: Value,
) -> Result<Vec<HlaInputFrame>> {
    let mut command = Command::new(path);
    command.arg("--runtime-root").arg(root).arg("--decode");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut process = HostProcess::spawn(command)?;
    process.send(&request)?;
    process.stdin.take();
    let response = process.response()?;
    process.finish()?;
    if response["format"] != "sigpilot.hla.raw.v1" {
        return Err(decode_error(
            "native runtime does not support original FrameV2; rebuild native resources",
        ));
    }
    serde_json::from_value(response["frames"].clone()).map_err(|e| decode_error(e.to_string()))
}

#[derive(Debug, Clone)]
pub struct HlaDecoder {
    python: PathBuf,
    script: PathBuf,
}
impl HlaDecoder {
    pub fn discover() -> Result<Self> {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut roots = vec![workspace.join("resources/native")];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                roots.insert(0, dir.join("resources/native"));
                roots.insert(0, dir.join("../Resources/resources/native"));
            }
        }
        let python_name = if cfg!(windows) {
            "bin/python.exe"
        } else {
            "bin/python3"
        };
        let python = crate::product_env("SIGPILOT_HLA_PYTHON").map(PathBuf::from)
            .or_else(|| roots.iter().map(|r| r.join("python-runtime").join(python_name)).find(|p| p.is_file()))
            .ok_or_else(|| decode_error("shared CPython runtime missing; prepare native resources or explicitly set SIGPILOT_HLA_PYTHON for development"))?;
        let script = crate::product_env("SIGPILOT_HLA_HOST")
            .map(PathBuf::from)
            .or_else(|| {
                roots
                    .iter()
                    .map(|r| r.join("hla-analyzer-sidecar/main.py"))
                    .find(|p| p.is_file())
            })
            .unwrap_or_else(|| workspace.join("native/hla-analyzer-sidecar/main.py"));
        if !script.is_file() {
            return Err(decode_error("HLA host main.py is missing"));
        }
        Ok(Self { python, script })
    }
    pub fn with_paths(python: PathBuf, script: PathBuf) -> Self {
        Self { python, script }
    }
    fn spawn(&self) -> Result<HostProcess> {
        let mut command = Command::new(&self.python);
        command.arg("-I").arg("-B").arg(&self.script);
        command.env_remove("PYTHONPATH").env_remove("PYTHONHOME");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        HostProcess::spawn(command)
    }
    pub fn cancellation_epoch() -> u64 {
        CANCEL_EPOCH.load(Ordering::SeqCst)
    }
    pub fn check_cancellation(epoch: u64) -> Result<()> {
        if Self::cancellation_epoch() == epoch {
            Ok(())
        } else {
            Err(decode_error("HLA decode cancelled"))
        }
    }
    pub fn cancel_all() {
        CANCEL_EPOCH.fetch_add(1, Ordering::SeqCst);
        let children: Vec<_> = registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        for child in children {
            let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
        }
    }
    pub fn inspect(&self, settings: &HlaDecodeSettings) -> Result<Value> {
        let mut process = self.spawn()?;
        let result = process.transact(
            &json!({"op":"inspect", "manifest_path":settings.manifest_path,
            "entry_point":settings.entry_point, "settings":settings.settings, "sample_rate_hz":1}),
        )?;
        let done = process.transact(&json!({"op":"finish"}))?;
        if done["done"] != true {
            return Err(decode_error("HLA inspect did not finish"));
        }
        process.finish()?;
        Ok(result)
    }
    pub fn decode(
        &self,
        capture: &CaptureData,
        settings: &HlaDecodeSettings,
    ) -> Result<DecoderOutput> {
        settings.validate()?;
        let epoch = CANCEL_EPOCH.load(Ordering::SeqCst);
        let input =
            SaleaeNativeDecoder::from_env_cached()?.raw_frames(capture, &settings.upstream)?;
        self.decode_frames(input, capture.metadata.sample_rate_hz, settings, epoch)
    }
    pub fn decode_sparse_view(
        &self,
        capture: &SparseCaptureView<'_>,
        settings: &HlaDecodeSettings,
    ) -> Result<DecoderOutput> {
        settings.validate()?;
        let epoch = CANCEL_EPOCH.load(Ordering::SeqCst);
        let input = SaleaeNativeDecoder::from_env_cached()?
            .raw_frames_sparse_view(capture, &settings.upstream)?;
        self.decode_frames(input, capture.metadata.sample_rate_hz, settings, epoch)
    }
    pub fn run_frames(
        &self,
        input: &[HlaInputFrame],
        rate: u64,
        settings: &HlaDecodeSettings,
    ) -> Result<Vec<HlaOutputFrame>> {
        self.run_frames_with_epoch(input, rate, settings, CANCEL_EPOCH.load(Ordering::SeqCst))
    }
    fn run_frames_with_epoch(
        &self,
        input: &[HlaInputFrame],
        rate: u64,
        settings: &HlaDecodeSettings,
        epoch: u64,
    ) -> Result<Vec<HlaOutputFrame>> {
        let check_cancel = || {
            if CANCEL_EPOCH.load(Ordering::SeqCst) == epoch {
                Ok(())
            } else {
                Err(decode_error("HLA decode cancelled"))
            }
        };
        check_cancel()?;
        settings.validate()?;
        if rate == 0 {
            return Err(decode_error("HLA sample rate must be positive"));
        }
        let mut process = self.spawn()?;
        check_cancel()?;
        let ready = process.transact(
            &json!({"op":"start", "manifest_path":settings.manifest_path,
            "entry_point":settings.entry_point, "settings":settings.settings,
            "sample_rate_hz":rate, "time_origin":settings.time_origin}),
        )?;
        if ready["ready"] != true {
            return Err(decode_error("HLA host did not initialize"));
        }
        let mut output = Vec::new();
        for frames in input.chunks(1024) {
            check_cancel()?;
            let response = process.transact(&json!({"op":"batch", "frames":frames}))?;
            let mut decoded: Vec<HlaOutputFrame> =
                serde_json::from_value(response["frames"].clone())
                    .map_err(|e| decode_error(e.to_string()))?;
            output.append(&mut decoded);
        }
        let done = process.transact(&json!({"op":"finish"}))?;
        if done["done"] != true {
            return Err(decode_error("HLA host did not finish"));
        }
        process.finish()?;
        check_cancel()?;
        // Match the ordered track/table contract without changing plugin decode ordering.
        output.sort_by_key(|f| (f.frame.start_sample, f.frame.end_sample));
        Ok(output)
    }
    fn decode_frames(
        &self,
        input: Vec<HlaInputFrame>,
        rate: u64,
        settings: &HlaDecodeSettings,
        epoch: u64,
    ) -> Result<DecoderOutput> {
        let output = self.run_frames_with_epoch(&input, rate, settings, epoch)?;
        let frames = output
            .into_iter()
            .enumerate()
            .map(|(id, out)| DecoderOutputFrame {
                frame_id: id as u64,
                start_sample: out.frame.start_sample,
                end_sample: out.frame.end_sample,
                row: out.frame.frame_type,
                texts: vec![out.text],
                fields: out
                    .frame
                    .data
                    .into_iter()
                    .map(|(name, value)| DecoderField {
                        name,
                        value: display_value(value),
                    })
                    .collect(),
                channel_values: vec![],
                markers: vec![],
            })
            .collect();
        Ok(DecoderOutput { backend: DecoderBackendKind::SaleaeNative, protocol: "HLA".into(), frames,
            diagnostics: vec![DecoderDiagnostic { level: "info".into(), message: "Independent CPython HLA host; local extensions execute with user permissions, not a sandbox".into() }] })
    }
}
fn display_value(value: HlaValue) -> DecoderFieldValue {
    match value {
        HlaValue::Text(v) => DecoderFieldValue::Text(v),
        HlaValue::Unsigned(v) => DecoderFieldValue::Unsigned(v),
        HlaValue::Signed(v) => DecoderFieldValue::Signed(v),
        HlaValue::Boolean(v) => DecoderFieldValue::Boolean(v),
        HlaValue::Bytes(v) => DecoderFieldValue::Bytes(v),
        HlaValue::Float(v) => DecoderFieldValue::Text(v.to_string()),
        v => DecoderFieldValue::Text(serde_json::to_string(&v).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recursive_values_preserve_float_bytes_and_null() {
        let value = HlaValue::Map(BTreeMap::from([
            ("float".into(), HlaValue::Float(0.125)),
            (
                "list".into(),
                HlaValue::List(vec![HlaValue::Bytes(vec![0, 255]), HlaValue::Null(())]),
            ),
        ]));
        let json = serde_json::to_value(&value).unwrap();
        assert_eq!(serde_json::from_value::<HlaValue>(json).unwrap(), value);
    }
    #[test]
    fn reject_recursive_or_native_upstream() {
        let mut setting = HlaDecodeSettings {
            manifest_path: "extension.json".into(),
            entry_point: "Hla.Hla".into(),
            settings: BTreeMap::new(),
            upstream_id: "uart".into(),
            upstream: Box::new(AnalyzerDecodeSettings::Uart(Default::default())),
            time_origin: Default::default(),
        };
        assert!(setting.validate().is_ok());
        setting.upstream = Box::new(AnalyzerDecodeSettings::Hla(setting.clone()));
        assert!(setting.validate().is_err());
    }
    #[test]
    #[cfg(unix)]
    fn cancel_terminates_active_process_and_invalidates_started_epoch() {
        let mut command = Command::new("sleep");
        command.arg("30");
        let process = HostProcess::spawn(command).unwrap();
        let epoch = CANCEL_EPOCH.load(Ordering::SeqCst);
        HlaDecoder::cancel_all();
        let started = Instant::now();
        assert!(process.response().is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_ne!(CANCEL_EPOCH.load(Ordering::SeqCst), epoch);
    }
}
