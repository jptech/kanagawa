//! Module dependency graph.
//!
//! This module provides the core data structures for tracking
//! module relationships, dependencies, and resolution state.

use crate::diagnostic::{circular_dependency, ResolveDiagnostics};
use crate::exports::ExportSet;
use kanagawa_hir::{HirFile, Span, SymbolTable};
use std::collections::{HashMap, HashSet, VecDeque};

/// Unique identifier for a module in the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ModuleId(pub usize);

impl ModuleId {
    /// The invalid/null module ID.
    pub const INVALID: ModuleId = ModuleId(usize::MAX);

    /// Check if this is a valid module ID.
    pub fn is_valid(self) -> bool {
        self != Self::INVALID
    }
}

/// A node in the module graph representing a single module.
#[derive(Debug)]
pub struct ModuleNode {
    /// Unique ID of this module.
    pub id: ModuleId,
    /// Encoded module namespace (e.g., "@data@optional").
    pub namespace: String,
    /// Display name (e.g., "data.optional").
    pub display_name: String,
    /// The HIR file for this module.
    pub hir: HirFile,
    /// Symbol table for this module.
    pub symbols: SymbolTable,
    /// Computed export set (filled during resolution).
    pub exports: ExportSet,
    /// IDs of modules this module imports.
    pub imports: Vec<ModuleId>,
    /// IDs of modules that import this module.
    pub importers: Vec<ModuleId>,
    /// Span of the module declaration.
    pub span: Span,
    /// Whether this module has been resolved.
    pub resolved: bool,
}

impl ModuleNode {
    /// Check if this module imports another module.
    pub fn imports_module(&self, other: ModuleId) -> bool {
        self.imports.contains(&other)
    }

    /// Get the number of imports.
    pub fn import_count(&self) -> usize {
        self.imports.len()
    }

    /// Check if this module has no dependencies.
    pub fn is_leaf(&self) -> bool {
        self.imports.is_empty()
    }
}

/// The module dependency graph.
///
/// This graph tracks all modules and their relationships.
/// It supports:
/// - Module registration and lookup
/// - Dependency tracking (imports/importers)
/// - Topological sorting for resolution order
/// - Cycle detection
#[derive(Debug, Default)]
pub struct ModuleGraph {
    /// All module nodes, indexed by ModuleId.
    nodes: Vec<ModuleNode>,
    /// Map from namespace to module ID for fast lookup.
    namespace_to_id: HashMap<String, ModuleId>,
    /// Map from file path (if known) to module ID.
    path_to_id: HashMap<String, ModuleId>,
}

impl ModuleGraph {
    /// Create a new empty module graph.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a module to the graph.
    ///
    /// Returns the module ID and whether it was newly added.
    /// If a module with the same namespace already exists, returns its ID.
    pub fn add_module(
        &mut self,
        hir: HirFile,
        symbols: SymbolTable,
    ) -> (ModuleId, bool) {
        // Extract namespace from module declaration
        let (namespace, display_name, span) = if let Some(ref module) = hir.module {
            let display = kanagawa_hir::display_module_namespace(&module.namespace);
            (module.namespace.clone(), display, module.span)
        } else {
            // Anonymous module - use a unique placeholder
            let placeholder = format!("@_anonymous_{}", self.nodes.len());
            (placeholder.clone(), "<anonymous>".to_string(), hir.span)
        };

        // Check if module already exists
        if let Some(&existing_id) = self.namespace_to_id.get(&namespace) {
            return (existing_id, false);
        }

        // Create new module node
        let id = ModuleId(self.nodes.len());
        let node = ModuleNode {
            id,
            namespace: namespace.clone(),
            display_name,
            hir,
            symbols,
            exports: ExportSet::new(),
            imports: Vec::new(),
            importers: Vec::new(),
            span,
            resolved: false,
        };

        self.nodes.push(node);
        self.namespace_to_id.insert(namespace, id);

        (id, true)
    }

    /// Associate a file path with a module.
    pub fn set_module_path(&mut self, id: ModuleId, path: impl Into<String>) {
        self.path_to_id.insert(path.into(), id);
    }

    /// Look up a module by namespace.
    pub fn get_by_namespace(&self, namespace: &str) -> Option<ModuleId> {
        self.namespace_to_id.get(namespace).copied()
    }

