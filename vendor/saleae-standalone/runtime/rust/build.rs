use std::env;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let lib_dir = env::var_os("SALEAE_COMPAT_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("..").join("build").join("lib"));
    let lib_dir = lib_dir.canonicalize().unwrap_or_else(|_| {
        panic!(
            "compatibility runtime not built; expected {}",
            lib_dir.display()
        )
    });

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=saleae_compat");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
    println!("cargo:rerun-if-env-changed=SALEAE_COMPAT_LIB_DIR");
}
