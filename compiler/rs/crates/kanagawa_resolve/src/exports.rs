//! Module export set computation.
//!
//! This module handles:
//! - Computing the set of symbols exported by each module
//! - Processing re-exports (module exports)
//! - Computing export differences (module A \ module B)
//! - Validating that exported symbols exist

use crate::diagnostic::{ResolveDiagnostic, ResolveDiagnostics, ResolveErrorCode};
use crate::graph::{ModuleGraph, ModuleId};
use kanagawa_hir::{DefId, HirExport, Span, Visibility};
use std::collections::{HashMap, HashSet};

/// An exported symbol from a module.
#[derive(Debug, Clone)]
pub struct ExportedSymbol {
    /// The name of the exported symbol.
    pub name: String,
    /// The DefId of the exported definition.
    pub def_id: DefId,
    /// Whether this is a re-export from another module.
    pub is_reexport: bool,
    /// The original module (for re-exports).
    pub source_module: Option<String>,
    /// Span of the export declaration.
    pub span: Span,
}

/// The set of symbols exported by a module.
#[derive(Debug, Clone, Default)]
pub struct ExportSet {
    /// Map from symbol name to exported symbol info.
    symbols: HashMap<String, ExportedSymbol>,
    /// Whether this is an "export all" module (no explicit exports).
    pub export_all: bool,
    /// Set of explicitly exported names.
    explicit_exports: HashSet<String>,
}

impl ExportSet {
    /// Create a new empty export set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create an "export all" set.
    pub fn export_all() -> Self {
        Self {
            export_all: true,
            ..Default::default()
        }
    }

    /// Add a symbol to the export set.
    pub fn add(&mut self, symbol: ExportedSymbol) {
        self.explicit_exports.insert(symbol.name.clone());
        self.symbols.insert(symbol.name.clone(), symbol);
    }

    /// Check if a symbol is exported.
    pub fn is_exported(&self, name: &str) -> bool {
        if self.export_all {
            return true;
        }
        self.symbols.contains_key(name)
    }

    /// Get an exported symbol by name.
    pub fn get(&self, name: &str) -> Option<&ExportedSymbol> {
        self.symbols.get(name)
    }

    /// Get all exported symbol names.
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.symbols.keys().map(|s| s.as_str())
    }

    /// Get all exported symbols.
    pub fn symbols(&self) -> impl Iterator<Item = &ExportedSymbol> {
        self.symbols.values()
    }

    /// Get the number of exported symbols.
    pub fn len(&self) -> usize {
        self.symbols.len()
    }

    /// Check if the export set is empty.
    pub fn is_empty(&self) -> bool {
        self.symbols.is_empty() && !self.export_all
    }

    /// Merge another export set into this one (for re-exports).
    pub fn merge(&mut self, other: &ExportSet, source_module: &str) {
        for (name, sym) in &other.symbols {
            if !self.symbols.contains_key(name) {
                let mut reexported = sym.clone();
                reexported.is_reexport = true;
                reexported.source_module = Some(source_module.to_string());
                self.symbols.insert(name.clone(), reexported);
            }
        }
    }

    /// Remove symbols from this set that are in another set (for export differences).
    pub fn subtract(&mut self, other: &ExportSet) {
        for name in other.symbols.keys() {
            self.symbols.remove(name);
        }
    }
}

/// Compute export sets for all modules in the graph.
///
/// This processes export declarations in topological order to handle
/// re-exports correctly.
pub fn compute_exports(
    graph: &mut ModuleGraph,
    diagnostics: &mut ResolveDiagnostics,
) {
    // Get topological order (or process in any order if there are cycles)
    let order = graph.topological_order().unwrap_or_else(|| {
        graph.module_ids().collect()
    });

    // Process each module
    for module_id in order {
        compute_module_exports(graph, module_id, diagnostics);
    }
}

/// Compute exports for a single module.
fn compute_module_exports(
    graph: &mut ModuleGraph,
    module_id: ModuleId,
    diagnostics: &mut ResolveDiagnostics,
) {
    // Get the module's export declarations
    let (exports_decl, symbols_snapshot, module_namespace) = {
        let node = match graph.get(module_id) {
            Some(n) => n,
            None => return,
        };

        let exports = node.hir.module.as_ref().map(|m| m.exports.clone());
        let namespace = node.namespace.clone();

        // Create a snapshot of symbols defined in this module
        let mut defined_symbols: HashMap<String, DefId> = HashMap::new();
        for entry in node.symbols.definitions() {
            if let Some(name) = entry.def.name.split('@').last() {
                defined_symbols.insert(name.to_string(), entry.def.def_id);
            }
        }

        (exports, defined_symbols, namespace)
    };

    let mut export_set = ExportSet::new();

    match exports_decl {
        Some(exports) if !exports.is_empty() => {
            // Process explicit exports
            for export in &exports {
                process_export(
                    export,
                    &mut export_set,
                    &symbols_snapshot,
                    graph,
                    module_id,
                    &module_namespace,
                    diagnostics,
                );
            }
        }
        _ => {
            // No exports = export all public symbols
            export_set.export_all = true;
            for (name, def_id) in &symbols_snapshot {
                // Check visibility from symbol table
                let is_public = graph
                    .get(module_id)
                    .and_then(|n| n.symbols.get(*def_id))
                    .map(|d| d.def.visibility == Visibility::Public)
                    .unwrap_or(true); // Default to public if no visibility info

                if is_public {
                    export_set.add(ExportedSymbol {
                        name: name.clone(),
                        def_id: *def_id,
                        is_reexport: false,
                        source_module: None,
                        span: Span::default(),
                    });
                }
            }
        }
    }

    // Store the computed export set
    if let Some(node) = graph.get_mut(module_id) {
        node.exports = export_set;
    }
}

