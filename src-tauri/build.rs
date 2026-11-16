fn main() {
    println!(
        "cargo:rustc-env=SIGPILOT_TARGET={}",
        std::env::var("TARGET").expect("Cargo target")
    );
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new().window_icon_path("icons/icon.ico"),
    ))
    .expect("failed to prepare Tauri build resources");
}
