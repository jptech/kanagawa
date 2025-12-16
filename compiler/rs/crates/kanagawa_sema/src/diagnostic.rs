//! Diagnostic types for semantic validation errors.
//!
//! This module provides comprehensive error reporting for all
//! semantic validation issues including duplicate definitions,
//! control flow errors, attribute violations, and memory annotations.

use kanagawa_hir::Span;
use std::fmt;

/// Error codes for semantic validation diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemaErrorCode {
    // Duplicate definition errors (S001-S099)
    /// Duplicate symbol in same scope.
    DuplicateDefinition,
    /// Duplicate parameter name in function.
    DuplicateParameter,
    /// Duplicate field in struct/class/union.
    DuplicateField,
    /// Duplicate enum variant.
    DuplicateVariant,
    /// Duplicate template parameter.
    DuplicateTemplateParam,
    /// Duplicate case label in switch.
    DuplicateCaseLabel,

    // Control flow errors (S100-S199)
    /// Break statement outside of loop.
    BreakOutsideLoop,
    /// Continue statement outside of loop.
    ContinueOutsideLoop,
    /// Return statement in void function with value.
    ReturnValueInVoidFunction,
    /// Return statement missing value in non-void function.
    MissingReturnValue,
    /// Not all paths return a value.
    NotAllPathsReturn,
    /// Unreachable code after return/break.
    UnreachableCode,
    /// Invalid loop variable binding.
    InvalidLoopVariable,
    /// Missing default case in switch (when required).
    MissingDefaultCase,

    // Attribute errors (S200-S299)
    /// Unknown attribute.
    UnknownAttribute,
    /// Invalid attribute target.
    InvalidAttributeTarget,
    /// Invalid attribute value.
    InvalidAttributeValue,
    /// Conflicting attributes.
    ConflictingAttributes,
    /// Missing required attribute.
    MissingRequiredAttribute,
    /// Attribute not allowed on this item.
    AttributeNotAllowed,
    /// Duplicate attribute.
    DuplicateAttribute,

    // Memory/Register annotation errors (S300-S399)
    /// Invalid memory attribute on non-array.
    MemoryAttrOnNonArray,
    /// Invalid latency value (negative or too large).
    InvalidLatencyValue,
    /// Invalid FIFO depth value.
    InvalidFifoDepth,
    /// Invalid thread count.
    InvalidThreadCount,
    /// Conflicting memory attributes.
    ConflictingMemoryAttrs,
    /// Invalid pipeline configuration.
    InvalidPipelineConfig,
    /// Invalid atomic operation scope.
    InvalidAtomicScope,

    // General semantic errors (S400-S499)
    /// Invalid def_id reference.
    InvalidDefId,
    /// Uninitialized constant.
    UninitializedConstant,
    /// Non-constant in constant context.
    NonConstantExpression,
    /// Invalid type in context.
    InvalidTypeInContext,
    /// Void type not allowed here.
    VoidNotAllowed,
}

impl fmt::Display for SemaErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            // Duplicate definition errors
            SemaErrorCode::DuplicateDefinition => "S001",
            SemaErrorCode::DuplicateParameter => "S002",
            SemaErrorCode::DuplicateField => "S003",
            SemaErrorCode::DuplicateVariant => "S004",
            SemaErrorCode::DuplicateTemplateParam => "S005",
            SemaErrorCode::DuplicateCaseLabel => "S006",
            // Control flow errors
            SemaErrorCode::BreakOutsideLoop => "S100",
            SemaErrorCode::ContinueOutsideLoop => "S101",
            SemaErrorCode::ReturnValueInVoidFunction => "S102",
            SemaErrorCode::MissingReturnValue => "S103",
            SemaErrorCode::NotAllPathsReturn => "S104",
            SemaErrorCode::UnreachableCode => "S105",
            SemaErrorCode::InvalidLoopVariable => "S106",
            SemaErrorCode::MissingDefaultCase => "S107",
            // Attribute errors
            SemaErrorCode::UnknownAttribute => "S200",
            SemaErrorCode::InvalidAttributeTarget => "S201",
            SemaErrorCode::InvalidAttributeValue => "S202",
            SemaErrorCode::ConflictingAttributes => "S203",
            SemaErrorCode::MissingRequiredAttribute => "S204",
            SemaErrorCode::AttributeNotAllowed => "S205",
            SemaErrorCode::DuplicateAttribute => "S206",
            // Memory/Register errors
            SemaErrorCode::MemoryAttrOnNonArray => "S300",
            SemaErrorCode::InvalidLatencyValue => "S301",
            SemaErrorCode::InvalidFifoDepth => "S302",
            SemaErrorCode::InvalidThreadCount => "S303",
            SemaErrorCode::ConflictingMemoryAttrs => "S304",
            SemaErrorCode::InvalidPipelineConfig => "S305",
            SemaErrorCode::InvalidAtomicScope => "S306",
            // General errors
            SemaErrorCode::InvalidDefId => "S400",
            SemaErrorCode::UninitializedConstant => "S401",
            SemaErrorCode::NonConstantExpression => "S402",
            SemaErrorCode::InvalidTypeInContext => "S403",
            SemaErrorCode::VoidNotAllowed => "S404",
        };
        write!(f, "{}", code)
    }
}

