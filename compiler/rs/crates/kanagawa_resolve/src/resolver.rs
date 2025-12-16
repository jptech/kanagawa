//! Main module resolution logic.
//!
//! This module provides the top-level API for multi-file module resolution:
//! - ModuleResolver: The main resolver that processes all modules
//! - ResolveResult: The result of resolution including diagnostics
//! - Cross-module symbol lookup and binding

use crate::diagnostic::{ResolveDiagnostic, ResolveDiagnostics, ResolveErrorCode};
use crate::exports::compute_exports;
use crate::graph::{ModuleGraph, ModuleId};
use crate::visibility::{check_module_visibility, validate_exports, VisibilityContext};
use kanagawa_hir::{
    DefId, HirExpr, HirExprKind, HirFile, HirItem, HirStmt, SymbolTable,
};
use std::collections::HashMap;

/// Result of module resolution.
#[derive(Debug)]
pub struct ResolveResult {
    /// The resolved module graph.
    pub graph: ModuleGraph,
    /// All diagnostics (errors and warnings).
    pub diagnostics: Vec<ResolveDiagnostic>,
    /// Whether resolution succeeded (no errors).
    pub success: bool,
}

impl ResolveResult {
    /// Check if there are any errors.
    pub fn has_errors(&self) -> bool {
        !self.success
    }

    /// Get the number of errors.
    pub fn error_count(&self) -> usize {
        self.diagnostics.iter().filter(|d| d.is_error()).count()
    }

    /// Get the resolved module graph (if successful).
    pub fn into_graph(self) -> Option<ModuleGraph> {
        if self.success {
            Some(self.graph)
        } else {
            None
        }
    }
}

/// The main module resolver.
///
/// Use this to perform multi-file module resolution:
///
/// ```ignore
/// let mut resolver = ModuleResolver::new();
///
/// // Add all modules
/// for (file, symbols) in files {
///     resolver.add_module(file, symbols);
/// }
///
/// // Resolve
/// let result = resolver.resolve_all();
/// ```
#[derive(Debug, Default)]
pub struct ModuleResolver {
    /// The module graph being built.
    graph: ModuleGraph,
    /// Collected diagnostics during resolution.
    diagnostics: ResolveDiagnostics,
    /// Map from import alias to (module_id, namespace) for quick lookup.
    import_aliases: HashMap<String, (ModuleId, String)>,
}

impl ModuleResolver {
    /// Create a new module resolver.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a module to the resolver.
    ///
    /// Returns the module ID and whether it was newly added.
    pub fn add_module(&mut self, file: HirFile, symbols: SymbolTable) -> (ModuleId, bool) {
        self.graph.add_module(file, symbols)
    }

    /// Add a module with an associated file path.
    pub fn add_module_with_path(
        &mut self,
        file: HirFile,
        symbols: SymbolTable,
        path: impl Into<String>,
    ) -> (ModuleId, bool) {
        let (id, is_new) = self.graph.add_module(file, symbols);
        if is_new {
            self.graph.set_module_path(id, path);
        }
        (id, is_new)
    }

    /// Get the number of modules added.
    pub fn module_count(&self) -> usize {
        self.graph.len()
    }

    /// Resolve all modules.
    ///
    /// This performs the full resolution process:
    /// 1. Build dependency graph
    /// 2. Detect cycles
    /// 3. Compute exports
    /// 4. Resolve cross-module references
    /// 5. Check visibility
    pub fn resolve_all(mut self) -> ResolveResult {
        // Phase 1: Build dependency graph from imports
        self.graph.build_dependencies(&mut self.diagnostics);

        // Phase 2: Detect circular dependencies
        let cycles = self.graph.detect_cycles(&mut self.diagnostics);
        let has_cycles = !cycles.is_empty();

        // Phase 3: Compute exports (even with cycles, do best effort)
        compute_exports(&mut self.graph, &mut self.diagnostics);

        // Phase 4: Validate exports (check no private exports)
        for id in self.graph.module_ids().collect::<Vec<_>>() {
            validate_exports(&self.graph, id, &mut self.diagnostics);
        }

        // Phase 5: Check module visibility
        for id in self.graph.module_ids().collect::<Vec<_>>() {
            check_module_visibility(&self.graph, id, &mut self.diagnostics);
        }

        // Phase 6: Resolve cross-module references
        if !has_cycles {
            self.resolve_cross_module_references();
        }

        // Build result
        let diagnostics = self.diagnostics.take();
        let success = !diagnostics.iter().any(|d| d.is_error());

        ResolveResult {
            graph: self.graph,
            diagnostics,
            success,
        }
    }

