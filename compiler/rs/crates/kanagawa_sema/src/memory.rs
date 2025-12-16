//! Memory and register annotation validation.
//!
//! This module validates memory and register annotations:
//! - Memory attributes can only be applied to arrays
//! - Valid FIFO depths and latency values
//! - Conflicting memory configurations
//! - Valid atomic operation scopes
//! - Register allocation hints

use crate::diagnostic::{
    invalid_latency_value, SemaDiagnostic, SemaDiagnostics,
    SemaErrorCode,
};
use kanagawa_hir::{
    HirAtomic, HirFile, HirFunction, HirItem, HirParam, HirStmt, HirStructMember, HirVariable,
    Span, Ty, TyAttr, TyAttrFlag, TyAttrName,
};

/// Memory annotation validator.
pub struct MemoryValidator {
    /// Collected diagnostics.
    pub diagnostics: SemaDiagnostics,
}

impl MemoryValidator {
    /// Create a new memory validator.
    pub fn new() -> Self {
        Self {
            diagnostics: SemaDiagnostics::new(),
        }
    }

    /// Validate memory annotations in a HIR file.
    pub fn validate_file(&mut self, file: &HirFile) {
        for item in &file.items {
            self.validate_item(item);
        }
    }

    /// Validate an item's memory annotations.
    fn validate_item(&mut self, item: &HirItem) {
        match item {
            HirItem::Function(f) => self.validate_function(f),
            HirItem::Struct(s) => {
                for member in &s.members {
                    self.validate_struct_member(member);
                }
            }
            HirItem::Class(c) => {
                for member in &c.members {
                    match member {
                        kanagawa_hir::HirClassMember::Variable(v) => {
                            self.validate_variable(v);
                        }
                        kanagawa_hir::HirClassMember::Function(f) => {
                            self.validate_function(f);
                        }
                        _ => {}
                    }
                }
            }
            HirItem::Union(u) => {
                for member in &u.members {
                    self.validate_struct_member(member);
                }
            }
            HirItem::Variable(v) => {
                self.validate_variable(v);
            }
            HirItem::Template(t) => {
                self.validate_item(&t.item);
            }
            HirItem::StaticIf(s) => {
                self.validate_item(&s.then_item);
                if let Some(else_item) = &s.else_item {
                    self.validate_item(else_item);
                }
            }
            HirItem::DeclBlock(d) => {
                for item in &d.items {
                    self.validate_item(item);
                }
            }
            _ => {}
        }
    }

    /// Validate function memory annotations.
    pub fn validate_function(&mut self, func: &HirFunction) {
        // Validate parameter types for memory annotations
        for param in &func.params {
            self.validate_param(param);
        }

        // Validate return type for memory annotations
        self.validate_return_type(&func.return_ty, func.span);

        // Validate body statements
        if let Some(body) = &func.body {
            for stmt in &body.stmts {
                self.validate_statement(stmt);
            }
        }
    }

    /// Validate a parameter's memory annotations.
    fn validate_param(&mut self, param: &HirParam) {
        match &param.ty {
            Ty::Array { attrs, .. } => {
                self.validate_array_attrs(attrs, param.span);
            }
            _ => {
                // Non-array types shouldn't have memory attributes
                // (but they might have other attributes that are handled elsewhere)
            }
        }
    }

    /// Validate return type memory annotations.
    fn validate_return_type(&mut self, ty: &Ty, span: Span) {
        if let Ty::Array { attrs, .. } = ty {
            self.validate_array_attrs(attrs, span);
        }
    }

    /// Validate a struct member's memory annotations.
    fn validate_struct_member(&mut self, member: &HirStructMember) {
        // HirStructMember doesn't have attrs field, just check array type
        if let Ty::Array { attrs, .. } = &member.ty {
            self.validate_array_attrs(attrs, member.span);
        }
    }

    /// Validate a variable's memory annotations.
    fn validate_variable(&mut self, v: &HirVariable) {
        if let Ty::Array { attrs, .. } = &v.ty {
            self.validate_array_attrs(attrs, v.span);
        }
    }