/// Severity level for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// Informational message.
    Info,
    /// Warning - code is valid but potentially problematic.
    Warning,
    /// Error - code is invalid and must be fixed.
    Error,
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Severity::Info => write!(f, "info"),
            Severity::Warning => write!(f, "warning"),
            Severity::Error => write!(f, "error"),
        }
    }
}

/// A semantic validation diagnostic with location and message.
#[derive(Debug, Clone)]
pub struct SemaDiagnostic {
    /// Severity of this diagnostic.
    pub severity: Severity,
    /// Primary error code.
    pub code: SemaErrorCode,
    /// Human-readable message.
    pub message: String,
    /// Primary source location.
    pub span: Span,
    /// Additional context notes.
    pub notes: Vec<String>,
    /// Related locations (e.g., showing first definition for duplicates).
    pub related: Vec<(Span, String)>,
}

impl SemaDiagnostic {
    /// Create a new error diagnostic.
    pub fn error(code: SemaErrorCode, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Error,
            code,
            message: message.into(),
            span,
            notes: Vec::new(),
            related: Vec::new(),
        }
    }

    /// Create a new warning diagnostic.
    pub fn warning(code: SemaErrorCode, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Warning,
            code,
            message: message.into(),
            span,
            notes: Vec::new(),
            related: Vec::new(),
        }
    }

    /// Create a new info diagnostic.
    pub fn info(code: SemaErrorCode, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Info,
            code,
            message: message.into(),
            span,
            notes: Vec::new(),
            related: Vec::new(),
        }
    }

    /// Add a note with additional information.
    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }

    /// Add a related location.
    pub fn with_related(mut self, span: Span, message: impl Into<String>) -> Self {
        self.related.push((span, message.into()));
        self
    }

    /// Check if this is an error.
    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }

    /// Check if this is a warning.
    pub fn is_warning(&self) -> bool {
        self.severity == Severity::Warning
    }
}

impl fmt::Display for SemaDiagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: [{}] {}", self.severity, self.code, self.message)?;
        if self.span != Span::default() {
            write!(f, " at {:?}", self.span)?;
        }
        for (span, msg) in &self.related {
            write!(f, "\n  --> {} at {:?}", msg, span)?;
        }
        for note in &self.notes {
            write!(f, "\n  = note: {}", note)?;
        }
        Ok(())
    }
}

/// Collection of semantic validation diagnostics.
#[derive(Debug, Default)]
pub struct SemaDiagnostics {
    diagnostics: Vec<SemaDiagnostic>,
}

impl SemaDiagnostics {
    /// Create a new empty diagnostics collection.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an error diagnostic.
    pub fn error(
        &mut self,
        code: SemaErrorCode,
        message: impl Into<String>,
        span: Span,
    ) {
        self.diagnostics.push(SemaDiagnostic::error(code, message, span));
    }

