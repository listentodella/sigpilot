//! Hardware-agnostic device abstraction.
//!
//! This is the seam that lets the workbench drive more than one logic analyzer
//! without the UI, the graph kernel or the file layer knowing which vendor is
//! attached. It replaces the hard-coded `if device_id == FakeBackend::DEVICE_ID
//! { ... } else { ... }` dispatch that used to live in the Tauri command layer.
//!
//! # Design notes
//!
//! The shape is deliberately borrowed from sigrok's `sr_dev_driver` vtable,
//! which has been validated across ~87 heterogeneous drivers
//! (see `docs/sigrok-device-layer-reference.md`). Three deliberate divergences:
//!
//! 1. **Capabilities are typed.** sigrok carries an untyped `uint32_t key` +
//!    `GVariant` and therefore needs a runtime key-metadata table plus a
//!    `check_key()` validator. Here the capability surface is the concrete
//!    [`HardwareCaptureCapabilities`] struct, so mismatches are compile errors.
//! 2. **Isolation is declared, not implied.** sigrok drivers always run in the
//!    host process, so a buggy driver crashes the application. [`DriverIsolation`]
//!    makes "first-party in-process" versus "third-party out-of-process" explicit
//!    at the descriptor level, matching the existing
//!    `DecoderBackendIsolation::Sidecar` decision for decoders.
//! 3. **Only enumeration, capability resolution and lifecycle live here.** The
//!    capture hot path still differs between the demo source and real hardware
//!    (FPGA bitstreams and trace events versus generated samples) and is being
//!    migrated separately; see the `TODO(capture-path)` note on [`DeviceDriver`].
//!
//! # Device id routing
//!
//! Device ids are `<scheme>:<rest>` — `fake:sigpilot-demo` for the demo source and
//! `usb:1a86:5237:1:4` for a PXLogic device on USB. [`DeviceDriver::owns_device`]
//! routes by the scheme, so **schemes must be disjoint across drivers**. Today the
//! PXLogic driver owns `usb` because it is the only USB driver; a second USB driver
//! will need a vendor-scoped scheme such as `usb-pxlogic`.

use std::sync::Arc;

use crate::{
    error::{CoreError, Result},
    models::{DeviceInfo, DiagnosticEvent, HardwareCaptureCapabilities},
};

/// How a driver is hosted relative to the workbench process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverIsolation {
    /// Runs inside the host process. Reserved for first-party drivers: a panic
    /// or an infinite loop here takes the whole application down.
    InProcess,
    /// Runs in a separate process behind the stable wire contract. Required for
    /// any third-party driver, which can otherwise crash the host or seize the
    /// USB device.
    Sidecar,
}

/// Static, serializable declaration of what a driver is.
///
/// Because this struct is `Serialize`, the same value can cross a sidecar
/// boundary and drive the UI — the descriptor is the single source of truth for
/// both the handshake and the presentation layer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeviceDescriptor {
    /// Stable driver identifier, e.g. `"fake"`, `"pxlogic"`, `"sigrok"`.
    pub driver_id: String,
    /// Human-readable name shown in the UI.
    pub display_name: String,
    /// Version of the driver contract this driver was built against. Unlike
    /// sigrok's `api_version` — which is only ever checked as `< 1` — this is
    /// meant to be compared, not merely presence-checked.
    pub protocol_version: u32,
    /// Hardware vendor, when the driver targets a single vendor.
    pub vendor: Option<String>,
    /// How the driver is hosted.
    pub isolation: DriverIsolation,
    /// Device-id schemes this driver owns, e.g. `["fake"]` or `["usb"]`.
    /// Must be disjoint across registered drivers.
    pub id_schemes: Vec<String>,
}

impl DeviceDescriptor {
    /// The current driver contract version.
    pub const PROTOCOL_VERSION: u32 = 1;
}

/// A source of logic-analyzer devices.
///
/// Implementations are registered in a [`DeviceRegistry`]. Everything the rest of
/// the application needs in order to talk to hardware goes through this trait.
///
/// `TODO(capture-path)`: capture is not yet part of this trait. The demo source
/// and real hardware currently differ in their capture entry points
/// (`capture_streaming_with_analyzers` versus `capture_with_trace_streaming`),
/// and unifying them touches the hot path, so it is deliberately deferred.
/// Until then the Tauri command layer still branches on device kind for capture.
pub trait DeviceDriver: Send + Sync {
    /// Static declaration. Must be cheap and allocation-free on repeat calls.
    fn descriptor(&self) -> &DeviceDescriptor;

