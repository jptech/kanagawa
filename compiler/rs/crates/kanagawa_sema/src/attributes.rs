//! Attribute validation.
//!
//! This module validates attributes and their usage:
//! - Known vs unknown attributes
//! - Valid attribute targets (functions, arrays, loops, etc.)
//! - Attribute value constraints
//! - Conflicting attribute combinations
//! - Duplicate attributes

use crate::diagnostic::{
    conflicting_attributes, invalid_attribute_target, SemaDiagnostic,
    SemaDiagnostics, SemaErrorCode,
};
use kanagawa_hir::{
    HirFile, HirFunction, HirItem, HirStmt, HirStructMember,
    Span, Ty, TyAttr, TyAttrFlag, TyAttrName,
};
use std::collections::HashSet;

/// Target of an attribute application.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeTarget {
    /// Function declaration.
    Function,
    /// Array type.
    Array,
    /// Loop statement.
    Loop,
    /// General statement.
    Statement,
    /// Function parameter.
    Parameter,
    /// Struct/class field.
    Field,
}

impl std::fmt::Display for AttributeTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttributeTarget::Function => write!(f, "function"),
            AttributeTarget::Array => write!(f, "array"),
            AttributeTarget::Loop => write!(f, "loop"),
            AttributeTarget::Statement => write!(f, "statement"),
            AttributeTarget::Parameter => write!(f, "parameter"),
            AttributeTarget::Field => write!(f, "field"),
        }
    }
}

/// Attribute validator.
pub struct AttributeValidator {
    /// Collected diagnostics.
    pub diagnostics: SemaDiagnostics,
}

impl AttributeValidator {
    /// Create a new attribute validator.
    pub fn new() -> Self {
        Self {
            diagnostics: SemaDiagnostics::new(),
        }
    }

    /// Validate attributes on a HIR file.
    pub fn validate_file(&mut self, file: &HirFile) {
        for item in &file.items {
            self.validate_item(item);
        }
    }

    /// Validate an item's attributes.
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
                            // Check array type attributes
                            if let Ty::Array { attrs, .. } = &v.ty {
                                self.validate_attrs(attrs, AttributeTarget::Field, v.span);
                            }
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

    /// Validate function attributes.
    pub fn validate_function(&mut self, func: &HirFunction) {
        // Validate function-level attributes
        self.validate_attrs(&func.attrs, AttributeTarget::Function, func.span);

        // Check for conflicting function attributes
        self.check_function_attr_conflicts(&func.attrs, func.span);

        // Validate parameter attributes
        for param in &func.params {
            if let Ty::Array { attrs, .. } = &param.ty {
                self.validate_attrs(attrs, AttributeTarget::Array, param.span);
            }
        }

        // Validate return type attributes
        if let Ty::Array { attrs, .. } = &func.return_ty {
            self.validate_attrs(attrs, AttributeTarget::Array, func.span);
        }

        // Validate body statements
        if let Some(body) = &func.body {
            for stmt in &body.stmts {
                self.validate_statement(stmt);
            }
        }
    }