    /// Add a warning diagnostic.
    pub fn warning(
        &mut self,
        code: SemaErrorCode,
        message: impl Into<String>,
        span: Span,
    ) {
        self.diagnostics.push(SemaDiagnostic::warning(code, message, span));
    }

    /// Add a pre-built diagnostic.
    pub fn add(&mut self, diagnostic: SemaDiagnostic) {
        self.diagnostics.push(diagnostic);
    }

    /// Check if there are any errors.
    pub fn has_errors(&self) -> bool {
        self.diagnostics.iter().any(|d| d.is_error())
    }

    /// Get the number of errors.
    pub fn error_count(&self) -> usize {
        self.diagnostics.iter().filter(|d| d.is_error()).count()
    }

    /// Get the number of warnings.
    pub fn warning_count(&self) -> usize {
        self.diagnostics.iter().filter(|d| d.is_warning()).count()
    }

    /// Get all diagnostics.
    pub fn iter(&self) -> impl Iterator<Item = &SemaDiagnostic> {
        self.diagnostics.iter()
    }

    /// Get all errors.
    pub fn errors(&self) -> impl Iterator<Item = &SemaDiagnostic> {
        self.diagnostics.iter().filter(|d| d.is_error())
    }

    /// Get all warnings.
    pub fn warnings(&self) -> impl Iterator<Item = &SemaDiagnostic> {
        self.diagnostics.iter().filter(|d| d.is_warning())
    }

    /// Take all diagnostics.
    pub fn take(&mut self) -> Vec<SemaDiagnostic> {
        std::mem::take(&mut self.diagnostics)
    }

    /// Check if empty.
    pub fn is_empty(&self) -> bool {
        self.diagnostics.is_empty()
    }

    /// Get the count of all diagnostics.
    pub fn len(&self) -> usize {
        self.diagnostics.len()
    }

    /// Extend with diagnostics from another collection.
    pub fn extend(&mut self, other: SemaDiagnostics) {
        self.diagnostics.extend(other.diagnostics);
    }
}

// Convenience functions for common diagnostics.

/// Create a "duplicate definition" diagnostic.
pub fn duplicate_definition(
    name: &str,
    first_span: Span,
    second_span: Span,
) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::DuplicateDefinition,
        format!("duplicate definition of `{}`", name),
        second_span,
    )
    .with_related(first_span, "first definition here")
    .with_note("each name must be unique within its scope")
}

/// Create a "duplicate parameter" diagnostic.
pub fn duplicate_parameter(name: &str, first_span: Span, second_span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::DuplicateParameter,
        format!("duplicate parameter `{}`", name),
        second_span,
    )
    .with_related(first_span, "first parameter here")
}

/// Create a "duplicate field" diagnostic.
pub fn duplicate_field(name: &str, type_name: &str, first_span: Span, second_span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::DuplicateField,
        format!("duplicate field `{}` in `{}`", name, type_name),
        second_span,
    )
    .with_related(first_span, "first field here")
}

/// Create a "duplicate enum variant" diagnostic.
pub fn duplicate_variant(name: &str, enum_name: &str, first_span: Span, second_span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::DuplicateVariant,
        format!("duplicate variant `{}` in enum `{}`", name, enum_name),
        second_span,
    )
    .with_related(first_span, "first variant here")
}

/// Create a "break outside loop" diagnostic.
pub fn break_outside_loop(span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::BreakOutsideLoop,
        "break statement outside of loop",
        span,
    )
    .with_note("break can only be used inside for, while, or do-while loops")
}

/// Create a "continue outside loop" diagnostic.
pub fn continue_outside_loop(span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::ContinueOutsideLoop,
        "continue statement outside of loop",
        span,
    )
    .with_note("continue can only be used inside for, while, or do-while loops")
}

/// Create a "return value in void function" diagnostic.
pub fn return_value_in_void(span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::ReturnValueInVoidFunction,
        "return with value in void function",
        span,
    )
    .with_note("remove the return value or change the function return type")
}

/// Create a "missing return value" diagnostic.
pub fn missing_return_value(span: Span, return_ty: &str) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::MissingReturnValue,
        format!("return statement missing value (expected `{}`)", return_ty),
        span,
    )
}