    /// Enumerate the devices this driver can currently reach.
    ///
    /// An `Err` means "nothing available" and is treated as an empty list by the
    /// registry, so a driver whose transport is missing (no USB permission, no
    /// sidecar binary) does not prevent other drivers from enumerating.
    fn list_devices(&self) -> Result<Vec<DeviceInfo>>;

    /// Capabilities for a single device.
    ///
    /// Only called with ids previously returned by [`DeviceDriver::list_devices`].
    fn capabilities(&self, device_id: &str) -> Result<HardwareCaptureCapabilities>;

    /// Put the device into a capturable state. Must be idempotent: the host may
    /// call it before every capture.
    ///
    /// `sink` receives progress diagnostics; drivers that have nothing to report
    /// may ignore it.
    fn prepare(&self, device_id: &str, sink: &mut dyn FnMut(DiagnosticEvent)) -> Result<()> {
        let _ = (device_id, sink);
        Ok(())
    }

    /// Release the device. Called on session teardown.
    fn stop(&self, device_id: &str) -> Result<()> {
        let _ = device_id;
        Ok(())
    }

    /// Drop any cached per-device state, forcing the next [`DeviceDriver::prepare`]
    /// to do real work again.
    ///
    /// The host calls this after a transport error or a device unplug, where a
    /// cached "already prepared" answer would be a lie. A sidecar driver should
    /// forward this to its child process.
    fn invalidate(&self, device_id: &str) {
        let _ = device_id;
    }

    /// Whether this driver owns `device_id`.
    ///
    /// The default implementation routes by device-id scheme. Override it when a
    /// driver needs finer routing than a scheme prefix can express.
    fn owns_device(&self, device_id: &str) -> bool {
        let Some((scheme, _)) = device_id.split_once(':') else {
            return false;
        };
        self.descriptor().id_schemes.iter().any(|owned| owned == scheme)
    }
}

/// Ordered collection of drivers, and the only dispatch point for device ids.
///
/// Order matters only for [`DeviceDriver::owns_device`] conflicts, which
/// [`DeviceRegistry::new`] rejects up front.
#[derive(Clone)]
pub struct DeviceRegistry {
    drivers: Vec<Arc<dyn DeviceDriver>>,
}

impl DeviceRegistry {
    /// Build a registry, rejecting drivers whose id schemes collide.
    ///
    /// A collision would make routing ambiguous, so it is treated as a
    /// programming error rather than silently resolved by order.
    pub fn new(drivers: Vec<Arc<dyn DeviceDriver>>) -> Result<Self> {
        let mut seen: Vec<&str> = Vec::new();
        for driver in &drivers {
            for scheme in &driver.descriptor().id_schemes {
                if seen.contains(&scheme.as_str()) {
                    return Err(CoreError::Decode(format!(
                        "device id scheme '{scheme}' is claimed by more than one driver"
                    )));
                }
                seen.push(scheme);
            }
        }
        Ok(Self { drivers })
    }

    /// Registry holding the first-party drivers this build supports.
    ///
    /// Adding a vendor driver means adding one entry here — or, once the sidecar
    /// manifest format exists, loading it from a `device.json`. Neither the UI nor
    /// the Tauri command layer has to change.
    ///
    /// Id schemes are known-disjoint at compile time, so this cannot fail; the
    /// fallible [`DeviceRegistry::new`] is for callers supplying their own set.
    pub fn with_builtin_drivers() -> Self {
        // Built as one expression rather than `let mut` + conditional `push`: when
        // `rusb-transport` is off (which is how `sigpilot-graph` pulls this crate in)
        // a conditional push would leave the binding needlessly mutable.
        let drivers: Vec<Arc<dyn DeviceDriver>> = vec![
            Arc::new(crate::fake::FakeDriver::new()),
            #[cfg(feature = "rusb-transport")]
            Arc::new(crate::rusb_backend::PxlogicDriver::new()),
            #[cfg(feature = "rusb-transport")]
            Arc::new(crate::kingst_la2016::KingstLa2016Driver::new()),
        ];
        Self { drivers }
    }

    /// Registered drivers, in registration order.
    pub fn drivers(&self) -> &[Arc<dyn DeviceDriver>] {
        &self.drivers
    }

