//! Concurrent bulk-IN transfers, for a device whose own buffering is too small.
//!
//! # Why this exists
//!
//! A synchronous `read_bulk` keeps one transfer in flight at a time. Between one
//! completing and the next being submitted, the endpoint has nowhere to put
//! data, and a device with only a small FIFO overflows in that window and stops.
//!
//! That is not a theoretical concern. The Kingst LA series tolerates about two
//! milliseconds of host stall before its stream dies, and what survives a longer
//! one is exactly 4,096 bytes — one endpoint buffer and no more. An OS scheduling
//! delay is enough to end a capture, which is why the same configuration runs for
//! ten seconds one time and one second the next, at every sample rate.
//!
//! A pool of transfers submitted together removes the window: the device always
//! has a queue of requests waiting, so host jitter is absorbed by the host's
//! buffering instead of overflowing the device's. The reference driver for the LA
//! series keeps eight 512 KiB transfers in flight for exactly this reason — four
//! megabytes of slack against the device's four kilobytes.
//!
//! A second difference matters as much: a transfer that reaches its timeout
//! reports whatever it received in `actual_length`, and that data is kept. The
//! synchronous API cancels on timeout and throws the bytes away.
//!
//! # Scope
//!
//! Deliberately device-agnostic. Anything that holds a [`rusb::DeviceHandle`] and
//! has a bulk IN endpoint can use this; nothing here knows what a logic analyser
//! is. The caller supplies the endpoint, the transfer size and the pool depth.
//!
//! # Threading
//!
//! Everything runs on the thread that calls [`BulkInPool::service`], because
//! libusb invokes transfer callbacks from inside its event handling. No worker
//! thread and no channel are involved, so the caller's callback runs where it
//! expects and chunks arrive in the order the device produced them.
//!
//! Only one thread may service a given libusb context at a time. That is a
//! libusb rule, not one of ours; a concurrent synchronous transfer on the same
//! context will make [`BulkInPool::service`] report a transient error rather than
//! corrupt anything.

use std::{
    os::raw::c_void,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use libc::timeval;
use libusb1_sys::{
    constants::{
        LIBUSB_ERROR_BUSY, LIBUSB_TRANSFER_CANCELLED, LIBUSB_TRANSFER_COMPLETED,
        LIBUSB_TRANSFER_NO_DEVICE, LIBUSB_TRANSFER_TIMED_OUT,
    },
    libusb_alloc_transfer, libusb_cancel_transfer, libusb_fill_bulk_transfer, libusb_free_transfer,
    libusb_handle_events_timeout_completed, libusb_submit_transfer, libusb_transfer,
};
use rusb::{DeviceHandle, UsbContext};

use crate::error::{CoreError, Result};

/// Pool depth the reference LA-series driver uses, and a sane default here.
pub const DEFAULT_POOL_DEPTH: usize = 8;

/// How long one transfer may wait before libusb hands back what it has.
///
/// Not a deadline for the capture: a stream is meant to run until the caller
/// stops it. This only bounds how long a transfer stays outstanding before its
/// partial contents are delivered and it is resubmitted.
pub const DEFAULT_TRANSFER_TIMEOUT: Duration = Duration::from_millis(500);

/// How long [`BulkInPool::stop`] waits for cancelled transfers to come back
/// before it gives up and leaks them.
const RECLAIM_TIMEOUT: Duration = Duration::from_secs(2);

/// Slice of time handed to libusb's event loop per iteration. Small enough that
/// the caller's cancellation is noticed promptly, large enough not to spin.
const EVENT_SLICE: Duration = Duration::from_millis(10);

/// What one [`BulkInPool::service`] call delivered.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Delivered {
    /// Transfers that carried data. A transfer that timed out empty does not
    /// count.
    pub transfers: usize,
    pub bytes: usize,
}

/// One completed transfer, waiting to be handed to the caller.
struct Completion {
    slot: usize,
    status: i32,
    bytes: usize,
}