    /// Resolve cross-module references in all modules.
    fn resolve_cross_module_references(&mut self) {
        // Get topological order for processing
        let order = match self.graph.topological_order() {
            Some(o) => o,
            None => return, // Cycles - can't resolve in order
        };

        // Build import alias map for each module
        for module_id in &order {
            self.build_import_map(*module_id);
        }

        // Process each module
        for module_id in order {
            self.resolve_module_references(module_id);
        }
    }

    /// Build the import alias map for a module.
    fn build_import_map(&mut self, module_id: ModuleId) {
        self.import_aliases.clear();

        let node = match self.graph.get(module_id) {
            Some(n) => n,
            None => return,
        };

        for import in &node.hir.imports {
            let alias = import.alias.clone().unwrap_or_else(|| {
                // Default alias is the last segment of the namespace
                kanagawa_hir::decode_module_namespace(&import.namespace)
                    .last()
                    .cloned()
                    .unwrap_or_default()
            });

            if let Some(target_id) = self.graph.get_by_namespace(&import.namespace) {
                // Check for duplicate alias
                if self.import_aliases.contains_key(&alias) {
                    self.diagnostics.add(ResolveDiagnostic::error(
                        ResolveErrorCode::AmbiguousImport,
                        format!("ambiguous import alias `{}`", alias),
                        import.span,
                    ));
                } else {
                    self.import_aliases
                        .insert(alias, (target_id, import.namespace.clone()));
                }
            }
        }
    }

    /// Resolve references within a single module.
    fn resolve_module_references(&mut self, module_id: ModuleId) {
        // Get items to process
        let items: Vec<_> = {
            match self.graph.get(module_id) {
                Some(node) => node.hir.items.clone(),
                None => return,
            }
        };

        // Process each item
        for item in &items {
            self.resolve_item(module_id, item);
        }
    }

    /// Resolve references in a single item.
    fn resolve_item(&mut self, module_id: ModuleId, item: &HirItem) {
        match item {
            HirItem::Function(func) => {
                if let Some(body) = &func.body {
                    for stmt in &body.stmts {
                        self.resolve_stmt(module_id, stmt);
                    }
                }
            }
            HirItem::Variable(var) => {
                if let Some(init) = &var.init {
                    self.resolve_expr(module_id, init);
                }
            }
            HirItem::Struct(s) => {
                for member in &s.members {
                    if let Some(init) = &member.init {
                        self.resolve_expr(module_id, init);
                    }
                }
            }
            HirItem::Class(c) => {
                for member in &c.members {
                    match member {
                        kanagawa_hir::HirClassMember::Variable(v) => {
                            if let Some(init) = &v.init {
                                self.resolve_expr(module_id, init);
                            }
                        }
                        kanagawa_hir::HirClassMember::Function(f) => {
                            if let Some(body) = &f.body {
                                for stmt in &body.stmts {
                                    self.resolve_stmt(module_id, stmt);
                                }
                            }
                        }
                        kanagawa_hir::HirClassMember::Nested(item) => {
                            self.resolve_item(module_id, item);
                        }
                        _ => {}
                    }
                }
            }
            HirItem::Template(t) => {
                self.resolve_item(module_id, &t.item);
            }
            HirItem::StaticIf(s) => {
                self.resolve_expr(module_id, &s.condition);
                self.resolve_item(module_id, &s.then_item);
                if let Some(else_item) = &s.else_item {
                    self.resolve_item(module_id, else_item);
                }
            }
            HirItem::DeclBlock(b) => {
                for inner in &b.items {
                    self.resolve_item(module_id, inner);
                }
            }
            _ => {}
        }
    }

