//! Main semantic validation orchestration.
//!
//! This module provides the main entry point for semantic validation,
//! combining all the individual validators into a comprehensive pass.

use crate::attributes::AttributeValidator;
use crate::control_flow::ControlFlowValidator;
use crate::diagnostic::SemaDiagnostics;
use crate::duplicates::DuplicateChecker;
use crate::memory::MemoryValidator;
use kanagawa_hir::{HirFile, SymbolTable};

/// Result of semantic validation.
#[derive(Debug)]
pub struct ValidationResult {
    /// All collected diagnostics.
    pub diagnostics: SemaDiagnostics,
    /// Whether validation passed (no errors).
    pub success: bool,
}

impl ValidationResult {
    /// Get the number of errors.
    pub fn error_count(&self) -> usize {
        self.diagnostics.error_count()
    }

    /// Get the number of warnings.
    pub fn warning_count(&self) -> usize {
        self.diagnostics.warning_count()
    }

    /// Check if there are any errors.
    pub fn has_errors(&self) -> bool {
        self.diagnostics.has_errors()
    }
}

/// Options for semantic validation.
#[derive(Debug, Clone, Default)]
pub struct ValidationOptions {
    /// Whether to check for duplicate definitions.
    pub check_duplicates: bool,
    /// Whether to validate control flow.
    pub check_control_flow: bool,
    /// Whether to validate attributes.
    pub check_attributes: bool,
    /// Whether to validate memory annotations.
    pub check_memory: bool,
}

impl ValidationOptions {
    /// Create options with all checks enabled.
    pub fn all() -> Self {
        Self {
            check_duplicates: true,
            check_control_flow: true,
            check_attributes: true,
            check_memory: true,
        }
    }

    /// Create options with no checks enabled.
    pub fn none() -> Self {
        Self::default()
    }

    /// Enable duplicate checking.
    pub fn with_duplicates(mut self) -> Self {
        self.check_duplicates = true;
        self
    }

    /// Enable control flow checking.
    pub fn with_control_flow(mut self) -> Self {
        self.check_control_flow = true;
        self
    }

    /// Enable attribute checking.
    pub fn with_attributes(mut self) -> Self {
        self.check_attributes = true;
        self
    }

    /// Enable memory annotation checking.
    pub fn with_memory(mut self) -> Self {
        self.check_memory = true;
        self
    }
}

/// Main semantic validator.
///
/// This orchestrates all semantic validation passes.
///
/// # Example
///
/// ```ignore
/// use kanagawa_sema::{SemanticValidator, ValidationOptions};
///
/// let mut validator = SemanticValidator::new(ValidationOptions::all());
/// let result = validator.validate(&hir_file, &symbols);
///
/// if result.has_errors() {
///     for error in result.diagnostics.errors() {
///         eprintln!("{}", error);
///     }
/// }
/// ```
pub struct SemanticValidator {
    /// Validation options.
    options: ValidationOptions,
}

impl SemanticValidator {
    /// Create a new semantic validator with the given options.
    pub fn new(options: ValidationOptions) -> Self {
        Self { options }
    }

    /// Create a validator with all checks enabled.
    pub fn all() -> Self {
        Self::new(ValidationOptions::all())
    }

    /// Validate a HIR file.
    pub fn validate(&self, file: &HirFile, symbols: &SymbolTable) -> ValidationResult {
        let mut diagnostics = SemaDiagnostics::new();

        // Phase 1: Check for duplicate definitions
        if self.options.check_duplicates {
            let mut checker = DuplicateChecker::new(symbols);
            checker.check_file(file);
            diagnostics.extend(checker.take_diagnostics());
        }

        // Phase 2: Validate control flow
        if self.options.check_control_flow {
            let mut validator = ControlFlowValidator::new(symbols);
            validator.validate_file(file);
            diagnostics.extend(validator.take_diagnostics());
        }

        // Phase 3: Validate attributes
        if self.options.check_attributes {
            let mut validator = AttributeValidator::new();
            validator.validate_file(file);
            diagnostics.extend(validator.take_diagnostics());
        }

        // Phase 4: Validate memory annotations
        if self.options.check_memory {
            let mut validator = MemoryValidator::new();
            validator.validate_file(file);
            diagnostics.extend(validator.take_diagnostics());
        }

        let success = !diagnostics.has_errors();
        ValidationResult { diagnostics, success }
    }

