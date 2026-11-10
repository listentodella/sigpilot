use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Keep the wire representation as a string, but avoid a heap allocation for
/// every clock/data marker. Unknown plugin kinds still round-trip losslessly.
#[derive(Debug, Clone)]
pub enum ProtocolMarkerKind {
    Dot,
    ErrorDot,
    Square,
    ErrorSquare,
    UpArrow,
    DownArrow,
    X,
    ErrorX,
    Start,
    Stop,
    One,
    Zero,
    // Box the String itself so the common enum occupies two machine words.
    Custom(Box<String>),
}

impl ProtocolMarkerKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Dot => "dot",
            Self::ErrorDot => "error_dot",
            Self::Square => "square",
            Self::ErrorSquare => "error_square",
            Self::UpArrow => "up_arrow",
            Self::DownArrow => "down_arrow",
            Self::X => "x",
            Self::ErrorX => "error_x",
            Self::Start => "start",
            Self::Stop => "stop",
            Self::One => "one",
            Self::Zero => "zero",
            Self::Custom(value) => value,
        }
    }

    pub fn allocated_bytes(&self) -> usize {
        match self {
            Self::Custom(value) => std::mem::size_of::<String>() + value.capacity(),
            _ => 0,
        }
    }
}

impl From<&str> for ProtocolMarkerKind {
    fn from(value: &str) -> Self {
        match value {
            "dot" => Self::Dot,
            "error_dot" => Self::ErrorDot,
            "square" => Self::Square,
            "error_square" => Self::ErrorSquare,
            "up_arrow" => Self::UpArrow,
            "down_arrow" => Self::DownArrow,
            "x" => Self::X,
            "error_x" => Self::ErrorX,
            "start" => Self::Start,
            "stop" => Self::Stop,
            "one" => Self::One,
            "zero" => Self::Zero,
            _ => Self::Custom(Box::new(value.to_owned())),
        }
    }
}

impl From<String> for ProtocolMarkerKind {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}

impl PartialEq<&str> for ProtocolMarkerKind {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl PartialEq for ProtocolMarkerKind {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}

impl Eq for ProtocolMarkerKind {}

impl Ord for ProtocolMarkerKind {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.as_str().cmp(other.as_str())
    }
}

impl PartialOrd for ProtocolMarkerKind {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Serialize for ProtocolMarkerKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ProtocolMarkerKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KindVisitor;
        impl serde::de::Visitor<'_> for KindVisitor {
            type Value = ProtocolMarkerKind;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a protocol marker kind")
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(value.into())
            }
        }
        deserializer.deserialize_str(KindVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_kinds_preserve_wire_strings_without_common_heap_allocations() {
        for name in [
            "dot",
            "error_dot",
            "square",
            "error_square",
            "up_arrow",
            "down_arrow",
            "x",
            "error_x",
            "start",
            "stop",
            "one",
            "zero",
            "plugin-specific",
        ] {
            let encoded = serde_json::to_string(name).unwrap();
            let kind: ProtocolMarkerKind = serde_json::from_str(&encoded).unwrap();
            assert_eq!(kind.as_str(), name);
            assert_eq!(serde_json::to_string(&kind).unwrap(), encoded);
            assert_eq!(kind.allocated_bytes() == 0, name != "plugin-specific");
        }
        assert!(std::mem::size_of::<ProtocolMarkerKind>() <= 2 * std::mem::size_of::<usize>());
        let custom_dot = ProtocolMarkerKind::Custom(Box::new("dot".to_owned()));
        assert_eq!(custom_dot, ProtocolMarkerKind::Dot);
        assert_eq!(
            custom_dot.cmp(&ProtocolMarkerKind::Dot),
            std::cmp::Ordering::Equal
        );
    }
}