    /// Resolve references in a statement.
    fn resolve_stmt(&mut self, module_id: ModuleId, stmt: &HirStmt) {
        match stmt {
            HirStmt::Block(b) => {
                for s in &b.stmts {
                    self.resolve_stmt(module_id, s);
                }
            }
            HirStmt::VarDecl(v) => {
                if let Some(init) = &v.init {
                    self.resolve_expr(module_id, init);
                }
            }
            HirStmt::Expr(e) => {
                self.resolve_expr(module_id, &e.expr);
            }
            HirStmt::Return(r) => {
                if let Some(value) = &r.value {
                    self.resolve_expr(module_id, value);
                }
            }
            HirStmt::If(i) => {
                self.resolve_expr(module_id, &i.condition);
                self.resolve_stmt(module_id, &i.then_branch);
                if let Some(else_branch) = &i.else_branch {
                    self.resolve_stmt(module_id, else_branch);
                }
            }
            HirStmt::Switch(s) => {
                self.resolve_expr(module_id, &s.expr);
                for case in &s.cases {
                    for stmt in &case.stmts {
                        self.resolve_stmt(module_id, stmt);
                    }
                }
            }
            HirStmt::RangeFor(f) => {
                self.resolve_expr(module_id, &f.limit);
                self.resolve_stmt(module_id, &f.body);
            }
            HirStmt::StaticFor(f) => {
                self.resolve_expr(module_id, &f.limit);
                self.resolve_stmt(module_id, &f.body);
            }
            HirStmt::UnrolledFor(f) => {
                self.resolve_expr(module_id, &f.limit);
                self.resolve_stmt(module_id, &f.body);
            }
            HirStmt::DoWhile(d) => {
                self.resolve_stmt(module_id, &d.body);
                self.resolve_expr(module_id, &d.condition);
            }
            HirStmt::StaticIf(s) => {
                self.resolve_expr(module_id, &s.condition);
                self.resolve_stmt(module_id, &s.then_branch);
                if let Some(else_branch) = &s.else_branch {
                    self.resolve_stmt(module_id, else_branch);
                }
            }
            HirStmt::Assign(a) => {
                self.resolve_expr(module_id, &a.lhs);
                self.resolve_expr(module_id, &a.rhs);
            }
            HirStmt::Reorder(r) => {
                self.resolve_stmt(module_id, &r.body);
            }
            HirStmt::Atomic(a) => {
                self.resolve_stmt(module_id, &a.body);
            }
            HirStmt::Annotated(a) => {
                self.resolve_stmt(module_id, &a.stmt);
            }
            _ => {}
        }
    }

    /// Resolve references in an expression.
    fn resolve_expr(&mut self, module_id: ModuleId, expr: &HirExpr) {
        match &expr.kind {
            HirExprKind::QualifiedIdent { path, def_id, .. } => {
                // Check if this is a cross-module reference
                if path.len() >= 2 {
                    let first = &path[0];
                    // Check if first segment is an import alias
                    if let Some((_target_module, namespace)) =
                        self.import_aliases.get(first).cloned()
                    {
                        let symbol_name = &path[1];
                        // Verify visibility
                        let mut ctx = VisibilityContext::new(
                            &self.graph,
                            module_id,
                            &mut self.diagnostics,
                        );
                        ctx.check_qualified_access(&namespace, symbol_name, *def_id, expr.span);
                    }
                }
            }
            HirExprKind::Binary { lhs, rhs, .. } => {
                self.resolve_expr(module_id, lhs);
                self.resolve_expr(module_id, rhs);
            }
            HirExprKind::Unary { operand, .. } => {
                self.resolve_expr(module_id, operand);
            }
            HirExprKind::Ternary {
                condition,
                then_expr,
                else_expr,
            } => {
                self.resolve_expr(module_id, condition);
                self.resolve_expr(module_id, then_expr);
                self.resolve_expr(module_id, else_expr);
            }
            HirExprKind::Call { callee, args, .. } => {
                self.resolve_expr(module_id, callee);
                for arg in args {
                    self.resolve_expr(module_id, arg);
                }
            }
            HirExprKind::Member { object, .. } => {
                self.resolve_expr(module_id, object);
            }
            HirExprKind::Subscript { array, index } => {
                self.resolve_expr(module_id, array);
                self.resolve_expr(module_id, index);
            }
            HirExprKind::Cast { expr, .. } => {
                self.resolve_expr(module_id, expr);
            }
            HirExprKind::InitializerList(elements) => {
                for elem in elements {
                    self.resolve_expr(module_id, elem);
                }
            }
            HirExprKind::DesignatedInitializer(fields) => {
                for (_, expr) in fields {
                    self.resolve_expr(module_id, expr);
                }
            }
            HirExprKind::FanOut { count, value } => {
                self.resolve_expr(module_id, count);
                self.resolve_expr(module_id, value);
            }
            HirExprKind::Mux { selector, args } => {
                self.resolve_expr(module_id, selector);
                for arg in args {
                    self.resolve_expr(module_id, arg);
                }
            }
            HirExprKind::Concat(args) => {
                for arg in args {
                    self.resolve_expr(module_id, arg);
                }
            }
            HirExprKind::Lambda(lambda) => {
                for stmt in &lambda.body.stmts {
                    self.resolve_stmt(module_id, stmt);
                }
            }
            HirExprKind::Static(inner) | HirExprKind::Paren(inner) | HirExprKind::NamedValue(inner) => {
                self.resolve_expr(module_id, inner);
            }
            _ => {}
        }
    }
}

