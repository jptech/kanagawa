//! Type checking diagnostics and error reporting.
//!
//! This module provides a comprehensive error reporting system for type checking,
//! designed for:
//! - Clear, actionable error messages
//! - Source location tracking via spans
//! - Error recovery (collecting multiple errors)
//! - Future extension for suggestions and fixes

use kanagawa_hir::{Span, Ty};
use std::fmt;

/// Severity level for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// Informational message (not an error).
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

/// A type checking diagnostic with location and message.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    /// Severity of this diagnostic.
    pub severity: Severity,
    /// Primary error code for categorization.
    pub code: DiagnosticCode,
    /// Human-readable message.
    pub message: String,
    /// Primary source location.
    pub span: Span,
    /// Additional labeled spans for context.
    pub labels: Vec<Label>,
    /// Suggested fixes or notes.
    pub notes: Vec<String>,
}

impl Diagnostic {
    /// Create a new error diagnostic.
    pub fn error(code: DiagnosticCode, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Error,
            code,
            message: message.into(),
            span,
            labels: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// Create a new warning diagnostic.
    pub fn warning(code: DiagnosticCode, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Warning,
            code,
            message: message.into(),
            span,
            labels: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// Add a labeled span for additional context.
    pub fn with_label(mut self, span: Span, message: impl Into<String>) -> Self {
        self.labels.push(Label {
            span,
            message: message.into(),
        });
        self
    }

    /// Add a note with additional information.
    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }

    /// Check if this is an error (not warning/info).
    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: [{}] {}", self.severity, self.code, self.message)?;
        if self.span != Span::default() {
            write!(f, " at {:?}", self.span)?;
        }
        for label in &self.labels {
            write!(f, "\n  --> {}", label.message)?;
        }
        for note in &self.notes {
            write!(f, "\n  = note: {}", note)?;
        }
        Ok(())
    }
}

/// A labeled source span for diagnostic context.
#[derive(Debug, Clone)]
pub struct Label {
    /// Source location.
    pub span: Span,
    /// Label message.
    pub message: String,
}

/// Categorized error codes for type checking diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticCode {
    // Type mismatch errors (E001-E099)
    /// Types are incompatible.
    TypeMismatch,
    /// Expected a specific type.
    ExpectedType,
    /// Cannot assign to this type.
    InvalidAssignment,
    /// Return type doesn't match function signature.
    ReturnTypeMismatch,
    /// Argument type doesn't match parameter.
    ArgumentTypeMismatch,

    // Type inference errors (E100-E199)
    /// Cannot infer type.
    CannotInfer,
    /// Ambiguous type inference.
    AmbiguousType,
    /// Recursive type dependency.
    RecursiveType,

    // Integer type errors (E200-E299)
    /// Integer width mismatch.
    IntegerWidthMismatch,
    /// Integer overflow in constant.
    IntegerOverflow,
    /// Invalid integer width.
    InvalidIntegerWidth,
    /// Signed/unsigned mismatch.
    SignednessMismatch,

    // Operator errors (E300-E399)
    /// Invalid operand type for operator.
    InvalidOperand,
    /// Binary operator type mismatch.
    BinaryOpMismatch,
    /// Unary operator not applicable.
    InvalidUnaryOp,

    // Cast errors (E400-E499)
    /// Invalid cast.
    InvalidCast,
    /// Implicit narrowing not allowed.
    ImplicitNarrowing,
    /// Cast to incompatible type.
    IncompatibleCast,

    // Function errors (E500-E599)
    /// Wrong number of arguments.
    ArgumentCount,
    /// Function not callable.
    NotCallable,
    /// Missing return value.
    MissingReturn,

    // Array errors (E600-E699)
    /// Invalid array index type.
    InvalidArrayIndex,
    /// Array dimension mismatch.
    ArrayDimensionMismatch,

    // Struct/Class errors (E700-E799)
    /// Unknown field.
    UnknownField,
    /// Field type mismatch.
    FieldTypeMismatch,
    /// Missing required field.
    MissingField,

    // Template errors (E800-E899)
    /// Template argument mismatch.
    TemplateArgMismatch,
    /// Invalid template argument.
    InvalidTemplateArg,
    /// Template instantiation failed.
    TemplateInstantiationFailed,

    // Resolution errors (E900-E999)
    /// Undefined symbol.
    UndefinedSymbol,
    /// Type not found.
    TypeNotFound,
    /// Ambiguous reference.
    AmbiguousReference,
}

