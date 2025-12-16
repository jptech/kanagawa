//! Duplicate definition checking.
//!
//! This module validates that there are no duplicate definitions within scopes:
//! - Top-level items (functions, types, variables)
//! - Function parameters
//! - Struct/class/union fields
//! - Enum variants
//! - Template parameters
//! - Switch case labels

use crate::diagnostic::{
    duplicate_definition, duplicate_field, duplicate_parameter, duplicate_variant,
    SemaDiagnostic, SemaDiagnostics, SemaErrorCode,
};
use kanagawa_hir::{
    DefId, HirClass, HirEnum, HirFile, HirFunction, HirItem, HirParam, HirStmt, HirStruct,
    HirStructMember, HirSwitch, HirSwitchLabel, HirTemplate, HirTemplateParam, HirUnion, Span,
    SymbolTable,
};
use std::collections::HashMap;

/// Context for duplicate checking.
pub struct DuplicateChecker<'a> {
    /// The symbol table for looking up definitions.
    pub symbols: &'a SymbolTable,
    /// Collected diagnostics.
    pub diagnostics: SemaDiagnostics,
}

impl<'a> DuplicateChecker<'a> {
    /// Create a new duplicate checker.
    pub fn new(symbols: &'a SymbolTable) -> Self {
        Self {
            symbols,
            diagnostics: SemaDiagnostics::new(),
        }
    }

    /// Check a HIR file for duplicate definitions.
    pub fn check_file(&mut self, file: &HirFile) {
        // Track top-level names
        let mut top_level: HashMap<String, (DefId, Span)> = HashMap::new();

        for item in &file.items {
            if let Some((name, def_id, span)) = self.get_item_name_and_id(item) {
                if let Some(&(first_id, first_span)) = top_level.get(&name) {
                    // Only report if it's actually a different definition
                    if first_id != def_id {
                        self.diagnostics.add(duplicate_definition(&name, first_span, span));
                    }
                } else {
                    top_level.insert(name, (def_id, span));
                }
            }

            // Check for duplicates within the item
            self.check_item(item);
        }
    }

    /// Get the name, DefId, and span from an item.
    fn get_item_name_and_id(&self, item: &HirItem) -> Option<(String, DefId, Span)> {
        match item {
            HirItem::Function(f) => Some((f.name.clone(), f.def_id, f.span)),
            HirItem::Struct(s) => Some((s.name.clone(), s.def_id, s.span)),
            HirItem::Enum(e) => Some((e.name.clone(), e.def_id, e.span)),
            HirItem::Class(c) => Some((c.name.clone(), c.def_id, c.span)),
            HirItem::Union(u) => Some((u.name.clone(), u.def_id, u.span)),
            HirItem::Using(u) => Some((u.name.clone(), u.def_id, u.span)),
            HirItem::Variable(v) => Some((v.name.clone(), v.def_id, v.span)),
            HirItem::Template(t) => {
                // Template's name comes from the inner item
                self.get_item_name_and_id(&t.item).map(|(name, _, _)| (name, t.def_id, t.span))
            }
            // These don't have simple names to check
            HirItem::StaticIf(_)
            | HirItem::StaticAssert(_)
            | HirItem::DeclBlock(_)
            | HirItem::Extern(_)
            | HirItem::Export(_) => None,
        }
    }

    /// Check an item for internal duplicates.
    fn check_item(&mut self, item: &HirItem) {
        match item {
            HirItem::Function(f) => self.check_function(f),
            HirItem::Struct(s) => self.check_struct(s),
            HirItem::Enum(e) => self.check_enum(e),
            HirItem::Class(c) => self.check_class(c),
            HirItem::Union(u) => self.check_union(u),
            HirItem::Template(t) => self.check_template(t),
            HirItem::StaticIf(s) => {
                // Check both branches
                self.check_item(&s.then_item);
                if let Some(else_item) = &s.else_item {
                    self.check_item(else_item);
                }
            }
            HirItem::DeclBlock(d) => {
                for item in &d.items {
                    self.check_item(item);
                }
            }
            _ => {}
        }
    }

    /// Check a function for duplicate parameters and internal duplicates.
    pub fn check_function(&mut self, func: &HirFunction) {
        // Check for duplicate parameter names
        self.check_parameters(&func.params, &func.name);

        // Check statements in body for duplicates (switch cases, etc.)
        if let Some(body) = &func.body {
            for stmt in &body.stmts {
                self.check_statement(stmt);
            }
        }
    }