/// State the transfer callback shares with the pool.
struct Shared {
    /// Completions awaiting delivery, in the order they finished.
    ///
    /// Order is the contract this module exists to preserve: bulk transfers on a
    /// single endpoint are filled by the host controller in the order they were
    /// submitted, so completion order is arrival order.
    queue: Mutex<Vec<Completion>>,
    /// Transfers libusb still owns. Nothing may be freed until this reaches zero.
    in_flight: AtomicUsize,
    device_gone: AtomicBool,
}

/// What the callback needs in order to report back. Lives in a `Box` owned by the
/// pool, so its address is stable for as long as libusb holds the transfer.
struct SlotContext {
    slot: usize,
    shared: Arc<Shared>,
}

struct Slot {
    transfer: *mut libusb_transfer,
    /// Raw pointer to a heap buffer. Deliberately not a `Box<[u8]>`: libusb holds
    /// this address until it hands the transfer back, and freeing it early would
    /// be a use-after-free. It is reclaimed in `stop`.
    buffer: *mut u8,
    capacity: usize,
    context: Box<SlotContext>,
    in_flight: bool,
}

/// Called by libusb from inside event handling. Must not panic and must not
/// touch anything the pool may have freed.
extern "system" fn on_transfer_complete(transfer: *mut libusb_transfer) {
    // SAFETY: `user_data` is the `SlotContext` installed in `submit`, and the
    // pool keeps it alive until every transfer has been reclaimed — leaking it
    // rather than freeing it if libusb never reports back.
    let context = unsafe { &*((*transfer).user_data as *const SlotContext) };
    // SAFETY: libusb owns `transfer` for the duration of this call.
    let (status, bytes) = unsafe { ((*transfer).status, (*transfer).actual_length.max(0) as usize) };
    if status == LIBUSB_TRANSFER_NO_DEVICE {
        context.shared.device_gone.store(true, Ordering::Release);
    }
    context.shared.in_flight.fetch_sub(1, Ordering::AcqRel);
    // A poisoned lock must not panic here: this runs inside libusb's event
    // handling, where unwinding is not an option.
    let mut queue = context
        .shared
        .queue
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    queue.push(Completion {
        slot: context.slot,
        status,
        bytes,
    });
}

/// A pool of concurrent bulk-IN transfers on one endpoint.
///
/// Submit once with [`BulkInPool::start`], then call [`BulkInPool::service`] in a
/// loop until the caller wants to stop. Dropping the pool stops it.
pub struct BulkInPool {
    context: *mut libusb1_sys::libusb_context,
    device: *mut libusb1_sys::libusb_device_handle,
    endpoint: u8,
    transfer_timeout_ms: u32,
    slots: Vec<Slot>,
    shared: Arc<Shared>,
    stopped: bool,
}

/// Rejects a pool that could never carry anything, which would otherwise leave
/// the caller waiting on a transfer that cannot complete.
fn check_shape(transfer_size: usize, depth: usize) -> Result<()> {
    if transfer_size == 0 || depth == 0 {
        return Err(CoreError::Usb(
            "a bulk-in pool needs a non-zero transfer size and depth".to_string(),
        ));
    }
    Ok(())
}