    /// Look up a module by file path.
    pub fn get_by_path(&self, path: &str) -> Option<ModuleId> {
        self.path_to_id.get(path).copied()
    }

    /// Get a module node by ID.
    pub fn get(&self, id: ModuleId) -> Option<&ModuleNode> {
        self.nodes.get(id.0)
    }

    /// Get a mutable module node by ID.
    pub fn get_mut(&mut self, id: ModuleId) -> Option<&mut ModuleNode> {
        self.nodes.get_mut(id.0)
    }

    /// Get the number of modules.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Check if the graph is empty.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Iterate over all modules.
    pub fn modules(&self) -> impl Iterator<Item = &ModuleNode> {
        self.nodes.iter()
    }

    /// Iterate over all module IDs.
    pub fn module_ids(&self) -> impl Iterator<Item = ModuleId> + '_ {
        (0..self.nodes.len()).map(ModuleId)
    }

    /// Build dependency edges from import declarations.
    ///
    /// This should be called after all modules are added to establish
    /// the import relationships.
    pub fn build_dependencies(&mut self, diagnostics: &mut ResolveDiagnostics) {
        // First pass: collect all import edges
        let mut edges: Vec<(ModuleId, ModuleId, Span)> = Vec::new();

        for node in &self.nodes {
            for import in &node.hir.imports {
                // Look up the imported module
                if let Some(target_id) = self.namespace_to_id.get(&import.namespace) {
                    // Check for self-import
                    if *target_id == node.id {
                        diagnostics.error(
                            crate::diagnostic::ResolveErrorCode::SelfImport,
                            format!("module `{}` imports itself", node.display_name),
                            import.span,
                        );
                    } else {
                        edges.push((node.id, *target_id, import.span));
                    }
                } else {
                    // Module not found
                    diagnostics.add(crate::diagnostic::module_not_found(
                        &kanagawa_hir::display_module_namespace(&import.namespace),
                        import.span,
                    ));
                }
            }
        }

        // Second pass: add edges to nodes
        for (from_id, to_id, _span) in edges {
            if let Some(from_node) = self.nodes.get_mut(from_id.0) {
                if !from_node.imports.contains(&to_id) {
                    from_node.imports.push(to_id);
                }
            }
            if let Some(to_node) = self.nodes.get_mut(to_id.0) {
                if !to_node.importers.contains(&from_id) {
                    to_node.importers.push(from_id);
                }
            }
        }
    }

    /// Detect circular dependencies in the module graph.
    ///
    /// Returns a list of cycles found. Each cycle is a list of module
    /// display names forming a cycle.
    pub fn detect_cycles(&self, diagnostics: &mut ResolveDiagnostics) -> Vec<Vec<String>> {
        let mut cycles = Vec::new();
        let mut visited = HashSet::new();
        let mut rec_stack = HashSet::new();
        let mut path = Vec::new();

        for id in self.module_ids() {
            if !visited.contains(&id) {
                self.detect_cycles_dfs(
                    id,
                    &mut visited,
                    &mut rec_stack,
                    &mut path,
                    &mut cycles,
                );
            }
        }

        // Report cycles as diagnostics
        for cycle in &cycles {
            if let Some(first_module) = self.get_by_namespace_display(&cycle[0]) {
                let span = self.get(first_module).map(|n| n.span).unwrap_or_default();
                diagnostics.add(circular_dependency(cycle, span));
            }
        }

        cycles
    }

    /// DFS helper for cycle detection.
    fn detect_cycles_dfs(
        &self,
        id: ModuleId,
        visited: &mut HashSet<ModuleId>,
        rec_stack: &mut HashSet<ModuleId>,
        path: &mut Vec<String>,
        cycles: &mut Vec<Vec<String>>,
    ) {
        visited.insert(id);
        rec_stack.insert(id);

        let node = match self.get(id) {
            Some(n) => n,
            None => return,
        };
        path.push(node.display_name.clone());

        for &import_id in &node.imports {
            if !visited.contains(&import_id) {
                self.detect_cycles_dfs(import_id, visited, rec_stack, path, cycles);
            } else if rec_stack.contains(&import_id) {
                // Found a cycle - extract it
                let import_name = self.get(import_id).map(|n| &n.display_name);
                if let Some(name) = import_name {
                    // Find where the cycle starts
                    if let Some(start) = path.iter().position(|n| n == name) {
                        let mut cycle: Vec<_> = path[start..].to_vec();
                        cycle.push(name.clone()); // Complete the cycle
                        cycles.push(cycle);
                    }
                }
            }
        }

        path.pop();
        rec_stack.remove(&id);
    }

    /// Get module by display name (for cycle detection).
    fn get_by_namespace_display(&self, display: &str) -> Option<ModuleId> {
        self.nodes
            .iter()
            .find(|n| n.display_name == display)
            .map(|n| n.id)
    }

    /// Compute a topological order for resolution.
    ///
    /// Returns modules in an order where each module comes after all
    /// modules it depends on. This is the order in which modules
    /// should be resolved.
    ///
    /// Returns None if there are cycles (use detect_cycles to find them).
    pub fn topological_order(&self) -> Option<Vec<ModuleId>> {
        let n = self.nodes.len();
        let mut in_degree: Vec<usize> = vec![0; n];
        let mut order = Vec::with_capacity(n);
        let mut queue = VecDeque::new();

        // Compute in-degrees (number of imports)
        for node in &self.nodes {
            in_degree[node.id.0] = node.imports.len();
        }

        // Start with modules that have no imports
        for (i, &degree) in in_degree.iter().enumerate() {
            if degree == 0 {
                queue.push_back(ModuleId(i));
            }
        }

        // Process in topological order
        while let Some(id) = queue.pop_front() {
            order.push(id);

            if let Some(node) = self.get(id) {
                for &importer_id in &node.importers {
                    in_degree[importer_id.0] -= 1;
                    if in_degree[importer_id.0] == 0 {
                        queue.push_back(importer_id);
                    }
                }
            }
        }

        // If we didn't process all nodes, there's a cycle
        if order.len() == n {
            Some(order)
        } else {
            None
        }
    }

    /// Get all modules that a given module transitively depends on.
    pub fn transitive_dependencies(&self, id: ModuleId) -> HashSet<ModuleId> {
        let mut deps = HashSet::new();
        let mut queue = VecDeque::new();

        if let Some(node) = self.get(id) {
            for &import_id in &node.imports {
                queue.push_back(import_id);
            }
        }

        while let Some(dep_id) = queue.pop_front() {
            if deps.insert(dep_id) {
                if let Some(dep_node) = self.get(dep_id) {
                    for &import_id in &dep_node.imports {
                        if !deps.contains(&import_id) {
                            queue.push_back(import_id);
                        }
                    }
                }
            }
        }

        deps
    }

    /// Get statistics about the graph.
    pub fn stats(&self) -> GraphStats {
        let mut total_imports = 0;
        let mut max_imports = 0;
        let mut leaf_count = 0;
        let mut root_count = 0;

        for node in &self.nodes {
            let imports = node.imports.len();
            total_imports += imports;
            max_imports = max_imports.max(imports);
            if imports == 0 {
                leaf_count += 1;
            }
            if node.importers.is_empty() {
                root_count += 1;
            }
        }

        GraphStats {
            module_count: self.nodes.len(),
            total_imports,
            max_imports,
            leaf_count,
            root_count,
        }
    }
}