/// Look up a symbol across modules.
///
/// Given an import alias and symbol name, find the DefId.
pub fn lookup_cross_module(
    graph: &ModuleGraph,
    from_module: ModuleId,
    import_alias: &str,
    symbol_name: &str,
) -> Option<(ModuleId, DefId)> {
    // Find the import
    let from_node = graph.get(from_module)?;

    for import in &from_node.hir.imports {
        let alias = import.alias.clone().unwrap_or_else(|| {
            kanagawa_hir::decode_module_namespace(&import.namespace)
                .last()
                .cloned()
                .unwrap_or_default()
        });

        if alias == import_alias {
            // Found the import
            let target_id = graph.get_by_namespace(&import.namespace)?;
            let target_node = graph.get(target_id)?;

            // Look up in exports
            let exported = target_node.exports.get(symbol_name)?;
            return Some((target_id, exported.def_id));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{HirImport, HirModule, Span};

    fn make_test_file(namespace: &str) -> HirFile {
        let encoded = kanagawa_hir::encode_module_namespace(&[namespace]);
        HirFile {
            span: Span::default(),
            module: Some(HirModule {
                span: Span::default(),
                def_id: DefId(0),
                namespace: encoded,
                exports: Vec::new(),
            }),
            imports: Vec::new(),
            items: Vec::new(),
        }
    }

    fn make_test_file_with_imports(namespace: &str, imports: &[&str]) -> HirFile {
        let encoded = kanagawa_hir::encode_module_namespace(&[namespace]);
        let hir_imports: Vec<_> = imports
            .iter()
            .map(|i| HirImport {
                span: Span::default(),
                namespace: kanagawa_hir::encode_module_namespace(&[i]),
                alias: None,
            })
            .collect();
        HirFile {
            span: Span::default(),
            module: Some(HirModule {
                span: Span::default(),
                def_id: DefId(0),
                namespace: encoded,
                exports: Vec::new(),
            }),
            imports: hir_imports,
            items: Vec::new(),
        }
    }

    #[test]
    fn test_basic_resolution() {
        let mut resolver = ModuleResolver::new();

        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success, "Resolution should succeed");
        assert_eq!(result.graph.len(), 2);
    }

    #[test]
    fn test_missing_import() {
        let mut resolver = ModuleResolver::new();

        // Module B imports non-existent module C
        let file_b = make_test_file_with_imports("b", &["nonexistent"]);
        resolver.add_module(file_b, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(!result.success, "Should fail with missing import");
        assert!(result.error_count() > 0);
    }

    #[test]
    fn test_circular_dependency_detection() {
        let mut resolver = ModuleResolver::new();

        // Create a cycle: a -> b -> c -> a
        let file_a = make_test_file_with_imports("a", &["c"]);
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["b"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(!result.success, "Should fail with circular dependency");

        // Should have circular dependency error
        let has_cycle_error = result.diagnostics.iter().any(|d| {
            matches!(d.code, ResolveErrorCode::CircularDependency)
        });
        assert!(has_cycle_error, "Should report circular dependency");
    }

    #[test]
    fn test_diamond_dependency() {
        let mut resolver = ModuleResolver::new();

        // Diamond: a <- b, c <- d where b and c both import a
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["a"]);
        let file_d = make_test_file_with_imports("d", &["b", "c"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());
        resolver.add_module(file_d, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success, "Diamond dependency should succeed");
    }

    #[test]
    fn test_topological_order() {
        let mut resolver = ModuleResolver::new();

        // Linear chain: a <- b <- c
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["b"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success);

        // Verify topological order exists
        let order = result.graph.topological_order();
        assert!(order.is_some());
        assert_eq!(order.unwrap().len(), 3);
    }

    #[test]
    fn test_self_import() {
        let mut resolver = ModuleResolver::new();

        // Module that imports itself
        let file = make_test_file_with_imports("a", &["a"]);
        resolver.add_module(file, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(!result.success, "Self-import should fail");

        let has_self_import = result.diagnostics.iter().any(|d| {
            matches!(d.code, ResolveErrorCode::SelfImport)
        });
        assert!(has_self_import, "Should report self-import error");
    }

    #[test]
    fn test_multiple_imports() {
        let mut resolver = ModuleResolver::new();

        // Module that imports multiple modules
        let file_a = make_test_file("a");
        let file_b = make_test_file("b");
        let file_c = make_test_file_with_imports("c", &["a", "b"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success, "Multiple imports should succeed");
        assert_eq!(result.graph.len(), 3);
    }

    #[test]
    fn test_complex_cycle() {
        let mut resolver = ModuleResolver::new();

        // Complex cycle with extra edges: a -> b -> c -> d -> b (cycle)
        let file_a = make_test_file_with_imports("a", &["b"]);
        let file_b = make_test_file_with_imports("b", &["c"]);
        let file_c = make_test_file_with_imports("c", &["d"]);
        let file_d = make_test_file_with_imports("d", &["b"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());
        resolver.add_module(file_d, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(!result.success, "Complex cycle should fail");

        let has_cycle_error = result.diagnostics.iter().any(|d| {
            matches!(d.code, ResolveErrorCode::CircularDependency)
        });
        assert!(has_cycle_error, "Should report circular dependency");
    }

    #[test]
    fn test_multiple_cycles() {
        let mut resolver = ModuleResolver::new();

        // Two separate cycles: a -> b -> a, c -> d -> c
        let file_a = make_test_file_with_imports("a", &["b"]);
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["d"]);
        let file_d = make_test_file_with_imports("d", &["c"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());
        resolver.add_module(file_d, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(!result.success, "Multiple cycles should fail");

        // Should detect at least one cycle
        let cycle_errors: Vec<_> = result.diagnostics.iter()
            .filter(|d| matches!(d.code, ResolveErrorCode::CircularDependency))
            .collect();
        assert!(!cycle_errors.is_empty(), "Should report circular dependencies");
    }

    #[test]
    fn test_deep_dependency_chain() {
        let mut resolver = ModuleResolver::new();

        // Long chain: a <- b <- c <- d <- e <- f
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["b"]);
        let file_d = make_test_file_with_imports("d", &["c"]);
        let file_e = make_test_file_with_imports("e", &["d"]);
        let file_f = make_test_file_with_imports("f", &["e"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());
        resolver.add_module(file_d, SymbolTable::new());
        resolver.add_module(file_e, SymbolTable::new());
        resolver.add_module(file_f, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success, "Deep chain should succeed");

        let order = result.graph.topological_order();
        assert!(order.is_some());
        let order = order.unwrap();
        assert_eq!(order.len(), 6);

        // Verify order is correct (a should come before b, b before c, etc.)
        let positions: std::collections::HashMap<_, _> = order.iter()
            .enumerate()
            .map(|(i, id)| {
                let name = result.graph.get(*id).unwrap().display_name.clone();
                (name, i)
            })
            .collect();

        assert!(positions["a"] < positions["b"]);
        assert!(positions["b"] < positions["c"]);
        assert!(positions["c"] < positions["d"]);
        assert!(positions["d"] < positions["e"]);
        assert!(positions["e"] < positions["f"]);
    }

    #[test]
    fn test_multiple_missing_imports() {
        let mut resolver = ModuleResolver::new();

        // Module that imports multiple non-existent modules
        let file = make_test_file_with_imports("a", &["nonexistent1", "nonexistent2"]);
        resolver.add_module(file, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(!result.success, "Should fail with missing imports");

        let missing_errors: Vec<_> = result.diagnostics.iter()
            .filter(|d| matches!(d.code, ResolveErrorCode::ModuleNotFound))
            .collect();
        assert_eq!(missing_errors.len(), 2, "Should report two missing imports");
    }

    #[test]
    fn test_tree_structure() {
        let mut resolver = ModuleResolver::new();

        // Tree structure:
        //       a
        //      / \
        //     b   c
        //    / \   \
        //   d   e   f
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["a"]);
        let file_d = make_test_file_with_imports("d", &["b"]);
        let file_e = make_test_file_with_imports("e", &["b"]);
        let file_f = make_test_file_with_imports("f", &["c"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());
        resolver.add_module(file_d, SymbolTable::new());
        resolver.add_module(file_e, SymbolTable::new());
        resolver.add_module(file_f, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success, "Tree structure should succeed");
        assert_eq!(result.graph.len(), 6);
    }

    #[test]
    fn test_isolated_module() {
        let mut resolver = ModuleResolver::new();

        // Module with no imports and nothing importing it
        let file_a = make_test_file("a");
        let file_b = make_test_file("b");

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success, "Isolated modules should succeed");
        assert_eq!(result.graph.len(), 2);
    }

    #[test]
    fn test_empty_graph() {
        let resolver = ModuleResolver::new();
        let result = resolver.resolve_all();
        assert!(result.success, "Empty graph should succeed");
        assert_eq!(result.graph.len(), 0);
    }

    #[test]
    fn test_single_module() {
        let mut resolver = ModuleResolver::new();

        let file = make_test_file("single");
        resolver.add_module(file, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success, "Single module should succeed");
        assert_eq!(result.graph.len(), 1);
    }

    #[test]
    fn test_diagnostic_counts() {
        let mut resolver = ModuleResolver::new();

        // Create various errors
        let file_a = make_test_file_with_imports("a", &["nonexistent"]);
        let file_b = make_test_file_with_imports("b", &["b"]); // Self-import

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(!result.success);
        assert!(result.error_count() >= 2, "Should have at least 2 errors");
    }

    #[test]
    fn test_transitive_dependency_detection() {
        let mut resolver = ModuleResolver::new();

        // Chain: a <- b <- c
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["b"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success);

        // Get module IDs
        let id_a = result.graph.get_by_namespace(
            &kanagawa_hir::encode_module_namespace(&["a"])
        ).unwrap();
        let id_c = result.graph.get_by_namespace(
            &kanagawa_hir::encode_module_namespace(&["c"])
        ).unwrap();

        // c should have a as transitive dependency
        let trans_deps = result.graph.transitive_dependencies(id_c);
        assert!(trans_deps.contains(&id_a), "c should transitively depend on a");
    }

    #[test]
    fn test_complex_diamond() {
        let mut resolver = ModuleResolver::new();

        // Complex diamond:
        //        a
        //       /|\
        //      b c d
        //       \|/
        //        e
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["a"]);
        let file_d = make_test_file_with_imports("d", &["a"]);
        let file_e = make_test_file_with_imports("e", &["b", "c", "d"]);

        resolver.add_module(file_a, SymbolTable::new());
        resolver.add_module(file_b, SymbolTable::new());
        resolver.add_module(file_c, SymbolTable::new());
        resolver.add_module(file_d, SymbolTable::new());
        resolver.add_module(file_e, SymbolTable::new());

        let result = resolver.resolve_all();
        assert!(result.success, "Complex diamond should succeed");
        assert_eq!(result.graph.len(), 5);

        // Verify topological order
        let order = result.graph.topological_order().unwrap();
        let positions: std::collections::HashMap<_, _> = order.iter()
            .enumerate()
            .map(|(i, id)| (result.graph.get(*id).unwrap().display_name.clone(), i))
            .collect();

        // a should come before b, c, d
        // b, c, d should come before e
        assert!(positions["a"] < positions["b"]);
        assert!(positions["a"] < positions["c"]);
        assert!(positions["a"] < positions["d"]);
        assert!(positions["b"] < positions["e"]);
        assert!(positions["c"] < positions["e"]);
        assert!(positions["d"] < positions["e"]);
    }
}