    /// Validate statement attributes.
    fn validate_statement(&mut self, stmt: &HirStmt) {
        match stmt {
            HirStmt::RangeFor(f) => {
                self.validate_loop_attrs(&f.attrs, f.span);
                self.validate_boxed_stmt(&f.body);
            }
            HirStmt::UnrolledFor(f) => {
                // UnrolledFor may not have attrs directly, but we still validate body
                self.validate_boxed_stmt(&f.body);
            }
            HirStmt::DoWhile(d) => {
                self.validate_loop_attrs(&d.attrs, d.span);
                self.validate_boxed_stmt(&d.body);
            }
            HirStmt::Annotated(a) => {
                self.validate_attrs(&a.attrs, AttributeTarget::Statement, a.span);
                self.validate_statement(&a.stmt);
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
            HirStmt::StaticFor(f) => {
                self.validate_boxed_stmt(&f.body);
            }
            HirStmt::Reorder(r) => {
                self.validate_boxed_stmt(&r.body);
            }
            HirStmt::Atomic(a) => {
                self.validate_boxed_stmt(&a.body);
            }
            HirStmt::StaticIf(s) => {
                self.validate_boxed_stmt(&s.then_branch);
                if let Some(else_branch) = &s.else_branch {
                    self.validate_boxed_stmt(else_branch);
                }
            }
            HirStmt::VarDecl(v) => {
                // Check array variable attributes
                if let Ty::Array { attrs, .. } = &v.ty {
                    self.validate_attrs(attrs, AttributeTarget::Array, v.span);
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

    /// Validate struct member attributes.
    fn validate_struct_member(&mut self, member: &HirStructMember) {
        // Check array type attributes
        if let Ty::Array { attrs, .. } = &member.ty {
            self.validate_attrs(attrs, AttributeTarget::Array, member.span);
        }
    }

    /// Validate loop attributes.
    fn validate_loop_attrs(&mut self, attrs: &[TyAttr], span: Span) {
        self.validate_attrs(attrs, AttributeTarget::Loop, span);
        self.check_loop_attr_conflicts(attrs, span);
    }

    /// Validate a set of attributes against a target.
    pub fn validate_attrs(&mut self, attrs: &[TyAttr], target: AttributeTarget, span: Span) {
        let mut seen: HashSet<String> = HashSet::new();

        for attr in attrs {
            let attr_name = get_attr_name(attr);

            // Check for duplicate attributes
            if seen.contains(&attr_name) {
                self.diagnostics.add(
                    SemaDiagnostic::warning(
                        SemaErrorCode::DuplicateAttribute,
                        format!("duplicate attribute `{}`", attr_name),
                        span,
                    )
                    .with_note("this attribute is already applied"),
                );
            } else {
                seen.insert(attr_name.clone());
            }

            // Check if attribute is valid for this target
            if !is_valid_for_target(attr, target) {
                self.diagnostics.add(invalid_attribute_target(&attr_name, &target.to_string(), span));
            }

            // Validate attribute value
            self.validate_attr_value(attr, span);
        }
    }

    /// Validate an attribute's value.
    fn validate_attr_value(&mut self, attr: &TyAttr, span: Span) {
        match attr {
            TyAttr::Int { name, value } => {
                match name {
                    TyAttrName::Latency => {
                        if *value < 0 {
                            self.diagnostics.add(
                                SemaDiagnostic::error(
                                    SemaErrorCode::InvalidAttributeValue,
                                    format!("latency must be non-negative, got {}", value),
                                    span,
                                ),
                            );
                        }
                    }
                    TyAttrName::CallRate => {
                        if *value <= 0 {
                            self.diagnostics.add(
                                SemaDiagnostic::error(
                                    SemaErrorCode::InvalidAttributeValue,
                                    format!("call_rate must be positive, got {}", value),
                                    span,
                                ),
                            );
                        }
                    }
                    TyAttrName::MaxThreads => {
                        if *value <= 0 {
                            self.diagnostics.add(
                                SemaDiagnostic::error(
                                    SemaErrorCode::InvalidAttributeValue,
                                    format!("max_threads must be positive, got {}", value),
                                    span,
                                ),
                            );
                        }
                    }
                    TyAttrName::FifoDepth => {
                        if *value < 0 {
                            self.diagnostics.add(
                                SemaDiagnostic::error(
                                    SemaErrorCode::InvalidAttributeValue,
                                    format!("fifo_depth must be non-negative, got {}", value),
                                    span,
                                ),
                            );
                        }
                    }
                    TyAttrName::TransactionSize => {
                        if *value <= 0 {
                            self.diagnostics.add(
                                SemaDiagnostic::error(
                                    SemaErrorCode::InvalidAttributeValue,
                                    format!("transaction_size must be positive, got {}", value),
                                    span,
                                ),
                            );
                        }
                    }
                    TyAttrName::ThreadRate => {
                        if *value <= 0 {
                            self.diagnostics.add(
                                SemaDiagnostic::error(
                                    SemaErrorCode::InvalidAttributeValue,
                                    format!("thread_rate must be positive, got {}", value),
                                    span,
                                ),
                            );
                        }
                    }
                    _ => {}
                }
            }
            TyAttr::Flag(_) => {
                // Flag attributes don't have values to validate
            }
            TyAttr::Named { .. } => {
                // Named attributes have complex values, validated elsewhere
            }
        }
    }

    /// Check for conflicting function attributes.
    fn check_function_attr_conflicts(&mut self, attrs: &[TyAttr], span: Span) {
        let has_async = attrs.iter().any(|a| matches!(a, TyAttr::Flag(TyAttrFlag::Async)));
        let has_pure = attrs.iter().any(|a| matches!(a, TyAttr::Flag(TyAttrFlag::Pure)));
        let has_pipelined = attrs.iter().any(|a| matches!(a, TyAttr::Flag(TyAttrFlag::Pipelined)));

        // async and pure are generally incompatible
        if has_async && has_pure {
            self.diagnostics.add(conflicting_attributes("async", "pure", span));
        }

        // pipelined and async might conflict in some contexts
        if has_pipelined && has_async {
            self.diagnostics.add(
                SemaDiagnostic::warning(
                    SemaErrorCode::ConflictingAttributes,
                    "using both `pipelined` and `async` may have unexpected behavior",
                    span,
                )
                .with_note("consider using only one execution model"),
            );
        }
    }

    /// Check for conflicting loop attributes.
    fn check_loop_attr_conflicts(&mut self, attrs: &[TyAttr], span: Span) {
        let has_pipelined = attrs.iter().any(|a| matches!(a, TyAttr::Flag(TyAttrFlag::Pipelined)));
        let has_unordered = attrs.iter().any(|a| matches!(a, TyAttr::Flag(TyAttrFlag::Unordered)));
        let has_reorder_by_looping = attrs.iter().any(|a| matches!(a, TyAttr::Flag(TyAttrFlag::ReorderByLooping)));

        // pipelined and unordered might conflict
        if has_pipelined && has_unordered {
            self.diagnostics.add(
                SemaDiagnostic::warning(
                    SemaErrorCode::ConflictingAttributes,
                    "using both `pipelined` and `unordered` on a loop may have unexpected behavior",
                    span,
                ),
            );
        }

        // reorder_by_looping without something to reorder
        if has_reorder_by_looping && !has_pipelined {
            self.diagnostics.add(
                SemaDiagnostic::warning(
                    SemaErrorCode::InvalidAttributeTarget,
                    "`reorder_by_looping` is typically used with `pipelined` loops",
                    span,
                ),
            );
        }
    }

    /// Take the collected diagnostics.
    pub fn take_diagnostics(self) -> SemaDiagnostics {
        self.diagnostics
    }
}

impl Default for AttributeValidator {
    fn default() -> Self {
        Self::new()
    }
}

/// Get the name of an attribute for display.
fn get_attr_name(attr: &TyAttr) -> String {
    match attr {
        TyAttr::Flag(flag) => format!("{:?}", flag).to_lowercase(),
        TyAttr::Int { name, .. } => format!("{:?}", name).to_lowercase(),
        TyAttr::Named { name, .. } => format!("{:?}", name).to_lowercase(),
    }
}

/// Check if an attribute is valid for a given target.
fn is_valid_for_target(attr: &TyAttr, target: AttributeTarget) -> bool {
    match attr {
        TyAttr::Flag(flag) => {
            match flag {
                // Function-only attributes
                TyAttrFlag::Async | TyAttrFlag::Pure => {
                    matches!(target, AttributeTarget::Function)
                }
                // Loop-oriented attributes
                TyAttrFlag::Pipelined | TyAttrFlag::ReorderByLooping => {
                    matches!(target, AttributeTarget::Function | AttributeTarget::Loop)
                }
                TyAttrFlag::Unordered => {
                    matches!(target, AttributeTarget::Loop | AttributeTarget::Statement)
                }
                // Memory attributes
                TyAttrFlag::Memory | TyAttrFlag::QuadPort => {
                    matches!(target, AttributeTarget::Array | AttributeTarget::Field)
                }
                // Hardware attributes
                TyAttrFlag::Atomic => {
                    matches!(target, AttributeTarget::Statement | AttributeTarget::Function)
                }
                TyAttrFlag::Reset | TyAttrFlag::Initialize => {
                    matches!(target, AttributeTarget::Function | AttributeTarget::Field)
                }
                TyAttrFlag::EndTransaction | TyAttrFlag::NonReplicated | TyAttrFlag::NoBackPressure => {
                    matches!(target, AttributeTarget::Function | AttributeTarget::Statement)
                }
            }
        }
        TyAttr::Int { name, .. } => {
            match name {
                TyAttrName::Latency => {
                    matches!(target, AttributeTarget::Function | AttributeTarget::Loop | AttributeTarget::Array)
                }
                TyAttrName::CallRate | TyAttrName::MaxThreads | TyAttrName::ThreadRate => {
                    matches!(target, AttributeTarget::Function)
                }
                TyAttrName::FifoDepth | TyAttrName::TransactionSize => {
                    matches!(target, AttributeTarget::Array | AttributeTarget::Parameter)
                }
                TyAttrName::Schedule | TyAttrName::Ecc | TyAttrName::Rename => {
                    // These are generally flexible
                    true
                }
            }
        }
        TyAttr::Named { name, .. } => {
            match name {
                TyAttrName::Schedule => {
                    matches!(target, AttributeTarget::Function | AttributeTarget::Loop)
                }
                _ => true, // Named attributes are generally flexible
            }
        }
    }
}

/// Validate attributes in a file.
pub fn validate_attributes(file: &HirFile) -> SemaDiagnostics {
    let mut validator = AttributeValidator::new();
    validator.validate_file(file);
    validator.take_diagnostics()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{DefId, HirBlock, FunctionKind};

    fn make_function_with_attrs(name: &str, attrs: Vec<TyAttr>) -> HirFunction {
        HirFunction {
            span: Span::default(),
            def_id: DefId(0),
            name: name.to_string(),
            ty: Ty::Void,
            kind: FunctionKind::Free,
            modifier: None,
            params: Vec::new(),
            return_ty: Ty::Void,
            body: Some(HirBlock { span: Span::default(), stmts: Vec::new() }),
            attrs,
        }
    }

    #[test]
    fn test_valid_function_attrs() {
        let func = make_function_with_attrs("test", vec![
            TyAttr::Flag(TyAttrFlag::Pipelined),
        ]);

        let mut validator = AttributeValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_conflicting_async_pure() {
        let func = make_function_with_attrs("test", vec![
            TyAttr::Flag(TyAttrFlag::Async),
            TyAttr::Flag(TyAttrFlag::Pure),
        ]);

        let mut validator = AttributeValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::ConflictingAttributes);
    }

    #[test]
    fn test_invalid_latency_value() {
        let func = make_function_with_attrs("test", vec![
            TyAttr::Int { name: TyAttrName::Latency, value: -5 },
        ]);

        let mut validator = AttributeValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::InvalidAttributeValue);
    }

    #[test]
    fn test_valid_latency_value() {
        let func = make_function_with_attrs("test", vec![
            TyAttr::Int { name: TyAttrName::Latency, value: 5 },
        ]);

        let mut validator = AttributeValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_duplicate_attribute() {
        let func = make_function_with_attrs("test", vec![
            TyAttr::Flag(TyAttrFlag::Pipelined),
            TyAttr::Flag(TyAttrFlag::Pipelined), // Duplicate
        ]);

        let mut validator = AttributeValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        // Should have warning about duplicate
        assert!(diags.warning_count() > 0);
    }

    #[test]
    fn test_memory_attr_on_function() {
        // Memory attribute should not be valid on function
        let func = make_function_with_attrs("test", vec![
            TyAttr::Flag(TyAttrFlag::Memory),
        ]);

        let mut validator = AttributeValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::InvalidAttributeTarget);
    }

    #[test]
    fn test_valid_array_attrs() {
        let attrs = vec![
            TyAttr::Flag(TyAttrFlag::Memory),
            TyAttr::Int { name: TyAttrName::FifoDepth, value: 16 },
        ];

        let mut validator = AttributeValidator::new();
        validator.validate_attrs(&attrs, AttributeTarget::Array, Span::default());
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_invalid_max_threads() {
        let func = make_function_with_attrs("test", vec![
            TyAttr::Int { name: TyAttrName::MaxThreads, value: 0 },
        ]);

        let mut validator = AttributeValidator::new();
        validator.validate_function(&func);
        let diags = validator.take_diagnostics();

        assert!(diags.has_errors());
    }

    #[test]
    fn test_loop_attrs() {
        let attrs = vec![
            TyAttr::Flag(TyAttrFlag::Pipelined),
            TyAttr::Int { name: TyAttrName::Latency, value: 2 },
        ];

        let mut validator = AttributeValidator::new();
        validator.validate_loop_attrs(&attrs, Span::default());
        let diags = validator.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_attribute_target_checking() {
        // Pure should only be on functions
        assert!(is_valid_for_target(&TyAttr::Flag(TyAttrFlag::Pure), AttributeTarget::Function));
        assert!(!is_valid_for_target(&TyAttr::Flag(TyAttrFlag::Pure), AttributeTarget::Loop));

        // Memory should be on arrays/fields
        assert!(is_valid_for_target(&TyAttr::Flag(TyAttrFlag::Memory), AttributeTarget::Array));
        assert!(is_valid_for_target(&TyAttr::Flag(TyAttrFlag::Memory), AttributeTarget::Field));
        assert!(!is_valid_for_target(&TyAttr::Flag(TyAttrFlag::Memory), AttributeTarget::Function));

        // Pipelined can be on functions and loops
        assert!(is_valid_for_target(&TyAttr::Flag(TyAttrFlag::Pipelined), AttributeTarget::Function));
        assert!(is_valid_for_target(&TyAttr::Flag(TyAttrFlag::Pipelined), AttributeTarget::Loop));
    }
}