    /// Check parameters for duplicates.
    pub fn check_parameters(&mut self, params: &[HirParam], context: &str) {
        let mut seen: HashMap<String, Span> = HashMap::new();

        for param in params {
            let name = &param.name;
            if !name.is_empty() {
                if let Some(&first_span) = seen.get(name) {
                    self.diagnostics.add(
                        duplicate_parameter(name, first_span, param.span)
                            .with_note(format!("in function `{}`", context)),
                    );
                } else {
                    seen.insert(name.clone(), param.span);
                }
            }
        }
    }

    /// Check a struct for duplicate fields.
    pub fn check_struct(&mut self, s: &HirStruct) {
        self.check_struct_members(&s.members, &s.name, "struct");
    }

    /// Check a union for duplicate fields.
    pub fn check_union(&mut self, u: &HirUnion) {
        self.check_struct_members(&u.members, &u.name, "union");
    }

    /// Check a class for duplicate members.
    pub fn check_class(&mut self, c: &HirClass) {
        let mut seen: HashMap<String, Span> = HashMap::new();

        for member in &c.members {
            match member {
                kanagawa_hir::HirClassMember::Variable(v) => {
                    if let Some(&first_span) = seen.get(&v.name) {
                        self.diagnostics.add(duplicate_field(&v.name, &c.name, first_span, v.span));
                    } else {
                        seen.insert(v.name.clone(), v.span);
                    }
                }
                kanagawa_hir::HirClassMember::Function(f) => {
                    // Methods can be overloaded in some languages, but for Kanagawa
                    // we check for duplicate names (overloading would need signature checking)
                    if let Some(&first_span) = seen.get(&f.name) {
                        self.diagnostics.add(
                            SemaDiagnostic::error(
                                SemaErrorCode::DuplicateDefinition,
                                format!("duplicate method `{}` in class `{}`", f.name, c.name),
                                f.span,
                            )
                            .with_related(first_span, "first definition here"),
                        );
                    } else {
                        seen.insert(f.name.clone(), f.span);
                    }

                    // Also check the method's parameters
                    self.check_parameters(&f.params, &format!("{}::{}", c.name, f.name));
                }
                kanagawa_hir::HirClassMember::Access(_)
                | kanagawa_hir::HirClassMember::DefaultInit(_)
                | kanagawa_hir::HirClassMember::Nested(_) => {}
            }
        }
    }

    /// Check an enum for duplicate variants.
    pub fn check_enum(&mut self, e: &HirEnum) {
        let mut seen: HashMap<String, Span> = HashMap::new();

        for variant in &e.variants {
            if let Some(&first_span) = seen.get(&variant.name) {
                self.diagnostics.add(duplicate_variant(&variant.name, &e.name, first_span, variant.span));
            } else {
                seen.insert(variant.name.clone(), variant.span);
            }
        }
    }

    /// Check a template for duplicate parameters.
    pub fn check_template(&mut self, t: &HirTemplate) {
        let mut seen: HashMap<String, Span> = HashMap::new();

        for param in &t.params {
            let (name, span) = match param {
                HirTemplateParam::Type { name, span, .. } => (name, *span),
                HirTemplateParam::NonType { name, span, .. } => (name, *span),
            };
            if let Some(&first_span) = seen.get(name) {
                self.diagnostics.add(
                    SemaDiagnostic::error(
                        SemaErrorCode::DuplicateTemplateParam,
                        format!("duplicate template parameter `{}`", name),
                        span,
                    )
                    .with_related(first_span, "first parameter here"),
                );
            } else {
                seen.insert(name.clone(), span);
            }
        }

        // Check the body of the template
        self.check_item(&t.item);
    }

    /// Check struct members for duplicates (used by struct and union).
    fn check_struct_members(&mut self, members: &[HirStructMember], type_name: &str, kind: &str) {
        let mut seen: HashMap<String, Span> = HashMap::new();

        for member in members {
            if let Some(&first_span) = seen.get(&member.name) {
                self.diagnostics.add(
                    duplicate_field(&member.name, type_name, first_span, member.span)
                        .with_note(format!("in {} `{}`", kind, type_name)),
                );
            } else {
                seen.insert(member.name.clone(), member.span);
            }
        }
    }

