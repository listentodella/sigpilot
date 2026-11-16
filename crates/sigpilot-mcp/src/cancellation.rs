//! Bridge MCP cancellation to synchronous, cooperative domain reads.
use rmcp::service::{RequestContext, RoleServer};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Keep the worker (and its semaphore permit) alive until it actually stops.
/// Aborting/dropping the handler also signals the worker. Once dispatched,
/// mutations ignore this flag and return their actual commit result; submitted
/// jobs use their own cancellation flags. No timeout can forcibly stop host Rust.
pub(crate) async fn run_blocking<T: Send + 'static>(
    context: RequestContext<RoleServer>,
    operation: impl FnOnce(&AtomicBool) -> T + Send + 'static,
) -> std::result::Result<T, tokio::task::JoinError> {
    let flag = Arc::new(AtomicBool::new(context.ct.is_cancelled()));
    let _guard = CancelOnDrop(flag.clone());
    let worker_flag = flag.clone();
    let mut worker = tokio::task::spawn_blocking(move || operation(&worker_flag));
    tokio::select! {
        biased;
        result = &mut worker => result,
        _ = context.ct.cancelled() => {
            flag.store(true, Ordering::Release);
            worker.await
        }
    }
}