    /// Validate multiple files.
    pub fn validate_files(&self, files: &[(&HirFile, &SymbolTable)]) -> ValidationResult {
        let mut diagnostics = SemaDiagnostics::new();

        for (file, symbols) in files {
            let result = self.validate(file, symbols);
            diagnostics.extend(result.diagnostics);
        }

        let success = !diagnostics.has_errors();
        ValidationResult { diagnostics, success }
    }
}

impl Default for SemanticValidator {
    fn default() -> Self {
        Self::all()
    }
}

/// Convenience function to validate a file with all checks.
pub fn validate(file: &HirFile, symbols: &SymbolTable) -> ValidationResult {
    SemanticValidator::all().validate(file, symbols)
}

/// Convenience function to validate only for duplicate definitions.
pub fn validate_duplicates(file: &HirFile, symbols: &SymbolTable) -> ValidationResult {
    SemanticValidator::new(ValidationOptions::none().with_duplicates()).validate(file, symbols)
}

/// Convenience function to validate only control flow.
pub fn validate_control_flow(file: &HirFile, symbols: &SymbolTable) -> ValidationResult {
    SemanticValidator::new(ValidationOptions::none().with_control_flow()).validate(file, symbols)
}

/// Convenience function to validate only attributes.
pub fn validate_attributes(file: &HirFile, symbols: &SymbolTable) -> ValidationResult {
    SemanticValidator::new(ValidationOptions::none().with_attributes()).validate(file, symbols)
}

