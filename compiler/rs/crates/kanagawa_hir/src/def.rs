//! Definition identifiers and metadata.
//!
//! Every named entity in HIR has a unique DefId that can be used to look up
//! information about the definition in the symbol table.

use crate::Span;

/// A unique identifier for a definition.
///
/// DefIds are assigned during HIR lowering and remain stable throughout
/// the compilation pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DefId(pub u32);

impl DefId {
    /// The invalid/null DefId.
    pub const INVALID: DefId = DefId(u32::MAX);

    /// Check if this DefId is valid.
    pub fn is_valid(self) -> bool {
        self != Self::INVALID
    }
}

impl Default for DefId {
    fn default() -> Self {
        Self::INVALID
    }
}

/// The kind of definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefKind {
    /// Module definition.
    Module,
    /// Function definition.
    Function,
    /// Variable definition (local, global, or parameter).
    Variable,
    /// Type definition (struct, enum, class, union, alias).
    Type,
    /// Template parameter (type or non-type).
    TemplateParam,
    /// Function parameter.
    Param,
    /// Enum variant.
    EnumVariant,
    /// Struct/class field.
    Field,
    /// Lambda capture.
    Capture,
}

/// Visibility of a definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Visibility {
    /// Public (accessible from outside the containing scope).
    Public,
    /// Private (only accessible within the containing scope).
    #[default]
    Private,
}

/// Metadata about a definition.
#[derive(Debug, Clone)]
pub struct Definition {
    /// Unique identifier.
    pub def_id: DefId,
    /// Kind of definition.
    pub kind: DefKind,
    /// Simple name (without namespace).
    pub name: String,
    /// Fully qualified name (with namespace).
    pub qualified_name: Vec<String>,
    /// Visibility.
    pub visibility: Visibility,
    /// Source span.
    pub span: Span,
    /// Parent scope DefId (if any).
    pub parent: Option<DefId>,
}

impl Definition {
    /// Create a new definition.
    pub fn new(
        def_id: DefId,
        kind: DefKind,
        name: impl Into<String>,
        span: Span,
    ) -> Self {
        let name = name.into();
        Self {
            def_id,
            kind,
            name: name.clone(),
            qualified_name: vec![name],
            visibility: Visibility::default(),
            span,
            parent: None,
        }
    }

    /// Set the qualified name.
    pub fn with_qualified_name(mut self, qn: Vec<String>) -> Self {
        self.qualified_name = qn;
        self
    }

    /// Set the visibility.
    pub fn with_visibility(mut self, vis: Visibility) -> Self {
        self.visibility = vis;
        self
    }

    /// Set the parent scope.
    pub fn with_parent(mut self, parent: DefId) -> Self {
        self.parent = Some(parent);
        self
    }
}

/// Generator for unique DefIds.
#[derive(Debug, Default)]
pub struct DefIdGenerator {
    next: u32,
}

impl DefIdGenerator {
    /// Create a new generator.
    pub fn new() -> Self {
        Self { next: 0 }
    }

    /// Generate the next unique DefId.
    pub fn next(&mut self) -> DefId {
        let id = DefId(self.next);
        self.next += 1;
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_def_id_invalid() {
        assert!(!DefId::INVALID.is_valid());
        assert!(DefId(0).is_valid());
        assert!(DefId(42).is_valid());
    }

    #[test]
    fn test_def_id_generator() {
        let mut gen = DefIdGenerator::new();
        assert_eq!(gen.next(), DefId(0));
        assert_eq!(gen.next(), DefId(1));
        assert_eq!(gen.next(), DefId(2));
    }

    #[test]
    fn test_definition() {
        let def = Definition::new(
            DefId(0),
            DefKind::Function,
            "foo",
            Span::default(),
        )
        .with_visibility(Visibility::Public)
        .with_qualified_name(vec!["module".to_string(), "foo".to_string()]);

        assert_eq!(def.name, "foo");
        assert_eq!(def.visibility, Visibility::Public);
        assert_eq!(def.qualified_name, vec!["module", "foo"]);
    }
}
