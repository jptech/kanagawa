//! Diagnostic types for module resolution errors.
//!
//! This module provides comprehensive error reporting for all
//! resolution-related issues including import errors, visibility
//! violations, and circular dependencies.

use kanagawa_hir::Span;
use std::fmt;

/// Error codes for resolution diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveErrorCode {
    // Import errors (R001-R099)
    /// Module not found during import resolution.
    ModuleNotFound,
    /// Symbol not found in imported module.
    SymbolNotFound,
    /// Import creates ambiguous reference.
    AmbiguousImport,
    /// Duplicate import of same module.
    DuplicateImport,
    /// Invalid module path syntax.
    InvalidModulePath,

    // Export errors (R100-R199)
    /// Exporting undefined symbol.
    UndefinedExport,
    /// Duplicate export of same symbol.
    DuplicateExport,
    /// Re-exported module not found.
    ReexportModuleNotFound,
    /// Export difference references unknown module.
    ExportDiffModuleNotFound,

    // Visibility errors (R200-R299)
    /// Accessing private symbol from outside module.
    PrivateAccess,
    /// Accessing non-exported symbol from import.
    NonExportedAccess,
    /// Exporting private symbol.
    ExportingPrivate,

    // Dependency errors (R300-R399)
    /// Circular dependency detected.
    CircularDependency,
    /// Self-import detected.
    SelfImport,
    /// Dependency chain too deep.
    DependencyTooDeep,

    // Module errors (R400-R499)
    /// Duplicate module definition.
    DuplicateModule,
    /// Module name conflicts with existing definition.
    ModuleNameConflict,
    /// Anonymous module (missing module declaration).
    AnonymousModule,

    // Resolution errors (R500-R599)
    /// Cannot resolve qualified name.
    UnresolvedQualifiedName,
    /// Multiple definitions for same name.
    MultipleDefinitions,
    /// Definition not found.
    DefinitionNotFound,
}

impl fmt::Display for ResolveErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            // Import errors
            ResolveErrorCode::ModuleNotFound => "R001",
            ResolveErrorCode::SymbolNotFound => "R002",
            ResolveErrorCode::AmbiguousImport => "R003",
            ResolveErrorCode::DuplicateImport => "R004",
            ResolveErrorCode::InvalidModulePath => "R005",
            // Export errors
            ResolveErrorCode::UndefinedExport => "R100",
            ResolveErrorCode::DuplicateExport => "R101",
            ResolveErrorCode::ReexportModuleNotFound => "R102",
            ResolveErrorCode::ExportDiffModuleNotFound => "R103",
            // Visibility errors
            ResolveErrorCode::PrivateAccess => "R200",
            ResolveErrorCode::NonExportedAccess => "R201",
            ResolveErrorCode::ExportingPrivate => "R202",
            // Dependency errors
            ResolveErrorCode::CircularDependency => "R300",
            ResolveErrorCode::SelfImport => "R301",
            ResolveErrorCode::DependencyTooDeep => "R302",
            // Module errors
            ResolveErrorCode::DuplicateModule => "R400",
            ResolveErrorCode::ModuleNameConflict => "R401",
            ResolveErrorCode::AnonymousModule => "R402",
            // Resolution errors
            ResolveErrorCode::UnresolvedQualifiedName => "R500",
            ResolveErrorCode::MultipleDefinitions => "R501",
            ResolveErrorCode::DefinitionNotFound => "R502",
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

/// A resolution diagnostic with location and message.
#[derive(Debug, Clone)]
pub struct ResolveDiagnostic {
    /// Severity of this diagnostic.
    pub severity: Severity,
    /// Primary error code.
    pub code: ResolveErrorCode,
    /// Human-readable message.
    pub message: String,
    /// Primary source location.
    pub span: Span,
    /// Additional context.
    pub notes: Vec<String>,
    /// Related locations (e.g., for showing where a cycle occurs).
    pub related: Vec<(Span, String)>,
}