    /// Enumerate every reachable device across all drivers.
    ///
    /// Drivers that fail to enumerate contribute nothing rather than aborting the
    /// whole scan — a missing USB permission or sidecar must not hide the demo
    /// source.
    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        let mut devices = Vec::new();
        for driver in &self.drivers {
            match driver.list_devices() {
                Ok(mut found) => devices.append(&mut found),
                Err(_) => continue,
            }
        }
        devices
    }

    /// The driver that owns `device_id`, if any.
    pub fn driver_for(&self, device_id: &str) -> Option<&Arc<dyn DeviceDriver>> {
        self.drivers.iter().find(|driver| driver.owns_device(device_id))
    }

    /// Capabilities for `device_id`.
    pub fn capabilities(&self, device_id: &str) -> Result<HardwareCaptureCapabilities> {
        let driver = self
            .driver_for(device_id)
            .ok_or(CoreError::UnsupportedDevice)?;
        driver.capabilities(device_id)
    }

    /// Prepare `device_id` for capture.
    pub fn prepare(
        &self,
        device_id: &str,
        sink: &mut dyn FnMut(DiagnosticEvent),
    ) -> Result<()> {
        let driver = self
            .driver_for(device_id)
            .ok_or(CoreError::UnsupportedDevice)?;
        driver.prepare(device_id, sink)
    }

    /// Release `device_id`.
    pub fn stop(&self, device_id: &str) -> Result<()> {
        let driver = self
            .driver_for(device_id)
            .ok_or(CoreError::UnsupportedDevice)?;
        driver.stop(device_id)
    }

    /// Drop cached per-device state. A no-op for unknown device ids, because the
    /// caller is usually reacting to a device that has just disappeared.
    pub fn invalidate(&self, device_id: &str) {
        if let Some(driver) = self.driver_for(device_id) {
            driver.invalidate(device_id);
        }
    }
}