impl BulkInPool {
    /// Allocates `depth` transfers of `transfer_size` bytes and submits them.
    ///
    /// `transfer_size` should be sized so a transfer fills in a short, bounded
    /// time at the expected rate — see the PXLogic backend's
    /// `pxview_capture_transfer_size`, which targets ten milliseconds of data.
    /// The pool then tolerates roughly `depth` times that long a stall.
    pub fn start<T: UsbContext>(
        handle: &DeviceHandle<T>,
        endpoint: u8,
        transfer_size: usize,
        depth: usize,
    ) -> Result<Self> {
        check_shape(transfer_size, depth)?;
        let shared = Arc::new(Shared {
            queue: Mutex::new(Vec::new()),
            in_flight: AtomicUsize::new(0),
            device_gone: AtomicBool::new(false),
        });
        let mut pool = Self {
            context: handle.context().as_raw(),
            device: handle.as_raw(),
            endpoint,
            transfer_timeout_ms: DEFAULT_TRANSFER_TIMEOUT.as_millis() as u32,
            slots: Vec::with_capacity(depth),
            shared,
            stopped: false,
        };

        for index in 0..depth {
            // SAFETY: `libusb_alloc_transfer` hands back a transfer this code owns
            // until `libusb_free_transfer`; the buffer is a live heap allocation
            // whose address is kept in the slot.
            let (transfer, buffer) = unsafe {
                let transfer = libusb_alloc_transfer(0);
                if transfer.is_null() {
                    pool.stop();
                    return Err(CoreError::Usb(
                        "cannot allocate a USB transfer for the bulk-in pool".to_string(),
                    ));
                }
                let buffer =
                    Box::into_raw(vec![0u8; transfer_size].into_boxed_slice()) as *mut u8;
                (transfer, buffer)
            };
            pool.slots.push(Slot {
                transfer,
                buffer,
                capacity: transfer_size,
                context: Box::new(SlotContext {
                    slot: index,
                    shared: Arc::clone(&pool.shared),
                }),
                in_flight: false,
            });
        }

        for index in 0..pool.slots.len() {
            pool.submit(index);
        }
        if pool.shared.device_gone.load(Ordering::Acquire) {
            pool.stop();
            return Err(CoreError::Usb(
                "the device disappeared while starting a bulk-in pool".to_string(),
            ));
        }
        Ok(pool)
    }