/// Statistics about the module graph.
#[derive(Debug, Clone)]
pub struct GraphStats {
    /// Total number of modules.
    pub module_count: usize,
    /// Total number of import edges.
    pub total_imports: usize,
    /// Maximum imports in any single module.
    pub max_imports: usize,
    /// Number of modules with no imports.
    pub leaf_count: usize,
    /// Number of modules with no importers.
    pub root_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{HirImport, HirModule};

    fn make_test_file(namespace: &str) -> HirFile {
        let encoded = kanagawa_hir::encode_module_namespace(&[namespace]);
        HirFile {
            span: Span::default(),
            module: Some(HirModule {
                span: Span::default(),
                def_id: kanagawa_hir::DefId(0),
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
                def_id: kanagawa_hir::DefId(0),
                namespace: encoded,
                exports: Vec::new(),
            }),
            imports: hir_imports,
            items: Vec::new(),
        }
    }

    #[test]
    fn test_add_module() {
        let mut graph = ModuleGraph::new();
        let file = make_test_file("foo");
        let symbols = SymbolTable::new();

        let (id, is_new) = graph.add_module(file, symbols);
        assert!(is_new);
        assert!(id.is_valid());
        assert_eq!(graph.len(), 1);
    }

    #[test]
    fn test_duplicate_module() {
        let mut graph = ModuleGraph::new();
        let file1 = make_test_file("foo");
        let file2 = make_test_file("foo");

        let (id1, is_new1) = graph.add_module(file1, SymbolTable::new());
        let (id2, is_new2) = graph.add_module(file2, SymbolTable::new());

        assert!(is_new1);
        assert!(!is_new2);
        assert_eq!(id1, id2);
        assert_eq!(graph.len(), 1);
    }