/// Process a single export declaration.
fn process_export(
    export: &HirExport,
    export_set: &mut ExportSet,
    defined_symbols: &HashMap<String, DefId>,
    graph: &ModuleGraph,
    _module_id: ModuleId,
    module_namespace: &str,
    diagnostics: &mut ResolveDiagnostics,
) {
    match export {
        HirExport::Name(name) => {
            // Export a single symbol
            if let Some(&def_id) = defined_symbols.get(name) {
                export_set.add(ExportedSymbol {
                    name: name.clone(),
                    def_id,
                    is_reexport: false,
                    source_module: None,
                    span: Span::default(),
                });
            } else {
                // Symbol not found - error
                diagnostics.add(ResolveDiagnostic::error(
                    ResolveErrorCode::UndefinedExport,
                    format!(
                        "cannot export undefined symbol `{}` from module `{}`",
                        name,
                        kanagawa_hir::display_module_namespace(module_namespace)
                    ),
                    Span::default(),
                ));
            }
        }

        HirExport::Module(namespace) => {
            // Re-export all symbols from another module
            if let Some(target_id) = graph.get_by_namespace(namespace) {
                if let Some(target_node) = graph.get(target_id) {
                    let display = kanagawa_hir::display_module_namespace(namespace);
                    export_set.merge(&target_node.exports, &display);
                }
            } else {
                diagnostics.add(ResolveDiagnostic::error(
                    ResolveErrorCode::ReexportModuleNotFound,
                    format!(
                        "cannot re-export module `{}`: not found",
                        kanagawa_hir::display_module_namespace(namespace)
                    ),
                    Span::default(),
                ));
            }
        }

        HirExport::ModuleDiff { include, exclude } => {
            // Export (module A) \ (module B)
            let include_exports = graph
                .get_by_namespace(include)
                .and_then(|id| graph.get(id))
                .map(|n| n.exports.clone());

            let exclude_exports = graph
                .get_by_namespace(exclude)
                .and_then(|id| graph.get(id))
                .map(|n| n.exports.clone());

            match (include_exports, exclude_exports) {
                (Some(mut included), Some(excluded)) => {
                    included.subtract(&excluded);
                    let display = kanagawa_hir::display_module_namespace(include);
                    export_set.merge(&included, &display);
                }
                (None, _) => {
                    diagnostics.add(ResolveDiagnostic::error(
                        ResolveErrorCode::ExportDiffModuleNotFound,
                        format!(
                            "cannot find module `{}` for export difference",
                            kanagawa_hir::display_module_namespace(include)
                        ),
                        Span::default(),
                    ));
                }
                (_, None) => {
                    diagnostics.add(ResolveDiagnostic::error(
                        ResolveErrorCode::ExportDiffModuleNotFound,
                        format!(
                            "cannot find module `{}` for export difference",
                            kanagawa_hir::display_module_namespace(exclude)
                        ),
                        Span::default(),
                    ));
                }
            }
        }
    }
}

/// Check if a module exports a specific symbol.
pub fn module_exports_symbol(graph: &ModuleGraph, module_id: ModuleId, name: &str) -> bool {
    graph
        .get(module_id)
        .map(|n| n.exports.is_exported(name))
        .unwrap_or(false)
}

/// Get the DefId of an exported symbol from a module.
pub fn get_exported_def_id(
    graph: &ModuleGraph,
    module_id: ModuleId,
    name: &str,
) -> Option<DefId> {
    graph
        .get(module_id)
        .and_then(|n| n.exports.get(name))
        .map(|e| e.def_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_set_add_and_get() {
        let mut set = ExportSet::new();
        set.add(ExportedSymbol {
            name: "Foo".to_string(),
            def_id: DefId(1),
            is_reexport: false,
            source_module: None,
            span: Span::default(),
        });

        assert!(set.is_exported("Foo"));
        assert!(!set.is_exported("Bar"));
        assert_eq!(set.get("Foo").unwrap().def_id, DefId(1));
    }

    #[test]
    fn test_export_set_merge() {
        let mut set1 = ExportSet::new();
        set1.add(ExportedSymbol {
            name: "Foo".to_string(),
            def_id: DefId(1),
            is_reexport: false,
            source_module: None,
            span: Span::default(),
        });

        let mut set2 = ExportSet::new();
        set2.add(ExportedSymbol {
            name: "Bar".to_string(),
            def_id: DefId(2),
            is_reexport: false,
            source_module: None,
            span: Span::default(),
        });

        set1.merge(&set2, "other.module");

        assert!(set1.is_exported("Foo"));
        assert!(set1.is_exported("Bar"));
        assert!(set1.get("Bar").unwrap().is_reexport);
    }

    #[test]
    fn test_export_set_subtract() {
        let mut set1 = ExportSet::new();
        set1.add(ExportedSymbol {
            name: "Foo".to_string(),
            def_id: DefId(1),
            is_reexport: false,
            source_module: None,
            span: Span::default(),
        });
        set1.add(ExportedSymbol {
            name: "Bar".to_string(),
            def_id: DefId(2),
            is_reexport: false,
            source_module: None,
            span: Span::default(),
        });

        let mut set2 = ExportSet::new();
        set2.add(ExportedSymbol {
            name: "Bar".to_string(),
            def_id: DefId(2),
            is_reexport: false,
            source_module: None,
            span: Span::default(),
        });

        set1.subtract(&set2);

        assert!(set1.is_exported("Foo"));
        assert!(!set1.is_exported("Bar"));
    }

    #[test]
    fn test_export_all() {
        let set = ExportSet::export_all();
        assert!(set.export_all);
        assert!(set.is_exported("anything"));
    }
}
