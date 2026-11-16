use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};

use crate::{AnalysisError, Result};

/// All exact integers cross the MCP boundary as canonical decimal strings.
/// Numeric JSON values are deliberately rejected rather than rounded by hosts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExactU64(pub u64);

impl Serialize for ExactU64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for ExactU64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty()
            || text.len() > 20
            || !text.bytes().all(|byte| byte.is_ascii_digit())
            || (text.len() > 1 && text.starts_with('0'))
        {
            return Err(D::Error::custom(
                "expected a canonical unsigned decimal string",
            ));
        }
        text.parse().map(Self).map_err(D::Error::custom)
    }
}

impl From<u64> for ExactU64 {
    fn from(value: u64) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SampleRange {
    pub start_sample: ExactU64,
    pub end_sample: ExactU64,
}

impl SampleRange {
    pub fn new(start: u64, end: u64, total_samples: u64) -> Result<Self> {
        let value = Self {
            start_sample: start.into(),
            end_sample: end.into(),
        };
        value.validate(total_samples)?;
        Ok(value)
    }

    pub fn validate(&self, total_samples: u64) -> Result<()> {
        if self.start_sample.0 >= self.end_sample.0 || self.end_sample.0 > total_samples {
            return Err(AnalysisError::InvalidInput(
                "range must satisfy 0 <= start < end <= sample_count".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeUnit {
    Seconds,
    Milliseconds,
    Microseconds,
    Nanoseconds,
}

impl TimeUnit {
    fn divisor(self) -> u128 {
        match self {
            Self::Seconds => 1,
            Self::Milliseconds => 1_000,
            Self::Microseconds => 1_000_000,
            Self::Nanoseconds => 1_000_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeRounding {
    Floor,
    Ceil,
    /// Round half away from zero, including negative offsets.
    Nearest,
    RejectNonintegral,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TimeOffset {
    pub value: String,
    pub unit: TimeUnit,
    pub rounding: TimeRounding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedTime {
    pub sample: ExactU64,
    pub anchor_sample: ExactU64,
    /// Exact quantization error in samples, as a signed rational.
    pub error_numerator: String,
    pub error_denominator: String,
}

impl TimeOffset {
    pub fn resolve(&self, rate_hz: u64, anchor: u64, sample_count: u64) -> Result<ResolvedTime> {
        if rate_hz == 0 {
            return Err(AnalysisError::InvalidInput(
                "sample rate must be positive".into(),
            ));
        }
        let (negative, numerator, scale) = parse_decimal(&self.value)?;
        let numerator = numerator
            .checked_mul(u128::from(rate_hz))
            .ok_or(AnalysisError::Overflow)?;
        let denominator = scale
            .checked_mul(self.unit.divisor())
            .ok_or(AnalysisError::Overflow)?;
        let whole = numerator / denominator;
        let remainder = numerator % denominator;
        let increment = match self.rounding {
            TimeRounding::RejectNonintegral if remainder != 0 => {
                return Err(AnalysisError::NonIntegralTime)
            }
            TimeRounding::RejectNonintegral => false,
            TimeRounding::Floor => negative && remainder != 0,
            TimeRounding::Ceil => !negative && remainder != 0,
            TimeRounding::Nearest => remainder != 0 && remainder >= denominator.div_ceil(2),
        };
        let magnitude = whole
            .checked_add(u128::from(increment))
            .ok_or(AnalysisError::Overflow)?;
        let magnitude = u64::try_from(magnitude).map_err(|_| AnalysisError::Overflow)?;
        let sample = if negative {
            anchor.checked_sub(magnitude)
        } else {
            anchor.checked_add(magnitude)
        }
        .ok_or(AnalysisError::Overflow)?;
        if sample >= sample_count {
            return Err(AnalysisError::InvalidInput(
                "resolved point is outside the capture".into(),
            ));
        }
        // Avoid multiplying the rounded coordinate by the denominator: only the
        // fractional remainder is needed, and every operation remains bounded.
        let error_magnitude = if increment {
            denominator - remainder
        } else {
            remainder
        };
        let error_negative = if increment { negative } else { !negative };
        let error_numerator = if error_negative && error_magnitude != 0 {
            format!("-{error_magnitude}")
        } else {
            error_magnitude.to_string()
        };
        Ok(ResolvedTime {
            sample: sample.into(),
            anchor_sample: anchor.into(),
            error_numerator,
            error_denominator: denominator.to_string(),
        })
    }
}

/// Decimal input is intentionally small and has no exponent/NaN/locale syntax.
fn parse_decimal(text: &str) -> Result<(bool, u128, u128)> {
    if text.is_empty() || text.len() > 40 {
        return Err(AnalysisError::InvalidInput(
            "decimal time must contain 1..40 characters".into(),
        ));
    }
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let mut pieces = text.split('.');
    let integer = pieces.next().unwrap_or_default();
    let fraction = pieces.next();
    if pieces.next().is_some()
        || integer.is_empty()
        || !integer.bytes().all(|b| b.is_ascii_digit())
        || fraction
            .is_some_and(|f| f.is_empty() || f.len() > 18 || !f.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(AnalysisError::InvalidInput(
            "expected a finite decimal with at most 18 fractional digits".into(),
        ));
    }
    let mut numerator = 0u128;
    for byte in integer.bytes().chain(fraction.unwrap_or_default().bytes()) {
        numerator = numerator
            .checked_mul(10)
            .and_then(|n| n.checked_add(u128::from(byte - b'0')))
            .ok_or(AnalysisError::Overflow)?;
    }
    let scale = 10u128.pow(fraction.map_or(0, |f| f.len() as u32));
    Ok((negative, numerator, scale))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_full_u64_and_rejects_numeric_or_ambiguous_json() {
        let encoded = serde_json::to_string(&ExactU64(u64::MAX)).unwrap();
        assert_eq!(encoded, "\"18446744073709551615\"");
        assert_eq!(
            serde_json::from_str::<ExactU64>(&encoded).unwrap().0,
            u64::MAX
        );
        for invalid in [
            "9007199254740993",
            "\"01\"",
            "\"+1\"",
            "\"-1\"",
            "\"18446744073709551616\"",
        ] {
            assert!(serde_json::from_str::<ExactU64>(invalid).is_err());
        }
    }

    #[test]
    fn rounds_signed_offsets_and_returns_exact_error() {
        let offset = |rounding| TimeOffset {
            value: "-1.5".into(),
            unit: TimeUnit::Nanoseconds,
            rounding,
        };
        let floor = offset(TimeRounding::Floor)
            .resolve(1_000_000_000, 10, 20)
            .unwrap();
        assert_eq!(floor.sample.0, 8);
        assert_eq!(floor.error_numerator, "-5000000000");
        assert_eq!(floor.error_denominator, "10000000000");
        assert_eq!(
            offset(TimeRounding::Ceil)
                .resolve(1_000_000_000, 10, 20)
                .unwrap()
                .sample
                .0,
            9
        );
        assert_eq!(
            offset(TimeRounding::Nearest)
                .resolve(1_000_000_000, 10, 20)
                .unwrap()
                .sample
                .0,
            8
        );
        assert!(matches!(
            offset(TimeRounding::RejectNonintegral).resolve(1_000_000_000, 10, 20),
            Err(AnalysisError::NonIntegralTime)
        ));
    }

    #[test]
    fn resolves_large_anchors_without_a_float_and_does_not_clamp() {
        let anchor = (1u64 << 53) + 1;
        let offset = TimeOffset {
            value: "1".into(),
            unit: TimeUnit::Nanoseconds,
            rounding: TimeRounding::RejectNonintegral,
        };
        assert_eq!(
            offset
                .resolve(1_000_000_000, anchor, anchor + 2)
                .unwrap()
                .sample
                .0,
            anchor + 1
        );
        assert!(offset.resolve(1_000_000_000, anchor, anchor + 1).is_err());
        assert!(offset.resolve(1_000_000_000, u64::MAX, u64::MAX).is_err());
        assert!(SampleRange::new(0, 10, 10).is_ok());
        assert!(SampleRange::new(10, 10, 10).is_err());
    }
}
