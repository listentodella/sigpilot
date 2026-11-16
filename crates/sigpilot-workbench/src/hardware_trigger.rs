//! Offline profiles and compilation share the finite rule model with replay.
//! No DeviceRegistry enumeration, preparation, or capture lifecycle is called.
use crate::{Result, WorkbenchError, WorkbenchService};
use serde_json::{json, Value};
use sigpilot_analysis::{
    hardware_trigger::{compile_checked, HardwareTriggerCompiler, HardwareTriggerTarget},
    trigger::TriggerRule,
};
use std::sync::{atomic::AtomicBool, Arc};
impl WorkbenchService {
    pub fn hardware_trigger_capabilities(&self) -> Value {
        json!({"profiles":self.hardware_triggers.read().catalog(),"scope":"offline_driver_profiles","hardware_verified":false,
            "max_profiles":64,"max_catalog_bytes":"65536","max_compile_input_bytes":"16384","max_compile_output_bytes":"65536",
            "no_capture_control":true,"registration":"trusted_rust_host_only"})
    }
    pub fn register_hardware_trigger_compiler(
        &self,
        compiler: Arc<dyn HardwareTriggerCompiler>,
    ) -> Result<()> {
        self.hardware_triggers
            .write()
            .register(compiler)
            .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))
    }
    pub fn compile_trigger(
        &self,
        target: &HardwareTriggerTarget,
        rule: &TriggerRule,
    ) -> Result<Value> {
        self.compile_trigger_with_cancel(target, rule, &AtomicBool::new(false))
    }
    pub fn compile_trigger_with_cancel(
        &self,
        target: &HardwareTriggerTarget,
        rule: &TriggerRule,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        crate::check_cancelled(cancel)?;
        let compiler = self
            .hardware_triggers
            .read()
            .get(&target.profile_id)
            .ok_or(WorkbenchError::TriggerProfileNotFound)?;
        let result = compile_checked(compiler.as_ref(), target, rule, cancel)
            .map_err(WorkbenchError::from)?;
        crate::check_cancelled(cancel)?;
        Ok(json!({"schema_version":"1","rule":rule,"compilation":result}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use sigpilot_analysis::{
        hardware_trigger::TargetMode,
        trigger::{Event, Step},
        EdgeDirection,
    };
    #[test]
    fn compilation_requires_an_explicit_registered_profile_and_leaves_the_workbench_unchanged() {
        let service = crate::tests::service();
        let before = service.gui_snapshot("session-a").unwrap();
        let events = service.subscribe().unwrap();
        let profiles = service.hardware_trigger_capabilities();
        let id = profiles["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["driver_id"] == "pxlogic")
            .unwrap()["profile_id"]
            .as_str()
            .unwrap();
        let mut target = HardwareTriggerTarget {
            profile_id: id.into(),
            mode: TargetMode::Buffer,
            channel_count: 8,
            enabled_channels: vec![0],
            sample_rate_hz: 1_000_000.into(),
        };
        let rule = TriggerRule {
            schema_version: "1".into(),
            steps: vec![Step {
                event: Event::Edge {
                    channel: 0,
                    direction: EdgeDirection::Rising,
                },
                guards: vec![],
                within: None,
            }],
            holdoff_samples: 0.into(),
        };
        let result = service.compile_trigger(&target, &rule).unwrap();
        assert_eq!(result["compilation"]["status"], "supported");
        assert_eq!(result["compilation"]["applied"], false);
        let after = service.gui_snapshot("session-a").unwrap();
        assert_eq!(before.context.capture, after.context.capture);
        assert_eq!(
            before.context.annotation_revision,
            after.context.annotation_revision
        );
        assert!(after.annotations.is_empty());
        assert!(matches!(
            events.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        target.profile_id = "invented".into();
        assert!(matches!(
            service.compile_trigger(&target, &rule),
            Err(WorkbenchError::TriggerProfileNotFound)
        ));
    }
}