/// Create a "not all paths return" diagnostic.
pub fn not_all_paths_return(func_name: &str, span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::NotAllPathsReturn,
        format!("not all code paths return a value in function `{}`", func_name),
        span,
    )
    .with_note("ensure all branches of the function return a value")
}

/// Create an "unreachable code" diagnostic.
pub fn unreachable_code(span: Span) -> SemaDiagnostic {
    SemaDiagnostic::warning(
        SemaErrorCode::UnreachableCode,
        "unreachable code",
        span,
    )
    .with_note("this code will never be executed")
}

/// Create an "unknown attribute" diagnostic.
pub fn unknown_attribute(name: &str, span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::UnknownAttribute,
        format!("unknown attribute `{}`", name),
        span,
    )
}

/// Create an "invalid attribute target" diagnostic.
pub fn invalid_attribute_target(attr_name: &str, target: &str, span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::InvalidAttributeTarget,
        format!("attribute `{}` cannot be applied to {}", attr_name, target),
        span,
    )
}

/// Create a "conflicting attributes" diagnostic.
pub fn conflicting_attributes(attr1: &str, attr2: &str, span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::ConflictingAttributes,
        format!("attributes `{}` and `{}` cannot be used together", attr1, attr2),
        span,
    )
}

/// Create an "invalid latency value" diagnostic.
pub fn invalid_latency_value(value: i64, span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::InvalidLatencyValue,
        format!("invalid latency value `{}` (must be non-negative)", value),
        span,
    )
}

/// Create a "memory attribute on non-array" diagnostic.
pub fn memory_attr_on_non_array(attr_name: &str, span: Span) -> SemaDiagnostic {
    SemaDiagnostic::error(
        SemaErrorCode::MemoryAttrOnNonArray,
        format!("memory attribute `{}` can only be applied to arrays", attr_name),
        span,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_code_display() {
        assert_eq!(format!("{}", SemaErrorCode::DuplicateDefinition), "S001");
        assert_eq!(format!("{}", SemaErrorCode::BreakOutsideLoop), "S100");
        assert_eq!(format!("{}", SemaErrorCode::UnknownAttribute), "S200");
        assert_eq!(format!("{}", SemaErrorCode::MemoryAttrOnNonArray), "S300");
    }

    #[test]
    fn test_diagnostic_creation() {
        let diag = SemaDiagnostic::error(
            SemaErrorCode::DuplicateDefinition,
            "duplicate `foo`",
            Span::default(),
        );
        assert!(diag.is_error());
        assert!(!diag.is_warning());
        assert_eq!(diag.code, SemaErrorCode::DuplicateDefinition);
    }

    #[test]
    fn test_diagnostic_with_notes() {
        let diag = SemaDiagnostic::error(
            SemaErrorCode::BreakOutsideLoop,
            "break outside loop",
            Span::default(),
        )
        .with_note("note 1")
        .with_note("note 2");

        assert_eq!(diag.notes.len(), 2);
    }

    #[test]
    fn test_diagnostic_with_related() {
        let diag = duplicate_definition("foo", Span::default(), Span::default());
        assert_eq!(diag.related.len(), 1);
    }

    #[test]
    fn test_diagnostics_collection() {
        let mut diags = SemaDiagnostics::new();
        assert!(diags.is_empty());

        diags.error(SemaErrorCode::DuplicateDefinition, "error 1", Span::default());
        diags.warning(SemaErrorCode::UnreachableCode, "warning 1", Span::default());

        assert!(!diags.is_empty());
        assert_eq!(diags.len(), 2);
        assert_eq!(diags.error_count(), 1);
        assert_eq!(diags.warning_count(), 1);
        assert!(diags.has_errors());
    }

    #[test]
    fn test_diagnostics_extend() {
        let mut diags1 = SemaDiagnostics::new();
        diags1.error(SemaErrorCode::DuplicateDefinition, "error 1", Span::default());

        let mut diags2 = SemaDiagnostics::new();
        diags2.error(SemaErrorCode::BreakOutsideLoop, "error 2", Span::default());

        diags1.extend(diags2);
        assert_eq!(diags1.len(), 2);
    }
}
