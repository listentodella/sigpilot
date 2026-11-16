//! Deterministic, bounded signal analysis shared by desktop and MCP adapters.
//! No device access, worker pools, or GUI dependencies live here.

pub mod coordinates;
pub mod correlation;
pub mod edges;
pub mod frames;
pub mod hardware_trigger;
pub mod measure;
pub mod protocol;
pub mod providers;
pub mod timing;
pub mod trigger;
mod trigger_level;
mod trigger_search;

pub use coordinates::{ExactU64, SampleRange, TimeOffset, TimeRounding, TimeUnit};
pub use edges::{query_edges, scan_pulses, EdgeDirection, EdgeEvent, Pulse, PulseQuery};

#[derive(Debug, thiserror::Error)]
pub enum AnalysisError {
    #[error("invalid analysis input: {0}")]
    InvalidInput(String),
    #[error("integer arithmetic overflow")]
    Overflow,
    #[error("requested time is not on the sampling grid")]
    NonIntegralTime,
    #[error("analysis was cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, AnalysisError>;