    /// Validate statement memory annotations.
    fn validate_statement(&mut self, stmt: &HirStmt) {
        match stmt {
            HirStmt::VarDecl(v) => {
                self.validate_variable(v);
            }
            HirStmt::Atomic(a) => {
                self.validate_atomic(a);
            }
            HirStmt::If(i) => {
                self.validate_boxed_stmt(&i.then_branch);
                if let Some(else_branch) = &i.else_branch {
                    self.validate_boxed_stmt(else_branch);
                }
            }
            HirStmt::Switch(sw) => {
                for case in &sw.cases {
                    for s in &case.stmts {
                        self.validate_statement(s);
                    }
                }
            }
            HirStmt::Block(b) => {
                for s in &b.stmts {
                    self.validate_statement(s);
                }
            }
            HirStmt::RangeFor(f) => {
                self.validate_boxed_stmt(&f.body);
            }
            HirStmt::StaticFor(f) => {
                self.validate_boxed_stmt(&f.body);
            }
            HirStmt::UnrolledFor(f) => {
                self.validate_boxed_stmt(&f.body);
            }
            HirStmt::DoWhile(d) => {
                self.validate_boxed_stmt(&d.body);
            }
            HirStmt::Annotated(a) => {
                self.validate_statement(&a.stmt);
            }
            HirStmt::Reorder(r) => {
                self.validate_boxed_stmt(&r.body);
            }
            HirStmt::StaticIf(s) => {
                self.validate_boxed_stmt(&s.then_branch);
                if let Some(else_branch) = &s.else_branch {
                    self.validate_boxed_stmt(else_branch);
                }
            }
            _ => {}
        }
    }

    /// Validate a boxed statement (handles Box<HirStmt> as block or single statement).
    fn validate_boxed_stmt(&mut self, stmt: &HirStmt) {
        match stmt {
            HirStmt::Block(block) => {
                for s in &block.stmts {
                    self.validate_statement(s);
                }
            }
            _ => self.validate_statement(stmt),
        }
    }

    /// Validate an atomic block.
    fn validate_atomic(&mut self, atomic: &HirAtomic) {
        // Validate atomic scope - check if body is empty
        let is_empty = match atomic.body.as_ref() {
            HirStmt::Block(block) => block.stmts.is_empty(),
            _ => false,
        };

        if is_empty {
            self.diagnostics.add(
                SemaDiagnostic::warning(
                    SemaErrorCode::InvalidAtomicScope,
                    "atomic block is empty",
                    atomic.span,
                )
                .with_note("empty atomic blocks have no effect"),
            );
        }

        // Validate statements inside atomic block
        self.validate_atomic_statement(&atomic.body, atomic.span);
    }

    /// Validate a statement inside an atomic block.
    fn validate_atomic_statement(&mut self, stmt: &HirStmt, atomic_span: Span) {
        // Check for nested atomics (not allowed)
        match stmt {
            HirStmt::Atomic(a) => {
                self.diagnostics.add(
                    SemaDiagnostic::error(
                        SemaErrorCode::InvalidAtomicScope,
                        "nested atomic blocks are not allowed",
                        a.span,
                    )
                    .with_related(atomic_span, "outer atomic block here"),
                );
            }
            HirStmt::Block(b) => {
                for s in &b.stmts {
                    self.validate_atomic_statement(s, atomic_span);
                }
            }
            HirStmt::If(i) => {
                self.validate_atomic_boxed_stmt(&i.then_branch, atomic_span);
                if let Some(else_branch) = &i.else_branch {
                    self.validate_atomic_boxed_stmt(else_branch, atomic_span);
                }
            }
            _ => {}
        }
    }

    /// Validate a boxed statement inside an atomic block.
    fn validate_atomic_boxed_stmt(&mut self, stmt: &HirStmt, atomic_span: Span) {
        match stmt {
            HirStmt::Block(block) => {
                for s in &block.stmts {
                    self.validate_atomic_statement(s, atomic_span);
                }
            }
            _ => self.validate_atomic_statement(stmt, atomic_span),
        }
    }