/// Convenience function to validate only memory annotations.
pub fn validate_memory(file: &HirFile, symbols: &SymbolTable) -> ValidationResult {
    SemanticValidator::new(ValidationOptions::none().with_memory()).validate(file, symbols)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{DefId, HirBlock, HirFunction, HirItem, HirReturn, HirStmt, HirExpr, HirExprKind, Span, Ty, TyAttr, TyAttrFlag, FunctionKind};

    fn make_empty_file() -> HirFile {
        HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: Vec::new(),
        }
    }

    fn make_function(name: &str, return_ty: Ty, body: HirBlock) -> HirFunction {
        HirFunction {
            span: Span::default(),
            def_id: DefId(0),
            name: name.to_string(),
            ty: Ty::Void,
            kind: FunctionKind::Free,
            modifier: None,
            params: Vec::new(),
            return_ty,
            body: Some(body),
            attrs: Vec::new(),
        }
    }

    fn make_block(stmts: Vec<HirStmt>) -> HirBlock {
        HirBlock {
            span: Span::default(),
            stmts,
        }
    }

    #[test]
    fn test_empty_file_passes() {
        let symbols = SymbolTable::new();
        let file = make_empty_file();

        let result = validate(&file, &symbols);
        assert!(result.success);
        assert_eq!(result.error_count(), 0);
    }

    #[test]
    fn test_validation_options_all() {
        let opts = ValidationOptions::all();
        assert!(opts.check_duplicates);
        assert!(opts.check_control_flow);
        assert!(opts.check_attributes);
        assert!(opts.check_memory);
    }

    #[test]
    fn test_validation_options_none() {
        let opts = ValidationOptions::none();
        assert!(!opts.check_duplicates);
        assert!(!opts.check_control_flow);
        assert!(!opts.check_attributes);
        assert!(!opts.check_memory);
    }

    #[test]
    fn test_validation_options_builder() {
        let opts = ValidationOptions::none()
            .with_duplicates()
            .with_control_flow();

        assert!(opts.check_duplicates);
        assert!(opts.check_control_flow);
        assert!(!opts.check_attributes);
        assert!(!opts.check_memory);
    }

    #[test]
    fn test_duplicate_detection() {
        let symbols = SymbolTable::new();
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: vec![
                HirItem::Function(make_function("foo", Ty::Void, make_block(vec![]))),
                HirItem::Function(HirFunction {
                    span: Span { start: 100, end: 110, file_index: 0 },
                    def_id: DefId(1), // Different DefId
                    name: "foo".to_string(),
                    ty: Ty::Void,
                    kind: FunctionKind::Free,
                    modifier: None,
                    params: Vec::new(),
                    return_ty: Ty::Void,
                    body: Some(make_block(vec![])),
                    attrs: Vec::new(),
                }),
            ],
        };

        let result = validate_duplicates(&file, &symbols);
        assert!(!result.success);
        assert!(result.error_count() > 0);
    }

    #[test]
    fn test_control_flow_validation() {
        let symbols = SymbolTable::new();
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: vec![HirItem::Function(make_function(
                "test",
                Ty::Signed(32), // Non-void return
                make_block(vec![]), // No return statement
            ))],
        };

        let result = validate_control_flow(&file, &symbols);
        assert!(!result.success);
    }

    #[test]
    fn test_attribute_validation() {
        let symbols = SymbolTable::new();
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: vec![HirItem::Function(HirFunction {
                span: Span::default(),
                def_id: DefId(0),
                name: "test".to_string(),
                ty: Ty::Void,
                kind: FunctionKind::Free,
                modifier: None,
                params: Vec::new(),
                return_ty: Ty::Void,
                body: Some(make_block(vec![])),
                attrs: vec![
                    TyAttr::Flag(TyAttrFlag::Async),
                    TyAttr::Flag(TyAttrFlag::Pure), // Conflicts with async
                ],
            })],
        };

        let result = validate_attributes(&file, &symbols);
        assert!(!result.success);
    }

    #[test]
    fn test_combined_validation() {
        let symbols = SymbolTable::new();

        // File with multiple issues
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: vec![
                // Duplicate function
                HirItem::Function(make_function("dup", Ty::Void, make_block(vec![]))),
                HirItem::Function(HirFunction {
                    span: Span { start: 100, end: 110, file_index: 0 },
                    def_id: DefId(1),
                    name: "dup".to_string(),
                    ty: Ty::Void,
                    kind: FunctionKind::Free,
                    modifier: None,
                    params: Vec::new(),
                    return_ty: Ty::Void,
                    body: Some(make_block(vec![])),
                    attrs: Vec::new(),
                }),
                // Function with break outside loop
                HirItem::Function(make_function(
                    "bad_break",
                    Ty::Void,
                    make_block(vec![HirStmt::Break(Span::default())]),
                )),
            ],
        };

        let result = validate(&file, &symbols);
        assert!(!result.success);
        assert!(result.error_count() >= 2);
    }

    #[test]
    fn test_valid_function_passes() {
        let symbols = SymbolTable::new();
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: vec![HirItem::Function(make_function(
                "good",
                Ty::Signed(32),
                make_block(vec![HirStmt::Return(HirReturn {
                    span: Span::default(),
                    value: Some(HirExpr::new(
                        Span::default(),
                        Ty::Signed(32),
                        HirExprKind::IntLiteral { value: 42, suffix: None },
                    )),
                })]),
            ))],
        };

        let result = validate(&file, &symbols);
        assert!(result.success);
    }

    #[test]
    fn test_validation_result() {
        let mut diags = SemaDiagnostics::new();
        diags.error(
            crate::diagnostic::SemaErrorCode::DuplicateDefinition,
            "test error",
            Span::default(),
        );
        diags.warning(
            crate::diagnostic::SemaErrorCode::UnreachableCode,
            "test warning",
            Span::default(),
        );

        let result = ValidationResult {
            diagnostics: diags,
            success: false,
        };

        assert_eq!(result.error_count(), 1);
        assert_eq!(result.warning_count(), 1);
        assert!(result.has_errors());
    }

    #[test]
    fn test_validate_files() {
        let symbols1 = SymbolTable::new();
        let file1 = make_empty_file();

        let symbols2 = SymbolTable::new();
        let file2 = make_empty_file();

        let validator = SemanticValidator::all();
        let result = validator.validate_files(&[(&file1, &symbols1), (&file2, &symbols2)]);

        assert!(result.success);
    }
}