    /// Hands the newest data to `on_data`, in arrival order, and resubmits each
    /// transfer that came back.
    ///
    /// Blocks until at least one transfer completes or `wait` elapses, so the
    /// caller can bound its own cancellation latency.
    pub fn service(
        &mut self,
        wait: Duration,
        on_data: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<Delivered> {
        let deadline = Instant::now() + wait;
        loop {
            let mut completed = 0i32;
            let mut slice = timeval {
                tv_sec: 0,
                tv_usec: EVENT_SLICE.as_micros() as _,
            };
            // SAFETY: the context outlives the pool — the caller's device handle
            // owns it — and a single thread services this pool.
            let code = unsafe {
                libusb_handle_events_timeout_completed(self.context, &mut slice, &mut completed)
            };
            if code == LIBUSB_ERROR_BUSY {
                // Another thread is inside libusb's event handling for this
                // context. Transient, so wait rather than fail the capture.
                std::thread::sleep(EVENT_SLICE);
            } else if code < 0 {
                return Err(CoreError::Usb(format!(
                    "libusb event handling failed with code {code}"
                )));
            }
            let queued = {
                let queue = self
                    .shared
                    .queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                !queue.is_empty()
            };
            if completed != 0 || queued {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        self.drain(on_data)
    }

    /// Whether libusb has reported the device as gone.
    pub fn device_gone(&self) -> bool {
        self.shared.device_gone.load(Ordering::Acquire)
    }

    /// Delivers everything queued and resubmits those slots.
    fn drain(&mut self, on_data: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<Delivered> {
        let mut delivered = Delivered::default();
        loop {
            let completion = {
                let mut queue = self
                    .shared
                    .queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if queue.is_empty() {
                    break;
                }
                queue.remove(0)
            };
            let slot = &mut self.slots[completion.slot];
            slot.in_flight = false;

            match completion.status {
                // A timeout is not a failure: libusb hands back whatever arrived,
                // and that is the whole reason for not using the synchronous API.
                LIBUSB_TRANSFER_COMPLETED | LIBUSB_TRANSFER_TIMED_OUT => {
                    if completion.bytes > 0 {
                        // SAFETY: the buffer is ours, holds `capacity` bytes, and
                        // libusb just reported `bytes <= capacity` written into it.
                        let chunk = unsafe {
                            std::slice::from_raw_parts(slot.buffer, completion.bytes.min(slot.capacity))
                        };
                        on_data(chunk)?;
                        delivered.transfers += 1;
                        delivered.bytes += chunk.len();
                    }
                }
                LIBUSB_TRANSFER_CANCELLED => {}
                LIBUSB_TRANSFER_NO_DEVICE => {
                    self.shared.device_gone.store(true, Ordering::Release);
                }
                other => {
                    return Err(CoreError::Usb(format!(
                        "USB bulk transfer on endpoint 0x{:02x} failed with status {other}",
                        self.endpoint
                    )));
                }
            }
            self.submit(completion.slot);
        }
        Ok(delivered)
    }

    /// Puts one slot's transfer back in the queue. A no-op if it is already in
    /// flight, which is what makes `drain` safe to call after an error.
    fn submit(&mut self, index: usize) {
        let device = self.device;
        let endpoint = self.endpoint;
        let timeout_ms = self.transfer_timeout_ms;
        let shared = Arc::clone(&self.shared);
        let slot = &mut self.slots[index];
        if slot.in_flight {
            return;
        }
        let user_data = &mut *slot.context as *mut SlotContext as *mut c_void;
        // SAFETY: the transfer was allocated by libusb and is not in flight; the
        // buffer outlives the transfer; `user_data` points at a `SlotContext` the
        // pool keeps alive until every transfer has been reclaimed.
        let code = unsafe {
            libusb_fill_bulk_transfer(
                slot.transfer,
                device,
                endpoint,
                slot.buffer,
                slot.capacity as i32,
                on_transfer_complete,
                user_data,
                timeout_ms,
            );
            shared.in_flight.fetch_add(1, Ordering::AcqRel);
            libusb_submit_transfer(slot.transfer)
        };
        if code < 0 {
            shared.in_flight.fetch_sub(1, Ordering::AcqRel);
            if code == LIBUSB_TRANSFER_NO_DEVICE {
                shared.device_gone.store(true, Ordering::Release);
            } else {
                tracing::warn!(
                    endpoint,
                    code,
                    "cannot submit a bulk-in transfer; the pool is one shallower"
                );
            }
            return;
        }
        slot.in_flight = true;
    }

    /// Cancels every outstanding transfer and reclaims it.
    ///
    /// Idempotent, and called by `Drop`.
    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;

        for slot in &self.slots {
            if slot.in_flight {
                // SAFETY: the transfer is ours and currently in flight.
                unsafe { libusb_cancel_transfer(slot.transfer) };
            }
        }

        // libusb only returns a transfer to us once its callback has run, and
        // freeing it before then would leave libusb writing into freed memory.
        let deadline = Instant::now() + RECLAIM_TIMEOUT;
        while self.shared.in_flight.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
            let mut slice = timeval {
                tv_sec: 0,
                tv_usec: 5_000,
            };
            let mut completed = 0i32;
            // SAFETY: same context, same thread, as `service`.
            unsafe {
                libusb_handle_events_timeout_completed(self.context, &mut slice, &mut completed)
            };
        }

        // Every slot that reported back is safe to free. A slot that never did is
        // leaked instead: a bounded leak on a path that should not happen beats
        // handing libusb a dangling pointer.
        let mut returned = vec![false; self.slots.len()];
        let mut queue = self
            .shared
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for completion in queue.drain(..) {
            returned[completion.slot] = true;
        }
        drop(queue);
        for (index, slot) in self.slots.iter().enumerate() {
            if !slot.in_flight {
                returned[index] = true;
            }
        }

        for (index, slot) in self.slots.drain(..).enumerate() {
            if !returned[index] {
                tracing::warn!(
                    slot = index,
                    "a USB transfer never came back after cancel; leaking it rather than \
                     freeing memory libusb may still write to"
                );
                std::mem::forget(slot.context);
                continue;
            }
            // SAFETY: the transfer is ours again, and the buffer was created by
            // `Box::into_raw` above with exactly this length.
            unsafe {
                libusb_free_transfer(slot.transfer);
                drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                    slot.buffer,
                    slot.capacity,
                )));
            }
        }
    }
}

impl Drop for BulkInPool {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_pool_that_could_never_carry_anything() {
        assert!(check_shape(0, 8).is_err());
        assert!(check_shape(4096, 0).is_err());
        assert!(check_shape(4096, 8).is_ok());
    }
}