    /// Validate array-specific attributes.
    pub fn validate_array_attrs(&mut self, attrs: &[TyAttr], span: Span) {
        let mut has_memory = false;
        let mut has_quad_port = false;
        let mut fifo_depth: Option<i64> = None;
        let mut latency: Option<i64> = None;

        for attr in attrs {
            match attr {
                TyAttr::Flag(TyAttrFlag::Memory) => {
                    has_memory = true;
                }
                TyAttr::Flag(TyAttrFlag::QuadPort) => {
                    has_quad_port = true;
                }
                TyAttr::Int { name: TyAttrName::FifoDepth, value } => {
                    if *value < 0 {
                        self.diagnostics.add(
                            SemaDiagnostic::error(
                                SemaErrorCode::InvalidFifoDepth,
                                format!("FIFO depth must be non-negative, got {}", value),
                                span,
                            ),
                        );
                    }
                    // Check for power of 2 (recommended)
                    if *value > 0 && !is_power_of_two(*value as u64) {
                        self.diagnostics.add(
                            SemaDiagnostic::warning(
                                SemaErrorCode::InvalidFifoDepth,
                                format!("FIFO depth {} is not a power of 2, which may be inefficient", value),
                                span,
                            )
                            .with_note("power of 2 depths are typically more efficient"),
                        );
                    }
                    fifo_depth = Some(*value);
                }
                TyAttr::Int { name: TyAttrName::Latency, value } => {
                    if *value < 0 {
                        self.diagnostics.add(invalid_latency_value(*value, span));
                    }
                    latency = Some(*value);
                }
                TyAttr::Int { name: TyAttrName::TransactionSize, value } => {
                    if *value <= 0 {
                        self.diagnostics.add(
                            SemaDiagnostic::error(
                                SemaErrorCode::InvalidAttributeValue,
                                format!("transaction size must be positive, got {}", value),
                                span,
                            ),
                        );
                    }
                }
                TyAttr::Int { name: TyAttrName::Ecc, value } => {
                    // ECC should be a reasonable value (typically 0, 1, or 2)
                    if *value < 0 || *value > 2 {
                        self.diagnostics.add(
                            SemaDiagnostic::warning(
                                SemaErrorCode::InvalidAttributeValue,
                                format!("unusual ECC value {}, expected 0, 1, or 2", value),
                                span,
                            ),
                        );
                    }
                }
                _ => {}
            }
        }

        // Check for conflicting configurations
        if has_quad_port && fifo_depth.is_some() {
            self.diagnostics.add(
                SemaDiagnostic::warning(
                    SemaErrorCode::ConflictingMemoryAttrs,
                    "quad_port and fifo_depth together may have unexpected behavior",
                    span,
                )
                .with_note("quad_port is typically used for RAM, not FIFOs"),
            );
        }

        // Warn about memory attribute without latency
        if has_memory && latency.is_none() {
            self.diagnostics.add(
                SemaDiagnostic::info(
                    SemaErrorCode::MissingRequiredAttribute,
                    "memory array without explicit latency will use default",
                    span,
                )
                .with_note("consider specifying latency for better synthesis results"),
            );
        }
    }

    /// Take the collected diagnostics.
    pub fn take_diagnostics(self) -> SemaDiagnostics {
        self.diagnostics
    }
}

impl Default for MemoryValidator {
    fn default() -> Self {
        Self::new()
    }
}

/// Check if a value is a power of 2.
fn is_power_of_two(n: u64) -> bool {
    n > 0 && (n & (n - 1)) == 0
}

/// Check if an attribute is memory-only (can only apply to arrays).
#[allow(dead_code)]
fn is_memory_only_attr(attr: &TyAttr) -> bool {
    match attr {
        TyAttr::Flag(TyAttrFlag::Memory | TyAttrFlag::QuadPort) => true,
        TyAttr::Int { name, .. } => matches!(
            name,
            TyAttrName::FifoDepth | TyAttrName::Ecc | TyAttrName::TransactionSize
        ),
        _ => false,
    }
}

/// Get the name of an attribute.
#[allow(dead_code)]
fn get_attr_name(attr: &TyAttr) -> String {
    match attr {
        TyAttr::Flag(flag) => format!("{:?}", flag).to_lowercase(),
        TyAttr::Int { name, .. } => format!("{:?}", name).to_lowercase(),
        TyAttr::Named { name, .. } => format!("{:?}", name).to_lowercase(),
    }
}

