//! Native file clipboard formats; Linux ownership is served by Tauri's GTK loop.

/// Copy a file as a file-manager paste operation, rather than as plain text.
pub fn copy_files(path: &std::path::Path) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        platform::copy_files(path)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err("Native file copying is unsupported on this platform".into())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::{mem::size_of, os::windows::ffi::OsStrExt, path::Path, ptr, time::Duration};
    use windows_sys::Win32::{
        Foundation::{GlobalFree, HGLOBAL, HWND, POINT},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
        },
        UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE},
    };

    // CF_HDROP and DROPFILES have a fixed Win32 ABI; defining them here avoids
    // enabling the unrelated shell/OLE bindings just for this small header.
    const CF_HDROP: u32 = 15;
    #[repr(C)]
    struct DropFiles {
        files_offset: u32,
        point: POINT,
        non_client: i32,
        wide: i32,
    }

    struct Allocation(HGLOBAL);
    impl Drop for Allocation {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { GlobalFree(self.0) };
            }
        }
    }
    struct Owner(HWND);
    impl Drop for Owner {
        fn drop(&mut self) {
            unsafe { DestroyWindow(self.0) };
        }
    }
    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }
    fn error(operation: &str) -> String {
        format!("{operation}: {}", std::io::Error::last_os_error())
    }

    pub(super) fn copy_files(path: &Path) -> Result<(), String> {
        let path = std::path::absolute(path).map_err(|e| format!("Invalid file path: {e}"))?;
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err("File path contains a NUL character".into());
        }
        wide.extend_from_slice(&[0, 0]);
        let bytes = wide
            .len()
            .checked_mul(size_of::<u16>())
            .and_then(|n| n.checked_add(size_of::<DropFiles>()))
            .ok_or("File path is too large for the clipboard")?;

        // Every allocation stays ours until SetClipboardData succeeds. Guards
        // also close the clipboard and destroy the owner on every error path.
        unsafe {
            let mut allocation = Allocation(GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes));
            if allocation.0.is_null() {
                return Err(error("GlobalAlloc failed"));
            }
            let data = GlobalLock(allocation.0);
            if data.is_null() {
                return Err(error("GlobalLock failed"));
            }
            ptr::write(
                data.cast::<DropFiles>(),
                DropFiles {
                    files_offset: size_of::<DropFiles>() as u32,
                    point: POINT { x: 0, y: 0 },
                    non_client: 0,
                    wide: 1,
                },
            );
            ptr::copy_nonoverlapping(
                wide.as_ptr(),
                data.cast::<u8>().add(size_of::<DropFiles>()).cast::<u16>(),
                wide.len(),
            );
            // A zero result is normal when the final lock is released.
            GlobalUnlock(allocation.0);

            // A null OpenClipboard owner makes EmptyClipboard set a null owner,
            // which prevents SetClipboardData. Use the built-in STATIC class.
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let owner = Owner(CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            ));
            if owner.0.is_null() {
                return Err(error("Creating clipboard owner failed"));
            }
            let mut opened = false;
            for attempt in 0..10 {
                if OpenClipboard(owner.0) != 0 {
                    opened = true;
                    break;
                }
                if attempt == 9 {
                    return Err(error("OpenClipboard failed after 10 attempts"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            debug_assert!(opened);
            let _clipboard = Clipboard;
            if EmptyClipboard() == 0 {
                return Err(error("EmptyClipboard failed"));
            }
            if SetClipboardData(CF_HDROP, allocation.0).is_null() {
                return Err(error("SetClipboardData failed"));
            }
            allocation.0 = ptr::null_mut(); // Ownership transferred to Windows.
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        os::unix::ffi::OsStrExt,
        path::Path,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn file_uri(path: &Path) -> Result<String, String> {
        if path.as_os_str().as_bytes().contains(&0) {
            return Err("File path contains a NUL character".into());
        }
        let path = std::path::absolute(path).map_err(|e| format!("Invalid file path: {e}"))?;
        gtk::glib::filename_to_uri(&path, None)
            .map(|uri| uri.to_string())
            .map_err(|e| format!("Cannot create file URI: {e}"))
    }

    fn set_clipboard(uri: String) -> Result<(), String> {
        if !gtk::is_initialized_main_thread() {
            return Err("File clipboard requires the application's GTK main thread".into());
        }
        let display = gtk::gdk::Display::default().ok_or("No GTK display is available")?;
        let clipboard = gtk::Clipboard::for_display(&display, &gtk::gdk::SELECTION_CLIPBOARD);
        let targets = [
            gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 0),
            gtk::TargetEntry::new("x-special/gnome-copied-files", gtk::TargetFlags::empty(), 1),
        ];
        let uri_list = format!("{uri}\r\n");
        let copied_files = format!("copy\n{uri}");
        // GTK retains the closure (and both payloads) until selection ownership
        // is replaced or the app exits. No helper process or text fallback.
        if !clipboard.set_with_data(&targets, move |_, selection, info| {
            let bytes = if info == 1 {
                copied_files.as_bytes()
            } else {
                uri_list.as_bytes()
            };
            selection.set(&selection.target(), 8, bytes);
        }) {
            return Err("GTK could not acquire the file clipboard".into());
        }
        // Ownership alone serves paste requests throughout the app lifetime.
        // Do not block here waiting for an optional clipboard manager to store.
        Ok(())
    }

    pub(super) fn copy_files(path: &Path) -> Result<(), String> {
        let uri = file_uri(path)?;
        let context = gtk::glib::MainContext::default();
        if gtk::is_initialized_main_thread() || context.is_owner() {
            return set_clipboard(uri);
        }
        let timeout = Duration::from_secs(3);
        let deadline = Instant::now() + timeout;
        let (sender, receiver) = mpsc::sync_channel(1);
        // Unlike MainContext::invoke, idle_add_once never runs immediately on
        // a worker when the default context happens to have no current owner.
        gtk::glib::idle_add_once(move || {
            if Instant::now() >= deadline {
                return; // A stalled loop must not perform a late clipboard copy.
            }
            let _ = sender.send(set_clipboard(uri));
        });
        receiver
            .recv_timeout(timeout)
            .map_err(|e| format!("Waiting for GTK file clipboard failed: {e}"))?
    }

    #[cfg(test)]
    mod tests {
        use super::file_uri;
        use std::{ffi::OsStr, os::unix::ffi::OsStrExt, path::Path};

        #[test]
        fn uri_escapes_filename_characters() {
            assert_eq!(
                file_uri(Path::new("/tmp/a b#%\n中文.txt")).unwrap(),
                "file:///tmp/a%20b%23%25%0A%E4%B8%AD%E6%96%87.txt"
            );
        }

        #[test]
        fn uri_preserves_non_utf8_filename_bytes() {
            assert_eq!(
                file_uri(Path::new(OsStr::from_bytes(b"/tmp/a\xff.txt"))).unwrap(),
                "file:///tmp/a%FF.txt"
            );
        }

        #[test]
        fn uri_rejects_nul() {
            assert!(file_uri(Path::new(OsStr::from_bytes(b"/tmp/a\0b"))).is_err());
        }
    }
}
