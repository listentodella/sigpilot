//! User-local persistence. Windows encrypts records with the current user's DPAPI key.
use serde::{de::DeserializeOwned, Serialize};
use std::{io, path::Path};

pub(crate) fn directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        crate::desktop::private_directory(path)
    }
    #[cfg(windows)]
    {
        std::fs::create_dir_all(path)?;
        validate_windows_path(path, true)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(io::ErrorKind::Unsupported.into())
    }
}

pub(crate) fn read<T: DeserializeOwned>(
    directory_path: &Path,
    name: &str,
    limit: u64,
) -> io::Result<Option<T>> {
    use std::io::Read;
    if !directory_path.exists() {
        return Ok(None);
    }
    directory(directory_path)?;
    let path = directory_path.join(name);
    #[cfg(windows)]
    if path.exists() {
        validate_windows_path(&path, false)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata()?;
        if !m.is_file() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::ErrorKind::InvalidData.into());
    }
    #[cfg(windows)]
    let bytes = dpapi(&bytes, false)?;
    if bytes.len() as u64 > limit {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}

pub(crate) fn write<T: Serialize>(directory_path: &Path, name: &str, value: &T) -> io::Result<()> {
    directory(directory_path)?;
    let bytes = serde_json::to_vec(value)?;
    #[cfg(unix)]
    {
        crate::desktop::write_private_atomic(&directory_path.join(name), &bytes)
    }
    #[cfg(windows)]
    {
        use std::{io::Write, os::windows::ffi::OsStrExt};
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let path = directory_path.join(name);
        if path.exists() {
            validate_windows_path(&path, false)?;
        }
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&dpapi(&bytes, true)?)?;
            file.sync_all()?;
            drop(file);
            let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();
        let _ = std::fs::remove_file(temporary);
        result
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = bytes;
        Err(io::ErrorKind::Unsupported.into())
    }
}

pub(crate) fn lock(path: &Path) -> io::Result<std::fs::File> {
    directory(path)?;
    #[cfg(unix)]
    {
        crate::desktop::connection_lock(path)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let target = path.join("connection.lock");
        if target.exists() {
            validate_windows_path(&target, false)?;
        }
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(target)
            .map_err(|error| {
                if error.raw_os_error() == Some(32) {
                    io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "MCP is enabled in another SigPilot window; disable it there first",
                    )
                } else {
                    error
                }
            })
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(io::ErrorKind::Unsupported.into())
    }
}

#[cfg(windows)]
fn validate_windows_path(path: &Path, is_directory: bool) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_attributes() & 0x400 != 0
        || metadata.is_dir() != is_directory
        || (!is_directory && !metadata.is_file())
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

#[cfg(windows)]
fn dpapi(bytes: &[u8], protect: bool) -> io::Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| io::ErrorKind::InvalidData)?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}
