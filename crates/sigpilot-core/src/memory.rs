/// Large decode batches leave free pages in glibc arenas. Release them at a
/// completed-decode boundary, never on the per-frame rendering path.
pub fn release_unused_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        unsafe extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        malloc_trim(0);
    }
}