    #[test]
    fn test_build_dependencies() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Create modules
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["a", "b"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());

        graph.build_dependencies(&mut diags);
        assert!(!diags.has_errors());

        // Check dependencies
        let a_id = graph.get_by_namespace("@a").unwrap();
        let b_id = graph.get_by_namespace("@b").unwrap();
        let c_id = graph.get_by_namespace("@c").unwrap();

        assert!(graph.get(a_id).unwrap().is_leaf());
        assert!(graph.get(b_id).unwrap().imports_module(a_id));
        assert!(graph.get(c_id).unwrap().imports_module(a_id));
        assert!(graph.get(c_id).unwrap().imports_module(b_id));
    }

    #[test]
    fn test_topological_order() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Create a -> b -> c dependency chain
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["b"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        let order = graph.topological_order().expect("should have no cycles");
        assert_eq!(order.len(), 3);

        // a should come before b, b before c
        let a_idx = order.iter().position(|&id| {
            graph.get(id).unwrap().display_name == "a"
        }).unwrap();
        let b_idx = order.iter().position(|&id| {
            graph.get(id).unwrap().display_name == "b"
        }).unwrap();
        let c_idx = order.iter().position(|&id| {
            graph.get(id).unwrap().display_name == "c"
        }).unwrap();

        assert!(a_idx < b_idx);
        assert!(b_idx < c_idx);
    }

    #[test]
    fn test_cycle_detection() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Create a cycle: a -> b -> c -> a
        let file_a = make_test_file_with_imports("a", &["c"]);
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["b"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        let cycles = graph.detect_cycles(&mut diags);
        assert!(!cycles.is_empty());
        assert!(diags.has_errors());
    }

    #[test]
    fn test_transitive_dependencies() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Create a -> b -> c -> d
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["b"]);
        let file_d = make_test_file_with_imports("d", &["c"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());
        graph.add_module(file_d, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        let d_id = graph.get_by_namespace("@d").unwrap();
        let deps = graph.transitive_dependencies(d_id);

        // d depends on a, b, c
        assert_eq!(deps.len(), 3);
    }

    #[test]
    fn test_graph_stats_empty() {
        let graph = ModuleGraph::new();
        let stats = graph.stats();

        assert_eq!(stats.module_count, 0);
        assert_eq!(stats.total_imports, 0);
        assert_eq!(stats.max_imports, 0);
        assert_eq!(stats.leaf_count, 0);
        assert_eq!(stats.root_count, 0);
    }

    #[test]
    fn test_graph_stats() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Tree structure:
        //     a
        //    / \
        //   b   c
        //   |
        //   d
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["a"]);
        let file_d = make_test_file_with_imports("d", &["b"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());
        graph.add_module(file_d, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        let stats = graph.stats();
        assert_eq!(stats.module_count, 4);
        assert_eq!(stats.total_imports, 3); // b->a, c->a, d->b
        assert_eq!(stats.max_imports, 1);
        assert_eq!(stats.leaf_count, 1); // only 'a' has no imports
        assert_eq!(stats.root_count, 2); // c and d have no importers
    }

    #[test]
    fn test_module_ids() {
        let mut graph = ModuleGraph::new();

        let file_a = make_test_file("a");
        let file_b = make_test_file("b");
        let file_c = make_test_file("c");

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());

        let ids: Vec<_> = graph.module_ids().collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn test_get_by_namespace() {
        let mut graph = ModuleGraph::new();

        let file_a = make_test_file("mymodule");
        graph.add_module(file_a, SymbolTable::new());

        // Should find by encoded namespace
        assert!(graph.get_by_namespace("@mymodule").is_some());

        // Should not find non-existent
        assert!(graph.get_by_namespace("@nonexistent").is_none());
    }

    #[test]
    fn test_get_by_path() {
        let mut graph = ModuleGraph::new();

        let file_a = make_test_file("pathtest");
        let (id, _) = graph.add_module(file_a, SymbolTable::new());

        // Set a path using the proper API
        graph.set_module_path(id, "/test/path.k");

        assert!(graph.get_by_path("/test/path.k").is_some());
        assert!(graph.get_by_path("/nonexistent.k").is_none());
    }

    #[test]
    fn test_importers_tracking() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // a is imported by b and c
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["a"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        let a_id = graph.get_by_namespace("@a").unwrap();
        let a_node = graph.get(a_id).unwrap();

        // a should have 2 importers (b and c)
        assert_eq!(a_node.importers.len(), 2);
    }

    #[test]
    fn test_self_reference_detection() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Module that imports itself
        let file_a = make_test_file_with_imports("a", &["a"]);
        graph.add_module(file_a, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        // Self-import is detected during build_dependencies as a SelfImport error
        // rather than in cycle detection (since the import isn't added to avoid cycle)
        assert!(diags.has_errors());

        // Should have self-import error
        let has_self_import = diags.iter().any(|d| {
            matches!(d.code, crate::diagnostic::ResolveErrorCode::SelfImport)
        });
        assert!(has_self_import, "Should detect self-import error");
    }

    #[test]
    fn test_missing_import_dependency() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Module that imports non-existent module
        let file_a = make_test_file_with_imports("a", &["nonexistent"]);
        graph.add_module(file_a, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        // Should report missing module error
        assert!(diags.has_errors());
    }

    #[test]
    fn test_complex_transitive_deps() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Diamond pattern: d depends on b and c, both depend on a
        //     a
        //    / \
        //   b   c
        //    \ /
        //     d
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["a"]);
        let file_d = make_test_file_with_imports("d", &["b", "c"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());
        graph.add_module(file_d, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        let d_id = graph.get_by_namespace("@d").unwrap();
        let deps = graph.transitive_dependencies(d_id);

        // d depends transitively on a, b, c
        assert_eq!(deps.len(), 3);
    }

    #[test]
    fn test_topological_order_diamond() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        // Diamond pattern
        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);
        let file_c = make_test_file_with_imports("c", &["a"]);
        let file_d = make_test_file_with_imports("d", &["b", "c"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.add_module(file_c, SymbolTable::new());
        graph.add_module(file_d, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        let order = graph.topological_order().expect("should have no cycles");
        assert_eq!(order.len(), 4);

        // Find positions
        let pos = |name: &str| -> usize {
            order.iter().position(|&id| {
                graph.get(id).unwrap().display_name == name
            }).unwrap()
        };

        // a must come before b and c
        // b and c must come before d
        assert!(pos("a") < pos("b"));
        assert!(pos("a") < pos("c"));
        assert!(pos("b") < pos("d"));
        assert!(pos("c") < pos("d"));
    }

    #[test]
    fn test_is_leaf() {
        let mut graph = ModuleGraph::new();
        let mut diags = ResolveDiagnostics::new();

        let file_a = make_test_file("a");
        let file_b = make_test_file_with_imports("b", &["a"]);

        graph.add_module(file_a, SymbolTable::new());
        graph.add_module(file_b, SymbolTable::new());
        graph.build_dependencies(&mut diags);

        let a_id = graph.get_by_namespace("@a").unwrap();
        let b_id = graph.get_by_namespace("@b").unwrap();

        assert!(graph.get(a_id).unwrap().is_leaf());
        assert!(!graph.get(b_id).unwrap().is_leaf());
    }

    #[test]
    fn test_module_id_validity() {
        let valid = ModuleId(0);
        let invalid = ModuleId::INVALID;

        assert!(valid.is_valid());
        assert!(!invalid.is_valid());
    }
}
