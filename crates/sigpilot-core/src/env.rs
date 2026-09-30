//! Product-level environment variable access with legacy-name fallback.
//!
//! The product was renamed from `PXLogic Studio` to `SigPilot`, so product-level
//! environment variables moved from the `PXLOGIC_*` namespace to `SIGPILOT_*`.
//!
//! To avoid breaking existing setups, [`product_env`] prefers the new name and
//! falls back to the legacy name, logging a deprecation warning once per lookup.
//! The fallback can be removed in a future release.
//!
//! Note that this module only covers **product-level configuration**. Hardware
//! constants such as `PXLOGIC_WCH_VID` describe the PXLogic device itself and
//! intentionally keep their prefix — see `docs/rename-plan.md`.

use std::ffi::OsString;

/// Prefix for the current product-level environment variables.
pub const ENV_PREFIX: &str = "SIGPILOT_";

/// Legacy prefix retained for backward compatibility.
pub const LEGACY_ENV_PREFIX: &str = "PXLOGIC_";

/// Read a product-level environment variable by its **full** current name.
///
/// `name` must be the complete new name, for example `"SIGPILOT_BITSTREAM_DIR"`.
/// If it is unset, the legacy `PXLOGIC_*` spelling is tried as a fallback and a
/// deprecation warning is emitted.
///
/// Returns `None` when neither name is set, or when `name` does not carry the
/// [`ENV_PREFIX`] prefix (in which case no fallback is attempted).
pub fn product_env(name: &str) -> Option<OsString> {
    if let Some(value) = std::env::var_os(name) {
        return Some(value);
    }

    let legacy = name.replacen(ENV_PREFIX, LEGACY_ENV_PREFIX, 1);
    if legacy == name {
        return None;
    }

    let value = std::env::var_os(&legacy)?;
    tracing::warn!("{legacy} is deprecated; please use {name} instead");
    Some(value)
}

/// Convenience wrapper around [`product_env`] for UTF-8 values.
///
/// Returns `None` when the variable is unset or not valid UTF-8.
pub fn product_env_string(name: &str) -> Option<String> {
    product_env(name).and_then(|value| value.into_string().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_new_name_when_both_are_set() {
        std::env::set_var("SIGPILOT_TEST_ENV_PREFERENCE", "new");
        std::env::set_var("PXLOGIC_TEST_ENV_PREFERENCE", "legacy");
        assert_eq!(
            product_env_string("SIGPILOT_TEST_ENV_PREFERENCE").as_deref(),
            Some("new")
        );
        std::env::remove_var("SIGPILOT_TEST_ENV_PREFERENCE");
        std::env::remove_var("PXLOGIC_TEST_ENV_PREFERENCE");
    }

    #[test]
    fn falls_back_to_the_legacy_name() {
        std::env::remove_var("SIGPILOT_TEST_ENV_FALLBACK");
        std::env::set_var("PXLOGIC_TEST_ENV_FALLBACK", "legacy");
        assert_eq!(
            product_env_string("SIGPILOT_TEST_ENV_FALLBACK").as_deref(),
            Some("legacy")
        );
        std::env::remove_var("PXLOGIC_TEST_ENV_FALLBACK");
    }

    #[test]
    fn returns_none_when_neither_name_is_set() {
        std::env::remove_var("SIGPILOT_TEST_ENV_ABSENT");
        std::env::remove_var("PXLOGIC_TEST_ENV_ABSENT");
        assert!(product_env("SIGPILOT_TEST_ENV_ABSENT").is_none());
    }

    #[test]
    fn does_not_fall_back_for_unprefixed_names() {
        std::env::set_var("PXLOGIC_TEST_ENV_UNPREFIXED", "legacy");
        assert!(product_env("SOME_OTHER_NAME").is_none());
        std::env::remove_var("PXLOGIC_TEST_ENV_UNPREFIXED");
    }
}
