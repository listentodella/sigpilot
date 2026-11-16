//! One explicitly owned Unix child, bounded pipes, memory, CPU and deadline.
//! No persistent decoder pool or global cancellation registry is used.
use crate::jobs::JobFailure;
use std::{
    io::{self, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const PROCESS_INPUT_BYTES: usize = 2 * 1024 * 1024;
pub const PROCESS_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
pub const PROCESS_MEMORY_BYTES: u64 = 512 * 1024 * 1024;
pub const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);

struct OwnedChild(Child, bool);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.1 {
            return;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn read_bounded(
    mut pipe: impl Read,
    limit: usize,
    overflow: Arc<AtomicBool>,
) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    pipe.by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut output)?;
    if output.len() > limit {
        overflow.store(true, Ordering::Release);
        output.truncate(limit);
    }
    Ok(output)
}

#[cfg(unix)]
pub fn run(
    path: &Path,
    root: &Path,
    input: Vec<u8>,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, JobFailure> {
    use std::os::unix::process::CommandExt;
    if input.len() > PROCESS_INPUT_BYTES {
        return Err(JobFailure::new(
            "RESOURCE_LIMIT",
            "decoder input exceeds 2 MiB",
        ));
    }
    if cancel.load(Ordering::Acquire) {
        return Err(JobFailure::new(
            "CANCELLED",
            "job cancelled before starting decoder",
        ));
    }
    let mut command = Command::new(path);
    command
        .args(["--runtime-root"])
        .arg(root)
        .arg("--decode")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Only async-signal-safe syscalls execute between fork and exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            for (resource, max) in [
                (libc::RLIMIT_AS, PROCESS_MEMORY_BYTES),
                (libc::RLIMIT_CPU, 30),
                (libc::RLIMIT_NOFILE, 64),
                (libc::RLIMIT_CORE, 0),
            ] {
                let limit = libc::rlimit {
                    rlim_cur: max as libc::rlim_t,
                    rlim_max: max as libc::rlim_t,
                };
                if libc::setrlimit(resource, &limit) != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            #[cfg(target_os = "linux")]
            {
                let parent = libc::getppid();
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != parent || parent == 1 {
                    libc::_exit(125);
                }
            }
            Ok(())
        });
    }
    let mut child = OwnedChild(
        command
            .spawn()
            .map_err(|e| JobFailure::new("DECODER_ERROR", e.to_string()))?,
        false,
    );
    let stdin = child.0.stdin.take().unwrap();
    let stdout = child.0.stdout.take().unwrap();
    let stderr = child.0.stderr.take().unwrap();
    let overflow = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    // Scoped helpers are reaped after terminating this process group, including
    // descendants that might still hold stdout/stdin open.
    std::thread::scope(|scope| {
        let writer = scope.spawn(move || {
            let mut pipe = stdin;
            pipe.write_all(&input)
        });
        let out_overflow = overflow.clone();
        let reader = scope.spawn(move || read_bounded(stdout, PROCESS_OUTPUT_BYTES, out_overflow));
        let err_overflow = overflow.clone();
        let errors = scope.spawn(move || read_bounded(stderr, 16 * 1024, err_overflow));
        let mut status = None;
        let mut failure = None;
        loop {
            if cancel.load(Ordering::Acquire) {
                failure = Some(JobFailure::new("CANCELLED", "decoder job cancelled"));
                break;
            }
            if overflow.load(Ordering::Acquire) {
                failure = Some(JobFailure::new(
                    "RESOURCE_LIMIT",
                    "decoder output exceeded pipe budget",
                ));
                break;
            }
            if started.elapsed() >= PROCESS_TIMEOUT {
                failure = Some(JobFailure::new(
                    "TIMEOUT",
                    "decoder exceeded 30-second deadline",
                ));
                break;
            }
            match child.0.try_wait() {
                Ok(Some(exit)) => {
                    status = Some(exit);
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    failure = Some(JobFailure::new("DECODER_ERROR", e.to_string()));
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Even a successful parent may leave a descendant with inherited pipes.
        unsafe {
            libc::kill(-(child.0.id() as i32), libc::SIGKILL);
        }
        let _ = child.0.kill();
        let _ = child.0.wait();
        child.1 = true;
        let write_result = writer
            .join()
            .map_err(|_| JobFailure::new("INTERNAL_ERROR", "decoder writer panicked"))?;
        let output = reader
            .join()
            .map_err(|_| JobFailure::new("INTERNAL_ERROR", "decoder reader panicked"))?
            .map_err(|e| JobFailure::new("DECODER_ERROR", e.to_string()))?;
        let stderr = errors
            .join()
            .map_err(|_| JobFailure::new("INTERNAL_ERROR", "decoder stderr reader panicked"))?
            .map_err(|e| JobFailure::new("DECODER_ERROR", e.to_string()))?;
        if let Some(error) = failure {
            return Err(error);
        }
        if overflow.load(Ordering::Acquire) {
            return Err(JobFailure::new(
                "RESOURCE_LIMIT",
                "decoder output exceeded pipe budget",
            ));
        }
        if !status.is_some_and(|s| s.success()) {
            return Err(JobFailure::new(
                "DECODER_ERROR",
                String::from_utf8_lossy(&stderr).into_owned(),
            ));
        }
        write_result.map_err(|e| JobFailure::new("DECODER_ERROR", e.to_string()))?;
        Ok(output)
    })
}

#[cfg(not(unix))]
pub fn run(_: &Path, _: &Path, _: Vec<u8>, _: &AtomicBool) -> Result<Vec<u8>, JobFailure> {
    Err(JobFailure::new(
        "UNSUPPORTED_PLATFORM",
        "isolated decoder resource limits require Unix in this release",
    ))
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
    pub struct Script(pub PathBuf);
    impl Script {
        pub fn new(body: &str) -> Self {
            let directory = std::env::temp_dir()
                .join(format!("sigpilot-child-{}", uuid::Uuid::new_v4().simple()));
            fs::create_dir(&directory).unwrap();
            let path = directory.join("decoder");
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
        pub fn root(&self) -> &Path {
            self.0.parent().unwrap()
        }
    }
    impl Drop for Script {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.root());
        }
    }
    #[test]
    fn process_output_budget_and_requested_cancellation_are_enforced() {
        let output = Script::new("cat >/dev/null\nhead -c 2097153 /dev/zero");
        let error = run(
            &output.0,
            output.root(),
            b"{}".to_vec(),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error.code, "RESOURCE_LIMIT");
        let slow = Script::new("cat >/dev/null\nsleep 60");
        let cancel = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(30));
                cancel.store(true, Ordering::Release);
            });
            let started = Instant::now();
            assert_eq!(
                run(&slow.0, slow.root(), b"{}".to_vec(), &cancel)
                    .unwrap_err()
                    .code,
                "CANCELLED"
            );
            assert!(started.elapsed() < Duration::from_secs(2));
        });
    }
}
