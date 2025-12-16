//! Visibility checking for cross-module access.
//!
//! This module enforces visibility rules:
//! - Private symbols can only be accessed within their defining module
//! - Non-exported symbols cannot be accessed from imports
//! - Re-exports must reference public/exported symbols

use crate::diagnostic::{non_exported_access, private_access, ResolveDiagnostic, ResolveDiagnostics, ResolveErrorCode};
use crate::graph::{ModuleGraph, ModuleId};
use kanagawa_hir::{DefId, Span, Visibility};

/// Result of a visibility check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VisibilityError {
    /// Symbol is private and cannot be accessed from outside module.
    Private {
        symbol: String,
        from_module: String,
        in_module: String,
    },
    /// Symbol is not exported and cannot be accessed via import.
    NotExported {
        symbol: String,
        from_module: String,
        in_module: String,
    },
}

impl VisibilityError {
    /// Convert to a diagnostic.
    pub fn to_diagnostic(&self, span: Span) -> ResolveDiagnostic {
        match self {
            VisibilityError::Private {
                symbol,
                from_module,
                in_module: _,
            } => private_access(symbol, from_module, span),
            VisibilityError::NotExported {
                symbol,
                from_module,
                in_module: _,
            } => non_exported_access(symbol, from_module, span),
        }
    }
}

/// Check if a symbol can be accessed from a given module.
///
/// Returns Ok(()) if access is allowed, or Err(VisibilityError) if not.
pub fn check_visibility(
    graph: &ModuleGraph,
    from_module: ModuleId,
    target_module: ModuleId,
    symbol_name: &str,
    def_id: DefId,
) -> Result<(), VisibilityError> {
    // Same module - always allowed
    if from_module == target_module {
        return Ok(());
    }

    let from_node = graph.get(from_module);
    let target_node = graph.get(target_module);

    let (from_name, target_name) = match (from_node, target_node) {
        (Some(f), Some(t)) => (f.display_name.clone(), t.display_name.clone()),
        _ => return Ok(()), // Can't check if modules don't exist
    };

    let target_node = target_node.unwrap();

    // Check 1: Is the symbol exported from the target module?
    if !target_node.exports.is_exported(symbol_name) {
        return Err(VisibilityError::NotExported {
            symbol: symbol_name.to_string(),
            from_module: from_name,
            in_module: target_name,
        });
    }

    // Check 2: Is the symbol public in its definition?
    if let Some(def) = target_node.symbols.get(def_id) {
        if def.def.visibility == Visibility::Private {
            return Err(VisibilityError::Private {
                symbol: symbol_name.to_string(),
                from_module: from_name,
                in_module: target_name,
            });
        }
    }

    Ok(())
}

/// Check visibility for all cross-module references in a module.
pub fn check_module_visibility(
    graph: &ModuleGraph,
    module_id: ModuleId,
    diagnostics: &mut ResolveDiagnostics,
) {
    let node = match graph.get(module_id) {
        Some(n) => n,
        None => return,
    };

    // Check all imports are accessing exported symbols
    for import in &node.hir.imports {
        if let Some(target_id) = graph.get_by_namespace(&import.namespace) {
            // For now, we just verify the import target exists
            // Full symbol resolution happens in resolver.rs
            if let Some(target_node) = graph.get(target_id) {
                if target_node.exports.is_empty() && !target_node.exports.export_all {
                    diagnostics.add(
                        ResolveDiagnostic::warning(
                            ResolveErrorCode::NonExportedAccess,
                            format!(
                                "module `{}` has no exports",
                                kanagawa_hir::display_module_namespace(&import.namespace)
                            ),
                            import.span,
                        )
                        .with_note("this import may not provide any accessible symbols"),
                    );
                }
            }
        }
    }
}

/// Validate that all exports are public symbols.
pub fn validate_exports(
    graph: &ModuleGraph,
    module_id: ModuleId,
    diagnostics: &mut ResolveDiagnostics,
) {
    let node = match graph.get(module_id) {
        Some(n) => n,
        None => return,
    };

    for exported in node.exports.symbols() {
        if !exported.is_reexport {
            // Check that the exported symbol is public
            if let Some(def) = node.symbols.get(exported.def_id) {
                if def.def.visibility == Visibility::Private {
                    diagnostics.add(
                        ResolveDiagnostic::error(
                            ResolveErrorCode::ExportingPrivate,
                            format!(
                                "cannot export private symbol `{}` from module `{}`",
                                exported.name, node.display_name
                            ),
                            exported.span,
                        )
                        .with_note("make the symbol public or remove it from exports"),
                    );
                }
            }
        }
    }
}

/// Context for visibility checking during expression traversal.
#[derive(Debug)]
pub struct VisibilityContext<'a> {
    /// The module graph.
    pub graph: &'a ModuleGraph,
    /// The current module being checked.
    pub current_module: ModuleId,
    /// Collected diagnostics.
    pub diagnostics: &'a mut ResolveDiagnostics,
}

