//! Module namespace encoding utilities.
//!
//! Following the Haskell frontend convention, module namespaces are encoded
//! using `@` prefixes. For example, `["data", "optional"]` becomes `"@data@optional"`.

/// Encode a module namespace as a string with `@` prefixes.
///
/// # Example
/// ```
/// use kanagawa_hir::encode_module_namespace;
/// assert_eq!(encode_module_namespace(&["data", "optional"]), "@data@optional");
/// ```
pub fn encode_module_namespace(segments: &[impl AsRef<str>]) -> String {
    segments
        .iter()
        .map(|s| format!("@{}", s.as_ref()))
        .collect()
}

/// Decode a module namespace string back to segments.
///
/// # Example
/// ```
/// use kanagawa_hir::decode_module_namespace;
/// assert_eq!(decode_module_namespace("@data@optional"), vec!["data", "optional"]);
/// ```
pub fn decode_module_namespace(encoded: &str) -> Vec<String> {
    if encoded.is_empty() || !encoded.starts_with('@') {
        return Vec::new();
    }
    encoded[1..]
        .split('@')
        .map(|s| s.to_string())
        .collect()
}

/// Convert a module namespace to a display string with dots.
///
/// # Example
/// ```
/// use kanagawa_hir::display_module_namespace;
/// assert_eq!(display_module_namespace("@data@optional"), "data.optional");
/// ```
pub fn display_module_namespace(encoded: &str) -> String {
    decode_module_namespace(encoded).join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_empty() {
        let empty: &[&str] = &[];
        assert_eq!(encode_module_namespace(empty), "");
    }

    #[test]
    fn test_encode_single() {
        assert_eq!(encode_module_namespace(&["core"]), "@core");
    }

    #[test]
    fn test_encode_multiple() {
        assert_eq!(encode_module_namespace(&["data", "optional"]), "@data@optional");
        assert_eq!(encode_module_namespace(&["data", "closure", "core"]), "@data@closure@core");
    }

    #[test]
    fn test_decode_empty() {
        assert!(decode_module_namespace("").is_empty());
    }

    #[test]
    fn test_decode_single() {
        assert_eq!(decode_module_namespace("@core"), vec!["core"]);
    }

    #[test]
    fn test_decode_multiple() {
        assert_eq!(decode_module_namespace("@data@optional"), vec!["data", "optional"]);
    }

    #[test]
    fn test_roundtrip() {
        let segments = vec!["data", "closure", "core"];
        let encoded = encode_module_namespace(&segments);
        let decoded = decode_module_namespace(&encoded);
        assert_eq!(decoded, segments);
    }

    #[test]
    fn test_display() {
        assert_eq!(display_module_namespace("@data@optional"), "data.optional");
    }
}