impl fmt::Display for DiagnosticCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            // Type mismatch
            DiagnosticCode::TypeMismatch => "E001",
            DiagnosticCode::ExpectedType => "E002",
            DiagnosticCode::InvalidAssignment => "E003",
            DiagnosticCode::ReturnTypeMismatch => "E004",
            DiagnosticCode::ArgumentTypeMismatch => "E005",
            // Inference
            DiagnosticCode::CannotInfer => "E100",
            DiagnosticCode::AmbiguousType => "E101",
            DiagnosticCode::RecursiveType => "E102",
            // Integer
            DiagnosticCode::IntegerWidthMismatch => "E200",
            DiagnosticCode::IntegerOverflow => "E201",
            DiagnosticCode::InvalidIntegerWidth => "E202",
            DiagnosticCode::SignednessMismatch => "E203",
            // Operator
            DiagnosticCode::InvalidOperand => "E300",
            DiagnosticCode::BinaryOpMismatch => "E301",
            DiagnosticCode::InvalidUnaryOp => "E302",
            // Cast
            DiagnosticCode::InvalidCast => "E400",
            DiagnosticCode::ImplicitNarrowing => "E401",
            DiagnosticCode::IncompatibleCast => "E402",
            // Function
            DiagnosticCode::ArgumentCount => "E500",
            DiagnosticCode::NotCallable => "E501",
            DiagnosticCode::MissingReturn => "E502",
            // Array
            DiagnosticCode::InvalidArrayIndex => "E600",
            DiagnosticCode::ArrayDimensionMismatch => "E601",
            // Struct
            DiagnosticCode::UnknownField => "E700",
            DiagnosticCode::FieldTypeMismatch => "E701",
            DiagnosticCode::MissingField => "E702",
            // Template
            DiagnosticCode::TemplateArgMismatch => "E800",
            DiagnosticCode::InvalidTemplateArg => "E801",
            DiagnosticCode::TemplateInstantiationFailed => "E802",
            // Resolution
            DiagnosticCode::UndefinedSymbol => "E900",
            DiagnosticCode::TypeNotFound => "E901",
            DiagnosticCode::AmbiguousReference => "E902",
        };
        write!(f, "{}", code)
    }
}

/// Collection of diagnostics from type checking.
#[derive(Debug, Default)]
pub struct Diagnostics {
    diagnostics: Vec<Diagnostic>,
}

impl Diagnostics {
    /// Create a new empty diagnostics collection.
    pub fn new() -> Self {
        Self::default()
    }

    /// Report an error.
    pub fn error(&mut self, code: DiagnosticCode, message: impl Into<String>, span: Span) {
        self.diagnostics.push(Diagnostic::error(code, message, span));
    }

    /// Report a warning.
    pub fn warning(&mut self, code: DiagnosticCode, message: impl Into<String>, span: Span) {
        self.diagnostics
            .push(Diagnostic::warning(code, message, span));
    }

    /// Add a pre-built diagnostic.
    pub fn add(&mut self, diagnostic: Diagnostic) {
        self.diagnostics.push(diagnostic);
    }

    /// Check if there are any errors (not just warnings).
    pub fn has_errors(&self) -> bool {
        self.diagnostics.iter().any(|d| d.is_error())
    }

    /// Get the number of errors.
    pub fn error_count(&self) -> usize {
        self.diagnostics.iter().filter(|d| d.is_error()).count()
    }

    /// Get all diagnostics.
    pub fn iter(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter()
    }

    /// Get all errors.
    pub fn errors(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter().filter(|d| d.is_error())
    }

    /// Get all warnings.
    pub fn warnings(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Warning)
    }

    /// Take all diagnostics, leaving the collection empty.
    pub fn take(&mut self) -> Vec<Diagnostic> {
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
}

// Convenience functions for creating common diagnostics.

/// Create a type mismatch diagnostic.
pub fn type_mismatch(expected: &Ty, found: &Ty, span: Span) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::TypeMismatch,
        format!("type mismatch: expected `{:?}`, found `{:?}`", expected, found),
        span,
    )
}

/// Create a cannot-infer diagnostic.
pub fn cannot_infer(context: &str, span: Span) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::CannotInfer,
        format!("cannot infer type {}", context),
        span,
    )
}

/// Create an invalid operand diagnostic.
pub fn invalid_operand(op: &str, ty: &Ty, span: Span) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::InvalidOperand,
        format!("invalid operand type `{:?}` for operator `{}`", ty, op),
        span,
    )
}

/// Create an implicit narrowing diagnostic.
pub fn implicit_narrowing(from: &Ty, to: &Ty, span: Span) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::ImplicitNarrowing,
        format!(
            "implicit narrowing conversion from `{:?}` to `{:?}` not allowed",
            from, to
        ),
        span,
    )
    .with_note("use explicit cast<>() if narrowing is intentional")
}

/// Create an argument count mismatch diagnostic.
pub fn argument_count(expected: usize, found: usize, span: Span) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::ArgumentCount,
        format!(
            "wrong number of arguments: expected {}, found {}",
            expected, found
        ),
        span,
    )
}

/// Create an unknown field diagnostic.
pub fn unknown_field(field: &str, ty: &Ty, span: Span) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::UnknownField,
        format!("unknown field `{}` on type `{:?}`", field, ty),
        span,
    )
}