impl<'a> VisibilityContext<'a> {
    /// Create a new visibility context.
    pub fn new(
        graph: &'a ModuleGraph,
        current_module: ModuleId,
        diagnostics: &'a mut ResolveDiagnostics,
    ) -> Self {
        Self {
            graph,
            current_module,
            diagnostics,
        }
    }

    /// Check access to a symbol in another module.
    pub fn check_access(
        &mut self,
        target_module: ModuleId,
        symbol_name: &str,
        def_id: DefId,
        span: Span,
    ) {
        if let Err(err) = check_visibility(
            self.graph,
            self.current_module,
            target_module,
            symbol_name,
            def_id,
        ) {
            self.diagnostics.add(err.to_diagnostic(span));
        }
    }

    /// Check if a qualified name access is valid.
    pub fn check_qualified_access(
        &mut self,
        module_namespace: &str,
        symbol_name: &str,
        def_id: DefId,
        span: Span,
    ) {
        if let Some(target_id) = self.graph.get_by_namespace(module_namespace) {
            self.check_access(target_id, symbol_name, def_id, span);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::ExportedSymbol;
    use crate::graph::ModuleGraph;
    use kanagawa_hir::{HirFile, HirModule, SymbolTable};

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

    #[test]
    fn test_same_module_access() {
        let mut graph = ModuleGraph::new();
        let file = make_test_file("test");
        let (id, _) = graph.add_module(file, SymbolTable::new());

        // Same module access is always allowed
        let result = check_visibility(&graph, id, id, "anything", DefId(0));
        assert!(result.is_ok());
    }

    #[test]
    fn test_exported_symbol_access() {
        let mut graph = ModuleGraph::new();

        // Module A with exported symbol
        let file_a = make_test_file("a");
        let (id_a, _) = graph.add_module(file_a, SymbolTable::new());

        // Add an exported symbol to A
        if let Some(node) = graph.get_mut(id_a) {
            node.exports.add(ExportedSymbol {
                name: "Foo".to_string(),
                def_id: DefId(1),
                is_reexport: false,
                source_module: None,
                span: Span::default(),
            });
        }

        // Module B
        let file_b = make_test_file("b");
        let (id_b, _) = graph.add_module(file_b, SymbolTable::new());

        // B accessing exported symbol from A should succeed
        let result = check_visibility(&graph, id_b, id_a, "Foo", DefId(1));
        assert!(result.is_ok());
    }

    #[test]
    fn test_non_exported_symbol_access() {
        let mut graph = ModuleGraph::new();

        // Module A with no exports
        let file_a = make_test_file("a");
        let (id_a, _) = graph.add_module(file_a, SymbolTable::new());

        // Module B
        let file_b = make_test_file("b");
        let (id_b, _) = graph.add_module(file_b, SymbolTable::new());

        // B accessing non-exported symbol from A should fail
        let result = check_visibility(&graph, id_b, id_a, "Foo", DefId(1));
        assert!(matches!(result, Err(VisibilityError::NotExported { .. })));
    }

    #[test]
    fn test_private_symbol_access() {
        use kanagawa_hir::{DefKind, Ty};

        let mut graph = ModuleGraph::new();

        // Module A with private symbol that's exported (should be caught)
        let file_a = make_test_file("a");
        let mut symbols_a = SymbolTable::new();
        let def_id = symbols_a.define_with_visibility(
            "privateVar",
            DefKind::Variable,
            Ty::Unsigned(32),
            Span::default(),
            Visibility::Private,
        );
        let (id_a, _) = graph.add_module(file_a, symbols_a);

        // Add the symbol as exported
        if let Some(node) = graph.get_mut(id_a) {
            node.exports.add(ExportedSymbol {
                name: "privateVar".to_string(),
                def_id,
                is_reexport: false,
                source_module: None,
                span: Span::default(),
            });
        }

        // Module B
        let file_b = make_test_file("b");
        let (id_b, _) = graph.add_module(file_b, SymbolTable::new());

        // B accessing private symbol from A should fail
        let result = check_visibility(&graph, id_b, id_a, "privateVar", def_id);
        assert!(matches!(result, Err(VisibilityError::Private { .. })));
    }

    #[test]
    fn test_public_symbol_access() {
        use kanagawa_hir::{DefKind, Ty};

        let mut graph = ModuleGraph::new();

        // Module A with public symbol
        let file_a = make_test_file("a");
        let mut symbols_a = SymbolTable::new();
        let def_id = symbols_a.define_with_visibility(
            "publicVar",
            DefKind::Variable,
            Ty::Unsigned(32),
            Span::default(),
            Visibility::Public,
        );
        let (id_a, _) = graph.add_module(file_a, symbols_a);

        // Add the symbol as exported
        if let Some(node) = graph.get_mut(id_a) {
            node.exports.add(ExportedSymbol {
                name: "publicVar".to_string(),
                def_id,
                is_reexport: false,
                source_module: None,
                span: Span::default(),
            });
        }

        // Module B
        let file_b = make_test_file("b");
        let (id_b, _) = graph.add_module(file_b, SymbolTable::new());

        // B accessing public exported symbol from A should succeed
        let result = check_visibility(&graph, id_b, id_a, "publicVar", def_id);
        assert!(result.is_ok());
    }

    #[test]
    fn test_visibility_error_to_diagnostic() {
        let error = VisibilityError::Private {
            symbol: "foo".to_string(),
            from_module: "module_b".to_string(),
            in_module: "module_a".to_string(),
        };

        let diag = error.to_diagnostic(Span::default());
        assert!(diag.is_error());
        assert!(diag.message.contains("private"));
        assert!(diag.message.contains("foo"));
    }

    #[test]
    fn test_visibility_error_not_exported() {
        let error = VisibilityError::NotExported {
            symbol: "bar".to_string(),
            from_module: "module_b".to_string(),
            in_module: "module_a".to_string(),
        };

        let diag = error.to_diagnostic(Span::default());
        assert!(diag.is_error());
        assert!(diag.message.contains("not exported"));
        assert!(diag.message.contains("bar"));
    }

    #[test]
    fn test_multiple_modules_visibility() {
        let mut graph = ModuleGraph::new();

        // Module A with exported symbol
        let file_a = make_test_file("a");
        let (id_a, _) = graph.add_module(file_a, SymbolTable::new());
        if let Some(node) = graph.get_mut(id_a) {
            node.exports.add(ExportedSymbol {
                name: "SharedType".to_string(),
                def_id: DefId(1),
                is_reexport: false,
                source_module: None,
                span: Span::default(),
            });
        }

        // Module B with exported symbol
        let file_b = make_test_file("b");
        let (id_b, _) = graph.add_module(file_b, SymbolTable::new());
        if let Some(node) = graph.get_mut(id_b) {
            node.exports.add(ExportedSymbol {
                name: "AnotherType".to_string(),
                def_id: DefId(2),
                is_reexport: false,
                source_module: None,
                span: Span::default(),
            });
        }

        // Module C
        let file_c = make_test_file("c");
        let (id_c, _) = graph.add_module(file_c, SymbolTable::new());

        // C can access A's exported symbol
        let result = check_visibility(&graph, id_c, id_a, "SharedType", DefId(1));
        assert!(result.is_ok());

        // C can access B's exported symbol
        let result = check_visibility(&graph, id_c, id_b, "AnotherType", DefId(2));
        assert!(result.is_ok());

        // C cannot access non-exported symbol from A
        let result = check_visibility(&graph, id_c, id_a, "NonExported", DefId(99));
        assert!(matches!(result, Err(VisibilityError::NotExported { .. })));
    }

    #[test]
    fn test_visibility_context() {
        let mut graph = ModuleGraph::new();

        // Module A with exported symbol
        let file_a = make_test_file("a");
        let (id_a, _) = graph.add_module(file_a, SymbolTable::new());
        if let Some(node) = graph.get_mut(id_a) {
            node.exports.add(ExportedSymbol {
                name: "Exported".to_string(),
                def_id: DefId(1),
                is_reexport: false,
                source_module: None,
                span: Span::default(),
            });
        }

        // Module B
        let file_b = make_test_file("b");
        let (id_b, _) = graph.add_module(file_b, SymbolTable::new());

        // Test exported symbol access - should succeed with no diagnostic
        {
            let mut diagnostics = ResolveDiagnostics::new();
            let mut ctx = VisibilityContext::new(&graph, id_b, &mut diagnostics);
            ctx.check_access(id_a, "Exported", DefId(1), Span::default());
            assert!(!diagnostics.has_errors());
        }

        // Test non-exported symbol access - should add error
        {
            let mut diagnostics = ResolveDiagnostics::new();
            let mut ctx = VisibilityContext::new(&graph, id_b, &mut diagnostics);
            ctx.check_access(id_a, "NonExported", DefId(99), Span::default());
            assert!(diagnostics.has_errors());
        }
    }

    #[test]
    fn test_export_all_visibility() {
        let mut graph = ModuleGraph::new();

        // Module A with export_all = true
        let file_a = make_test_file("a");
        let (id_a, _) = graph.add_module(file_a, SymbolTable::new());
        if let Some(node) = graph.get_mut(id_a) {
            node.exports.export_all = true;
        }

        // Module B
        let file_b = make_test_file("b");
        let (id_b, _) = graph.add_module(file_b, SymbolTable::new());

        // B can access any symbol from A when export_all is true
        let result = check_visibility(&graph, id_b, id_a, "AnySymbol", DefId(1));
        assert!(result.is_ok());
    }
}