    /// Check a statement for duplicates (primarily switch cases).
    fn check_statement(&mut self, stmt: &HirStmt) {
        match stmt {
            HirStmt::Switch(switch) => self.check_switch(switch),
            HirStmt::If(if_stmt) => {
                self.check_boxed_stmt(&if_stmt.then_branch);
                if let Some(else_branch) = &if_stmt.else_branch {
                    self.check_boxed_stmt(else_branch);
                }
            }
            HirStmt::Block(block) => {
                for s in &block.stmts {
                    self.check_statement(s);
                }
            }
            HirStmt::RangeFor(f) => {
                self.check_boxed_stmt(&f.body);
            }
            HirStmt::StaticFor(f) => {
                self.check_boxed_stmt(&f.body);
            }
            HirStmt::UnrolledFor(f) => {
                self.check_boxed_stmt(&f.body);
            }
            HirStmt::DoWhile(d) => {
                self.check_boxed_stmt(&d.body);
            }
            HirStmt::Annotated(a) => {
                self.check_statement(&a.stmt);
            }
            HirStmt::Reorder(r) => {
                self.check_boxed_stmt(&r.body);
            }
            HirStmt::Atomic(a) => {
                self.check_boxed_stmt(&a.body);
            }
            HirStmt::StaticIf(s) => {
                self.check_boxed_stmt(&s.then_branch);
                if let Some(else_branch) = &s.else_branch {
                    self.check_boxed_stmt(else_branch);
                }
            }
            _ => {}
        }
    }

    /// Check a boxed statement (handles Box<HirStmt> as block or single statement).
    fn check_boxed_stmt(&mut self, stmt: &HirStmt) {
        match stmt {
            HirStmt::Block(block) => {
                for s in &block.stmts {
                    self.check_statement(s);
                }
            }
            _ => self.check_statement(stmt),
        }
    }

    /// Check a switch statement for duplicate case labels.
    pub fn check_switch(&mut self, switch: &HirSwitch) {
        let mut seen_cases: HashMap<String, Span> = HashMap::new();
        let mut default_span: Option<Span> = None;

        for case in &switch.cases {
            match &case.label {
                HirSwitchLabel::Default => {
                    if let Some(first_span) = default_span {
                        self.diagnostics.add(
                            SemaDiagnostic::error(
                                SemaErrorCode::DuplicateCaseLabel,
                                "duplicate default case",
                                case.span,
                            )
                            .with_related(first_span, "first default here"),
                        );
                    } else {
                        default_span = Some(case.span);
                    }
                }
                HirSwitchLabel::Case(expr) => {
                    // Convert case label to string for comparison
                    let label = format!("case:{:?}", expr.span);
                    if let Some(&first_span) = seen_cases.get(&label) {
                        self.diagnostics.add(
                            SemaDiagnostic::error(
                                SemaErrorCode::DuplicateCaseLabel,
                                format!("duplicate case label"),
                                case.span,
                            )
                            .with_related(first_span, "first case here"),
                        );
                    } else {
                        seen_cases.insert(label, case.span);
                    }
                }
            }

            // Check statements in case body
            for stmt in &case.stmts {
                self.check_statement(stmt);
            }
        }
    }

    /// Take the collected diagnostics.
    pub fn take_diagnostics(self) -> SemaDiagnostics {
        self.diagnostics
    }
}