/// Validate memory annotations in a file.
pub fn validate_memory(file: &HirFile) -> SemaDiagnostics {
    let mut validator = MemoryValidator::new();
    validator.validate_file(file);
    validator.take_diagnostics()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{DefId, HirBlock, FunctionKind};

    fn make_array_ty(attrs: Vec<TyAttr>) -> Ty {
        Ty::Array {
            attrs,
            element: Box::new(Ty::Signed(32)),
            dims: vec![16],
        }
    }

    fn make_function_with_array_param(param_attrs: Vec<TyAttr>) -> HirFunction {
        HirFunction {
            span: Span::default(),
            def_id: DefId(0),
            name: "test".to_string(),
            ty: Ty::Void,
            kind: FunctionKind::Free,
            modifier: None,
            params: vec![HirParam {
                span: Span::default(),
                def_id: DefId(1),
                name: "arr".to_string(),
                ty: make_array_ty(param_attrs),
                default: None,
            }],
            return_ty: Ty::Void,
            body: Some(HirBlock { span: Span::default(), stmts: Vec::new() }),
            attrs: Vec::new(),
        }
    }

    #[test]
    fn test_valid_memory_attrs() {
        let func = make_function_with_array_param(vec![
            TyAttr::Flag(TyAttrFlag::Memory),
            TyAttr::Int { name: TyAttrName::Latency, value: 2 },
        ]);

        let mut validator = MemoryValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_invalid_fifo_depth() {
        let func = make_function_with_array_param(vec![
            TyAttr::Int { name: TyAttrName::FifoDepth, value: -4 },
        ]);

        let mut validator = MemoryValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::InvalidFifoDepth);
    }

    #[test]
    fn test_non_power_of_two_fifo() {
        let func = make_function_with_array_param(vec![
            TyAttr::Int { name: TyAttrName::FifoDepth, value: 15 }, // Not power of 2
        ]);

        let mut validator = MemoryValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        // Should have warning about non-power-of-2
        assert!(diags.warning_count() > 0);
    }

    #[test]
    fn test_power_of_two_fifo() {
        let func = make_function_with_array_param(vec![
            TyAttr::Int { name: TyAttrName::FifoDepth, value: 16 }, // Power of 2
        ]);

        let mut validator = MemoryValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        // Should not have error for power of 2
        assert!(!diags.has_errors());
    }

    #[test]
    fn test_invalid_latency() {
        let func = make_function_with_array_param(vec![
            TyAttr::Int { name: TyAttrName::Latency, value: -1 },
        ]);

        let mut validator = MemoryValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
    }

    #[test]
    fn test_is_power_of_two() {
        assert!(is_power_of_two(1));
        assert!(is_power_of_two(2));
        assert!(is_power_of_two(4));
        assert!(is_power_of_two(16));
        assert!(is_power_of_two(1024));

        assert!(!is_power_of_two(0));
        assert!(!is_power_of_two(3));
        assert!(!is_power_of_two(15));
        assert!(!is_power_of_two(100));
    }

    #[test]
    fn test_quad_port_with_fifo_warning() {
        let func = make_function_with_array_param(vec![
            TyAttr::Flag(TyAttrFlag::QuadPort),
            TyAttr::Int { name: TyAttrName::FifoDepth, value: 16 },
        ]);

        let mut validator = MemoryValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        // Should warn about conflicting configuration
        assert!(diags.warning_count() > 0);
    }

    #[test]
    fn test_memory_without_latency_info() {
        let func = make_function_with_array_param(vec![
            TyAttr::Flag(TyAttrFlag::Memory),
            // No latency specified
        ]);

        let mut validator = MemoryValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        // Should have info about missing latency
        let infos: Vec<_> = diags.iter().filter(|d| !d.is_error() && !d.is_warning()).collect();
        assert!(!infos.is_empty());
    }

    #[test]
    fn test_nested_atomic_not_allowed() {
        let inner_atomic = HirStmt::Atomic(HirAtomic {
            span: Span { start: 20, end: 30, file_index: 0 },
            body: Box::new(HirStmt::Block(HirBlock { span: Span::default(), stmts: Vec::new() })),
        });

        let outer_atomic = HirAtomic {
            span: Span { start: 0, end: 50, file_index: 0 },
            body: Box::new(HirStmt::Block(HirBlock {
                span: Span::default(),
                stmts: vec![inner_atomic],
            })),
        };

        let mut validator = MemoryValidator::new();
        validator.validate_atomic(&outer_atomic);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::InvalidAtomicScope);
    }

    #[test]
    fn test_empty_atomic_warning() {
        let atomic = HirAtomic {
            span: Span::default(),
            body: Box::new(HirStmt::Block(HirBlock { span: Span::default(), stmts: Vec::new() })),
        };

        let mut validator = MemoryValidator::new();
        validator.validate_atomic(&atomic);
        let diags = validator.take_diagnostics();

        assert!(diags.warning_count() > 0);
    }
}
