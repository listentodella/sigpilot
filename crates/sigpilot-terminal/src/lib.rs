//! A single user-owned, bounded PTY session. No agent or shell is bundled.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::Duration,
};

const OUTPUT_BUDGET: usize = 256 * 1024;
const POLL_BUDGET: usize = 64 * 1024;
const INPUT_BUDGET: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
pub struct TerminalOutput {
    /// Raw bytes preserve UTF-8 and escape sequences across read boundaries.
    pub data: Vec<u8>,
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    reader_done: bool,
    child_done: bool,
    exit_code: Option<u32>,
    error: Option<String>,
}

struct Session {
    info: SessionInfo,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    output: Mutex<Output>,
    space: Condvar,
    closing: AtomicBool,
}

impl Session {
    fn start(id: String, cwd: &Path, cols: u16, rows: u16) -> Result<Arc<Self>, String> {
        let mut command = CommandBuilder::new_default_prog();
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "SigPilot");
        // AppImage loader paths belong to SigPilot, not the user's commands.
        for key in [
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "DYLD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
        ] {
            command.env_remove(key);
        }
        let info = SessionInfo {
            id,
            shell: command.get_shell(),
            cwd: cwd.to_string_lossy().into_owned(),
        };
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(error)?;
        // Prepare master handles before spawning, so failures leave no child.
        let reader = pair.master.try_clone_reader().map_err(error)?;
        let writer = pair.master.take_writer().map_err(error)?;
        let child = pair.slave.spawn_command(command).map_err(error)?;
        drop(pair.slave);
        let session = Arc::new(Self {
            info,
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(child)),
            output: Mutex::new(Output::default()),
            space: Condvar::new(),
            closing: AtomicBool::new(false),
        });
        let reader_session = session.clone();
        if let Err(e) = thread::Builder::new()
            .name("terminal-output".into())
            .spawn(move || {
                reader_session.read(reader);
            })
        {
            session.close();
            return Err(error(e));
        }
        let waiter_session = session.clone();
        if let Err(e) = thread::Builder::new()
            .name("terminal-exit".into())
            .spawn(move || {
                waiter_session.wait();
            })
        {
            session.close();
            return Err(error(e));
        }
        Ok(session)
    }

    fn read(&self, mut reader: Box<dyn Read + Send>) {
        let mut buffer = [0; 8192];
        loop {
            if self.closing.load(Ordering::Acquire) {
                break;
            }
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let mut output = self.output.lock().unwrap();
                    while output.bytes.len() + length > OUTPUT_BUDGET
                        && !self.closing.load(Ordering::Acquire)
                    {
                        output = self.space.wait(output).unwrap();
                    }
                    if self.closing.load(Ordering::Acquire) {
                        break;
                    }
                    output.bytes.extend(&buffer[..length]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    // Linux PTYs report EIO when the slave closes normally.
                    #[cfg(unix)]
                    if e.raw_os_error() == Some(libc::EIO) {
                        break;
                    }
                    if !self.closing.load(Ordering::Acquire) {
                        self.output.lock().unwrap().error = Some(error(e));
                    }
                    break;
                }
            }
        }
        self.output.lock().unwrap().reader_done = true;
    }

    fn wait(&self) {
        loop {
            let mut child = self.child.lock().unwrap();
            let status = match child.as_mut() {
                Some(child) => child.try_wait(),
                None => break,
            };
            match status {
                Ok(Some(status)) => {
                    let mut output = self.output.lock().unwrap();
                    output.child_done = true;
                    output.exit_code = Some(status.exit_code());
                    break;
                }
                Err(e) => {
                    let mut output = self.output.lock().unwrap();
                    output.child_done = true;
                    output.error = Some(error(e));
                    break;
                }
                Ok(None) => {}
            }
            drop(child);
            thread::sleep(Duration::from_millis(40));
        }
    }

    fn poll(&self) -> TerminalOutput {
        let mut output = self.output.lock().unwrap();
        let count = output.bytes.len().min(POLL_BUDGET);
        let data = output.bytes.drain(..count).collect();
        let result = TerminalOutput {
            data,
            exited: output.child_done && output.reader_done && output.bytes.is_empty(),
            exit_code: output.exit_code,
            error: output.error.clone(),
        };
        self.space.notify_all();
        result
    }

    fn close(&self) {
        if self.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        self.space.notify_all();
        // Serialize termination with try_wait, before the child PID is reaped.
        if let Some(mut child) = self.child.lock().unwrap().take() {
            if matches!(child.try_wait(), Ok(None)) {
                #[cfg(unix)]
                {
                    let master = self.master.lock().unwrap();
                    if let Some(master) = master.as_ref() {
                        if let Some(fd) = master.as_raw_fd() {
                            let foreground = unsafe { libc::tcgetpgrp(fd) };
                            if foreground > 0 && foreground != unsafe { libc::getpgrp() } {
                                unsafe {
                                    libc::kill(-foreground, libc::SIGKILL);
                                }
                            }
                        }
                    }
                    if let Some(pid) = child.process_id() {
                        if pid > 1 && pid as i32 != unsafe { libc::getpgrp() } {
                            unsafe {
                                libc::kill(-(pid as i32), libc::SIGKILL);
                            }
                        }
                    }
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        // Closing the PTY wakes its reader. Input is capped and runs off the UI thread.
        self.writer.lock().unwrap().take();
        self.master.lock().unwrap().take();
    }
}

/// Only one shell per desktop window. A stale session ID cannot affect a new shell.
#[derive(Default)]
pub struct TerminalManager {
    session: Mutex<Option<Arc<Session>>>,
    next_id: AtomicU64,
}

impl TerminalManager {
    pub fn open(&self, cwd: &Path, cols: u16, rows: u16) -> Result<SessionInfo, String> {
        let mut current = self.session.lock().unwrap();
        if let Some(session) = current.as_ref() {
            return Ok(session.info.clone());
        }
        if !cwd.is_dir() {
            return Err("Terminal working directory does not exist".into());
        }
        let id = self
            .next_id
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1)
            .to_string();
        let session = Session::start(id, cwd, cols, rows)?;
        let info = session.info.clone();
        *current = Some(session);
        Ok(info)
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.session
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.info.id == id)
            .cloned()
            .ok_or_else(|| "Terminal session is no longer available".into())
    }

    pub fn poll(&self, id: &str) -> Result<TerminalOutput, String> {
        Ok(self.get(id)?.poll())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        if data.len() > INPUT_BUDGET {
            return Err("Terminal input exceeds 64 KiB".into());
        }
        let session = self.get(id)?;
        if session.closing.load(Ordering::Acquire) || session.output.lock().unwrap().child_done {
            return Err("Terminal shell has exited".into());
        }
        let mut writer = session.writer.lock().unwrap();
        let writer = writer.as_mut().ok_or("Terminal is closed")?;
        writer.write_all(data).map_err(error)?;
        writer.flush().map_err(error)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let size = size(cols, rows)?;
        let session = self.get(id)?;
        let master = session.master.lock().unwrap();
        master
            .as_ref()
            .ok_or("Terminal is closed")?
            .resize(size)
            .map_err(error)
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let mut current = self.session.lock().unwrap();
        if current.as_ref().is_some_and(|s| s.info.id != id) {
            return Err("Terminal session is no longer available".into());
        }
        if let Some(session) = current.take() {
            session.close();
        }
        Ok(())
    }

    pub fn close_all(&self) {
        if let Some(session) = self.session.lock().unwrap().take() {
            session.close();
        }
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(1..=200).contains(&rows) {
        return Err("Terminal dimensions must be 2..500 columns and 1..200 rows".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