/// Check for duplicate definitions in a file.
pub fn check_duplicates(file: &HirFile, symbols: &SymbolTable) -> SemaDiagnostics {
    let mut checker = DuplicateChecker::new(symbols);
    checker.check_file(file);
    checker.take_diagnostics()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{HirBlock, Ty};

    fn make_param(name: &str, span_offset: u32) -> HirParam {
        HirParam {
            span: Span { start: span_offset, end: span_offset + 1, file_index: 0 },
            def_id: DefId(span_offset),
            name: name.to_string(),
            ty: Ty::Signed(32),
            default: None,
        }
    }

    fn make_struct_member(name: &str, span_offset: u32) -> HirStructMember {
        HirStructMember {
            span: Span { start: span_offset, end: span_offset + 1, file_index: 0 },
            def_id: DefId(span_offset),
            name: name.to_string(),
            ty: Ty::Signed(32),
            init: None,
        }
    }

    fn make_function(name: &str, params: Vec<HirParam>, span_offset: u32) -> HirFunction {
        HirFunction {
            span: Span { start: span_offset, end: span_offset + 10, file_index: 0 },
            def_id: DefId(span_offset),
            name: name.to_string(),
            ty: Ty::Void,
            kind: kanagawa_hir::FunctionKind::Free,
            modifier: None,
            params,
            return_ty: Ty::Void,
            body: Some(HirBlock { span: Span::default(), stmts: Vec::new() }),
            attrs: Vec::new(),
        }
    }

    fn make_struct(name: &str, members: Vec<HirStructMember>, span_offset: u32) -> HirStruct {
        HirStruct {
            span: Span { start: span_offset, end: span_offset + 10, file_index: 0 },
            def_id: DefId(span_offset),
            name: name.to_string(),
            ty: Ty::Void,
            members,
        }
    }

    #[test]
    fn test_no_duplicates() {
        let symbols = SymbolTable::new();
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: vec![
                HirItem::Function(make_function("foo", vec![], 0)),
                HirItem::Function(make_function("bar", vec![], 100)),
            ],
        };

        let diags = check_duplicates(&file, &symbols);
        assert!(!diags.has_errors());
    }

    #[test]
    fn test_duplicate_function() {
        let symbols = SymbolTable::new();
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: vec![
                HirItem::Function(make_function("foo", vec![], 0)),
                HirItem::Function(make_function("foo", vec![], 100)),
            ],
        };

        let diags = check_duplicates(&file, &symbols);
        assert!(diags.has_errors());
        assert_eq!(diags.error_count(), 1);

        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::DuplicateDefinition);
    }

    #[test]
    fn test_duplicate_parameter() {
        let symbols = SymbolTable::new();
        let func = make_function(
            "test",
            vec![
                make_param("x", 10),
                make_param("y", 20),
                make_param("x", 30), // Duplicate
            ],
            0,
        );

        let mut checker = DuplicateChecker::new(&symbols);
        checker.check_function(&func);
        let diags = checker.take_diagnostics();

        assert!(diags.has_errors());
        assert_eq!(diags.error_count(), 1);

        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::DuplicateParameter);
    }

    #[test]
    fn test_duplicate_struct_field() {
        let symbols = SymbolTable::new();
        let s = make_struct(
            "Point",
            vec![
                make_struct_member("x", 10),
                make_struct_member("y", 20),
                make_struct_member("x", 30), // Duplicate
            ],
            0,
        );

        let mut checker = DuplicateChecker::new(&symbols);
        checker.check_struct(&s);
        let diags = checker.take_diagnostics();

        assert!(diags.has_errors());
        assert_eq!(diags.error_count(), 1);

        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::DuplicateField);
    }

    #[test]
    fn test_duplicate_enum_variant() {
        let symbols = SymbolTable::new();
        let e = HirEnum {
            span: Span::default(),
            def_id: DefId(0),
            name: "Color".to_string(),
            ty: Ty::Unsigned(32),
            base_ty: Ty::Unsigned(32),
            variants: vec![
                kanagawa_hir::HirEnumVariant {
                    span: Span { start: 10, end: 11, file_index: 0 },
                    def_id: DefId(1),
                    name: "Red".to_string(),
                    value: None,
                },
                kanagawa_hir::HirEnumVariant {
                    span: Span { start: 20, end: 21, file_index: 0 },
                    def_id: DefId(2),
                    name: "Green".to_string(),
                    value: None,
                },
                kanagawa_hir::HirEnumVariant {
                    span: Span { start: 30, end: 31, file_index: 0 },
                    def_id: DefId(3),
                    name: "Red".to_string(), // Duplicate
                    value: None,
                },
            ],
        };

        let mut checker = DuplicateChecker::new(&symbols);
        checker.check_enum(&e);
        let diags = checker.take_diagnostics();

        assert!(diags.has_errors());
        assert_eq!(diags.error_count(), 1);

        let errors: Vec<_> = diags.errors().collect();
        assert_eq!(errors[0].code, SemaErrorCode::DuplicateVariant);
    }

    #[test]
    fn test_empty_param_not_duplicate() {
        let symbols = SymbolTable::new();
        let func = make_function(
            "test",
            vec![
                HirParam {
                    span: Span { start: 10, end: 11, file_index: 0 },
                    def_id: DefId(1),
                    name: "".to_string(), // Empty name
                    ty: Ty::Signed(32),
                    default: None,
                },
                HirParam {
                    span: Span { start: 20, end: 21, file_index: 0 },
                    def_id: DefId(2),
                    name: "".to_string(), // Also empty - should not be duplicate
                    ty: Ty::Signed(32),
                    default: None,
                },
            ],
            0,
        );

        let mut checker = DuplicateChecker::new(&symbols);
        checker.check_function(&func);
        let diags = checker.take_diagnostics();

        assert!(!diags.has_errors());
    }

    #[test]
    fn test_multiple_duplicates() {
        let symbols = SymbolTable::new();
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: vec![
                HirItem::Function(make_function("foo", vec![], 0)),
                HirItem::Function(make_function("foo", vec![], 100)),
                HirItem::Function(make_function("bar", vec![], 200)),
                HirItem::Function(make_function("bar", vec![], 300)),
            ],
        };

        let diags = check_duplicates(&file, &symbols);
        assert!(diags.has_errors());
        assert_eq!(diags.error_count(), 2);
    }
}