impl std::fmt::Debug for DeviceRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeviceRegistry")
            .field(
                "drivers",
                &self
                    .drivers
                    .iter()
                    .map(|driver| driver.descriptor().driver_id.as_str())
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DeviceKind, HardwareChannelModeInfo};

    struct StubDriver {
        descriptor: DeviceDescriptor,
        devices: Vec<DeviceInfo>,
        fail_scan: bool,
        invalidations: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl StubDriver {
        fn new(driver_id: &str, scheme: &str, device_ids: &[&str]) -> Self {
            Self {
                descriptor: DeviceDescriptor {
                    driver_id: driver_id.to_string(),
                    display_name: driver_id.to_string(),
                    protocol_version: DeviceDescriptor::PROTOCOL_VERSION,
                    vendor: None,
                    isolation: DriverIsolation::InProcess,
                    id_schemes: vec![scheme.to_string()],
                },
                devices: device_ids.iter().map(|id| stub_device(id)).collect(),
                fail_scan: false,
                invalidations: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }

        fn failing(driver_id: &str, scheme: &str) -> Self {
            Self {
                fail_scan: true,
                ..Self::new(driver_id, scheme, &[])
            }
        }
    }

    fn stub_device(id: &str) -> DeviceInfo {
        DeviceInfo {
            id: id.to_string(),
            kind: DeviceKind::Fake,
            vid: 0,
            pid: 0,
            bus: None,
            address: None,
            label: id.to_string(),
            ready: true,
            manufacturer: None,
            product: None,
            serial_number: None,
            usb_speed: None,
            logic_mode: None,
            profile_model: None,
            probe_error: None,
        }
    }

    fn stub_capabilities(device_id: &str) -> HardwareCaptureCapabilities {
        HardwareCaptureCapabilities {
            device_id: device_id.to_string(),
            profile_vendor: None,
            profile_model: Some(device_id.to_string()),
            usb_speed: None,
            logic_mode: None,
            max_channels: 8,
            default_channel_count: 8,
            default_sample_rate_hz: 1_000_000,
            sample_rates: vec![1_000_000],
            threshold_volts: vec![3.3],
            channel_modes: Vec::<HardwareChannelModeInfo>::new(),
        }
    }

    impl DeviceDriver for StubDriver {
        fn descriptor(&self) -> &DeviceDescriptor {
            &self.descriptor
        }

        fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
            if self.fail_scan {
                return Err(CoreError::UnsupportedDevice);
            }
            Ok(self.devices.clone())
        }

        fn capabilities(&self, device_id: &str) -> Result<HardwareCaptureCapabilities> {
            if self.devices.iter().any(|device| device.id == device_id) {
                Ok(stub_capabilities(device_id))
            } else {
                Err(CoreError::UnsupportedDevice)
            }
        }

        fn invalidate(&self, device_id: &str) {
            if self.devices.iter().any(|device| device.id == device_id) {
                self.invalidations
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    fn registry(drivers: Vec<Arc<dyn DeviceDriver>>) -> DeviceRegistry {
        DeviceRegistry::new(drivers).expect("stub schemes are disjoint")
    }

    #[test]
    fn routes_a_device_id_to_its_owning_driver() {
        let registry = registry(vec![
            Arc::new(StubDriver::new("fake", "fake", &["fake:demo"])),
            Arc::new(StubDriver::new("pxlogic", "usb", &["usb:1a86:5237:1:4"])),
        ]);

        assert_eq!(
            registry.driver_for("usb:1a86:5237:1:4").unwrap().descriptor().driver_id,
            "pxlogic"
        );
        assert_eq!(
            registry.driver_for("fake:demo").unwrap().descriptor().driver_id,
            "fake"
        );
        assert!(registry.driver_for("sigrok:something").is_none());
    }

    #[test]
    fn rejects_an_id_without_a_scheme() {
        let registry = registry(vec![Arc::new(StubDriver::new("fake", "fake", &[]))]);
        assert!(registry.driver_for("no-scheme-here").is_none());
    }

    #[test]
    fn lists_devices_from_every_driver() {
        let registry = registry(vec![
            Arc::new(StubDriver::new("fake", "fake", &["fake:demo"])),
            Arc::new(StubDriver::new("pxlogic", "usb", &["usb:a", "usb:b"])),
        ]);

        let ids: Vec<String> = registry
            .list_devices()
            .into_iter()
            .map(|device| device.id)
            .collect();
        assert_eq!(ids, vec!["fake:demo", "usb:a", "usb:b"]);
    }

    #[test]
    fn a_failing_driver_does_not_hide_the_others() {
        let registry = registry(vec![
            Arc::new(StubDriver::failing("pxlogic", "usb")),
            Arc::new(StubDriver::new("fake", "fake", &["fake:demo"])),
        ]);

        let ids: Vec<String> = registry
            .list_devices()
            .into_iter()
            .map(|device| device.id)
            .collect();
        assert_eq!(ids, vec!["fake:demo"]);
    }

    #[test]
    fn capabilities_reject_an_unknown_device() {
        let registry = registry(vec![Arc::new(StubDriver::new("fake", "fake", &["fake:demo"]))]);
        assert!(registry.capabilities("fake:demo").is_ok());
        assert!(registry.capabilities("usb:nope").is_err());
    }

    #[test]
    fn default_prepare_and_stop_are_no_ops() {
        let registry = registry(vec![Arc::new(StubDriver::new("fake", "fake", &["fake:demo"]))]);
        assert!(registry.prepare("fake:demo", &mut |_| {}).is_ok());
        assert!(registry.stop("fake:demo").is_ok());
        assert!(registry.prepare("usb:nope", &mut |_| {}).is_err());
    }

    #[test]
    fn invalidate_reaches_only_the_owning_driver() {
        let fake = StubDriver::new("fake", "fake", &["fake:demo"]);
        let invalidations = fake.invalidations.clone();
        let registry = registry(vec![Arc::new(fake)]);

        registry.invalidate("fake:demo");
        assert_eq!(invalidations.load(std::sync::atomic::Ordering::SeqCst), 1);

        // An unknown device must be a silent no-op, not a panic: the host calls
        // this while reacting to a device that has already disappeared.
        registry.invalidate("usb:gone");
        assert_eq!(invalidations.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn rejects_overlapping_id_schemes() {
        let error = DeviceRegistry::new(vec![
            Arc::new(StubDriver::new("a", "usb", &[])),
            Arc::new(StubDriver::new("b", "usb", &[])),
        ])
        .expect_err("duplicate scheme must be rejected");
        assert!(error.to_string().contains("usb"));
    }

    #[test]
    fn descriptor_round_trips_through_serde() {
        let descriptor = DeviceDescriptor {
            driver_id: "pxlogic".to_string(),
            display_name: "PXLogic".to_string(),
            protocol_version: DeviceDescriptor::PROTOCOL_VERSION,
            vendor: Some("PX_Tool".to_string()),
            isolation: DriverIsolation::Sidecar,
            id_schemes: vec!["usb".to_string()],
        };

        let encoded = serde_json::to_string(&descriptor).expect("descriptor serializes");
        let decoded: DeviceDescriptor =
            serde_json::from_str(&encoded).expect("descriptor deserializes");
        assert_eq!(decoded, descriptor);
        assert!(encoded.contains("\"sidecar\""));
    }
}