impl ResolveDiagnostic {
    /// Create a new error diagnostic.
    pub fn error(code: ResolveErrorCode, message: impl Into<String>, span: Span) -> Self {
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
    pub fn warning(code: ResolveErrorCode, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Warning,
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
}

impl fmt::Display for ResolveDiagnostic {
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

/// Collection of resolution diagnostics.
#[derive(Debug, Default)]
pub struct ResolveDiagnostics {
    diagnostics: Vec<ResolveDiagnostic>,
}

impl ResolveDiagnostics {
    /// Create a new empty diagnostics collection.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an error diagnostic.
    pub fn error(
        &mut self,
        code: ResolveErrorCode,
        message: impl Into<String>,
        span: Span,
    ) {
        self.diagnostics.push(ResolveDiagnostic::error(code, message, span));
    }

    /// Add a warning diagnostic.
    pub fn warning(
        &mut self,
        code: ResolveErrorCode,
        message: impl Into<String>,
        span: Span,
    ) {
        self.diagnostics.push(ResolveDiagnostic::warning(code, message, span));
    }

    /// Add a pre-built diagnostic.
    pub fn add(&mut self, diagnostic: ResolveDiagnostic) {
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

    /// Get all diagnostics.
    pub fn iter(&self) -> impl Iterator<Item = &ResolveDiagnostic> {
        self.diagnostics.iter()
    }

    /// Get all errors.
    pub fn errors(&self) -> impl Iterator<Item = &ResolveDiagnostic> {
        self.diagnostics.iter().filter(|d| d.is_error())
    }

    /// Take all diagnostics.
    pub fn take(&mut self) -> Vec<ResolveDiagnostic> {
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
    pub fn extend(&mut self, other: ResolveDiagnostics) {
        self.diagnostics.extend(other.diagnostics);
    }
}

// Convenience functions for common diagnostics.

/// Create a "module not found" diagnostic.
pub fn module_not_found(module: &str, span: Span) -> ResolveDiagnostic {
    ResolveDiagnostic::error(
        ResolveErrorCode::ModuleNotFound,
        format!("module `{}` not found", module),
        span,
    )
    .with_note("check that the module path is correct and the file exists")
}

/// Create a "symbol not found" diagnostic.
pub fn symbol_not_found(symbol: &str, module: &str, span: Span) -> ResolveDiagnostic {
    ResolveDiagnostic::error(
        ResolveErrorCode::SymbolNotFound,
        format!("symbol `{}` not found in module `{}`", symbol, module),
        span,
    )
}

/// Create a "circular dependency" diagnostic.
pub fn circular_dependency(cycle: &[String], span: Span) -> ResolveDiagnostic {
    let cycle_str = cycle.join(" -> ");
    ResolveDiagnostic::error(
        ResolveErrorCode::CircularDependency,
        format!("circular dependency detected: {}", cycle_str),
        span,
    )
    .with_note("break the cycle by reorganizing module dependencies")
}

/// Create a "private access" diagnostic.
pub fn private_access(symbol: &str, module: &str, span: Span) -> ResolveDiagnostic {
    ResolveDiagnostic::error(
        ResolveErrorCode::PrivateAccess,
        format!("cannot access private symbol `{}` from module `{}`", symbol, module),
        span,
    )
    .with_note("consider making the symbol public or using a public accessor")
}

/// Create a "non-exported access" diagnostic.
pub fn non_exported_access(symbol: &str, module: &str, span: Span) -> ResolveDiagnostic {
    ResolveDiagnostic::error(
        ResolveErrorCode::NonExportedAccess,
        format!(
            "symbol `{}` is not exported from module `{}`",
            symbol, module
        ),
        span,
    )
    .with_note("add the symbol to the module's export list")
}

/// Create a "duplicate module" diagnostic.
pub fn duplicate_module(module: &str, first: Span, second: Span) -> ResolveDiagnostic {
    ResolveDiagnostic::error(
        ResolveErrorCode::DuplicateModule,
        format!("duplicate module definition: `{}`", module),
        second,
    )
    .with_related(first, "first definition here")
}

/// Create a "duplicate import" diagnostic.
pub fn duplicate_import(module: &str, first: Span, second: Span) -> ResolveDiagnostic {
    ResolveDiagnostic::warning(
        ResolveErrorCode::DuplicateImport,
        format!("duplicate import of module `{}`", module),
        second,
    )
    .with_related(first, "first import here")
}
